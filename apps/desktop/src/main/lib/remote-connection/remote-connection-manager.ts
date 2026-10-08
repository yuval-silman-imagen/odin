import * as childProcess from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import path from "node:path";
import { app } from "electron";
import log from "electron-log/main";
import { env as sharedEnv } from "shared/env.shared";
import {
	findFreePort,
	HEALTH_POLL_TIMEOUT_MS,
	pollHealthCheck,
} from "../host-service-utils";
import { HOOK_PROTOCOL_VERSION } from "../terminal/env";
import {
	buildRemoteStartCommand,
	buildSshCommandArgs,
	buildTestCommand,
	buildTunnelArgs,
	parseTestOutput,
	shellQuote,
	sshOptionArgs,
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
/** How long a one-shot ssh/scp probe may run before we give up. */
const SSH_COMMAND_TIMEOUT_MS = 20_000;
/** Remote layout under the configured odin folder. */
const REMOTE_BACKEND_DIRNAME = "backend";
const REMOTE_BUNDLE_NAME = "host-service.js";
const REMOTE_MIGRATIONS_DIRNAME = "host-migrations";

interface CommandResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

/**
 * Owns SSH-managed remote backends: tests reachability, provisions and starts
 * the host-service on the remote, and keeps a local `-L` tunnel open so the
 * renderer can talk to it on loopback. Disconnecting tears down only the local
 * tunnel - the remote daemon keeps running so agents outlive the laptop.
 */
export class RemoteConnectionManager {
	private readonly emitter = new EventEmitter();
	private tunnel: ReturnType<typeof childProcess.spawn> | null = null;
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
		const result = await this.runCommand(
			"ssh",
			buildSshCommandArgs(config, buildTestCommand(config)),
		);
		const reachable = result.code === 0 || result.stdout.length > 0;
		return parseTestOutput(result.stdout, reachable, result.stderr);
	}

	/**
	 * Provision + start the remote backend (idempotent), then open the tunnel
	 * and wait until the forwarded port answers a health check. Any previously
	 * active tunnel is closed first.
	 */
	async connect(config: RemoteConnectionConfig): Promise<ActiveRemote> {
		this.closeTunnel();
		const secret = randomBytes(32).toString("hex");
		const localPort = await findFreePort();
		this.setStatus(config, "connecting", localPort, null);

		try {
			await this.provisionRemote(config);
			await this.startRemoteBackend(config, secret);
			this.openTunnel(config, localPort);

			const endpoint = `http://127.0.0.1:${localPort}`;
			const healthy = await pollHealthCheck(
				endpoint,
				secret,
				HEALTH_POLL_TIMEOUT_MS,
				() => this.tunnel === null || this.tunnel.exitCode !== null,
			);
			if (!healthy) {
				throw new Error(
					`Remote host-service did not answer on the tunnel within ${HEALTH_POLL_TIMEOUT_MS}ms.`,
				);
			}

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
			this.closeTunnel();
			this.active = null;
			const message = error instanceof Error ? error.message : String(error);
			this.setStatus(config, "error", null, message);
			throw error;
		}
	}

	/** Close the local tunnel only; the remote daemon is left running. */
	disconnect(): void {
		const previous = this.active;
		this.closeTunnel();
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

	private async provisionRemote(config: RemoteConnectionConfig): Promise<void> {
		const backendDir = `${config.odinFolder}/${REMOTE_BACKEND_DIRNAME}`;
		const bundleSource = path.join(__dirname, REMOTE_BUNDLE_NAME);
		const migrationsSource = app.isPackaged
			? path.join(process.resourcesPath, "resources/host-migrations")
			: path.join(app.getAppPath(), "../../packages/host-service/drizzle");

		await this.runCommandChecked(
			"ssh",
			buildSshCommandArgs(config, `mkdir -p ${shellQuote(backendDir)}`),
			"prepare the remote backend directory",
		);
		await this.scp(config, bundleSource, `${backendDir}/${REMOTE_BUNDLE_NAME}`);
		await this.scp(
			config,
			migrationsSource,
			`${backendDir}/${REMOTE_MIGRATIONS_DIRNAME}`,
			{ recursive: true },
		);

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
		await this.runCommandChecked(
			"ssh",
			buildSshCommandArgs(config, install),
			"install the remote backend's native dependencies",
		);
	}

	private async startRemoteBackend(
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
		await this.runCommandChecked(
			"ssh",
			buildSshCommandArgs(config, command),
			"start the remote host-service",
		);
	}

	private openTunnel(config: RemoteConnectionConfig, localPort: number): void {
		const child = childProcess.spawn(
			"ssh",
			buildTunnelArgs(config, localPort),
			{
				stdio: ["ignore", "ignore", "pipe"],
				windowsHide: true,
			},
		);
		this.tunnel = child;
		child.stderr?.on("data", (chunk: Buffer) => {
			log.warn(`[remote-connection] tunnel: ${chunk.toString().trim()}`);
		});
		child.on("exit", (code, signal) => {
			if (this.tunnel !== child) return;
			this.tunnel = null;
			const wasConnected = this.active?.status === "connected";
			if (wasConnected && this.active) {
				const dropped = this.active;
				this.active = null;
				this.emitter.emit("status", {
					connectionId: dropped.connectionId,
					name: dropped.name,
					host: dropped.host,
					status: "error",
					localPort: null,
					error: `SSH tunnel closed unexpectedly (code ${code ?? signal}).`,
				} satisfies RemoteConnectionStatusEvent);
			}
		});
	}

	private closeTunnel(): void {
		if (!this.tunnel) return;
		const child = this.tunnel;
		this.tunnel = null;
		try {
			child.kill("SIGTERM");
		} catch {
			// Best-effort - the tunnel may already be gone.
		}
	}

	private async scp(
		config: RemoteConnectionConfig,
		localPath: string,
		remotePath: string,
		options: { recursive?: boolean } = {},
	): Promise<void> {
		const args = [
			...sshOptionArgs(config, { portFlag: "-P" }),
			...(options.recursive ? ["-r"] : []),
			localPath,
			`${config.username}@${config.host}:${remotePath}`,
		];
		await this.runCommandChecked(
			"scp",
			args,
			`copy ${path.basename(localPath)} to the remote`,
		);
	}

	private async runCommandChecked(
		command: string,
		args: string[],
		description: string,
	): Promise<CommandResult> {
		const result = await this.runCommand(command, args);
		if (result.code !== 0) {
			const detail = (result.stderr || result.stdout).trim();
			throw new Error(`Failed to ${description}${detail ? `: ${detail}` : ""}`);
		}
		return result;
	}

	private runCommand(command: string, args: string[]): Promise<CommandResult> {
		return new Promise((resolve) => {
			const child = childProcess.spawn(command, args, {
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
			let stdout = "";
			let stderr = "";
			const timer = setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} catch {
					// Already gone.
				}
			}, SSH_COMMAND_TIMEOUT_MS);
			child.stdout?.on("data", (chunk: Buffer) => {
				stdout += chunk.toString();
			});
			child.stderr?.on("data", (chunk: Buffer) => {
				stderr += chunk.toString();
			});
			child.on("error", (error) => {
				clearTimeout(timer);
				resolve({ code: 127, stdout, stderr: stderr || error.message });
			});
			child.on("close", (code) => {
				clearTimeout(timer);
				resolve({ code, stdout, stderr });
			});
		});
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
