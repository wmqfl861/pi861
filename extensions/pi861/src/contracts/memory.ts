import { digest } from "./hash.ts";
import type { ScopeId } from "./identity.ts";
import { formatScope, isValidScope } from "./identity.ts";

/**
 * C6 memory contract: the three-dimensional model (purpose x scope x read depth), the provenance
 * chain, revisions, derivation links, withdrawal propagation, and necessary-context assembly.
 * Model inference can never promote itself to confirmed; recalled output is never new evidence;
 * withdrawal of a source invalidates its derivatives instead of resurrecting content.
 */

export type MemoryPurpose = "constraint" | "working" | "project" | "experience" | "evidence";
export type MemoryStatus = "candidate" | "confirmed" | "withdrawn";
export type SourceKind = "user" | "tool" | "inference" | "verified";

export interface ProvenanceEntry {
	sourceKind: SourceKind;
	ref: string;
	at: number;
}

export interface DerivationLink {
	scope: string;
	id: string;
	revision: number;
}

export interface MemoryRecord {
	id: string;
	scope: ScopeId;
	purpose: MemoryPurpose;
	abstract: string;
	overview: string;
	full: string;
	provenance: ProvenanceEntry[];
	derivedFrom: DerivationLink[];
	revision: number;
	status: MemoryStatus;
	updatedAt: number;
}

export const MAX_MEMORY_BYTES = 262_144;

export function validateMemoryRecord(record: MemoryRecord): void {
	if (!record.id || record.id.length > 200) throw new Error("Invalid memory identity");
	if (!isValidScope(formatScope(record.scope))) throw new Error("Memory scope must be canonical");
	if (!["constraint", "working", "project", "experience", "evidence"].includes(record.purpose)) throw new Error("Invalid memory purpose");
	if (!["candidate", "confirmed", "withdrawn"].includes(record.status)) throw new Error("Invalid memory status");
	if (!record.abstract.trim() || !record.overview.trim() || !record.full.trim() ||
		Buffer.byteLength(record.full, "utf8") > MAX_MEMORY_BYTES) throw new Error("Memory bodies must be non-empty and bounded");
	if (!Number.isSafeInteger(record.revision) || record.revision < 1 || !Number.isFinite(record.updatedAt)) {
		throw new Error("Invalid memory revision");
	}
	if (!record.provenance.length || record.provenance.some((entry) => !entry.ref.trim() ||
		!["user", "tool", "inference", "verified"].includes(entry.sourceKind) || !Number.isFinite(entry.at))) {
		throw new Error("Memory requires a valid provenance chain");
	}
	if (record.status === "confirmed" && !record.provenance.some((entry) => entry.sourceKind === "user" || entry.sourceKind === "verified")) {
		throw new Error("Model inference cannot promote itself to a confirmed fact or policy");
	}
	if (record.status === "confirmed" && record.purpose === "constraint" &&
		!record.provenance.some((entry) => entry.sourceKind === "user")) {
		throw new Error("Constraints require direct user provenance");
	}
	for (const link of record.derivedFrom) {
		if (!isValidScope(link.scope) || !link.id || !Number.isSafeInteger(link.revision) || link.revision < 1) {
			throw new Error("Invalid derivation link");
		}
	}
}

/** Content and provenance fingerprints; withdrawal tombstones block both silent restoration paths. */
export function memoryFingerprints(record: Pick<MemoryRecord, "scope" | "full" | "provenance">): string[] {
	const scope = formatScope(record.scope);
	return [
		digest(["memory-content", scope, record.full.trim().replace(/\s+/g, " ")]),
		digest(["memory-provenance", scope, record.provenance]),
	];
}

export interface WithdrawalPlan {
	tombstones: string[];
	invalidDerivatives: DerivationLink[];
}

/** Withdrawing a record lists the derivatives that must be withdrawn or rebuilt from new provenance. */
export function planWithdrawal(record: MemoryRecord, derivatives: readonly MemoryRecord[]): WithdrawalPlan {
	if (record.status !== "withdrawn") throw new Error("Plan withdrawal from the withdrawn record itself");
	const sourceFingerprints = memoryFingerprints(record);
	const derivedKey = (link: DerivationLink): string => JSON.stringify([link.scope, link.id]);
	const sourceLinks = new Set(record.derivedFrom.map(derivedKey));
	const invalidDerivatives: DerivationLink[] = [];
	for (const candidate of derivatives) {
		if (candidate.status === "withdrawn") continue;
		const depends = candidate.derivedFrom.some((link) =>
			(link.scope === formatScope(record.scope) && link.id === record.id) || sourceLinks.has(derivedKey(link)));
		if (depends) invalidDerivatives.push({ scope: formatScope(candidate.scope), id: candidate.id, revision: candidate.revision });
	}
	return { tombstones: [...sourceFingerprints], invalidDerivatives };
}

export type AssemblyMode = "startup" | "takeover" | "model-switch" | "compaction" | "node-switch" | "event-recall";

export interface ContextAssemblyOptions {
	mode: AssemblyMode;
	maxBytes: number;
	readDepth: 0 | 1 | 2;
	readableScopes: string[];
}

export interface AssembledContext {
	text: string;
	usedBytes: number;
	omitted: number;
	sections: { kind: string; count: number }[];
}

function bodyFor(record: MemoryRecord, depth: 0 | 1 | 2): string {
	return depth === 0 ? record.abstract : depth === 1 ? record.overview : record.full;
}

/**
 * Necessary-context assembly. Boot modes (startup, takeover, model-switch, compaction,
 * node-switch) install fixed constraints and working/project state directly; only event-recall
 * mode adds long-term experience. Withdrawn records and records outside the readable scopes are
 * excluded before packing; the byte budget drops whole records, never truncates one.
 */
export function assembleNecessaryContext(records: readonly MemoryRecord[], options: ContextAssemblyOptions): AssembledContext {
	if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1 || ![0, 1, 2].includes(options.readDepth) ||
		!options.readableScopes.length) throw new Error("Invalid context assembly options");
	const readable = new Set(options.readableScopes);
	const visible = records.filter((record) => record.status !== "withdrawn" && readable.has(formatScope(record.scope)));
	const boot = options.mode !== "event-recall";
	const order: MemoryPurpose[] = boot
		? ["constraint", "working", "project"]
		: ["constraint", "working", "project", "experience", "evidence"];
	const sections: { kind: string; count: number }[] = [];
	const lines: string[] = [];
	let usedBytes = 0;
	let omitted = 0;
	for (const purpose of order) {
		const bucket = visible.filter((record) => record.purpose === purpose)
			.sort((a, b) => a.revision - b.revision || a.id.localeCompare(b.id));
		let included = 0;
		for (const record of bucket) {
			const line = JSON.stringify({
				id: record.id, scope: formatScope(record.scope), revision: record.revision, purpose: record.purpose,
				provenance: record.provenance.map((entry) => entry.sourceKind), content: bodyFor(record, options.readDepth),
			});
			const size = Buffer.byteLength(line, "utf8") + (lines.length ? 1 : 0);
			if (usedBytes + size > options.maxBytes) { omitted++; continue; }
			lines.push(line);
			usedBytes += size;
			included++;
		}
		if (included) sections.push({ kind: purpose, count: included });
	}
	return { text: lines.join("\n"), usedBytes, omitted, sections };
}
