import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type { CheckOutcome } from "../contracts/acceptance.ts";
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
	/** C7 outcome vocabulary: only pass satisfies; skip/not-run/blocked never do. */
	outcome: CheckOutcome;
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
	outcomes: Record<CheckOutcome, number>;
	checks: CheckEvidence[];
	/** Automated checks never substitute for the independent reviewer. */
	independentReview: "not-performed";
}

const TEST_SUMMARY_KEYS = ["tests", "pass", "fail", "cancelled", "skipped", "todo"];

/**
 * Parses node:test summaries for both reporters: `# tests 3` (tap) and `ℹ tests 3` (spec).
 * Returns null when no complete summary is present; callers must treat null as
 * "no proof that any test executed" for behavioral evidence.
 */
export function parseTestCounts(output: string): TestCounts | null {
	const values = new Map<string, number>();
	for (const match of output.matchAll(/^[ \t]*(?:#|ℹ)[ \t]*(tests|pass|fail|cancelled|skipped|todo)[ \t]+(\d+)[ \t]*$/gm))
		values.set(match[1] ?? "", Number(match[2] ?? "0"));
	if (TEST_SUMMARY_KEYS.some((key) => !values.has(key))) return null;
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

/**
 * Honest status for one check under any reporter. Test counts are parsed the same way for
 * "exit" and "tap"; the exit reporter no longer accepts exit code 0 alone as proof that a
 * test suite ran. Only structural checks without a test suite (compilers, linters, presence
 * probes) may pass on exit code 0 alone, because their oracle is the exit code itself.
 */
function checkOutcome(
	check: Pick<AcceptanceCheck, "kind" | "reporter">,
	exitCode: number | null,
	termination: CheckEvidence["termination"],
	counts: TestCounts | null,
): { status: CheckEvidence["status"]; outcome: CheckOutcome } {
	if (termination !== "exited") return { status: "failed", outcome: "blocked" };
	if (exitCode !== 0) return { status: "failed", outcome: "fail" };
	if (counts) {
		if (counts.failed > 0 || counts.cancelled > 0) return { status: "failed", outcome: "fail" };
		if (counts.skipped > 0 || counts.todo > 0) return { status: "incomplete", outcome: "skip" };
		if (counts.tests === 0) return { status: "incomplete", outcome: "not-run" };
		return { status: "passed", outcome: "pass" };
	}
	return check.reporter === "tap" || check.kind === "behavioral-check"
		? { status: "incomplete", outcome: "not-run" }
		: { status: "passed", outcome: "pass" };
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
				// Real-service opt-ins are set only by the operator running scripts/real-acceptance/*
				// directly; they can never be armed through acceptance configs or suite manifests.
				// Case-insensitive: environment-variable lookup on Windows ignores case, so a
				// lowercase spelling would still reach the child as the real opt-in (review-1 D3r).
				if (/^PI861_REAL_/i.test(key))
					throw new Error("Real-service authorization variables cannot be passed through acceptance configuration");
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

export type AcceptanceSuite = "unit" | "hosts" | "pg17" | "mcp" | "web" | "workers" | "ax" | "local";
function isAcceptanceSuite(value: unknown): value is AcceptanceSuite {
	return (
		value === "unit" ||
		value === "hosts" ||
		value === "pg17" ||
		value === "mcp" ||
		value === "web" ||
		value === "workers" ||
		value === "ax" ||
		value === "local"
	);
}
const MANIFEST_FIELDS = [
	"version",
	"suite",
	"workspace",
	"expectedCommit",
	"requiredChecks",
	"environmentNames",
	"checks",
	"workerPairEvidence",
];
export interface AcceptanceManifest {
	version: 1;
	suite: AcceptanceSuite;
	workspace: string;
	expectedCommit?: string;
	requiredChecks: string[];
	environmentNames: string[];
	checks: AcceptanceCheck[];
	workerPairEvidence?: string;
}

/**
 * Trusted suite manifest for the acceptance runner. Required fields must be present and
 * correct; missing fields, unknown fields and unknown suites are rejected so a partial or
 * smuggled manifest can never reach execution.
 */
export function parseAcceptanceManifest(input: unknown): AcceptanceManifest {
	const root = record(input);
	if (!root) throw new Error("Acceptance manifest must be an object");
	for (const key of Object.keys(root))
		if (!MANIFEST_FIELDS.includes(key)) throw new Error(`Unknown acceptance manifest field: ${key}`);
	if (root.version !== 1) throw new Error("Acceptance manifest requires version 1");
	if (!isAcceptanceSuite(root.suite)) throw new Error("Acceptance manifest requires a known suite");
	if (typeof root.workspace !== "string" || !isAbsolute(root.workspace))
		throw new Error("Acceptance manifest requires an absolute workspace");
	if (
		!Array.isArray(root.requiredChecks) ||
		!root.requiredChecks.length ||
		root.requiredChecks.some((id: unknown) => typeof id !== "string" || !/^[\w.-]{1,100}$/.test(id)) ||
		new Set(root.requiredChecks).size !== root.requiredChecks.length
	)
		throw new Error("Acceptance manifest requires non-empty unique required check ids");
	if (
		!Array.isArray(root.environmentNames) ||
		root.environmentNames.some((name: unknown) => typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
	)
		throw new Error("Acceptance manifest requires environmentNames to be a list of variable names");
	// Case-insensitive for the same reason as check.env keys (review-1 D3r): process.env lookup
	// on Windows is case-insensitive, so a lowercase name would still pass through the value.
	if (root.environmentNames.some((name: string) => /^PI861_REAL_/i.test(name)))
		throw new Error("Real-service authorization variables cannot be passed through suite manifests");
	const config = parseAcceptanceConfig({
		workspace: root.workspace,
		checks: root.checks,
		expectedCommit: root.expectedCommit,
	});
	const known = new Set(config.checks.map((check) => check.id));
	for (const id of root.requiredChecks)
		if (!known.has(id)) throw new Error(`Required check is not defined in the manifest: ${id}`);
	if (
		root.workerPairEvidence !== undefined &&
		(typeof root.workerPairEvidence !== "string" || !isAbsolute(root.workerPairEvidence))
	)
		throw new Error("Acceptance manifest worker pair evidence must be an absolute path");
	if (root.suite === "workers" && typeof root.workerPairEvidence !== "string")
		throw new Error("The workers suite requires worker pair evidence");
	return {
		version: 1,
		suite: root.suite,
		workspace: config.workspace,
		expectedCommit: config.expectedCommit,
		requiredChecks: [...root.requiredChecks],
		environmentNames: [...root.environmentNames],
		checks: config.checks,
		workerPairEvidence: typeof root.workerPairEvidence === "string" ? root.workerPairEvidence : undefined,
	};
}

export interface WorkerPairWorkerEvidence {
	pid: number;
	workspace: string;
	startedAt: string;
}
export interface WorkerPairEvidence {
	kind: "pi-worker-pair";
	workers: WorkerPairWorkerEvidence[];
}
export interface WorkerPairValidation {
	valid: boolean;
	workers: number;
	distinctPids: boolean;
	distinctWorkspaces: boolean;
	reason?: string;
}

/**
 * K7 gate: a dual-worker acceptance can only be satisfied by evidence of at least two real,
 * distinct worker processes. A single worker, duplicate pids or shared workspaces never validate.
 */
export function validateWorkerPairEvidence(input: unknown): WorkerPairValidation {
	const root = record(input);
	if (!root || root.kind !== "pi-worker-pair" || !Array.isArray(root.workers))
		return { valid: false, workers: 0, distinctPids: false, distinctWorkspaces: false, reason: "not worker pair evidence" };
	const workers: unknown[] = root.workers;
	if (workers.length < 2)
		return { valid: false, workers: workers.length, distinctPids: false, distinctWorkspaces: false, reason: "fewer than two workers" };
	const parsed: WorkerPairWorkerEvidence[] = [];
	for (const raw of workers) {
		const item = record(raw);
		if (
			!item ||
			typeof item.pid !== "number" ||
			!Number.isSafeInteger(item.pid) ||
			item.pid <= 0 ||
			typeof item.workspace !== "string" ||
			!isAbsolute(item.workspace) ||
			typeof item.startedAt !== "string"
		)
			return { valid: false, workers: workers.length, distinctPids: false, distinctWorkspaces: false, reason: "invalid worker record" };
		parsed.push({ pid: item.pid, workspace: item.workspace, startedAt: item.startedAt });
	}
	const pids = new Set(parsed.map((worker) => worker.pid)),
		workspaces = new Set(parsed.map((worker) => worker.workspace));
	if (pids.size !== parsed.length || workspaces.size !== parsed.length)
		return {
			valid: false,
			workers: parsed.length,
			distinctPids: pids.size === parsed.length,
			distinctWorkspaces: workspaces.size === parsed.length,
			reason: "workers must have distinct pids and workspaces",
		};
	return { valid: true, workers: parsed.length, distinctPids: true, distinctWorkspaces: true };
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
		// Regression fix (source: m5-review-457ccf2 logs/11-acceptance-skip.log): the exit reporter
		// used to mark exit code 0 as passed with counts null, so a skip-only test run passed
		// acceptance. Both reporters now parse the same summaries and non-pass never satisfies.
		const counts = parseTestCounts(stdout);
		const { status, outcome } = checkOutcome(check, exitCode, termination, counts);
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
			outcome,
			counts,
			durationMs: Math.round(performance.now() - started),
			stdout,
			stderr,
			commandDigest: digest([check.command, check.args, check.env ?? {}]),
			evidence: `check:${check.id}:${outcome}:sha256:${digest({ stdout, stderr })}`,
		});
		if (signal?.aborted) break;
	}
	const after = await snapshot(config.workspace),
		workspaceChanged = before.hash !== after.hash;
	const outcomes: Record<CheckOutcome, number> = { pass: 0, fail: 0, skip: 0, "not-run": 0, blocked: 0 };
	for (const check of checks) outcomes[check.outcome] += 1;
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
		outcomes,
		checks,
		independentReview: "not-performed",
	};
}
