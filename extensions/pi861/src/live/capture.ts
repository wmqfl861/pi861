import { digest, type MemoryBackend, type MemoryInput } from "../memory.ts";

/**
 * Governance for automatic capture of tool results into memory.
 * Oversized or sensitive payloads become controlled references (digest plus
 * retrieval state) instead of being silently dropped, and secret material
 * never enters the stored text or its summaries.
 */
const SECRET_RULES: { name: string; pattern: RegExp }[] = [
	{ name: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
	{ name: "token", pattern: /(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{16,}/ },
	{ name: "bearer", pattern: /Bearer\s+[A-Za-z0-9._-]{12,}/ },
	{ name: "credential-assignment", pattern: /(?:password|api[_-]?key|secret)\s*[:=]\s*["']?[^\s"']{8,}/i },
];
export function sensitiveRule(value: string): string | undefined {
	return SECRET_RULES.find((rule) => rule.pattern.test(value))?.name;
}
export function looksSensitive(value: string): boolean {
	return sensitiveRule(value) !== undefined;
}
export const CAPTURE_DIRECT_MAX_BYTES = 64_000;
export const CAPTURE_REFERENCE_PREVIEW_BYTES = 4_096;

export interface ToolObservation {
	sessionId: string;
	toolCallId: string;
	toolName: string;
	result: unknown;
	isError?: boolean;
}
export interface PlannedCapture {
	requestId: string;
	item: MemoryInput;
	mode: "direct" | "reference";
	reason?: "oversize" | "sensitive" | "unserializable";
}
function referenceItem(id: string, scope: string, toolName: string, descriptor: string, source: MemoryInput["source"]): MemoryInput {
	const note = `Tool result stored as a controlled reference (${toolName}); original payload withheld, see record body for digest and retrieval state.`;
	return { id, scope, kind: "evidence", status: "candidate", full: descriptor, abstract: note, overview: note, source };
}
export function planToolCapture(observation: ToolObservation, scope: string): PlannedCapture {
	const id = digest([observation.sessionId, observation.toolCallId]);
	const source = { kind: "tool" as const, ref: `pi-session:${observation.sessionId}/tool:${observation.toolCallId}` };
	let payload: string;
	try {
		payload = JSON.stringify({ tool: observation.toolName, result: observation.result, isError: observation.isError === true });
	} catch {
		// Cyclic or exotic values still leave a durable reference; the event is never lost silently.
		const descriptor = JSON.stringify({ capture: "tool-reference", tool: observation.toolName, sessionId: observation.sessionId,
			toolCallId: observation.toolCallId, isError: observation.isError === true, withheld: "unserializable-result", storedAt: Date.now() });
		return { requestId: id, mode: "reference", reason: "unserializable", item: referenceItem(id, scope, observation.toolName, descriptor, source) };
	}
	const bytes = Buffer.byteLength(payload, "utf8"), contentDigest = digest(payload);
	const sensitive = sensitiveRule(payload);
	if (sensitive) {
		const descriptor = JSON.stringify({ capture: "tool-reference", tool: observation.toolName, sessionId: observation.sessionId,
			toolCallId: observation.toolCallId, isError: observation.isError === true, bytes, contentDigest, withheld: "sensitive", matchedRule: sensitive });
		return { requestId: id, mode: "reference", reason: "sensitive", item: referenceItem(id, scope, observation.toolName, descriptor, source) };
	}
	if (bytes > CAPTURE_DIRECT_MAX_BYTES) {
		const preview = `${payload.slice(0, CAPTURE_REFERENCE_PREVIEW_BYTES)}\n[preview truncated; full payload omitted, verify against contentDigest]`;
		const safePreview = looksSensitive(preview) ? "[preview withheld: potential credential at truncation boundary]" : preview;
		const descriptor = JSON.stringify({ capture: "tool-reference", tool: observation.toolName, sessionId: observation.sessionId,
			toolCallId: observation.toolCallId, isError: observation.isError === true, bytes, contentDigest, truncated: true, preview: safePreview });
		return { requestId: id, mode: "reference", reason: "oversize", item: referenceItem(id, scope, observation.toolName, descriptor, source) };
	}
	return { requestId: id, mode: "direct", item: { id, scope, kind: "evidence", status: "candidate", full: payload,
		abstract: `Tool result: ${observation.toolName}`, overview: payload.slice(0, 1000), source } };
}
export interface CaptureOutcome { status: "captured" | "referenced" | "failed"; id: string; error?: string; }
/** Never throws: a failed capture is reported to the host instead of breaking the tool pipeline. */
export async function captureToolResult(backend: Pick<MemoryBackend, "put">, observation: ToolObservation, scope: string): Promise<CaptureOutcome> {
	try {
		const plan = planToolCapture(observation, scope);
		await backend.put({ requestId: plan.requestId, expectedRevision: null, item: plan.item });
		return { status: plan.mode === "direct" ? "captured" : "referenced", id: plan.item.id };
	} catch (error) {
		return { status: "failed", id: "", error: (error instanceof Error ? error.message : "memory capture failed").slice(0, 300) };
	}
}
