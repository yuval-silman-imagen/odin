import type { RemoteConnectionConfig, TestConnectionResult } from "./types";

/** Seconds to wait for the SSH handshake before giving up on a probe. */
const SSH_CONNECT_TIMEOUT_SECONDS = 10;

/** Markers the remote probe prints so we can parse its result unambiguously. */
export const FOLDER_OK_MARKER = "ODIN_FOLDER_OK";
export const NODE_OK_MARKER = "ODIN_NODE_OK";

/**
 * Single-quote a string for a POSIX shell: wrap in single quotes and escape any
 * embedded single quote as '\''. Safe for arbitrary paths passed to the remote.
 */
export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function sshTarget(config: RemoteConnectionConfig): string {
	return `${config.username}@${config.host}`;
}

/**
 * The common `ssh`/`scp` options for a connection. `batch` disables password
 * prompts so a misconfigured key fails fast instead of hanging on a tty. The
 * `portFlag` differs between the two binaries (`-p` for ssh, `-P` for scp).
 */
export function sshOptionArgs(
	config: RemoteConnectionConfig,
	options: { batch?: boolean; portFlag?: "-p" | "-P" } = {},
): string[] {
	const { batch = true, portFlag = "-p" } = options;
	const args = [
		portFlag,
		String(config.sshPort),
		"-o",
		`ConnectTimeout=${SSH_CONNECT_TIMEOUT_SECONDS}`,
		"-o",
		"StrictHostKeyChecking=accept-new",
	];
	if (batch) args.push("-o", "BatchMode=yes");
	if (config.sshKeyPath) args.push("-i", config.sshKeyPath);
	return args;
}

/** Full argv for running a remote shell command over ssh. */
export function buildSshCommandArgs(
	config: RemoteConnectionConfig,
	remoteCommand: string,
): string[] {
	return [...sshOptionArgs(config), sshTarget(config), remoteCommand];
}

/** Full argv for the `-L` tunnel: forward a local port to the remote loopback. */
export function buildTunnelArgs(
	config: RemoteConnectionConfig,
	localPort: number,
): string[] {
	return [
		"-N",
		"-L",
		`${localPort}:127.0.0.1:${config.remoteHostServicePort}`,
		// Keep the tunnel from silently going dead on a dozing laptop's network.
		"-o",
		"ServerAliveInterval=15",
		"-o",
		"ServerAliveCountMax=3",
		...sshOptionArgs(config),
		sshTarget(config),
	];
}

/**
 * Remote probe for Test-connection: create the odin folder and report whether
 * Node is present. Prints stable markers the parser keys off.
 */
export function buildTestCommand(config: RemoteConnectionConfig): string {
	const folder = shellQuote(config.odinFolder);
	return [
		`mkdir -p ${folder} && printf '%s\\n' ${shellQuote(FOLDER_OK_MARKER)}`,
		`if command -v node >/dev/null 2>&1; then printf '%s %s\\n' ${shellQuote(NODE_OK_MARKER)} "$(node --version 2>/dev/null)"; fi`,
	].join("; ");
}

/** Parse the probe's stdout into a structured, UI-friendly result. */
export function parseTestOutput(
	stdout: string,
	reachable: boolean,
	errorText = "",
): TestConnectionResult {
	const folderReady = stdout.includes(FOLDER_OK_MARKER);
	const nodeLine = stdout
		.split("\n")
		.find((line) => line.startsWith(NODE_OK_MARKER));
	const nodeAvailable = Boolean(nodeLine);
	const nodeVersion = nodeLine
		? nodeLine.slice(NODE_OK_MARKER.length).trim() || null
		: null;

	if (!reachable) {
		return {
			ok: false,
			reachable: false,
			nodeAvailable: false,
			nodeVersion: null,
			folderReady: false,
			message: errorText.trim() || "Could not reach the host over SSH.",
		};
	}
	if (!nodeAvailable) {
		return {
			ok: false,
			reachable: true,
			nodeAvailable: false,
			nodeVersion: null,
			folderReady,
			message:
				"Connected, but Node.js was not found on the remote. Install Node 20 or newer.",
		};
	}
	return {
		ok: folderReady,
		reachable: true,
		nodeAvailable: true,
		nodeVersion,
		folderReady,
		message: folderReady
			? `Connected. Node ${nodeVersion ?? "(unknown version)"} found and the odin folder is ready.`
			: "Connected, but the odin folder could not be created.",
	};
}

/**
 * Remote command to ensure the backend is running, then exit. It is a no-op
 * when a healthy host-service already answers on the configured port, so a
 * reconnect re-adopts the daemon left running after the laptop closed rather
 * than starting a second one. Env is inlined so we do not depend on the
 * remote's login profile.
 */
export function buildRemoteStartCommand(
	config: RemoteConnectionConfig,
	params: {
		secret: string;
		organizationId: string;
		bundlePath: string;
		migrationsDir: string;
		hookPort: number;
		hookVersion: string;
	},
): string {
	const folder = config.odinFolder;
	const manifestDir = `${folder}/host/${params.organizationId}`;
	const env = [
		`ODIN_HOME_DIR=${shellQuote(folder)}`,
		`ORGANIZATION_ID=${shellQuote(params.organizationId)}`,
		`HOST_SERVICE_SECRET=${shellQuote(params.secret)}`,
		`HOST_SERVICE_PORT=${shellQuote(String(config.remoteHostServicePort))}`,
		`HOST_MANIFEST_DIR=${shellQuote(manifestDir)}`,
		`HOST_DB_PATH=${shellQuote(`${manifestDir}/host.db`)}`,
		`HOST_MIGRATIONS_FOLDER=${shellQuote(params.migrationsDir)}`,
		`ODIN_AGENT_HOOK_PORT=${shellQuote(String(params.hookPort))}`,
		`ODIN_AGENT_HOOK_VERSION=${shellQuote(params.hookVersion)}`,
		`NODE_ENV=production`,
	].join(" ");
	const healthProbe = buildRemoteHealthProbe(
		config.remoteHostServicePort,
		params.secret,
	);
	const log = shellQuote(`${folder}/host-service.log`);
	const start = `cd ${shellQuote(folder)} && ${env} setsid nohup node ${shellQuote(params.bundlePath)} >> ${log} 2>&1 < /dev/null & echo ODIN_STARTED`;
	return `if ${healthProbe}; then echo ODIN_ALREADY_RUNNING; else ${start}; fi`;
}

/**
 * A `node -e` one-liner that exits 0 only when the local host-service answers
 * `/trpc/health.check` with 200. Used remotely (over the configured port) to
 * decide whether the daemon already runs. Node is a hard prerequisite anyway.
 */
export function buildRemoteHealthProbe(port: number, secret: string): string {
	const script = [
		"const http=require('http');",
		`const r=http.get({host:'127.0.0.1',port:${port},path:'/trpc/health.check',headers:{Authorization:'Bearer '+process.env.ODIN_HEALTH_SECRET},timeout:2000},`,
		"res=>process.exit(res.statusCode===200?0:1));",
		"r.on('error',()=>process.exit(1));r.on('timeout',()=>{r.destroy();process.exit(1)});",
	].join("");
	return `ODIN_HEALTH_SECRET=${shellQuote(secret)} node -e ${shellQuote(script)}`;
}
