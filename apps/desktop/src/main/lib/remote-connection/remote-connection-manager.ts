import { createHash, randomBytes } from "node:crypto";
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
	ALREADY_RUNNING_MARKER,
	buildProvisionCommand,
	buildRemoteStartCommand,
	buildTestCommand,
	collectBundleFiles,
	parseTestOutput,
	REMOTE_AUTH_PROBE_PATH,
	REMOTE_RUNTIME_DEPS,
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
 * Bundle entry points the remote backend needs beside each other. The worker
 * pool resolves host-worker.js and the daemon supervisor resolves
 * pty-daemon.js next to host-service.js. The chunks they load are collected
 * from these by {@link collectBundleFiles}. Native addons are not copied -
 * they are installed on the remote for its own platform.
 */
const REMOTE_BUNDLE_ENTRIES = [
	"host-service.js",
	"host-worker.js",
	"pty-daemon.js",
];
/** Log lines quoted back when the remote backend fails to come up. */
const REMOTE_LOG_TAIL_LINES = 30;

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
			const resolved = await this.resolveConfig(client, config);
			const result = await this.exec(client, buildTestCommand(resolved));
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
		const localPort = await findFreePort();
		this.setStatus(config, "connecting", localPort, null);

		let client: Client | null = null;
		let resolved: RemoteConnectionConfig = config;
		try {
			const readyClient = await this.openClient(config);
			client = readyClient;
			resolved = await this.resolveConfig(readyClient, config);
			const bundleHash = await this.provisionRemote(readyClient, resolved);
			const secret = await this.startRemoteBackend(
				readyClient,
				resolved,
				bundleHash,
			);

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
				const logTail = await this.readRemoteLogTail(readyClient, resolved);
				throw new Error(
					`Remote host-service did not answer on the tunnel within ${HEALTH_POLL_TIMEOUT_MS}ms.${
						logTail
							? `\n\nLast lines of ${resolved.odinFolder}/host-service.log:\n${logTail}`
							: ""
					}`,
				);
			}

			// health.check is public; prove the secret before the renderer
			// gets a wall of 401s.
			const auth = await fetch(
				`http://127.0.0.1:${localPort}${REMOTE_AUTH_PROBE_PATH}`,
				{ headers: { Authorization: `Bearer ${secret}` } },
			);
			if (auth.status === 401) {
				throw new Error(
					"The remote host-service rejected this app's credentials. Restart it on the server and connect again.",
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

	/**
	 * Expand a leading `~` in the odin folder to the remote home directory.
	 * The folder is quoted in shell commands (so the shell never expands `~`)
	 * and sftp cannot expand it either, so resolve it once against the real
	 * remote `$HOME`.
	 */
	private async resolveConfig(
		client: Client,
		config: RemoteConnectionConfig,
	): Promise<RemoteConnectionConfig> {
		if (!config.odinFolder.startsWith("~")) return config;
		const result = await this.exec(client, 'printf %s "$HOME"');
		const home = result.stdout.trim();
		if (!home) {
			throw new Error("Could not resolve the remote home directory.");
		}
		return {
			...config,
			odinFolder: config.odinFolder.replace(/^~(?=\/|$)/, home),
		};
	}

	/**
	 * Ship the backend bundle (entries + chunks) and migrations, and install
	 * its runtime deps for the remote's platform. Returns the bundle's content
	 * hash so the start step can tell a current daemon from a stale one.
	 */
	private async provisionRemote(
		client: Client,
		config: RemoteConnectionConfig,
	): Promise<string> {
		const backendDir = `${config.odinFolder}/${REMOTE_BACKEND_DIRNAME}`;
		const migrationsSource = app.isPackaged
			? path.join(process.resourcesPath, "resources/host-migrations")
			: path.join(app.getAppPath(), "../../packages/host-service/drizzle");

		const staged = this.stageBundleFiles();
		try {
			const running = await this.exec(
				client,
				`cat ${shellQuote(`${backendDir}/.running-bundle`)} 2>/dev/null`,
			);
			// The daemon already runs exactly this bundle: nothing to copy.
			if (running.stdout.trim() !== staged.hash) {
				const remoteDirs = new Set([backendDir]);
				for (const file of staged.files) {
					remoteDirs.add(path.posix.dirname(`${backendDir}/${file.name}`));
				}
				await this.execChecked(
					client,
					`mkdir -p ${[...remoteDirs].map(shellQuote).join(" ")}`,
					"prepare the remote backend directory",
				);
				const sftp = await this.openSftp(client);
				try {
					for (const file of staged.files) {
						await this.putFile(
							sftp,
							file.localPath,
							`${backendDir}/${file.name}`,
						);
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
			}
		} finally {
			try {
				fs.rmSync(staged.dir, { recursive: true, force: true });
			} catch {
				// Temp dir - best-effort cleanup.
			}
		}

		await this.execChecked(
			client,
			buildProvisionCommand(backendDir, REMOTE_RUNTIME_DEPS),
			"install the remote backend's npm dependencies",
		);
		return staged.hash;
	}

	/**
	 * Copy the backend bundle files out of their install location (inside
	 * app.asar when packaged) into a temp dir sftp can read. Reads go through
	 * Electron's asar-aware fs; the returned paths are real files on disk.
	 */
	private stageBundleFiles(): {
		dir: string;
		hash: string;
		files: { name: string; localPath: string }[];
	} {
		const sourceDir = __dirname;
		if (!fs.existsSync(path.join(sourceDir, REMOTE_BUNDLE_NAME))) {
			throw new Error(
				`Backend bundle not found at ${path.join(sourceDir, REMOTE_BUNDLE_NAME)}`,
			);
		}
		const names = collectBundleFiles(REMOTE_BUNDLE_ENTRIES, (rel) => {
			const source = path.join(sourceDir, rel);
			return fs.existsSync(source) ? fs.readFileSync(source, "utf8") : null;
		});
		for (const entry of REMOTE_BUNDLE_ENTRIES) {
			if (!names.includes(entry)) {
				log.warn(`[remote-connection] bundle file missing, skipping: ${entry}`);
			}
		}
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odin-remote-"));
		const hash = createHash("sha256");
		const files = names.map((name) => {
			const content = fs.readFileSync(path.join(sourceDir, name));
			hash.update(name).update("\0").update(content);
			const localPath = path.join(dir, name);
			fs.mkdirSync(path.dirname(localPath), { recursive: true });
			fs.writeFileSync(localPath, content);
			return { name, localPath };
		});
		return { dir, hash: hash.digest("hex"), files };
	}

	/**
	 * Start the remote backend, or adopt the one already running, and return
	 * the secret it answers to.
	 */
	private async startRemoteBackend(
		client: Client,
		config: RemoteConnectionConfig,
		bundleHash: string,
	): Promise<string> {
		const bundlePath = `${config.odinFolder}/${REMOTE_BACKEND_DIRNAME}/${REMOTE_BUNDLE_NAME}`;
		const migrationsDir = `${config.odinFolder}/${REMOTE_BACKEND_DIRNAME}/${REMOTE_MIGRATIONS_DIRNAME}`;
		const existing = await this.readRemoteManifest(client, config);
		const secret = randomBytes(32).toString("hex");
		const command = buildRemoteStartCommand(config, {
			secret,
			existing,
			bundleHash,
			organizationId: REMOTE_ORGANIZATION_ID,
			bundlePath,
			migrationsDir,
			hookPort: sharedEnv.DESKTOP_NOTIFICATIONS_PORT,
			hookVersion: HOOK_PROTOCOL_VERSION,
			vitePort: sharedEnv.DESKTOP_VITE_PORT,
		});
		const result = await this.execChecked(
			client,
			command,
			"start the remote host-service",
		);
		if (existing && result.stdout.includes(ALREADY_RUNNING_MARKER)) {
			log.info("[remote-connection] adopted the running remote host-service");
			return existing.secret;
		}
		return secret;
	}

	/** pid + secret of the daemon a previous connect left running, if any. */
	private async readRemoteManifest(
		client: Client,
		config: RemoteConnectionConfig,
	): Promise<{ secret: string; pid: number } | null> {
		const manifestPath = `${config.odinFolder}/host/${REMOTE_ORGANIZATION_ID}/manifest.json`;
		const result = await this.exec(
			client,
			`cat ${shellQuote(manifestPath)} 2>/dev/null`,
		);
		try {
			const data = JSON.parse(result.stdout) as {
				pid?: unknown;
				authToken?: unknown;
			};
			if (
				typeof data.authToken === "string" &&
				data.authToken &&
				Number.isInteger(data.pid)
			) {
				return { secret: data.authToken, pid: data.pid as number };
			}
		} catch {
			// No manifest yet, or a torn write - start fresh.
		}
		return null;
	}

	private async readRemoteLogTail(
		client: Client,
		config: RemoteConnectionConfig,
	): Promise<string> {
		try {
			const result = await this.exec(
				client,
				`tail -n ${REMOTE_LOG_TAIL_LINES} ${shellQuote(`${config.odinFolder}/host-service.log`)} 2>/dev/null`,
			);
			return result.stdout.trim();
		} catch {
			return "";
		}
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
