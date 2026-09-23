import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import type { ProcessSpec } from "./line-process.ts";

const execute = promisify(execFile);

/**
 * P2-W Linux OCI container execution adapter (continuation plan section 4, "Worker隔离"; R3.8).
 *
 * The worker SERVICE remains a trusted host process (container management is done by the trusted
 * host); only the model-driven task process runs inside a Linux OCI container with:
 *   - a non-root uid:gid (uid 0 is rejected),
 *   - every Linux capability dropped and no-new-privileges,
 *   - a read-only root filesystem; /tmp is a noexec,nosuid tmpfs; ONLY the task workspace is
 *     mounted writable,
 *   - no host credential, home or container-socket mounts (deny-listed; extra mounts are read-only),
 *   - memory, CPU and pid limits,
 *   - network "none" (v1 has no approved-network expansion; that requires a plan update).
 *
 * Host-side git operations, trusted check commands and durable state stay OUTSIDE the container.
 * Trusted-local mode (config without isolation.container) is a separate, explicitly declared
 * mode with no OS sandbox; it must never be reported as isolated (R5.11).
 */

export interface ContainerMount {
	host: string;
	container: string;
}

export interface ContainerExecutionOptions {
	/** OCI image reference. Must already exist in the local daemon image store. */
	image: string;
	/** Non-root "uid:gid" for the task process. */
	userId: string;
	/** Only "none" is accepted in v1. */
	network: string;
	memoryBytes: number;
	cpus: number;
	pidsLimit: number;
	tmpfsBytes: number;
	/** Extra read-only mounts (fixture programs, pinned CLI installs). Never credentials. */
	mounts: ContainerMount[];
	/** Exact env names or "PREFIX_*" patterns copied from the worker process env. */
	envAllowlist: string[];
	/** Unique per-deployment container name prefix. */
	namePrefix: string;
}

export interface ContainerProbe {
	serverOs: string;
	serverVersion: string;
	imageId: string;
}

const CREDENTIAL_SEGMENTS = [".docker", ".ssh", ".aws", ".gnupg", ".kube", ".config"];
const FORBIDDEN_CONTAINER_PATHS = ["/var/run/docker.sock", "/run/docker.sock", "/var/run/crio.sock", "/run/containers"];

function fail(message: string): never {
	throw new Error(`Container isolation config: ${message}`);
}

function absoluteString(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim()) fail(`${field} must be a non-empty string`);
	const trimmed = value.trim();
	if (!isAbsolute(trimmed)) fail(`${field} must be an absolute path`);
	return trimmed;
}

function boundedInteger(value: unknown, field: string, minimum: number, maximum: number): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum)
		fail(`${field} must be an integer between ${minimum} and ${maximum}`);
	return value;
}

function envPattern(value: unknown): string {
	if (typeof value !== "string" || !value.trim()) fail("envAllowlist entries must be non-empty strings");
	const trimmed = value.trim();
	const pattern = trimmed.endsWith("*") ? trimmed.slice(0, -1) : trimmed;
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(pattern)) fail(`Invalid env allowlist entry: ${trimmed}`);
	return trimmed;
}

function posixAbsolute(value: string): boolean {
	return value.startsWith("/") && !value.includes("\\") && !value.split("/").includes("..");
}

/**
 * Parses and validates the trusted `isolation.container` config section. Identity and capabilities
 * come only from this operator-owned file, never from requests.
 */
export function parseContainerExecutionOptions(
	raw: unknown,
	tokenEnv: string,
	defaults: { namePrefix: string },
): ContainerExecutionOptions {
	if (!raw || typeof raw !== "object") fail("container section must be an object when mode is container");
	const value = raw as Record<string, unknown>;
	const image = typeof value.image === "string" ? value.image.trim() : "";
	if (!image || /[\s"']/.test(image)) fail("image must be a local OCI image reference");
	const userId = typeof value.userId === "string" ? value.userId.trim() : "1000:1000";
	if (!/^\d+:\d+$/.test(userId)) fail('userId must be numeric "uid:gid"');
	if (userId.startsWith("0:")) fail("container task processes must not run as root");
	const network = typeof value.network === "string" ? value.network.trim() : "none";
	if (network !== "none") fail('network must be "none" in v1; approved networks require a plan update');
	const mounts: ContainerMount[] = [];
	const seenContainer = new Set<string>();
	if (value.mounts !== undefined) {
		if (!Array.isArray(value.mounts)) fail("mounts must be a list");
		for (const item of value.mounts) {
			if (!item || typeof item !== "object") fail("each mount must be an object");
			const mount = item as Record<string, unknown>;
			const host = absoluteString(mount.host, "mount.host");
			const container = typeof mount.container === "string" ? mount.container.trim() : "";
			if (!posixAbsolute(container)) fail(`mount.container must be an absolute container path: ${container}`);
			if (container === "/workspace" || container.startsWith("/workspace/"))
				fail("mount.container must not overlap /workspace");
			if (FORBIDDEN_CONTAINER_PATHS.some((path) => container === path || container.startsWith(`${path}/`)))
				fail(`Forbidden container mount path: ${container}`);
			if (container.endsWith("docker.sock")) fail("Container runtime sockets cannot be mounted");
			if (seenContainer.has(container)) fail(`Duplicate container mount path: ${container}`);
			seenContainer.add(container);
			const segments = host.split(/[\\/]/).map((segment) => segment.toLowerCase());
			if (segments.some((segment) => CREDENTIAL_SEGMENTS.includes(segment)))
				fail(`Host credential directories cannot be mounted: ${host}`);
			mounts.push({ host, container });
		}
	}
	const envAllowlist: string[] = [];
	if (value.envAllowlist !== undefined) {
		if (!Array.isArray(value.envAllowlist)) fail("envAllowlist must be a list");
		for (const item of value.envAllowlist) {
			const pattern = envPattern(item);
			if (pattern === tokenEnv || (pattern.endsWith("*") && tokenEnv.startsWith(pattern)))
				fail("The worker bearer token env must never be passed into the container");
			envAllowlist.push(pattern);
		}
	}
	const namePrefix = typeof value.namePrefix === "string" && value.namePrefix.trim()
		? value.namePrefix.trim()
		: defaults.namePrefix;
	if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(namePrefix)) fail("namePrefix must be a short lowercase slug");
	return {
		image,
		userId,
		network,
		memoryBytes: boundedInteger(value.memoryBytes ?? 536_870_912, "memoryBytes", 33_554_432, 8_589_934_592),
		cpus:
			typeof value.cpus === "number"
				? boundedInteger(value.cpus * 10, "cpus*10", 1, 160) / 10
				: 1,
		pidsLimit: boundedInteger(value.pidsLimit ?? 64, "pidsLimit", 16, 1024),
		tmpfsBytes: boundedInteger(value.tmpfsBytes ?? 67_108_864, "tmpfsBytes", 1_048_576, 1_073_741_824),
		mounts,
		envAllowlist,
		namePrefix,
	};
}

/** Startup probe: the daemon must be reachable, Linux and hold the image locally. Fails closed. */
export async function probeContainerRuntime(
	options: ContainerExecutionOptions,
	dockerCommand = "docker",
	timeoutMs = 20_000,
): Promise<ContainerProbe> {
	let serverOs = "",
		serverVersion = "";
	try {
		const version = await execute(
			dockerCommand,
			["version", "--format", "{{.Server.Os}} {{.Server.Version}}"],
			{ timeout: timeoutMs, maxBuffer: 65_536 },
		);
		const parts = version.stdout.trim().split(/\s+/);
		serverOs = parts[0] ?? "";
		serverVersion = parts[1] ?? "";
	} catch (error) {
		fail(`OCI runtime not reachable (${error instanceof Error ? error.message : "unknown"})`);
	}
	if (serverOs !== "linux")
		fail(`Linux OCI containers required; daemon reports "${serverOs}". R3.8 stays blocked without it`);
	let imageId = "";
	try {
		const inspect = await execute(dockerCommand, ["image", "inspect", options.image, "--format", "{{.Id}}"], {
			timeout: timeoutMs,
			maxBuffer: 65_536,
		});
		imageId = inspect.stdout.trim();
	} catch (error) {
		fail(
			`Image ${options.image} is not available locally (${error instanceof Error ? error.message : "unknown"}); ` +
				"pulling at runtime is not authorized",
		);
	}
	return { serverOs, serverVersion, imageId };
}

function allowlistedEnv(
	allowlist: readonly string[],
	env: NodeJS.ProcessEnv,
): Record<string, string> {
	const passed: Record<string, string> = {};
	for (const entry of allowlist) {
		if (entry.endsWith("*")) {
			const prefix = entry.slice(0, -1);
			for (const [key, value] of Object.entries(env))
				if (key.startsWith(prefix) && typeof value === "string" && !(key in passed)) passed[key] = value;
		} else if (typeof env[entry] === "string") passed[entry] = env[entry] as string;
	}
	return passed;
}

export interface ContainerTaskSpec {
	/** Command inside the container viewport, e.g. "node". */
	command: string;
	/** Args inside the container viewport, using container paths. */
	args: string[];
	/** Host-side absolute workspace path; mounted writable at /workspace. */
	workspaceHostPath: string;
}

export interface ContainerLaunch {
	spec: ProcessSpec;
	containerName: string;
}

/**
 * Translates a container-viewport task spec into a host-side `docker run` ProcessSpec for
 * LineProcess. stdin/stdout stay attached ("-i"), so the RPC protocol passes through unchanged.
 */
export function containerLaunch(
	task: ContainerTaskSpec,
	options: ContainerExecutionOptions,
	env: NodeJS.ProcessEnv,
	uniqueId = randomUUID().slice(0, 12),
): ContainerLaunch {
	if (!task.command.trim() || !task.args.every((arg) => typeof arg === "string"))
		fail("container task needs a command and string args");
	const workspace = absoluteString(task.workspaceHostPath, "workspaceHostPath");
	const containerName = `${options.namePrefix}-${uniqueId}`;
	const args = [
		"run",
		"--rm",
		"-i",
		"--name",
		containerName,
		"--network",
		options.network,
		"--user",
		options.userId,
		"--cap-drop",
		"ALL",
		"--security-opt",
		"no-new-privileges",
		"--read-only",
		"--tmpfs",
		`/tmp:rw,noexec,nosuid,size=${options.tmpfsBytes}`,
		"--memory",
		String(options.memoryBytes),
		"--cpus",
		String(options.cpus),
		"--pids-limit",
		String(options.pidsLimit),
		"--stop-timeout",
		"5",
		"-v",
		`${workspace}:/workspace:rw`,
	];
	for (const mount of options.mounts) args.push("-v", `${mount.host}:${mount.container}:ro`);
	args.push("-w", "/workspace");
	for (const [key, value] of Object.entries(allowlistedEnv(options.envAllowlist, env)))
		args.push("-e", `${key}=${value}`);
	args.push(options.image, task.command, ...task.args);
	return { spec: { command: "docker", args, cwd: workspace }, containerName };
}

/** Best-effort cleanup after a session ends; a crashed client must not leak its container. */
export async function forceRemoveContainer(containerName: string, dockerCommand = "docker"): Promise<void> {
	await execute(dockerCommand, ["rm", "-f", containerName], { timeout: 15_000, maxBuffer: 65_536 }).catch(() => {});
}
