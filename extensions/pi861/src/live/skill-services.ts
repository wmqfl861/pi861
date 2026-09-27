import type { AuxiliaryCallContext, AuxiliaryModelInvocations } from "./auxiliary-models.ts";
import type { SkillCompiler, SkillRepositoryOptions } from "./skill-repository.ts";

/**
 * K-side adapters connecting the Skill chain to the frozen P1-S shared invocation service
 * (extensions/pi861/src/live/auxiliary-models.ts). Automatic grouping (R4.3) and compilation
 * (R4.6) MUST run through AuxiliaryModelInvocations so every physical model request is
 * C1-verified against the identity authority, reserved under the shared C3 root budget before
 * dispatch, carried on the caller's AbortSignal and settled from measured usage (unknown usage
 * is booked conservatively, never as zero). Calling the raw compilers (chooseSkillGroup /
 * skillCompiler) from host wiring instead of these adapters bypasses the budget and is a
 * wiring defect the host review must reject.
 */

/**
 * Automatic grouping (R4.3) through the S port. Feeds repository discovery (source, installed
 * peers, known groups) into AuxiliaryModelInvocations.groupSkill; discovery classifies only and
 * never activates tools or performs business writes.
 */
export function auxiliaryGrouping(
	invocations: AuxiliaryModelInvocations,
	context: AuxiliaryCallContext,
): NonNullable<SkillRepositoryOptions["classify"]> {
	return (input, signal) => invocations.groupSkill(context, input.source, input.groups, signal, input.installed);
}

/**
 * Compilation (R4.6) through the S port. The operator-supplied approvedBindings are mandatory
 * at this boundary; a compile input without an approvedBindings array is rejected before any
 * model call, and a generated skill declaring a binding the operator did not approve is
 * rejected by the S compiler and again by the repository's own validation.
 */
export function auxiliaryCompiler(
	invocations: AuxiliaryModelInvocations,
	context: AuxiliaryCallContext,
): SkillCompiler {
	return {
		compile: (input, signal) => invocations.compileSkill(context, input, signal),
	};
}
