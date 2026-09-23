import type { RuntimeSkill, ToolBinding } from "../capabilities.ts";
import { type AcceptanceEvidence, AcceptanceLedger } from "../contracts/acceptance.ts";
import type { ArtifactReference } from "../contracts/artifact.ts";
import { type ExecutionIdentity, isValidScope, validateExecutionIdentity } from "../contracts/identity.ts";
import { canonical, digest } from "../memory.ts";
import { record } from "../search.ts";

export interface SkillValidationCase {
	branchId: string;
	phase: string;
	/** Trusted expected constraints, never copied from the generated candidate. */
	instructionIncludes: string[];
	calls?: { binding: ToolBinding; args: Record<string, unknown>; expected: unknown }[];
}
export interface SkillEvidenceOwner {
	producedBy: ExecutionIdentity;
	scope: string;
	recordedBy: string;
	now?: number;
}
export interface SkillValidationOptions extends SkillEvidenceOwner {
	approvedBindings: ToolBinding[];
	environment: string[];
	cases: SkillValidationCase[];
	/** Explicitly authorized test endpoint. Omit to prevent all external tool calls. */
	invoke?: (binding: ToolBinding, args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;
	timeoutMs?: number;
}

function artifactFor(skill: RuntimeSkill, owner: SkillEvidenceOwner): ArtifactReference {
	if (!isValidScope(owner.scope) || !owner.recordedBy.trim()) throw new Error("Trusted Skill evidence owner required");
	return {
		artifactId: `skill:${skill.id}:${skill.revision}`,
		contentDigest: digest(skill),
		byteSize: Buffer.byteLength(canonical(skill)),
		scope: owner.scope,
		producedBy: validateExecutionIdentity(owner.producedBy),
		producedAt: owner.now ?? Date.now(),
	};
}

/** Run deterministic checks against this exact candidate. This does not assess model reasoning quality. */
export async function runSkillValidation(
	skill: RuntimeSkill,
	options: SkillValidationOptions,
	signal: AbortSignal,
): Promise<{ evidence: AcceptanceEvidence[] }> {
	const candidate = structuredClone(skill),
		config = {
			...options,
			...structuredClone({
				approvedBindings: options.approvedBindings,
				environment: options.environment,
				cases: options.cases,
			}),
		};
	const artifact = artifactFor(candidate, config),
		timeoutMs = config.timeoutMs ?? 30_000;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000)
		throw new Error("Invalid Skill validation timeout");
	const controller = new AbortController(),
		effective = AbortSignal.any([signal, controller.signal]);
	const timer = setTimeout(() => controller.abort(new Error("Skill validation timed out")), timeoutMs);
	const evidence: AcceptanceEvidence[] = [];
	const add = (kind: "structural-check" | "behavioral-check", summary: string, command: unknown): void => {
		evidence.push({
			clauseId: artifact.artifactId,
			kind,
			artifact,
			passed: true,
			commandDigest: digest(command),
			exitCode: 0,
			summary,
			recordedAt: config.now ?? Date.now(),
			recordedBy: config.recordedBy,
			recorderKind: "trusted-automated-checker",
		});
	};
	try {
		effective.throwIfAborted();
		validateApprovedBindings(candidate, config.approvedBindings);
		if (
			!candidate.id ||
			!candidate.revision ||
			!candidate.title.trim() ||
			!candidate.category.trim() ||
			!candidate.instructions.trim() ||
			!candidate.sources.length ||
			!candidate.branches.length ||
			new Set(candidate.branches.map((branch) => branch.id)).size !== candidate.branches.length
		)
			throw new Error("Invalid Skill structure");
		for (const branch of candidate.branches) {
			if (
				!branch.id ||
				!branch.when.trim() ||
				!branch.instructions.trim() ||
				branch.environment.some((item) => !config.environment.includes(item)) ||
				branch.conflictsWith.includes(branch.id)
			)
				throw new Error("Invalid Skill branch structure or environment");
		}
		add("structural-check", "Validated branch structure, environments, conflict symmetry and approved bindings", [
			"pi861-skill-structure-v1",
			config.approvedBindings,
			config.environment,
		]);
		if (
			!config.cases.length ||
			candidate.branches.some((branch) => !config.cases.some((sample) => sample.branchId === branch.id))
		)
			throw new Error("Skill behavioral checks require trusted cases for every branch");
		const covered = new Set<string>();
		for (const sample of config.cases) {
			effective.throwIfAborted();
			const branch = candidate.branches.find((item) => item.id === sample.branchId);
			if (
				!branch ||
				!sample.phase ||
				!sample.instructionIncludes.length ||
				sample.instructionIncludes.some(
					(text) => !text.trim() || !`${candidate.instructions}\n${branch.instructions}`.includes(text),
				)
			)
				throw new Error("Skill behavioral instruction expectation failed");
			for (const call of sample.calls ?? []) {
				const binding = branch.tools.find(
					(item) => digest(item) === digest(call.binding) && item.phase === sample.phase,
				);
				if (!binding || !config.invoke)
					throw new Error("Skill behavioral tool case requires an authorized test binding and invoker");
				let abort: (() => void) | undefined;
				try {
					const abandoned = new Promise<never>((_resolve, reject) => {
						abort = () => reject(effective.reason);
						effective.addEventListener("abort", abort, { once: true });
					});
					effective.throwIfAborted();
					const actual = await Promise.race([
						config.invoke(structuredClone(binding), structuredClone(call.args), effective),
						abandoned,
					]);
					effective.throwIfAborted();
					if (digest(actual) !== digest(call.expected))
						throw new Error("Skill behavioral tool result expectation failed");
					covered.add(digest([branch.id, binding]));
				} finally {
					if (abort) effective.removeEventListener("abort", abort);
				}
			}
		}
		if (
			candidate.branches.some((branch) => branch.tools.some((binding) => !covered.has(digest([branch.id, binding]))))
		)
			throw new Error("Skill behavioral checks did not exercise every tool binding");
		add(
			"behavioral-check",
			"Executed trusted instruction assertions and configured tool samples; protocol evidence only, not model quality acceptance",
			["pi861-skill-behavior-v1", config.cases],
		);
		return { evidence };
	} finally {
		clearTimeout(timer);
	}
}

/** The host calls this only after an actual human acceptance of this candidate. */
export function recordSkillAcceptance(
	skill: RuntimeSkill,
	owner: SkillEvidenceOwner & { summary: string },
): AcceptanceEvidence {
	if (!owner.summary.trim()) throw new Error("Human acceptance summary required");
	const artifact = artifactFor(skill, owner);
	return {
		clauseId: artifact.artifactId,
		kind: "human-acceptance",
		artifact,
		passed: true,
		summary: owner.summary,
		recordedAt: owner.now ?? Date.now(),
		recordedBy: owner.recordedBy,
		recorderKind: "human",
	};
}

/** Validation is supplied by trusted checkers, never generated by the Skill compiler. */
export function validateSkillEvidence(skill: RuntimeSkill, value: unknown): AcceptanceEvidence[] {
	const verdict = record(value);
	if (!verdict || !Array.isArray(verdict.evidence) || !verdict.evidence.length || verdict.passed === false)
		throw new Error("Skill validation requires typed evidence");
	const ledger = new AcceptanceLedger();
	for (const item of verdict.evidence) {
		const evidence = record(item),
			artifact = record(evidence?.artifact);
		if (
			!evidence ||
			!artifact ||
			evidence.passed !== true ||
			typeof evidence.summary !== "string" ||
			typeof evidence.recordedBy !== "string" ||
			typeof evidence.recordedAt !== "number" ||
			artifact.byteSize !== Buffer.byteLength(canonical(skill)) ||
			artifact.contentDigest !== digest(skill) ||
			artifact.artifactId !== `skill:${skill.id}:${skill.revision}` ||
			typeof artifact.scope !== "string" ||
			!isValidScope(artifact.scope) ||
			typeof artifact.producedAt !== "number" ||
			!Number.isFinite(artifact.producedAt) ||
			!record(artifact.producedBy)
		)
			throw new Error("Skill validation evidence must bind the exact candidate artifact and pass");
		const checked = item as AcceptanceEvidence;
		validateExecutionIdentity(checked.artifact.producedBy);
		if (
			checked.clauseId !== artifact.artifactId ||
			((checked.kind === "structural-check" || checked.kind === "behavioral-check") && checked.exitCode !== 0)
		)
			throw new Error("Skill validation evidence outcome mismatch");
		ledger.record(checked);
	}
	const result = ledger.evaluate([
		{
			clauseId: `skill:${skill.id}:${skill.revision}`,
			description: "Publish this exact Skill version",
			requiredEvidence: ["structural-check", "behavioral-check", "human-acceptance"],
		},
	]);
	if (!result.accepted)
		throw new Error(`Skill validation missing evidence: ${result.missing.map((item) => item.kind).join(", ")}`);
	return ledger.exportState().evidence;
}

/** Compiler output cannot invent accounts, resources, schemas or phases. */
export function validateApprovedBindings(skill: RuntimeSkill, approved: readonly ToolBinding[]): void {
	const permitted = new Set(approved.map((binding) => digest(binding)));
	for (const branch of skill.branches) {
		for (const binding of branch.tools) {
			if (
				!binding.toolId ||
				!binding.accountId ||
				!binding.resourceId ||
				!binding.schemaHash ||
				!binding.phase ||
				!permitted.has(digest(binding))
			)
				throw new Error("Compiled Skill contains an unapproved tool binding");
		}
		for (const conflict of branch.conflictsWith) {
			if (!skill.branches.find((other) => other.id === conflict)?.conflictsWith.includes(branch.id))
				throw new Error("Skill branch conflicts must be symmetric");
		}
	}
}
