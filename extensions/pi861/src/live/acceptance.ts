import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { digest } from "../memory.ts";
import { record } from "../search.ts";
import type { CheckCommand } from "./workspace.ts";

const execute = promisify(execFile);
export interface AcceptanceCheck extends CheckCommand {
	kind: "structural-check" | "behavioral-check";
	reporter: "exit" | "tap";
}
export interface AcceptanceConfig {
	workspace: string;
	checks: AcceptanceCheck[];
	expectedCommit?: string;
}
export interface TestCounts {
	tests: number;
	passed: number;
	failed: number;
	skipped: number;
	cancelled: number;
	todo: number;
}
export interface CheckEvidence {
	id: string;
	kind: AcceptanceCheck["kind"];
	command: string;
	args: string[];
	environmentNames: string[];
	exitCode: number | null;
	termination: "exited" | "timeout" | "cancelled" | "spawn-error" | "output-limit";
	status: "passed" | "failed" | "incomplete";
	counts: TestCounts | null;
	durationMs: number;
	stdout: string;
	stderr: string;
	commandDigest: string;
	evidence: string;
}
export interface AcceptanceReport {
	version: 1;
	codeSha: string;
	workspace: string;
	workspaceDigest: string;
	workspaceChanged: boolean;
	environment: { node: string; platform: string; arch: string };
	startedAt: string;
	status: "passed" | "failed" | "incomplete";
	checks: CheckEvidence[];
	/** Automated checks never substitute for the independent reviewer. */
	independentReview: "not-performed";
}

/** Only trusted configuration may call this parser; accepting JSON is not authorization to execute it. */
export function parseAcceptanceConfig(input: unknown): AcceptanceConfig {
	const root = record(input);
	if (
		!root ||
		typeof root.workspace !== "string" ||
		!isAbsolute(root.workspace) ||
		!Array.isArray(root.checks) ||
		!root.checks.length ||
		root.checks.length > 100
	)
		throw new Error("Acceptance requires an absolute artifact workspace and bounded checks");
	if (
		root.expectedCommit !== undefined &&
		(typeof root.expectedCommit !== "string" || !/^[a-f0-9]{40,64}$/.test(root.expectedCommit))
	)
		throw new Error("Invalid expected commit");
	const ids = new Set<string>();
	const checks: AcceptanceCheck[] = root.checks.map((raw: unknown) => {
		const item = record(raw);
		if (
			!item ||
			typeof item.id !== "string" ||
			!/^[\w.-]{1,100}$/.test(item.id) ||
			ids.has(item.id) ||
			typeof item.command !== "string" ||
			!item.command ||
			!Array.isArray(item.args) ||
			!item.args.every((arg: unknown) => typeof arg === "string") ||
			(item.kind !== "structural-check" && item.kind !== "behavioral-check") ||
			(item.reporter !== "exit" && item.reporter !== "tap")
		)
			throw new Error("Invalid acceptance check");
		const timeoutMs = item.timeoutMs ?? 120_000;
		if (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000)
			throw new Error("Invalid check timeout");
		const env: Record<string, string> = {};
		if (item.env !== undefined) {
			const entries = record(item.env);
			if (!entries) throw new Error("Invalid check environment");
			for (const [key, value] of Object.entries(entries)) {
				if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string")
					throw new Error("Invalid check environment");
				env[key] = value;
			}
		}
		ids.add(item.id);
		return {
			id: item.id,
			command: item.command,
			args: item.args,
			timeoutMs,
			env,
			kind: item.kind,
			reporter: item.reporter,
		};
	});
	return {
		workspace: root.workspace,
		checks,
		expectedCommit: typeof root.expectedCommit === "string" ? root.expectedCommit : undefined,
	};
}

async function snapshot(workspace: string): Promise<{ sha: string; hash: string }> {
	const sha = (await execute("git", ["rev-parse", "HEAD"], { cwd: workspace })).stdout.trim();
	const paths = (
		await execute("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
			cwd: workspace,
			maxBuffer: 16_777_216,
		})
	).stdout
		.split("\0")
		.filter(Boolean);
	const hash = createHash("sha256");
	hash.update(sha);
	for (const path of [...new Set(paths)].sort()) {
		hash.update(path);
		hash.update("\0");
		try {
			const full = join(workspace, path),
				stat = lstatSync(full);
			hash.update(String(stat.mode));
			hash.update(stat.isSymbolicLink() ? readlinkSync(full) : stat.isFile() ? readFileSync(full) : "[directory]");
		} catch (error) {
			if (record(error)?.code === "ENOENT") hash.update("[deleted]");
			else throw error;
		}
		hash.update("\0");
	}
	return { sha, hash: hash.digest("hex") };
}

function tapCounts(output: string): TestCounts | null {
	const values = new Map<string, number>();
	for (const match of output.matchAll(/^# (tests|pass|fail|cancelled|skipped|todo) (\d+)\s*$/gm))
		values.set(match[1] ?? "", Number(match[2]));
	if (["tests", "pass", "fail", "cancelled", "skipped", "todo"].some((key) => !values.has(key))) return null;
	const counts = {
		tests: values.get("tests") ?? 0,
		passed: values.get("pass") ?? 0,
		failed: values.get("fail") ?? 0,
		skipped: values.get("skipped") ?? 0,
		cancelled: values.get("cancelled") ?? 0,
		todo: values.get("todo") ?? 0,
	};
	return Object.values(counts).every(Number.isSafeInteger) &&
		counts.tests === counts.passed + counts.failed + counts.skipped + counts.cancelled + counts.todo
		? counts
		: null;
}

export async function runAcceptance(rawConfig: AcceptanceConfig, signal?: AbortSignal): Promise<AcceptanceReport> {
	const config = parseAcceptanceConfig(rawConfig),
		before = await snapshot(config.workspace);
	if (config.expectedCommit && config.expectedCommit !== before.sha)
		throw new Error("Artifact commit does not match the required implementation base");
	const checks: CheckEvidence[] = [],
		startedAt = new Date().toISOString();
	for (const check of config.checks) {
		const started = performance.now();
		const env = {
			PATH: process.env.PATH,
			SystemRoot: process.env.SystemRoot,
			PI861_WORKSPACE: config.workspace,
			...check.env,
		};
		const hidden = Object.values(check.env ?? {})
			.filter(Boolean)
			.sort((a, b) => b.length - a.length);
		const redact = (text: string): string => {
			let safe = text;
			for (const value of hidden) safe = safe.split(value).join("[redacted]");
			return safe
				.replace(/(Bearer\s+)[^\s"']+/gi, "$1[redacted]")
				.replace(/((?:password|api[_-]?key|token|secret)\s*[:=]\s*)[^\s"']+/gi, "$1[redacted]");
		};
		let stdout = "",
			stderr = "",
			exitCode: number | null = null;
		let termination: CheckEvidence["termination"] = "exited";
		try {
			signal?.throwIfAborted();
			const output = await execute(check.command, check.args, {
				cwd: config.workspace,
				env,
				signal,
				timeout: check.timeoutMs,
				maxBuffer: 4_194_304,
				windowsHide: true,
			});
			stdout = output.stdout;
			stderr = output.stderr;
			exitCode = 0;
		} catch (error) {
			const details = record(error);
			stdout = typeof details?.stdout === "string" ? details.stdout : "";
			stderr = typeof details?.stderr === "string" ? details.stderr : "";
			exitCode = typeof details?.code === "number" ? details.code : null;
			termination = signal?.aborted
				? "cancelled"
				: details?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
					? "output-limit"
					: details?.killed === true
						? "timeout"
						: exitCode === null
							? "spawn-error"
							: "exited";
		}
		const counts = check.reporter === "tap" ? tapCounts(stdout) : null;
		const status =
			exitCode !== 0 || termination !== "exited" || (counts && (counts.failed || counts.cancelled))
				? "failed"
				: check.reporter === "tap" && (!counts || !counts.tests || counts.skipped || counts.todo)
					? "incomplete"
					: "passed";
		stdout = redact(stdout);
		stderr = redact(stderr);
		checks.push({
			id: check.id,
			kind: check.kind,
			command: redact(check.command),
			args: check.args.map(redact),
			environmentNames: Object.keys(env).sort(),
			exitCode,
			termination,
			status,
			counts,
			durationMs: Math.round(performance.now() - started),
			stdout,
			stderr,
			commandDigest: digest([check.command, check.args, check.env ?? {}]),
			evidence: `check:${check.id}:${status}:sha256:${digest({ stdout, stderr })}`,
		});
		if (signal?.aborted) break;
	}
	const after = await snapshot(config.workspace),
		workspaceChanged = before.hash !== after.hash;
	return {
		version: 1,
		codeSha: before.sha,
		workspace: config.workspace,
		workspaceDigest: before.hash,
		workspaceChanged,
		environment: { node: process.version, platform: process.platform, arch: process.arch },
		startedAt,
		status:
			workspaceChanged || checks.some((check) => check.status === "failed")
				? "failed"
				: checks.length !== config.checks.length || checks.some((check) => check.status !== "passed")
					? "incomplete"
					: "passed",
		checks,
		independentReview: "not-performed",
	};
}
