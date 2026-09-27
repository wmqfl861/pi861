import { record } from "../search.ts";
import { looksSensitive } from "./capture.ts";

/**
 * Shared extraction contract used by both the file-backed LayeredMemory and the
 * PostgreSQL record service: deterministic output validation (literal quotes,
 * bounded sizes), failure classification and bounded exponential backoff.
 */

export type ExtractionFailureClass = "transient" | "permanent" | "invalid_output";

/** Deterministic validation rejected the extractor output; retrying the same shape is not worth the budget. */
export class InvalidExtractionOutput extends Error {}

export interface ExtractionOutput {
	abstract: string;
	overview: string;
	facts: { text: string; quote: string }[];
}

export const EXTRACTION_LIMITS = { abstract: 600, overview: 6000, facts: 20, factText: 2000 };
export const DEFAULT_MAX_EXTRACTION_ATTEMPTS = 3;
export const DEFAULT_BACKOFF_BASE_MS = 30_000;
export const DEFAULT_BACKOFF_CAP_MS = 900_000;

/** Model-driven summary of one memory record; the model call always runs outside any storage lock. */
export interface MemoryExtractor {
	modelId: string;
	extract(
		input: { id: string; revision: number; text: string; source: { kind: string; ref: string } },
		signal: AbortSignal,
	): Promise<unknown>;
}

export function validateExtractionOutput(result: unknown, sourceText: string): ExtractionOutput {
	if (!result || typeof result !== "object") throw new InvalidExtractionOutput("Invalid extraction output");
	const candidate = record(result);
	if (
		!candidate ||
		typeof candidate.abstract !== "string" ||
		!candidate.abstract.trim() ||
		candidate.abstract.length > EXTRACTION_LIMITS.abstract ||
		typeof candidate.overview !== "string" ||
		!candidate.overview.trim() ||
		candidate.overview.length > EXTRACTION_LIMITS.overview ||
		!Array.isArray(candidate.facts) ||
		candidate.facts.length > EXTRACTION_LIMITS.facts
	)
		throw new InvalidExtractionOutput("Invalid extraction output");
	const facts = candidate.facts.map((raw) => {
		const fact = record(raw);
		if (
			!fact ||
			typeof fact.text !== "string" ||
			!fact.text.trim() ||
			fact.text.length > EXTRACTION_LIMITS.factText ||
			typeof fact.quote !== "string" ||
			!fact.quote.trim() ||
			!sourceText.includes(fact.quote)
		)
			throw new InvalidExtractionOutput("Extraction lacks a literal source quotation");
		return { text: fact.text, quote: fact.quote };
	});
	return { abstract: candidate.abstract, overview: candidate.overview, facts };
}

export function classifyExtractionFailure(error: unknown): ExtractionFailureClass {
	return error instanceof InvalidExtractionOutput ? "invalid_output" : "transient";
}

export function failureBackoffMs(failures: number, baseMs: number, capMs: number): number {
	if (
		!Number.isSafeInteger(failures) ||
		failures < 1 ||
		!Number.isSafeInteger(baseMs) ||
		baseMs < 0 ||
		!Number.isSafeInteger(capMs) ||
		capMs < 1 ||
		baseMs > capMs
	)
		throw new Error("Invalid backoff parameters");
	return Math.min(capMs, baseMs * 2 ** (failures - 1));
}

/** Failure text never leaks credential-shaped content into the durable job record. */
export function withheldFailureText(message: string): string {
	const text = message.slice(0, 300);
	return looksSensitive(message) ? "withheld: potentially sensitive failure text" : text;
}

export interface EnrichmentJobView {
	id: string;
	scope: string;
	memoryId: string;
	revision: number;
	state: "queued" | "running" | "done" | "obsolete" | "failed";
	attempts: number;
	failures: number;
	failureClass?: ExtractionFailureClass;
	nextAttemptAt?: number;
	lastError?: string;
	requeues: number;
	expiresAt?: number;
}
