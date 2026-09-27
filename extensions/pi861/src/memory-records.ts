import { digest } from "./contracts/hash.ts";
import { formatScope, parseScope } from "./contracts/identity.ts";
import {
	type AssemblyMode,
	assembleNecessaryContext,
	type MemoryPurpose,
	type MemoryRecord,
	memoryFingerprints,
	type SourceKind,
	validateMemoryRecord,
} from "./contracts/memory.ts";
import { contentFingerprint, type MemoryInput, type MemoryItem, type MemoryKind, sourceFingerprint } from "./memory.ts";

export type { MemoryRecord };

/**
 * Bridge between the kernel memory item and the C6 memory record. The record model
 * (purpose x canonical scope x provenance chain) is the authoritative storage shape;
 * the kernel item remains the compatibility facade for the host surface until the
 * integration phase rewires it.
 */

const PURPOSE_BY_KIND: Record<MemoryKind, MemoryPurpose> = {
	constraint: "constraint",
	working: "working",
	project: "project",
	experience: "experience",
	evidence: "evidence",
};
const KIND_BY_PURPOSE: Record<MemoryPurpose, MemoryKind> = {
	constraint: "constraint",
	working: "working",
	project: "project",
	experience: "experience",
	evidence: "evidence",
};

function sourceKindOf(kind: MemoryInput["source"]["kind"]): SourceKind {
	if (kind === "user" || kind === "tool" || kind === "inference" || kind === "verified") return kind;
	throw new Error("Recalled memory is not new evidence");
}

export interface RecordView {
	revision: number;
	updatedAt: number;
	status: "candidate" | "confirmed" | "withdrawn";
}

/**
 * Converts a stored kernel item into its C6 record. A short record (empty summary
 * segments) is its own summary at every depth, so the missing segments are filled
 * from the full text rather than failing contract validation.
 */
export function toRecord(item: MemoryItem): MemoryRecord {
	const record: MemoryRecord = {
		id: item.id,
		scope: parseScope(item.scope),
		purpose: PURPOSE_BY_KIND[item.kind],
		abstract: item.abstract.trim() ? item.abstract : item.full,
		overview: item.overview.trim() ? item.overview : item.full,
		full: item.full,
		provenance: [{ sourceKind: sourceKindOf(item.source.kind), ref: item.source.ref, at: item.updatedAt }],
		derivedFrom: [],
		revision: item.revision,
		status: item.status,
		updatedAt: item.updatedAt,
	};
	validateMemoryRecord(record);
	return record;
}

/** Converts a C6 record back into the kernel item; the first provenance entry is the original source. */
export function toItem(record: MemoryRecord): MemoryItem {
	const first = record.provenance[0];
	if (!first) throw new Error("Record lacks a provenance chain");
	return {
		id: record.id,
		scope: formatScope(record.scope),
		kind: KIND_BY_PURPOSE[record.purpose],
		abstract: record.abstract,
		overview: record.overview,
		full: record.full,
		source: { kind: first.sourceKind, ref: first.ref },
		status: record.status === "withdrawn" ? "withdrawn" : record.status,
		revision: record.revision,
		updatedAt: record.updatedAt,
	};
}

export function recordFingerprints(record: MemoryRecord): string[] {
	const scope = formatScope(record.scope);
	// Keep legacy tombstones effective and bind source identity independently of ingestion time.
	return [
		...new Set([
			...memoryFingerprints(record),
			contentFingerprint({ scope, full: record.full }),
			...record.provenance.map((entry) =>
				sourceFingerprint({ scope, source: { kind: entry.sourceKind, ref: entry.ref } }),
			),
		]),
	];
}

/**
 * Record-level write (P2-M consumer surface): carries the COMPLETE C6 record, so
 * multi-entry provenance chains (adoption's [original source, verified]) and
 * cross-record derivedFrom links survive the write; the item facade cannot express
 * either (toRecord always produces a single-entry chain and an empty derivedFrom).
 * revision/updatedAt are recomputed by the authority and never taken from the wire.
 */
export interface MemoryRecordWrite {
	requestId: string;
	expectedRevision: number | null;
	record: MemoryRecord;
}

/** C4 content digest over the intended write payload; an identical retry presents the identical digest. */
export function putContentDigest(
	scope: string,
	id: string,
	expectedRevision: number | null,
	item: MemoryInput,
): string {
	return digest([
		"pi861.memory.put",
		scope,
		id,
		expectedRevision,
		{
			kind: item.kind,
			status: item.status,
			abstract: item.abstract,
			overview: item.overview,
			full: item.full,
			source: item.source,
		},
	]);
}

export function withdrawContentDigest(scope: string, id: string, expectedRevision: number): string {
	return digest(["pi861.memory.withdraw", scope, id, expectedRevision]);
}

/** Digest over a record-level write: every caller-controlled field of the record. */
export function putRecordContentDigest(
	scope: string,
	id: string,
	expectedRevision: number | null,
	record: MemoryRecord,
): string {
	return digest([
		"pi861.memory.put-record",
		scope,
		id,
		expectedRevision,
		{
			purpose: record.purpose,
			abstract: record.abstract,
			overview: record.overview,
			full: record.full,
			status: record.status,
			provenance: record.provenance,
			derivedFrom: record.derivedFrom,
		},
	]);
}

/** Read depth per purpose: constraints survive summarization, working state reads at overview depth. */
export const ASSEMBLY_DEPTH: Record<MemoryPurpose, 0 | 1 | 2> = {
	constraint: 2,
	working: 1,
	project: 0,
	experience: 0,
	evidence: 0,
};

export interface KernelAssemblyResult {
	text: string;
	usedBytes: number;
	omitted: number;
	included: { id: string; scope: string; kind: MemoryKind; level: 0 | 1 | 2 }[];
}

/**
 * Necessary-state assembly delegated to the C6 packer. The contract takes one read depth
 * per call, so records are packed depth bucket by depth bucket (constraints first) under
 * one shared byte budget; the contract owns visibility filtering, ordering and the
 * whole-record-or-nothing budget rule. Boot modes exclude long-term experience, matching
 * the C6 assembly semantics.
 */
export function assembleRecords(
	records: readonly MemoryRecord[],
	options: {
		mode: AssemblyMode;
		maxBytes: number;
		readableScopes: string[];
	},
): KernelAssemblyResult {
	if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) throw new Error("Invalid assembly budget");
	if (!["startup", "takeover", "model-switch", "compaction", "node-switch", "event-recall"].includes(options.mode)) {
		throw new Error("Invalid assembly mode");
	}
	const included: KernelAssemblyResult["included"] = [];
	const lines: string[] = [];
	let usedBytes = 0;
	let omitted = 0;
	const purposes: MemoryPurpose[] =
		options.mode === "event-recall"
			? ["constraint", "working", "project", "experience", "evidence"]
			: ["constraint", "working", "project"];
	const seen = new Set<string>();
	for (const purpose of purposes) {
		const bucket = records
			.filter(
				(record) =>
					record.purpose === purpose &&
					record.status !== "withdrawn" &&
					options.readableScopes.includes(formatScope(record.scope)),
			)
			.sort((a, b) => a.id.localeCompare(b.id) || formatScope(a.scope).localeCompare(formatScope(b.scope)));
		for (const record of bucket) {
			const identity = JSON.stringify([formatScope(record.scope), record.id]);
			if (seen.has(identity)) continue;
			seen.add(identity);
			const level = ASSEMBLY_DEPTH[purpose];
			const assembled = assembleNecessaryContext([record], {
				mode: options.mode,
				maxBytes: options.maxBytes,
				readDepth: level,
				readableScopes: options.readableScopes,
			});
			if (!assembled.text) {
				omitted++;
				continue;
			}
			// Preserve epistemic status and provenance references omitted by the base C6 packer.
			const line = JSON.stringify({
				...JSON.parse(assembled.text),
				kind: purpose,
				status: record.status,
				provenance: record.provenance,
				derivedFrom: record.derivedFrom,
			});
			const size = Buffer.byteLength(line, "utf8") + (lines.length ? 1 : 0);
			if (usedBytes + size > options.maxBytes) {
				omitted++;
				continue;
			}
			lines.push(line);
			usedBytes += size;
			included.push({ id: record.id, scope: formatScope(record.scope), kind: purpose, level });
		}
	}
	return { text: lines.join("\n"), usedBytes, omitted, included };
}
