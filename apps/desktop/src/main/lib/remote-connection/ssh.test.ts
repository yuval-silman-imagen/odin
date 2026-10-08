import { describe, expect, it } from "bun:test";
import {
	buildRemoteHealthProbe,
	buildRemoteStartCommand,
	buildTestCommand,
	FOLDER_OK_MARKER,
	NODE_OK_MARKER,
	parseTestOutput,
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
		organizationId: "remote",
		bundlePath: "/srv/odin/backend/host-service.js",
		migrationsDir: "/srv/odin/backend/host-migrations",
		hookPort: 51741,
		hookVersion: "2",
	};

	it("is a no-op when a healthy daemon already answers", () => {
		const command = buildRemoteStartCommand(config, startParams);
		expect(command).toContain("ODIN_ALREADY_RUNNING");
		expect(command.startsWith("if ")).toBe(true);
	});

	it("starts detached with the backend env inlined", () => {
		const command = buildRemoteStartCommand(config, startParams);
		expect(command).toContain(
			"setsid nohup node '/srv/odin/backend/host-service.js'",
		);
		expect(command).toContain("ODIN_HOME_DIR='/srv/odin'");
		expect(command).toContain("HOST_SERVICE_SECRET='s3cr3t'");
		expect(command).toContain("HOST_SERVICE_PORT='48000'");
		expect(command).toContain("< /dev/null &");
	});
});

describe("buildRemoteHealthProbe", () => {
	it("passes the secret via env, never on the argv", () => {
		const probe = buildRemoteHealthProbe(48000, "s3cr3t");
		expect(probe).toContain("ODIN_HEALTH_SECRET='s3cr3t'");
		expect(probe).toContain("process.env.ODIN_HEALTH_SECRET");
		expect(probe).toContain("statusCode===200");
	});
});
