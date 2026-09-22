import { digest } from "./hash.ts";
import type { ArtifactReference } from "./artifact.ts";

/**
 * C7 acceptance contract: goal contracts name the evidence kinds each clause requires, and the
 * ledger keeps the four evidence classes separate - structural checks and behavioral checks are
 * recorded by trusted automated checkers, independent review must come from a principal other
 * than the implementer, and human acceptance is recorded by a human. One class never substitutes
 * for another: a failed check never satisfies a clause, and a human acceptance never counts as
 * an independent review or an automated check.
 */

export type EvidenceKind = "structural-check" | "behavioral-check" | "independent-review" | "human-acceptance";
export type RecorderKind = "trusted-automated-checker" | "agent" | "human";

export interface AcceptanceEvidence {
	clauseId: string;
	kind: EvidenceKind;
	artifact: ArtifactReference;
	passed: boolean;
	commandDigest?: string;
	exitCode?: number;
	summary: string;
	recordedAt: number;
	recordedBy: string;
	recorderKind: RecorderKind;
	/** For independent review: the principal whose work is being reviewed. */
	reviewedWorkBy?: string;
}

export interface GoalContractClause {
	clauseId: string;
	description: string;
	requiredEvidence: EvidenceKind[];
}

export interface AcceptanceEvaluation {
	accepted: boolean;
	satisfied: { clauseId: string; kind: EvidenceKind }[];
	missing: { clauseId: string; kind: EvidenceKind }[];
}

export interface AcceptanceSnapshot {
	version: 1;
	evidence: AcceptanceEvidence[];
}

export class AcceptanceLedger {
	private readonly evidence: AcceptanceEvidence[] = [];

	record(evidence: AcceptanceEvidence): void {
		if (!evidence.clauseId || evidence.clauseId.length > 200 ||
			!["structural-check", "behavioral-check", "independent-review", "human-acceptance"].includes(evidence.kind) ||
			!["trusted-automated-checker", "agent", "human"].includes(evidence.recorderKind) ||
			!evidence.recordedBy || !evidence.summary.trim() || !Number.isFinite(evidence.recordedAt) ||
			!evidence.artifact.artifactId || !evidence.artifact.contentDigest) {
			throw new Error("Invalid acceptance evidence");
		}
		if (evidence.kind === "structural-check" || evidence.kind === "behavioral-check") {
			if (evidence.recorderKind !== "trusted-automated-checker") throw new Error("Automated check evidence requires a trusted automated recorder");
			if (!evidence.commandDigest || !Number.isSafeInteger(evidence.exitCode)) throw new Error("Automated check evidence requires a command digest and exit code");
		}
		if (evidence.kind === "independent-review") {
			if (evidence.recorderKind === "trusted-automated-checker") throw new Error("Independent review is recorded by a reviewer, not a checker");
			if (!evidence.reviewedWorkBy || evidence.reviewedWorkBy === evidence.recordedBy) {
				throw new Error("Independent review requires a reviewer other than the implementer");
			}
		}
		if (evidence.kind === "human-acceptance" && evidence.recorderKind !== "human") {
			throw new Error("Human acceptance is recorded by a human principal");
		}
		this.evidence.push(structuredClone(evidence));
	}

	evaluate(clauses: readonly GoalContractClause[]): AcceptanceEvaluation {
		if (!clauses.length || clauses.some((clause) => !clause.clauseId || !clause.requiredEvidence.length ||
			new Set(clauses.map((item) => item.clauseId)).size !== clauses.length ||
			clause.requiredEvidence.some((kind) => !["structural-check", "behavioral-check", "independent-review", "human-acceptance"].includes(kind)))) {
			throw new Error("Invalid goal contract clauses");
		}
		const satisfied: { clauseId: string; kind: EvidenceKind }[] = [];
		const missing: { clauseId: string; kind: EvidenceKind }[] = [];
		for (const clause of clauses) {
			for (const kind of clause.requiredEvidence) {
				if (this.evidence.some((item) => item.clauseId === clause.clauseId && item.kind === kind && item.passed)) {
					satisfied.push({ clauseId: clause.clauseId, kind });
				} else {
					missing.push({ clauseId: clause.clauseId, kind });
				}
			}
		}
		return { accepted: missing.length === 0, satisfied, missing };
	}

	evidenceFor(clauseId: string): AcceptanceEvidence[] {
		return this.evidence.filter((item) => item.clauseId === clauseId).map((item) => structuredClone(item));
	}

	exportState(): AcceptanceSnapshot {
		return { version: 1, evidence: this.evidence.map((item) => structuredClone(item)) };
	}

	restore(snapshot: AcceptanceSnapshot): void {
		if (snapshot.version !== 1 || !Array.isArray(snapshot.evidence)) throw new Error("Invalid acceptance snapshot");
		const restored: AcceptanceEvidence[] = [];
		for (const item of snapshot.evidence) {
			const clone = structuredClone(item);
			this.validateRestored(clone);
			restored.push(clone);
		}
		this.evidence.length = 0;
		this.evidence.push(...restored);
	}

	private validateRestored(evidence: AcceptanceEvidence): void {
		if (!evidence.clauseId || !evidence.recordedBy ||
			!["structural-check", "behavioral-check", "independent-review", "human-acceptance"].includes(evidence.kind) ||
			!["trusted-automated-checker", "agent", "human"].includes(evidence.recorderKind) ||
			typeof evidence.passed !== "boolean" || !Number.isFinite(evidence.recordedAt)) {
			throw new Error("Invalid acceptance evidence snapshot");
		}
	}
}

/**
 * Evidence digest for reports: binds clause, kind, artifact and outcome so acceptance claims in
 * a HANDOFF are verifiable against the ledger without replaying the checks.
 */
export function evidenceDigest(evidence: AcceptanceEvidence): string {
	return digest(["acceptance-evidence", evidence.clauseId, evidence.kind, evidence.artifact.contentDigest, evidence.passed]);
}
