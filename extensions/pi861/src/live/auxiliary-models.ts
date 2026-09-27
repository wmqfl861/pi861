import type { RuntimeSkill } from "../capabilities.ts";
import type { MeteredKind, TaskTreeBudget, UsageMeasure } from "../contracts/budget.ts";
import { type IdentityAuthority, type PrincipalCredential, parseScope } from "../contracts/identity.ts";
import type { ModelTarget } from "../routing.ts";
import type { TaskSpec } from "../scheduler.ts";
import {
	chooseSkillGroup,
	type GenerateText,
	memoryExtractor,
	projectPlan,
	routeClassifier,
	type SkillCompileInput,
	type SkillGrouping,
	skillCompiler,
} from "./compilers.ts";
import type { ExecutionSpec } from "./coordinator.ts";
import type { MemoryExtractor } from "./layered-memory.ts";
import type { RouteDecision } from "./model-runtime.ts";
import type { RuntimeConfig } from "./runtime-configuration.ts";
import type { SkillSource } from "./skill-repository.ts";

/**
 * Unified shared invocation service (P1-S). Route classification, Skill compilation, memory
 * distillation and project planning run through one discipline: a C1-verified execution context,
 * a C3 reservation under the shared root budget before every physical request, and a caller-owned
 * AbortSignal. The physical model boundary is an injectable port shaped after M1's
 * ModelRequestService.attempt (extensions/pi861/src/live/model-service.ts); S never builds a bare
 * provider client behind it. P2-A injects the real service; until then tests inject fakes.
 */

/** C3 metered kinds S routes for the four auxiliary call families. */
export type AuxiliaryMeteredKind = Extract<MeteredKind, "reception" | "skill-compile" | "distill" | "planning">;

/** M1 UsagePurpose subset used by auxiliary invocations ("classify" for reception, "auxiliary" for the rest). */
export type AuxiliaryModelPurpose = "classify" | "auxiliary";

/**
 * Usage measurement reported by one physical attempt, in M1's UsageMeasurement shape. Missing
 * fields stay unknown; unknown usage is booked conservatively and never written down as zero (C3).
 */
export interface AuxiliaryUsageMeasurement {
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	costUsd?: number;
}

export type AuxiliaryUsageReport = (usage: AuxiliaryUsageMeasurement) => void;

/** One auxiliary text generation request: M1's ModelAttemptRequest identity fields plus the carried prompt. */
export interface AuxiliaryAttemptRequest {
	/** Fresh identity per logical call; retries derive distinct physical attempt identities (M1 rule). */
	requestId: string;
	purpose: AuxiliaryModelPurpose;
	target: ModelTarget;
	signal: AbortSignal;
	prompt: string;
}

/**
 * Injectable model boundary shaped after M1's ModelRequestService.attempt. The implementer owns
 * admission, per-attempt metering and the transport; S supplies the request identity and settles
 * its own C3 reservation from the reported usage.
 */
export interface AuxiliaryModelPort {
	attempt(request: AuxiliaryAttemptRequest, onUsage: AuxiliaryUsageReport): Promise<string>;
	newRequestId(): string;
}

/** Performs one text generation against a resolved target; implemented by the model service wiring (P2-A). */
export type AuxiliaryTextTransport = (
	request: { prompt: string; target: ModelTarget; signal: AbortSignal },
	onUsage: AuxiliaryUsageReport,
) => Promise<string>;

/** M1's attempt boundary: admission, metering and settlement around one physical model call. */
export type AuxiliaryAttemptBoundary = (
	request: { requestId: string; purpose: AuxiliaryModelPurpose; target: ModelTarget; signal: AbortSignal },
	call: (onUsage: AuxiliaryUsageReport) => Promise<string>,
) => Promise<string>;

/**
 * Adapts an M1-shaped attempt boundary plus the transport it wraps into the port S consumes. One
 * measurement flows both to the boundary's own ledger and to S's C3 settlement listener.
 */
export function auxiliaryPort(
	attempt: AuxiliaryAttemptBoundary,
	transport: AuxiliaryTextTransport,
	newRequestId: () => string,
): AuxiliaryModelPort {
	return {
		attempt: (request, onUsage) =>
			attempt(
				{
					requestId: request.requestId,
					purpose: request.purpose,
					target: request.target,
					signal: request.signal,
				},
				(report) =>
					transport({ prompt: request.prompt, target: request.target, signal: request.signal }, (usage) => {
						report(usage);
						onUsage(usage);
					}),
			),
		newRequestId: () => newRequestId(),
	};
}

/** Shared execution context for every auxiliary model invocation: C1 identity and scope, C3 task attribution. */
export interface AuxiliaryCallContext {
	/** C1 credential; re-verified against the authority on EVERY invocation, so forged or revoked credentials never pass. */
	credential: PrincipalCredential;
	/** Canonical C1 scope the invocation reads within, for example "project:pi861". */
	scope: string;
	/** C3 task the usage is attributed to; null meters tree-level work against the root budget. */
	taskId: string | null;
}

export interface AuxiliaryModelTargets {
	/** Intake route classification target (RuntimeConfig models.intakeId). */
	classifier: ModelTarget;
	/** Skill compilation and automatic grouping target (RuntimeConfig skills.compilerModelId). */
	compiler: ModelTarget;
	/** Memory distillation target (RuntimeConfig memory.modelId). */
	enrich: ModelTarget;
	/** Project planning target (RuntimeConfig project.plannerModelId). */
	planner: ModelTarget;
}

/** Conservative pre-request estimate and unknown-usage booking for one call family. */
export interface AuxiliaryEstimate {
	estimate: UsageMeasure;
	unknown: UsageMeasure;
}

export type AuxiliaryEstimates = Record<AuxiliaryMeteredKind, AuxiliaryEstimate>;

/** Host-tunable conservative estimates; unknown bookings equal the estimate so unknown usage is never zero. */
export const DEFAULT_AUXILIARY_ESTIMATES: AuxiliaryEstimates = {
	reception: {
		estimate: { inputTokens: 24_000, outputTokens: 2_000, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.1 },
		unknown: { inputTokens: 24_000, outputTokens: 2_000, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.1 },
	},
	"skill-compile": {
		estimate: { inputTokens: 60_000, outputTokens: 8_000, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.4 },
		unknown: { inputTokens: 60_000, outputTokens: 8_000, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.4 },
	},
	distill: {
		estimate: { inputTokens: 32_000, outputTokens: 6_000, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.2 },
		unknown: { inputTokens: 32_000, outputTokens: 6_000, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.2 },
	},
	planning: {
		estimate: { inputTokens: 48_000, outputTokens: 8_000, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.3 },
		unknown: { inputTokens: 48_000, outputTokens: 8_000, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.3 },
	},
};

export interface ProjectPlanEntry {
	task: TaskSpec;
	execution: ExecutionSpec;
}

/** Distillation input accepted by the memory extractor, taken from the LayeredMemory port. */
export type AuxiliaryRecordInput = Parameters<MemoryExtractor["extract"]>[0];

export interface AuxiliaryInvocationOptions {
	/** C1 identity authority; verifies the caller's credential on every invocation. */
	authority: IdentityAuthority;
	/** C3 shared root budget; mandatory. Invocations without a budget are rejected, never metered elsewhere. */
	budget: TaskTreeBudget;
	/** Injectable M1-shaped model boundary. S never constructs a provider client. */
	port: AuxiliaryModelPort;
	/** Resolved auxiliary model targets (resolveAuxiliaryTargets). */
	targets: AuxiliaryModelTargets;
	/** Conservative estimates; defaults cover typical auxiliary prompts. */
	estimates?: Partial<AuxiliaryEstimates>;
	now?: () => number;
}

/**
 * The shared invocation surface every auxiliary consumer (intake classifier, Skill compiler,
 * memory enricher, project planner) must go through: same context verification, same budget,
 * same signal discipline. Bypassing it means bypassing the budget, which the negative tests pin.
 */
export class AuxiliaryModelInvocations {
	private readonly authority: IdentityAuthority;
	private readonly budget: TaskTreeBudget;
	private readonly port: AuxiliaryModelPort;
	private readonly targets: AuxiliaryModelTargets;
	private readonly estimates: AuxiliaryEstimates;
	private readonly now: () => number;

	constructor(options: AuxiliaryInvocationOptions) {
		for (const key of ["authority", "budget", "port", "targets"] as const) {
			if (!options[key]) throw new Error(`Auxiliary invocations require ${key}`);
		}
		this.authority = options.authority;
		this.budget = options.budget;
		this.port = options.port;
		this.targets = options.targets;
		this.estimates = { ...DEFAULT_AUXILIARY_ESTIMATES, ...options.estimates };
		this.now = options.now ?? Date.now;
	}

	/** Intake route classification (R1.2): decides direct/fixed/dynamic once per reception. */
	async classify(
		context: AuxiliaryCallContext,
		task: string,
		candidates: ModelTarget[],
		signal: AbortSignal,
	): Promise<RouteDecision> {
		return routeClassifier(this.sharedGenerate("reception", "classify", this.targets.classifier, context)).classify(
			task,
			candidates,
			signal,
		);
	}

	/** Skill compilation; approvedBindings is mandatory and every declared tool must be operator-approved (R4.6). */
	async compileSkill(
		context: AuxiliaryCallContext,
		input: SkillCompileInput,
		signal: AbortSignal,
	): Promise<RuntimeSkill> {
		if (!Array.isArray(input?.approvedBindings))
			throw new Error("Skill compilation requires operator-approved tool bindings");
		return skillCompiler(this.sharedGenerate("skill-compile", "auxiliary", this.targets.compiler, context)).compile(
			input,
			signal,
		);
	}

	/** Automatic Skill grouping (R4.3): discovery classifies only; it never activates or writes. */
	async groupSkill(
		context: AuxiliaryCallContext,
		source: SkillSource,
		groups: string[],
		signal: AbortSignal,
		installed: SkillSource[] = [],
	): Promise<SkillGrouping> {
		return chooseSkillGroup(
			source,
			groups,
			this.sharedGenerate("skill-compile", "auxiliary", this.targets.compiler, context),
			signal,
			installed,
		);
	}

	/** Memory distillation of one untrusted historical record; the extractor validates the model output shape. */
	async enrich(context: AuxiliaryCallContext, input: AuxiliaryRecordInput, signal: AbortSignal): Promise<unknown> {
		return memoryExtractor(
			this.targets.enrich.id,
			this.sharedGenerate("distill", "auxiliary", this.targets.enrich, context),
		).extract(input, signal);
	}

	/** Bounded project planning against operator-supplied model/role/check vocabularies (R8.6). */
	async plan(
		context: AuxiliaryCallContext,
		objective: string,
		repositoryFacts: string,
		vocabulary: { models: string[]; roles: string[]; checkIds: string[] },
		signal: AbortSignal,
	): Promise<ProjectPlanEntry[]> {
		return projectPlan(
			objective,
			repositoryFacts,
			vocabulary.models,
			vocabulary.roles,
			vocabulary.checkIds,
			this.sharedGenerate("planning", "auxiliary", this.targets.planner, context),
			signal,
		);
	}

	/**
	 * One shared generate discipline: verify the C1 credential against the authority, authorize the
	 * scope, reserve C3 capacity before the request is dispatched, propagate the caller's signal and
	 * settle measured usage - or a conservative unknown booking, never zero.
	 */
	private sharedGenerate(
		kind: AuxiliaryMeteredKind,
		purpose: AuxiliaryModelPurpose,
		target: ModelTarget,
		context: AuxiliaryCallContext,
	): GenerateText {
		return async (prompt, signal) => this.runAttempt(kind, purpose, target, context, prompt, signal);
	}

	private async runAttempt(
		kind: AuxiliaryMeteredKind,
		purpose: AuxiliaryModelPurpose,
		target: ModelTarget,
		context: AuxiliaryCallContext,
		prompt: string,
		signal: AbortSignal,
	): Promise<string> {
		signal.throwIfAborted(); // A pre-dispatch abort consumes no budget.
		parseScope(context.scope);
		if (context.taskId !== null && typeof context.taskId !== "string") throw new Error("Invalid task attribution");
		this.authority.assertRead(context.credential, context.scope); // Re-verify identity on every call.
		const estimate = this.estimates[kind];
		if (!estimate) throw new Error(`Missing auxiliary estimate for ${kind}`);
		const reservation = this.budget.reserve(context.taskId, kind, estimate.estimate, this.now());
		let measurement: AuxiliaryUsageMeasurement | undefined;
		let reported = false;
		const onUsage = (usage: AuxiliaryUsageMeasurement): void => {
			if (!reported) {
				reported = true;
				measurement = structuredClone(usage);
			}
		};
		try {
			const text = await this.port.attempt(
				{ requestId: this.port.newRequestId(), purpose, target, signal, prompt },
				onUsage,
			);
			this.settleReservation(reservation.reservationId, measurement, estimate.unknown);
			return text;
		} catch (error) {
			this.settleReservation(reservation.reservationId, measurement, estimate.unknown);
			throw error;
		}
	}

	private settleReservation(
		reservationId: string,
		measurement: AuxiliaryUsageMeasurement | undefined,
		unknownBooking: UsageMeasure,
	): void {
		if (
			measurement?.inputTokens !== undefined &&
			measurement.outputTokens !== undefined &&
			measurement.cacheReadTokens !== undefined &&
			measurement.cacheWriteTokens !== undefined &&
			measurement.costUsd !== undefined
		) {
			this.budget.settle(reservationId, {
				inputTokens: measurement.inputTokens,
				outputTokens: measurement.outputTokens,
				cacheReadTokens: measurement.cacheReadTokens,
				cacheWriteTokens: measurement.cacheWriteTokens,
				costUsd: measurement.costUsd,
			});
			return;
		}
		// Unknown usage books a bounded conservative amount; it is never written down as zero (C3).
		this.budget.settleUnknown(reservationId, unknownBooking);
	}
}

/**
 * Resolves the auxiliary model targets a validated runtime configuration names. Every referenced
 * id (models.intakeId, skills.compilerModelId, memory.modelId, project.plannerModelId) must be a
 * configured, enabled target; a missing or disabled reference is rejected.
 */
export function resolveAuxiliaryTargets(config: RuntimeConfig): AuxiliaryModelTargets {
	const models = config.models;
	if (!models) throw new Error("Auxiliary invocations require configured model targets");
	const find = (id: string | undefined, section: string): ModelTarget => {
		if (id === undefined) throw new Error(`Auxiliary model target is not configured: ${section}`);
		const target = models?.targets.find((candidate) => candidate.id === id);
		if (!target || !target.enabled) throw new Error(`Auxiliary model target unavailable: ${section}=${id}`);
		return target;
	};
	return {
		classifier: find(models.intakeId, "models.intakeId"),
		compiler: find(config.skills?.compilerModelId, "skills.compilerModelId"),
		enrich: find(config.memory?.modelId, "memory.modelId"),
		planner: find(config.project?.plannerModelId, "project.plannerModelId"),
	};
}
