import type { AuxiliaryCallContext, AuxiliaryModelInvocations, ProjectPlanEntry } from "./auxiliary-models.ts";
import {
	type PlanPolicy,
	type PlanTask,
	type ProjectState,
	validatePlanGraph,
	validateTaskContracts,
} from "./coordinator.ts";

/**
 * G-side adapter that turns the frozen P1-S planning port into the ProjectRunner planner callback.
 * The shared invocation service owns admission, the C3 reservation under the goal's root budget and
 * settlement of measured usage; this adapter owns the scheduling-layer acceptance of the plan:
 * dependency-reference existence, acyclicity against the live board, and the operator-approved
 * model/role/check vocabulary (P1-S validates the model output's vocabulary; reference and cycle
 * validity are properties of the board the plan lands on, so they are checked here).
 */

export interface GoalPlannerOptions {
	/** Frozen P1-S shared invocation service; plan() reserves C3 budget before the physical call. */
	invocations: AuxiliaryModelInvocations;
	/** C1 execution context re-verified on every planning call. */
	context: AuxiliaryCallContext;
	/** Operator-supplied vocabularies the planner may choose from (R8.6: no invented ids). */
	vocabulary: { models: string[]; roles: string[]; checkIds: string[] };
	/** Repository facts handed to the planner; a function sees the live project state. */
	repositoryFacts: string | ((state: ProjectState) => string);
	/** Whether the appended batch completes the plan; default false (rolling low-watermark refill). */
	sealed?: boolean | ((state: ProjectState) => boolean);
	/** Optional narrowing policy; defaults to exactly the supplied vocabulary. */
	policy?: PlanPolicy;
}

export type GoalPlanner = (state: ProjectState, signal: AbortSignal) => Promise<{ tasks: PlanTask[]; sealed: boolean }>;

export function createGoalPlanner(options: GoalPlannerOptions): GoalPlanner {
	return async (state, signal) => {
		signal.throwIfAborted();
		if (!options.vocabulary.models.length || !options.vocabulary.roles.length || !options.vocabulary.checkIds.length)
			throw new Error("Goal planning requires non-empty model, role and check vocabularies");
		const entries: ProjectPlanEntry[] = await options.invocations.plan(
			options.context,
			state.objective,
			typeof options.repositoryFacts === "function" ? options.repositoryFacts(state) : options.repositoryFacts,
			options.vocabulary,
			signal,
		);
		// Budget exhaustion inside invocations.plan propagates: a goal may not plan around C3.
		validatePlanGraph(state.board.tasks, entries);
		validateTaskContracts(
			entries,
			options.policy ?? {
				roleIds: options.vocabulary.roles,
				modelIds: options.vocabulary.models,
				checkIds: options.vocabulary.checkIds,
			},
		);
		const sealed = typeof options.sealed === "function" ? options.sealed(state) : (options.sealed ?? false);
		if (sealed && !entries.length) throw new Error("A sealing plan batch must contain at least one task");
		return { tasks: entries, sealed };
	};
}
