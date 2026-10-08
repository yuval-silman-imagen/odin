import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import path from "node:path";
import { app } from "electron";
import log from "electron-log/main";
import { env as sharedEnv } from "shared/env.shared";
import { Client, type ConnectConfig, type SFTPWrapper } from "ssh2";
import {
	findFreePort,
	HEALTH_POLL_TIMEOUT_MS,
	pollHealthCheck,
} from "../host-service-utils";
import { HOOK_PROTOCOL_VERSION } from "../terminal/env";
import {
	buildRemoteStartCommand,
	buildTestCommand,
	parseTestOutput,
	shellQuote,
} from "./ssh";
import type {
	ActiveRemote,
	RemoteConnectionConfig,
	RemoteConnectionStatus,
	RemoteConnectionStatusEvent,
	TestConnectionResult,
} from "./types";

/** Organization scope for a remote backend - one host per remote for now. */
const REMOTE_ORGANIZATION_ID = "remote";
/** SSH handshake timeout. */
const SSH_READY_TIMEOUT_MS = 20_000;
/** Remote layout under the configured odin folder. */
const REMOTE_BACKEND_DIRNAME = "backend";
const REMOTE_BUNDLE_NAME = "host-service.js";
const REMOTE_MIGRATIONS_DIRNAME = "host-migrations";
/**
 * Bundle files the remote backend needs beside each other. host-worker.js is
 * resolved next to host-service.js by the worker pool, so it must ship too.
 * Native addons are not copied - they are installed on the remote for its own
 * platform.
 */
const REMOTE_BUNDLE_FILES = ["host-service.js", "host-worker.js"];

interface CommandResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

function expandHome(filePath: string): string {
	if (filePath === "~") return os.homedir();
	if (filePath.startsWith("~/") || filePath.startsWith("~\\")) {
		return path.join(os.homedir(), filePath.slice(2));
	}
	return filePath;
}

/** Platform path to the running SSH agent, if any. */
function sshAgentPath(): string | undefined {
	if (process.platform === "win32") return "\\\\.\\pipe\\openssh-ssh-agent";
	return process.env.SSH_AUTH_SOCK || undefined;
}

/** First existing default private key under ~/.ssh, if any. */
function defaultPrivateKeyPath(): string | null {
	const dir = path.join(os.homedir(), ".ssh");
	for (const name of ["id_ed25519", "id_rsa", "id_ecdsa"]) {
		const candidate = path.join(dir, name);
		if (fs.existsSync(candidate)) return candidate;
	}
	return null;
}

/**
 * Owns SSH-managed remote backends through the in-process ssh2 client (so
 * password auth works on every platform, Windows included). It provisions and
 * starts the host-service on the remote and keeps one SSH connection open that
 * carries both control channels and a forwarded local port. Disconnecting
 * closes only the local side - the remote daemon keeps running so agents
 * outlive the laptop.
 */
export class RemoteConnectionManager {
	private readonly emitter = new EventEmitter();
	private client: Client | null = null;
	private tunnelServer: net.Server | null = null;
	private active: ActiveRemote | null = null;

	onStatusChange(
		listener: (event: RemoteConnectionStatusEvent) => void,
	): () => void {
		this.emitter.on("status", listener);
		return () => this.emitter.off("status", listener);
	}

	getActive(): ActiveRemote | null {
		return this.active;
	}

	/** Probe reachability, Node presence and that the odin folder is writable. */
	async testConnection(
		config: RemoteConnectionConfig,
	): Promise<TestConnectionResult> {
		let client: Client | null = null;
		try {
			client = await this.openClient(config);
			const result = await this.exec(client, buildTestCommand(config));
			return parseTestOutput(result.stdout, true, result.stderr);
		} catch (error) {
			return parseTestOutput(
				"",
				false,
				error instanceof Error ? error.message : String(error),
			);
		} finally {
			client?.end();
		}
	}

	/**
	 * Provision + start the remote backend (idempotent), open the forwarded
	 * port, and wait until it answers a health check. Any previously active
	 * connection is closed first.
	 */
	async connect(config: RemoteConnectionConfig): Promise<ActiveRemote> {
		this.closeActive();
		const secret = randomBytes(32).toString("hex");
		const localPort = await findFreePort();
		this.setStatus(config, "connecting", localPort, null);

		let client: Client | null = null;
		try {
			const readyClient = await this.openClient(config);
			client = readyClient;
			await this.provisionRemote(readyClient, config);
			await this.startRemoteBackend(readyClient, config, secret);

			const server = this.openTunnel(
				readyClient,
				localPort,
				config.remoteHostServicePort,
			);
			this.client = readyClient;
			this.tunnelServer = server;

			const healthy = await pollHealthCheck(
				`http://127.0.0.1:${localPort}`,
				secret,
				HEALTH_POLL_TIMEOUT_MS,
				() => this.client !== readyClient,
			);
			if (!healthy) {
				throw new Error(
					`Remote host-service did not answer on the tunnel within ${HEALTH_POLL_TIMEOUT_MS}ms.`,
				);
			}

			// Watch for the connection dropping while we are live.
			readyClient.on("close", () => this.handleClientClosed(readyClient));
			readyClient.on("error", () => this.handleClientClosed(readyClient));

			this.active = {
				connectionId: config.id,
				name: config.name,
				host: config.host,
				localPort,
				secret,
				status: "connected",
			};
			this.setStatus(config, "connected", localPort, null);
			log.info(
				`[remote-connection] connected to ${config.host} via :${localPort}`,
			);
			return this.active;
		} catch (error) {
			if (this.client === client) {
				this.closeActive();
			} else {
				client?.end();
			}
			this.active = null;
			const message = error instanceof Error ? error.message : String(error);
			this.setStatus(config, "error", null, message);
			throw error;
		}
	}

	/** Close the local side only; the remote daemon is left running. */
	disconnect(): void {
		const previous = this.active;
		this.closeActive();
		this.active = null;
		if (previous) {
			this.emitter.emit("status", {
				connectionId: previous.connectionId,
				name: previous.name,
				host: previous.host,
				status: "disconnected",
				localPort: null,
				error: null,
			} satisfies RemoteConnectionStatusEvent);
		}
	}

	// ── SSH orchestration ─────────────────────────────────────────────

	private openClient(config: RemoteConnectionConfig): Promise<Client> {
		return new Promise((resolve, reject) => {
			const client = new Client();
			let settled = false;
			client.on("ready", () => {
				settled = true;
				resolve(client);
			});
			client.on("error", (error) => {
				if (settled) return;
				settled = true;
				reject(error);
			});
			let connectConfig: ConnectConfig;
			try {
				connectConfig = {
					host: config.host,
					port: config.sshPort,
					username: config.username,
					readyTimeout: SSH_READY_TIMEOUT_MS,
					...this.buildAuth(config),
				};
			} catch (error) {
				reject(error);
				return;
			}
			client.connect(connectConfig);
		});
	}

	private buildAuth(config: RemoteConnectionConfig): Partial<ConnectConfig> {
		if (config.authMethod === "password") {
			if (!config.password) {
				throw new Error("A password is required for password authentication.");
			}
			return { password: config.password };
		}
		const keyPath = config.sshKeyPath
			? expandHome(config.sshKeyPath)
			: defaultPrivateKeyPath();
		if (keyPath) {
			if (!fs.existsSync(keyPath)) {
				throw new Error(`SSH key not found at ${keyPath}`);
			}
			return { privateKey: fs.readFileSync(keyPath) };
		}
		const agent = sshAgentPath();
		if (agent) return { agent };
		throw new Error(
			"No SSH key found and no agent is running. Set a key path, or switch to password authentication.",
		);
	}

	private async provisionRemote(
		client: Client,
		config: RemoteConnectionConfig,
	): Promise<void> {
		const backendDir = `${config.odinFolder}/${REMOTE_BACKEND_DIRNAME}`;
		const migrationsSource = app.isPackaged
			? path.join(process.resourcesPath, "resources/host-migrations")
			: path.join(app.getAppPath(), "../../packages/host-service/drizzle");

		await this.execChecked(
			client,
			`mkdir -p ${shellQuote(backendDir)}`,
			"prepare the remote backend directory",
		);

		const sftp = await this.openSftp(client);
		try {
			const staged = this.stageBundleFiles();
			try {
				for (const file of staged) {
					await this.putFile(
						sftp,
						file.localPath,
						`${backendDir}/${file.name}`,
					);
				}
			} finally {
				for (const file of staged) {
					try {
						fs.rmSync(file.localPath, { force: true });
					} catch {
						// Temp file - best-effort cleanup.
					}
				}
			}
			await this.putDir(
				client,
				sftp,
				migrationsSource,
				`${backendDir}/${REMOTE_MIGRATIONS_DIRNAME}`,
			);
		} finally {
			sftp.end();
		}

		// First-cut native-dep install, guarded by a marker. The host-service
		// bundle externalizes better-sqlite3 and node-pty, so they must be built
		// for the remote's platform. Hardening (ABI pinning, a prebuilt package)
		// is a follow-up - see the feature plan.
		const marker = `${backendDir}/.provisioned`;
		const install = [
			`if [ ! -f ${shellQuote(marker)} ]; then`,
			`cd ${shellQuote(backendDir)}`,
			`&& printf '%s' '{"name":"odin-remote-backend","private":true}' > package.json`,
			`&& npm install --no-audit --no-fund better-sqlite3 node-pty`,
			`&& touch ${shellQuote(marker)}; fi`,
		].join(" ");
		await this.execChecked(
			client,
			install,
			"install the remote backend's native dependencies",
		);
	}

	/**
	 * Copy the backend bundle files out of their install location (inside
	 * app.asar when packaged) into a temp dir sftp can read. Reads go through
	 * Electron's asar-aware fs; the returned paths are real files on disk.
	 */
	private stageBundleFiles(): { name: string; localPath: string }[] {
		const sourceDir = __dirname;
		const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), "odin-remote-"));
		const staged: { name: string; localPath: string }[] = [];
		for (const name of REMOTE_BUNDLE_FILES) {
			const source = path.join(sourceDir, name);
			if (!fs.existsSync(source)) {
				if (name === REMOTE_BUNDLE_NAME) {
					throw new Error(`Backend bundle not found at ${source}`);
				}
				log.warn(`[remote-connection] bundle file missing, skipping: ${name}`);
				continue;
			}
			const localPath = path.join(stageDir, name);
			fs.writeFileSync(localPath, fs.readFileSync(source));
			staged.push({ name, localPath });
		}
		return staged;
	}

	private async startRemoteBackend(
		client: Client,
		config: RemoteConnectionConfig,
		secret: string,
	): Promise<void> {
		const bundlePath = `${config.odinFolder}/${REMOTE_BACKEND_DIRNAME}/${REMOTE_BUNDLE_NAME}`;
		const migrationsDir = `${config.odinFolder}/${REMOTE_BACKEND_DIRNAME}/${REMOTE_MIGRATIONS_DIRNAME}`;
		const command = buildRemoteStartCommand(config, {
			secret,
			organizationId: REMOTE_ORGANIZATION_ID,
			bundlePath,
			migrationsDir,
			hookPort: sharedEnv.DESKTOP_NOTIFICATIONS_PORT,
			hookVersion: HOOK_PROTOCOL_VERSION,
		});
		await this.execChecked(client, command, "start the remote host-service");
	}

	private openTunnel(
		client: Client,
		localPort: number,
		remotePort: number,
	): net.Server {
		const server = net.createServer((socket) => {
			client.forwardOut(
				socket.remoteAddress ?? "127.0.0.1",
				socket.remotePort ?? 0,
				"127.0.0.1",
				remotePort,
				(error, stream) => {
					if (error) {
						socket.destroy();
						return;
					}
					socket.pipe(stream).pipe(socket);
					stream.on("error", () => socket.destroy());
					socket.on("error", () => stream.end());
				},
			);
		});
		server.on("error", (error) => {
			log.warn(`[remote-connection] tunnel server error: ${error.message}`);
		});
		server.listen(localPort, "127.0.0.1");
		return server;
	}

	private handleClientClosed(client: Client): void {
		if (this.client !== client) return;
		const dropped = this.active;
		this.closeActive();
		this.active = null;
		if (dropped) {
			this.emitter.emit("status", {
				connectionId: dropped.connectionId,
				name: dropped.name,
				host: dropped.host,
				status: "error",
				localPort: null,
				error: "SSH connection closed unexpectedly.",
			} satisfies RemoteConnectionStatusEvent);
		}
	}

	private closeActive(): void {
		if (this.tunnelServer) {
			try {
				this.tunnelServer.close();
			} catch {
				// Best-effort.
			}
			this.tunnelServer = null;
		}
		if (this.client) {
			try {
				this.client.end();
			} catch {
				// Best-effort.
			}
			this.client = null;
		}
	}

	// ── ssh2 primitives ───────────────────────────────────────────────

	private exec(client: Client, command: string): Promise<CommandResult> {
		return new Promise((resolve, reject) => {
			client.exec(command, (error, stream) => {
				if (error) {
					reject(error);
					return;
				}
				let stdout = "";
				let stderr = "";
				stream
					.on("close", (code: number | null) =>
						resolve({ code: code ?? null, stdout, stderr }),
					)
					.on("data", (chunk: Buffer) => {
						stdout += chunk.toString();
					});
				stream.stderr.on("data", (chunk: Buffer) => {
					stderr += chunk.toString();
				});
			});
		});
	}

	private async execChecked(
		client: Client,
		command: string,
		description: string,
	): Promise<CommandResult> {
		const result = await this.exec(client, command);
		if (result.code !== 0) {
			const detail = (result.stderr || result.stdout).trim();
			throw new Error(`Failed to ${description}${detail ? `: ${detail}` : ""}`);
		}
		return result;
	}

	private openSftp(client: Client): Promise<SFTPWrapper> {
		return new Promise((resolve, reject) => {
			client.sftp((error, sftp) => {
				if (error) reject(error);
				else resolve(sftp);
			});
		});
	}

	private putFile(
		sftp: SFTPWrapper,
		localPath: string,
		remotePath: string,
	): Promise<void> {
		return new Promise((resolve, reject) => {
			sftp.fastPut(localPath, remotePath, (error) => {
				if (error) {
					reject(
						new Error(
							`Failed to copy ${path.basename(localPath)} to the remote: ${error.message}`,
						),
					);
				} else {
					resolve();
				}
			});
		});
	}

	/** Recursively copy a local directory to the remote over sftp. */
	private async putDir(
		client: Client,
		sftp: SFTPWrapper,
		localDir: string,
		remoteDir: string,
	): Promise<void> {
		const files: { abs: string; rel: string }[] = [];
		const walk = (dir: string, rel: string) => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const abs = path.join(dir, entry.name);
				const relPath = rel ? `${rel}/${entry.name}` : entry.name;
				if (entry.isDirectory()) walk(abs, relPath);
				else if (entry.isFile()) files.push({ abs, rel: relPath });
			}
		};
		walk(localDir, "");
		const remoteDirs = new Set<string>([remoteDir]);
		for (const file of files) {
			const parent = file.rel.includes("/")
				? `${remoteDir}/${file.rel.slice(0, file.rel.lastIndexOf("/"))}`
				: remoteDir;
			remoteDirs.add(parent);
		}
		await this.execChecked(
			client,
			`mkdir -p ${[...remoteDirs].map(shellQuote).join(" ")}`,
			"create the remote migrations directory",
		);
		for (const file of files) {
			await this.putFile(sftp, file.abs, `${remoteDir}/${file.rel}`);
		}
	}

	private setStatus(
		config: RemoteConnectionConfig,
		status: RemoteConnectionStatus,
		localPort: number | null,
		error: string | null,
	): void {
		this.emitter.emit("status", {
			connectionId: config.id,
			name: config.name,
			host: config.host,
			status,
			localPort,
			error,
		} satisfies RemoteConnectionStatusEvent);
	}
}

let singleton: RemoteConnectionManager | null = null;

export function getRemoteConnectionManager(): RemoteConnectionManager {
	if (!singleton) singleton = new RemoteConnectionManager();
	return singleton;
}
