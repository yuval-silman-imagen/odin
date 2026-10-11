import { describe, expect, it } from "bun:test";
import hostServicePackage from "../../../../../../packages/host-service/package.json";
import desktopPackage from "../../../../package.json";
import {
	ALREADY_RUNNING_MARKER,
	buildProvisionCommand,
	buildRemoteHealthProbe,
	buildRemoteStartCommand,
	buildTestCommand,
	collectBundleFiles,
	FOLDER_OK_MARKER,
	NODE_OK_MARKER,
	parseTestOutput,
	REMOTE_RUNTIME_DEPS,
	STARTED_MARKER,
	shellQuote,
} from "./ssh";
import type { RemoteConnectionConfig } from "./types";

const config: RemoteConnectionConfig = {
	id: "conn-1",
	name: "Build box",
	host: "10.0.0.42",
	sshPort: 2222,
	username: "ubuntu",
	authMethod: "key",
	sshKeyPath: "/home/me/.ssh/id_ed25519",
	password: null,
	odinFolder: "/srv/odin",
	remoteHostServicePort: 48000,
};

describe("shellQuote", () => {
	it("wraps a plain value in single quotes", () => {
		expect(shellQuote("/srv/odin")).toBe("'/srv/odin'");
	});

	it("escapes embedded single quotes so injection is impossible", () => {
		expect(shellQuote("a'b")).toBe("'a'\\''b'");
		// A quote-and-command attempt stays inside the quoting.
		expect(shellQuote("x'; rm -rf /")).toBe("'x'\\''; rm -rf /'");
	});
});

describe("buildTestCommand + parseTestOutput", () => {
	it("creates the folder and probes for node", () => {
		const command = buildTestCommand(config);
		expect(command).toContain("mkdir -p '/srv/odin'");
		expect(command).toContain("command -v node");
	});

	it("parses a fully healthy probe", () => {
		const stdout = `${FOLDER_OK_MARKER}\n${NODE_OK_MARKER} v20.11.1\n`;
		const result = parseTestOutput(stdout, true);
		expect(result).toMatchObject({
			ok: true,
			reachable: true,
			nodeAvailable: true,
			nodeVersion: "v20.11.1",
			folderReady: true,
		});
	});

	it("reports node missing even when the folder is ready", () => {
		const result = parseTestOutput(`${FOLDER_OK_MARKER}\n`, true);
		expect(result.ok).toBe(false);
		expect(result.nodeAvailable).toBe(false);
		expect(result.folderReady).toBe(true);
		expect(result.message).toContain("Node");
	});

	it("reports unreachable with the error text when ssh failed", () => {
		const result = parseTestOutput(
			"",
			false,
			"All configured authentication methods failed",
		);
		expect(result.ok).toBe(false);
		expect(result.reachable).toBe(false);
		expect(result.message).toContain("authentication");
	});
});

describe("buildRemoteStartCommand", () => {
	const startParams = {
		secret: "s3cr3t",
		existing: null,
		bundleHash: "abc123",
		organizationId: "remote",
		bundlePath: "/srv/odin/backend/host-service.js",
		migrationsDir: "/srv/odin/backend/host-migrations",
		hookPort: 51741,
		hookVersion: "2",
		vitePort: 5173,
	};

	it("starts detached with the backend env inlined", () => {
		const command = buildRemoteStartCommand(config, startParams);
		expect(command).toContain(
			"setsid nohup node '/srv/odin/backend/host-service.js'",
		);
		expect(command).toContain("ODIN_HOME_DIR='/srv/odin'");
		expect(command).toContain("HOST_SERVICE_SECRET='s3cr3t'");
		expect(command).toContain("HOST_SERVICE_PORT='48000'");
		expect(command).toContain("< /dev/null &");
		expect(command).toContain(STARTED_MARKER);
	});

	it("passes every var the desktop host-service env schema requires", () => {
		const command = buildRemoteStartCommand(config, startParams);
		for (const name of [
			"HOST_DB_PATH",
			"HOST_MIGRATIONS_FOLDER",
			"HOST_SERVICE_SECRET",
			"HOST_SERVICE_PORT",
			"ORGANIZATION_ID",
			"DESKTOP_VITE_PORT",
		]) {
			expect(command).toContain(`${name}=`);
		}
	});

	it("records the bundle hash it started", () => {
		const command = buildRemoteStartCommand(config, startParams);
		expect(command).toContain(
			"printf '%s' 'abc123' > '/srv/odin/backend/.running-bundle'",
		);
	});

	it("starts without probing when no previous daemon is known", () => {
		const command = buildRemoteStartCommand(config, startParams);
		expect(command).not.toContain(ALREADY_RUNNING_MARKER);
		expect(command).not.toContain("kill");
	});

	it("adopts a previous daemon only on the same bundle and its own secret", () => {
		const command = buildRemoteStartCommand(config, {
			...startParams,
			existing: { secret: "old-secret", pid: 4242 },
		});
		expect(
			command.startsWith("if [ \"$(cat '/srv/odin/backend/.running-bundle'"),
		).toBe(true);
		expect(command).toContain("= 'abc123' ] &&");
		expect(command).toContain("ODIN_HEALTH_SECRET='old-secret'");
		expect(command).toContain(ALREADY_RUNNING_MARKER);
	});

	it("stops the previous daemon, by verified pid, before starting anew", () => {
		const command = buildRemoteStartCommand(config, {
			...startParams,
			existing: { secret: "old-secret", pid: 4242 },
		});
		const elseBranch = command.slice(command.indexOf("; else "));
		expect(elseBranch).toContain("/proc/4242/cmdline");
		expect(elseBranch).toContain(
			"grep -qF -- '/srv/odin/backend/host-service.js'",
		);
		expect(elseBranch.indexOf("kill 4242")).toBeLessThan(
			elseBranch.indexOf("setsid"),
		);
		expect(elseBranch).toContain("HOST_SERVICE_SECRET='s3cr3t'");
	});
});

describe("collectBundleFiles", () => {
	const files: Record<string, string> = {
		"host-service.js": `const a = require("./chunks/a-1.js");\nconst http = require("node:http");`,
		"host-worker.js": `require("./chunks/b-2.js");`,
		"chunks/a-1.js": `require("./shared-3.js"); require("better-sqlite3");`,
		"chunks/b-2.js": `require("./shared-3.js");`,
		"chunks/shared-3.js": `Promise.resolve().then(() => require("./lazy-4.js"));`,
		"chunks/lazy-4.js": "module.exports = 1;",
		"chunks/unused-5.js": "module.exports = 2;",
	};
	const read = (rel: string) => files[rel] ?? null;

	it("follows chunk requires transitively, relative to each file", () => {
		expect(
			collectBundleFiles(["host-service.js", "host-worker.js"], read),
		).toEqual([
			"chunks/a-1.js",
			"chunks/b-2.js",
			"chunks/lazy-4.js",
			"chunks/shared-3.js",
			"host-service.js",
			"host-worker.js",
		]);
	});

	it("skips missing entries instead of throwing", () => {
		expect(collectBundleFiles(["pty-daemon.js"], read)).toEqual([]);
	});
});

describe("buildProvisionCommand", () => {
	it("reinstalls when the marker does not hold this exact dep list", () => {
		const command = buildProvisionCommand("/srv/odin/backend", [
			"a@1",
			"@b/c@2",
		]);
		expect(command).toContain(
			"if [ \"$(cat '/srv/odin/backend/.provisioned' 2>/dev/null)\" != 'a@1 @b/c@2' ]",
		);
		expect(command).toContain(
			"npm install --no-audit --no-fund --loglevel=error 'a@1' '@b/c@2'",
		);
		expect(command).toContain(
			"printf '%s' 'a@1 @b/c@2' > '/srv/odin/backend/.provisioned'",
		);
	});
});

describe("REMOTE_RUNTIME_DEPS", () => {
	it("pins each package to the version the app itself bundles against", () => {
		const declared: Record<string, string> = {
			...hostServicePackage.dependencies,
			...desktopPackage.dependencies,
		};
		for (const spec of REMOTE_RUNTIME_DEPS) {
			const at = spec.lastIndexOf("@");
			const name = spec.slice(0, at);
			expect(`${name}@${declared[name]}`).toBe(spec);
		}
	});
});

describe("buildRemoteHealthProbe", () => {
	it("passes the secret via env, never on the argv", () => {
		const probe = buildRemoteHealthProbe(48000, "s3cr3t");
		expect(probe).toContain("ODIN_HEALTH_SECRET='s3cr3t'");
		expect(probe).toContain("process.env.ODIN_HEALTH_SECRET");
		expect(probe).toContain("statusCode===200");
	});

	it("probes an authenticated route, not the public health check", () => {
		const probe = buildRemoteHealthProbe(48000, "s3cr3t");
		expect(probe).toContain("/trpc/settings.branchPrefix.get");
		expect(probe).not.toContain("health.check");
	});
});
