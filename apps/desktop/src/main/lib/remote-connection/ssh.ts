import path from "node:path";
import type { RemoteConnectionConfig, TestConnectionResult } from "./types";

/** Markers the remote probe prints so we can parse its result unambiguously. */
export const FOLDER_OK_MARKER = "ODIN_FOLDER_OK";
export const NODE_OK_MARKER = "ODIN_NODE_OK";

/**
 * Single-quote a string for a POSIX shell: wrap in single quotes and escape any
 * embedded single quote as '\''. Safe for arbitrary paths run on the remote.
 */
export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
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
 * Packages the backend bundle loads from node_modules at runtime: the main
 * build's externals (runtime-dependencies.ts) that host-service reaches, plus
 * what it loads through createRequire (@xterm/headless in the terminal mode
 * tracker, the ACP adapter for sessions). Pinned to the app's own versions so
 * native ABIs match - ssh.test.ts checks them against the package.json files.
 */
export const REMOTE_RUNTIME_DEPS = [
	"better-sqlite3@12.6.2",
	"node-pty@1.2.0-beta.14",
	"@parcel/watcher@2.5.6",
	"mastracode@0.18.1",
	"@xterm/headless@6.1.0-beta.289",
	"@agentclientprotocol/claude-agent-acp@0.56.0",
];

export const ALREADY_RUNNING_MARKER = "ODIN_ALREADY_RUNNING";
export const STARTED_MARKER = "ODIN_STARTED";

/**
 * Collect the bundle entry files plus every chunk they load, transitively.
 * electron-vite code-splits the main build, so host-service.js is only a
 * shell that `require`s `./chunks/*.js` - shipping it alone fails on the
 * remote with "Cannot find module './chunks/...'". Chunk requires are always
 * emitted as literal relative `require("./x.js")` calls, so a scan is exact.
 * Returns paths relative to the bundle directory, POSIX-separated.
 */
export function collectBundleFiles(
	entries: string[],
	readFile: (relPath: string) => string | null,
): string[] {
	const seen = new Set<string>();
	const queue = [...entries];
	const relativeRequire = /require\("(\.\/[^"]+\.js)"\)/g;
	while (queue.length > 0) {
		const file = queue.shift() as string;
		if (seen.has(file)) continue;
		const source = readFile(file);
		if (source === null) continue;
		seen.add(file);
		const dir = path.posix.dirname(file);
		for (const match of source.matchAll(relativeRequire)) {
			queue.push(path.posix.normalize(path.posix.join(dir, match[1])));
		}
	}
	return [...seen].sort();
}

/**
 * Remote command that installs the backend's runtime npm deps when the set
 * differs from the last install. The marker holds the exact dep list, so a
 * new app version with a changed list reinstalls instead of trusting a stale
 * `.provisioned` file from an older one.
 */
export function buildProvisionCommand(
	backendDir: string,
	deps: string[],
): string {
	const marker = shellQuote(`${backendDir}/.provisioned`);
	const spec = deps.join(" ");
	// npm_config_libc=glibc: without it prebuild-install reports an empty libc
	// and misses the prebuilt binary, falling back to a source compile that
	// needs a full C/C++ toolchain.
	return [
		`if [ "$(cat ${marker} 2>/dev/null)" != ${shellQuote(spec)} ]; then`,
		`cd ${shellQuote(backendDir)}`,
		`&& printf '%s' '{"name":"odin-remote-backend","private":true}' > package.json`,
		`&& npm_config_libc=glibc npm install --no-audit --no-fund --loglevel=error ${deps.map(shellQuote).join(" ")}`,
		`&& printf '%s' ${shellQuote(spec)} > ${marker}; fi`,
	].join(" ");
}

/**
 * Remote command to ensure the backend is running, then exit.
 *
 * It adopts a daemon left running by an earlier connect (agents outlive the
 * laptop) only when it answers a health check with that daemon's own secret,
 * read from its manifest, AND it runs the bundle we just shipped. Otherwise
 * the old daemon - stale code, or a secret we can no longer present - is
 * stopped first so the new one can bind the port. Prints
 * {@link ALREADY_RUNNING_MARKER} or {@link STARTED_MARKER}; the caller uses
 * the matching secret. Env is inlined so we do not depend on the remote's
 * login profile.
 */
export function buildRemoteStartCommand(
	config: RemoteConnectionConfig,
	params: {
		secret: string;
		/** Secret and pid from the remote manifest of a previous daemon. */
		existing: { secret: string; pid: number } | null;
		/** Content hash of the shipped bundle; a change forces a restart. */
		bundleHash: string;
		organizationId: string;
		bundlePath: string;
		migrationsDir: string;
		hookPort: number;
		hookVersion: string;
		vitePort: number;
	},
): string {
	const folder = config.odinFolder;
	const manifestDir = `${folder}/host/${params.organizationId}`;
	const env = [
		`ODIN_HOME_DIR=${shellQuote(folder)}`,
		`ORGANIZATION_ID=${shellQuote(params.organizationId)}`,
		`HOST_SERVICE_SECRET=${shellQuote(params.secret)}`,
		`HOST_SERVICE_PORT=${shellQuote(String(config.remoteHostServicePort))}`,
		`HOST_DB_PATH=${shellQuote(`${manifestDir}/host.db`)}`,
		`HOST_MIGRATIONS_FOLDER=${shellQuote(params.migrationsDir)}`,
		// Required by the desktop host-service env schema (CORS allowlist).
		`DESKTOP_VITE_PORT=${shellQuote(String(params.vitePort))}`,
		`ODIN_AGENT_HOOK_PORT=${shellQuote(String(params.hookPort))}`,
		`ODIN_AGENT_HOOK_VERSION=${shellQuote(params.hookVersion)}`,
		"NODE_ENV=production",
	].join(" ");
	const stamp = shellQuote(`${folder}/backend/.running-bundle`);
	const hash = shellQuote(params.bundleHash);
	const log = shellQuote(`${folder}/host-service.log`);
	const start = [
		`cd ${shellQuote(folder)}`,
		`&& printf '%s' ${hash} > ${stamp}`,
		`&& { ${env} setsid nohup node ${shellQuote(params.bundlePath)} >> ${log} 2>&1 < /dev/null & }`,
		`&& echo ${STARTED_MARKER}`,
	].join(" ");
	if (!params.existing) return start;

	const { pid } = params.existing;
	const healthProbe = buildRemoteHealthProbe(
		config.remoteHostServicePort,
		params.existing.secret,
	);
	// Only signal the pid if it is still our node process (pids get reused),
	// then wait out its graceful shutdown so the port is free.
	const stopOld = [
		`if tr '\\0' ' ' < /proc/${pid}/cmdline 2>/dev/null | grep -qF -- ${shellQuote(params.bundlePath)}; then`,
		`kill ${pid} 2>/dev/null;`,
		`for i in $(seq 1 40); do kill -0 ${pid} 2>/dev/null || break; sleep 0.25; done;`,
		`kill -9 ${pid} 2>/dev/null; fi`,
	].join(" ");
	return `if [ "$(cat ${stamp} 2>/dev/null)" = ${hash} ] && ${healthProbe}; then echo ${ALREADY_RUNNING_MARKER}; else ${stopOld}; ${start}; fi`;
}

/**
 * A protected, cheap tRPC query. health.check is a publicProcedure and answers
 * 200 to any token, so it cannot tell whether we still hold the daemon's
 * secret; this one returns 401 when we do not.
 */
export const REMOTE_AUTH_PROBE_PATH = "/trpc/settings.branchPrefix.get";

/**
 * A `node -e` one-liner that exits 0 only when the local host-service answers
 * an authenticated query with 200 for this secret. Used remotely (over the
 * configured port) to decide whether the running daemon can be adopted. Node
 * is a hard prerequisite anyway.
 */
export function buildRemoteHealthProbe(port: number, secret: string): string {
	const script = [
		"const http=require('http');",
		`const r=http.get({host:'127.0.0.1',port:${port},path:'${REMOTE_AUTH_PROBE_PATH}',headers:{Authorization:'Bearer '+process.env.ODIN_HEALTH_SECRET},timeout:2000},`,
		"res=>process.exit(res.statusCode===200?0:1));",
		"r.on('error',()=>process.exit(1));r.on('timeout',()=>{r.destroy();process.exit(1)});",
	].join("");
	return `ODIN_HEALTH_SECRET=${shellQuote(secret)} node -e ${shellQuote(script)}`;
}
