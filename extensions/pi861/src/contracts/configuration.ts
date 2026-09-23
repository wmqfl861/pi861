import { digest } from "./hash.ts";
import type { OutboundRule, ResolvedOutbound, ToolGrant } from "./identity.ts";
import { isValidScope, resolveOutbound } from "./identity.ts";

/**
 * C1 configuration contract: versioned, layered configuration with an explicit split between
 * behavior preferences (any layer may tune them) and permission ceilings (a more specific layer
 * may only NARROW them). Authorization never widens through configuration: a scope, outbound
 * rule or tool grant absent from the parent layer simply does not take effect. Documents are
 * loaded from trusted host configuration; a model-supplied document has no path into this
 * registry.
 */

export type ConfigLayerName = "global" | "project" | "role" | "agent" | "subagent";

export interface BehaviorPreferences {
	executionModePreference: "auto" | "direct" | "fixed" | "dynamic";
	failoverEnabled: boolean;
	failbackEnabled: boolean;
	memory: {
		autoRecall: boolean;
		autoCapture: boolean;
		autoDistill: boolean;
		activeTools: boolean;
		defaultReadDepth: 0 | 1 | 2;
	};
	planning: {
		lowWatermarkTasks: number;
		maxPlanTasks: number;
	};
	search: {
		enabled: boolean;
	};
}

export interface PermissionCeilings {
	maxConcurrentAttempts: number;
	maxRequestAttempts: number;
	readScopes: string[];
	writeScopes: string[];
	outbound: ResolvedOutbound;
	toolGrants: ToolGrant[];
}

export interface BehaviorPatch {
	executionModePreference?: BehaviorPreferences["executionModePreference"];
	failoverEnabled?: boolean;
	failbackEnabled?: boolean;
	memory?: Partial<BehaviorPreferences["memory"]>;
	planning?: Partial<BehaviorPreferences["planning"]>;
	search?: Partial<BehaviorPreferences["search"]>;
}

export interface CeilingsPatch {
	maxConcurrentAttempts?: number;
	maxRequestAttempts?: number;
	readScopes?: string[];
	writeScopes?: string[];
	outbound?: OutboundRule[];
	toolGrants?: ToolGrant[];
}

export function validateCeilings(ceilings: PermissionCeilings): void {
	if (
		!Number.isSafeInteger(ceilings.maxConcurrentAttempts) ||
		ceilings.maxConcurrentAttempts < 1 ||
		!Number.isSafeInteger(ceilings.maxRequestAttempts) ||
		ceilings.maxRequestAttempts < 1
	) {
		throw new Error("Ceiling limits must be positive integers");
	}
	if (
		!ceilings.readScopes.every(isValidScope) ||
		!ceilings.writeScopes.every(isValidScope) ||
		ceilings.writeScopes.some((scope) => !ceilings.readScopes.includes(scope))
	) {
		throw new Error("Ceiling scopes must be canonical and write must stay within read");
	}
	for (const grant of ceilings.toolGrants) {
		if (
			!grant.serviceId ||
			!grant.toolName ||
			!grant.accountId ||
			!grant.resourceIds.length ||
			grant.resourceIds.some((resource) => !resource)
		)
			throw new Error("Incomplete ceiling tool grant");
	}
}

function validateBehaviorPatch(patch: BehaviorPatch): void {
	if (
		patch.executionModePreference !== undefined &&
		!["auto", "direct", "fixed", "dynamic"].includes(patch.executionModePreference)
	)
		throw new Error("Invalid execution mode preference");
	if (patch.memory?.defaultReadDepth !== undefined && ![0, 1, 2].includes(patch.memory.defaultReadDepth)) {
		throw new Error("Invalid default read depth");
	}
	if (patch.planning !== undefined) {
		for (const value of [patch.planning.lowWatermarkTasks, patch.planning.maxPlanTasks]) {
			if (value !== undefined && (!Number.isSafeInteger(value) || value < 1))
				throw new Error("Invalid planning preference");
		}
	}
}

function validateCeilingsPatch(patch: CeilingsPatch): void {
	for (const value of [patch.maxConcurrentAttempts, patch.maxRequestAttempts]) {
		if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new Error("Invalid ceiling limit");
	}
	if (
		patch.readScopes?.some((scope) => !isValidScope(scope)) ||
		patch.writeScopes?.some((scope) => !isValidScope(scope))
	) {
		throw new Error("Ceiling override scopes must be canonical");
	}
	if (patch.outbound) resolveOutbound(patch.outbound);
	for (const grant of patch.toolGrants ?? []) {
		if (
			!grant.serviceId ||
			!grant.toolName ||
			!grant.accountId ||
			!grant.resourceIds.length ||
			grant.resourceIds.some((resource) => !resource)
		)
			throw new Error("Incomplete ceiling tool grant");
	}
}

function cloneBehavior(base: BehaviorPreferences): BehaviorPreferences {
	return {
		executionModePreference: base.executionModePreference,
		failoverEnabled: base.failoverEnabled,
		failbackEnabled: base.failbackEnabled,
		memory: { ...base.memory },
		planning: { ...base.planning },
		search: { ...base.search },
	};
}

function applyBehavior(base: BehaviorPreferences, patch: BehaviorPatch | undefined): BehaviorPreferences {
	const next = cloneBehavior(base);
	if (!patch) return next;
	if (patch.executionModePreference !== undefined) next.executionModePreference = patch.executionModePreference;
	if (patch.failoverEnabled !== undefined) next.failoverEnabled = patch.failoverEnabled;
	if (patch.failbackEnabled !== undefined) next.failbackEnabled = patch.failbackEnabled;
	if (patch.memory) Object.assign(next.memory, patch.memory);
	if (patch.planning) Object.assign(next.planning, patch.planning);
	if (patch.search) Object.assign(next.search, patch.search);
	validateBehaviorPatch(next as BehaviorPatch);
	return next;
}

function intersect(left: readonly string[], right: readonly string[]): string[] {
	return left.filter((value) => right.includes(value));
}

function narrowOutbound(base: ResolvedOutbound, patch: OutboundRule[] | undefined): ResolvedOutbound {
	if (patch === undefined) return structuredClone(base);
	if (!patch.length) return { rules: [], allowPrivateNetworks: false };
	const narrowed = resolveOutbound(patch);
	const rules = base.rules.flatMap((rule) => {
		const match = narrowed.rules.find((candidate) => candidate.hostPattern === rule.hostPattern);
		if (!match) return [];
		const protocols = rule.protocols.filter((protocol) => match.protocols.includes(protocol));
		if (!protocols.length) return [];
		return [
			{
				hostPattern: rule.hostPattern,
				protocols: [...protocols],
				allowPrivateNetworks: rule.allowPrivateNetworks && match.allowPrivateNetworks,
			},
		];
	});
	return { rules, allowPrivateNetworks: base.allowPrivateNetworks && narrowed.allowPrivateNetworks };
}

function narrowGrants(base: readonly ToolGrant[], patch: readonly ToolGrant[] | undefined): ToolGrant[] {
	if (!patch) return base.map((grant) => ({ ...grant, resourceIds: [...grant.resourceIds] }));
	const narrowed: ToolGrant[] = [];
	for (const grant of base) {
		for (const limit of patch) {
			if (
				limit.serviceId !== grant.serviceId ||
				limit.toolName !== grant.toolName ||
				limit.accountId !== grant.accountId
			)
				continue;
			const resourceIds = grant.resourceIds.filter((resource) => limit.resourceIds.includes(resource));
			if (resourceIds.length)
				narrowed.push({
					serviceId: grant.serviceId,
					toolName: grant.toolName,
					accountId: grant.accountId,
					resourceIds,
				});
		}
	}
	return narrowed;
}

function cloneCeilings(base: PermissionCeilings): PermissionCeilings {
	return {
		maxConcurrentAttempts: base.maxConcurrentAttempts,
		maxRequestAttempts: base.maxRequestAttempts,
		readScopes: [...base.readScopes],
		writeScopes: [...base.writeScopes],
		outbound: structuredClone(base.outbound),
		toolGrants: base.toolGrants.map((grant) => ({ ...grant, resourceIds: [...grant.resourceIds] })),
	};
}

function narrowCeilings(base: PermissionCeilings, patch: CeilingsPatch | undefined): PermissionCeilings {
	if (!patch) return cloneCeilings(base);
	validateCeilingsPatch(patch);
	const readScopes = patch.readScopes ? intersect(base.readScopes, patch.readScopes) : [...base.readScopes];
	const writeCandidate = patch.writeScopes ? intersect(base.writeScopes, patch.writeScopes) : [...base.writeScopes];
	const result: PermissionCeilings = {
		maxConcurrentAttempts:
			patch.maxConcurrentAttempts !== undefined
				? Math.min(base.maxConcurrentAttempts, patch.maxConcurrentAttempts)
				: base.maxConcurrentAttempts,
		maxRequestAttempts:
			patch.maxRequestAttempts !== undefined
				? Math.min(base.maxRequestAttempts, patch.maxRequestAttempts)
				: base.maxRequestAttempts,
		readScopes: [...readScopes].sort(),
		writeScopes: intersect(writeCandidate, readScopes).sort(),
		outbound: narrowOutbound(base.outbound, patch.outbound),
		toolGrants: narrowGrants(base.toolGrants, patch.toolGrants),
	};
	validateCeilings(result);
	return result;
}

export interface ConfigDocument {
	version: 1;
	layer: ConfigLayerName;
	ownerId: string;
	revision: string;
	behavior?: BehaviorPatch;
	ceilings?: CeilingsPatch;
	documentDigest: string;
}

export interface ResolvedConfiguration {
	behavior: BehaviorPreferences;
	ceilings: PermissionCeilings;
	resolutionPath: string[];
}

export interface ConfigPin {
	pinnedDigest: string;
	epoch: number;
	pinnedAt: number;
}

function layerDocument(
	layer: ConfigLayerName,
	ownerId: string,
	revision: string,
	behavior: BehaviorPatch | undefined,
	ceilings: CeilingsPatch | undefined,
): ConfigDocument {
	if (layer !== "project" && layer !== "role" && layer !== "agent")
		throw new Error("Only override layers are stored as documents");
	if (!ownerId || ownerId.length > 200 || !revision || revision.length > 200)
		throw new Error("Invalid configuration document identity");
	if (behavior) validateBehaviorPatch(behavior);
	if (ceilings) validateCeilingsPatch(ceilings);
	const document: ConfigDocument = { version: 1, layer, ownerId, revision, documentDigest: "" };
	if (behavior) document.behavior = structuredClone(behavior);
	if (ceilings) document.ceilings = structuredClone(ceilings);
	document.documentDigest = digest([
		"config",
		layer,
		ownerId,
		revision,
		document.behavior ?? null,
		document.ceilings ?? null,
	]);
	return document;
}

/**
 * Single-owner registry of layered configuration. The constructor takes the trusted global
 * defaults (full ceilings; there is nothing to narrow from yet). Runtime modification goes
 * through put(): it advances the epoch so previously pinned executions stay on their pinned
 * digest while new resolutions observe the change.
 */
export class ConfigurationRegistry {
	private readonly documents = new Map<string, ConfigDocument>();
	private readonly globalBehavior: BehaviorPreferences;
	private readonly globalCeilings: PermissionCeilings;
	private epoch = 0;

	constructor(global: { behavior: BehaviorPreferences; ceilings: PermissionCeilings; revision: string }) {
		validateBehaviorPatch(global.behavior);
		validateCeilings(global.ceilings);
		if (!global.revision) throw new Error("Global configuration revision required");
		this.globalBehavior = cloneBehavior(global.behavior);
		this.globalCeilings = cloneCeilings(global.ceilings);
	}

	put(input: {
		layer: ConfigLayerName;
		ownerId: string;
		revision: string;
		behavior?: BehaviorPatch;
		ceilings?: CeilingsPatch;
	}): void {
		const candidate = layerDocument(input.layer, input.ownerId, input.revision, input.behavior, input.ceilings);
		const key = `${candidate.layer}:${candidate.ownerId}`;
		const existing = this.documents.get(key);
		if (existing) {
			if (existing.revision === candidate.revision) {
				if (existing.documentDigest !== candidate.documentDigest)
					throw new Error("Configuration revisions are immutable");
				return;
			}
		}
		this.documents.set(key, candidate);
		this.epoch++;
	}

	resolve(selector: { projectId?: string; roleId?: string; agentId?: string }): ResolvedConfiguration {
		const chain: ConfigDocument[] = [];
		const wanted: [ConfigLayerName, string | undefined][] = [
			["project", selector.projectId],
			["role", selector.roleId],
			["agent", selector.agentId],
		];
		for (const [layer, ownerId] of wanted) {
			if (!ownerId) continue;
			const document = this.documents.get(`${layer}:${ownerId}`);
			if (document) chain.push(document);
		}
		let behavior = cloneBehavior(this.globalBehavior);
		let ceilings = cloneCeilings(this.globalCeilings);
		for (const document of chain) {
			behavior = applyBehavior(behavior, document.behavior);
			ceilings = narrowCeilings(ceilings, document.ceilings);
		}
		return {
			behavior,
			ceilings,
			resolutionPath: ["global", ...chain.map((document) => `${document.layer}:${document.ownerId}`)],
		};
	}

	get configurationEpoch(): number {
		return this.epoch;
	}

	pin(resolved: ResolvedConfiguration, now: number): ConfigPin {
		return { pinnedDigest: digest(["config-pin", resolved]), epoch: this.epoch, pinnedAt: now };
	}

	snapshot(): { version: 1; epoch: number; documents: ConfigDocument[] } {
		return {
			version: 1,
			epoch: this.epoch,
			documents: [...this.documents.values()].map((document) => structuredClone(document)),
		};
	}

	restore(snapshot: { version: 1; epoch: number; documents: ConfigDocument[] }): void {
		if (
			snapshot.version !== 1 ||
			!Number.isSafeInteger(snapshot.epoch) ||
			snapshot.epoch < 0 ||
			!Array.isArray(snapshot.documents)
		)
			throw new Error("Invalid configuration snapshot");
		const restored = new Map<string, ConfigDocument>();
		for (const stored of snapshot.documents) {
			const candidate = layerDocument(
				stored.layer,
				stored.ownerId,
				stored.revision,
				stored.behavior,
				stored.ceilings,
			);
			if (candidate.documentDigest !== stored.documentDigest)
				throw new Error("Restored document fails integrity re-derivation");
			restored.set(`${candidate.layer}:${candidate.ownerId}`, candidate);
		}
		this.documents.clear();
		for (const [key, document] of restored) this.documents.set(key, document);
		this.epoch = snapshot.epoch + 1;
	}
}

/** Sub-agent inheritance: behavior is inherited unchanged; ceilings only narrow. */
export function deriveSubagentConfiguration(
	parent: ResolvedConfiguration,
	restriction: CeilingsPatch,
): ResolvedConfiguration {
	return {
		behavior: cloneBehavior(parent.behavior),
		ceilings: narrowCeilings(parent.ceilings, restriction),
		resolutionPath: [...parent.resolutionPath, `subagent:${digest(["restriction", restriction]).slice(0, 12)}`],
	};
}
