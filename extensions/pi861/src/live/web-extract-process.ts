/**
 * Controlled extraction boundary (continuation plan section 4): page text extraction
 * runs in a forked child process so a pathological page can never monopolize the host
 * CPU, and a synchronous spin inside the child cannot be hidden by a Promise.race on
 * the host event loop. The parent enforces an independent wall-clock budget and the
 * caller's AbortSignal, forcibly terminates the child when they fire, and settles only
 * after observing the child exit. Input, output and time are bounded on both sides.
 */
import { type ChildProcess, fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { extractText } from "../web-extract.ts";

export interface ControlledExtractionBudget {
	/** Independent wall-clock budget for the whole child round trip. */
	timeoutMs: number;
	/** Input guard; the caller's byte caps must already bound the body. */
	maxInputCharacters: number;
	/** Output guard; text beyond this is cut and reported truncated. */
	maxOutputCharacters: number;
}
export interface ControlledExtractionChild {
	pid: number;
	exitCode: number | null;
	signal: string | null;
	/** True when the parent had to terminate the child instead of a natural exit. */
	killed: boolean;
}
export interface ControlledExtractionOutcome {
	status: "ok" | "timeout";
	text: string;
	/** True when the extracted text was cut at maxOutputCharacters. */
	truncated: boolean;
	elapsedMs: number;
	child: ControlledExtractionChild;
}
const CHILD_MARKER = "PI861_WEB_EXTRACT_CHILD";
/** Grace before SIGKILL after SIGTERM, and how long a healthy child gets to exit on its own. */
const EXIT_GRACE_MS = 1_000;
const KILL_GRACE_MS = 2_000;
const childModule = fileURLToPath(import.meta.url);

function childExecArgv(): string[] {
	// Inherit the parent's loader flags (for example a tsx --import) so the child can load
	// TypeScript sources, but never inherit test-runner flags from a `node --test` parent.
	const inherited = process.execArgv.filter((arg) => arg !== "--test" && !arg.startsWith("--test-"));
	const parts = process.versions.node.split(".");
	const major = Number.parseInt(parts[0] ?? "0", 10);
	const minor = Number.parseInt(parts[1] ?? "0", 10);
	const stripsNatively = major > 23 || (major === 23 && minor >= 6);
	return stripsNatively ? inherited : [...inherited, "--experimental-strip-types"];
}
function snapshotChild(child: ChildProcess, forced: boolean): ControlledExtractionChild {
	return {
		pid: child.pid ?? -1,
		exitCode: child.exitCode,
		signal: child.signalCode ?? null,
		killed: forced || child.killed,
	};
}
function waitExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
	return new Promise((resolve) => {
		let done = false;
		const finish = (observed: boolean): void => {
			if (done) return;
			done = true;
			resolve(observed);
		};
		child.once("exit", () => finish(true));
		setTimeout(() => finish(false), timeoutMs).unref();
	});
}
async function terminateChild(child: ChildProcess): Promise<ControlledExtractionChild> {
	if (child.exitCode === null && child.signalCode === null) {
		// Give a child that already finished its work a moment to exit on its own, then force.
		const natural = await waitExit(child, EXIT_GRACE_MS);
		if (!natural) {
			child.kill();
			const terminated = await waitExit(child, EXIT_GRACE_MS);
			if (!terminated) {
				child.kill("SIGKILL");
				await waitExit(child, KILL_GRACE_MS);
				return snapshotChild(child, true);
			}
			return snapshotChild(child, true);
		}
	}
	return snapshotChild(child, false);
}

interface ExtractionRequest {
	body: string;
	mime: string;
	maxOutputCharacters: number;
}
interface ExtractionReply {
	ok: boolean;
	text: string;
	truncated: boolean;
	message?: string;
}
function isExtractionRequest(value: unknown): value is ExtractionRequest {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const request = value as Partial<ExtractionRequest>;
	return (
		typeof request.body === "string" &&
		typeof request.mime === "string" &&
		typeof request.maxOutputCharacters === "number"
	);
}
function isExtractionReply(value: unknown): value is ExtractionReply {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const reply = value as Partial<ExtractionReply>;
	return typeof reply.ok === "boolean" && typeof reply.text === "string" && typeof reply.truncated === "boolean";
}

/**
 * Run extractText in a child process under an independent wall-clock budget. Never
 * rejects on timeout or cancellation: both settle as { status: "timeout" } after the
 * child is confirmed gone. Structural failures (bad budget, oversize input, fork
 * failure, corrupt reply) reject so callers can fail honestly.
 */
export async function runControlledExtraction(
	body: string,
	mime: string,
	budget: ControlledExtractionBudget,
	signal?: AbortSignal,
): Promise<ControlledExtractionOutcome> {
	if (
		!Number.isSafeInteger(budget.timeoutMs) ||
		budget.timeoutMs < 1 ||
		!Number.isSafeInteger(budget.maxInputCharacters) ||
		budget.maxInputCharacters < 1 ||
		!Number.isSafeInteger(budget.maxOutputCharacters) ||
		budget.maxOutputCharacters < 1
	)
		throw new Error("Invalid extraction budget");
	if (body.length > budget.maxInputCharacters)
		throw new Error("Extraction input exceeds the controlled boundary limit");
	const started = Date.now();
	const child = fork(childModule, [], {
		execArgv: childExecArgv(),
		env: { ...process.env, [CHILD_MARKER]: "1" },
		// With explicit stdio, fork() does not append the ipc entry itself; the last entry is it.
		stdio: ["ignore", "pipe", "pipe", "ipc"],
	});
	let stderrTail = "";
	child.stderr?.setEncoding("utf8");
	child.stderr?.on("data", (chunk: string) => {
		stderrTail = (stderrTail + chunk).slice(-2_000);
	});
	const settled = await new Promise<{ status: "ok" | "timeout"; text: string; truncated: boolean }>(
		(resolve, reject) => {
			let done = false;
			const finish = (value: { status: "ok" | "timeout"; text: string; truncated: boolean }): void => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				resolve(value);
			};
			const timeoutValue = { status: "timeout" as const, text: "", truncated: false };
			const timer = setTimeout(() => finish(timeoutValue), budget.timeoutMs);
			const onAbort = (): void => finish(timeoutValue);
			signal?.addEventListener("abort", onAbort, { once: true });
			if (signal?.aborted) onAbort();
			child.once("message", (message: unknown) => {
				if (done) return;
				if (!isExtractionReply(message)) {
					done = true;
					clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
					reject(new Error(`Corrupt extraction reply${stderrTail ? `: ${stderrTail}` : ""}`));
					return;
				}
				if (message.ok !== true) {
					done = true;
					clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
					reject(new Error(`Extraction child failed: ${message.message ?? "unknown failure"}`));
					return;
				}
				finish({ status: "ok", text: message.text, truncated: message.truncated });
			});
			child.once("error", (error: Error) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				reject(error);
			});
			// Listeners are attached; request the extraction. A synchronous send failure rejects here.
			child.send({ body, mime, maxOutputCharacters: budget.maxOutputCharacters });
		},
	);
	const childOutcome = await terminateChild(child);
	return { ...settled, elapsedMs: Date.now() - started, child: childOutcome };
}

function childMain(): void {
	process.on("message", (request: unknown) => {
		const reply = (() => {
			if (!isExtractionRequest(request)) return { ok: false, text: "", truncated: false, message: "invalid request" };
			try {
				const extracted = extractText(request.body, request.mime);
				const truncated = extracted.length > request.maxOutputCharacters;
				return {
					ok: true,
					text: truncated ? extracted.slice(0, request.maxOutputCharacters) : extracted,
					truncated,
				};
			} catch (error) {
				return { ok: false, text: "", truncated: false, message: error instanceof Error ? error.message : "failure" };
			}
		})();
		// The detached method would lose its receiver; bind it. Exit once the reply is flushed;
		// the self-timer is the backstop for a lost channel.
		const send = process.send?.bind(process);
		if (!send) process.exit(2);
		else {
			send(reply, () => process.exit(0));
			setTimeout(() => process.exit(3), 5_000).unref();
		}
	});
	process.on("disconnect", () => process.exit(0));
	// Orphan backstop: a child that never hears from the parent cannot outlive this cap.
	setTimeout(() => process.exit(124), 60_000).unref();
}
if (process.env[CHILD_MARKER] === "1") childMain();
