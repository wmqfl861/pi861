import { digest } from "./hash.ts";
import type { ToolGrant } from "./identity.ts";

/**
 * C5 capability contract: full tool identity (service, tool, account, resource, schema) and
 * immutable activation pins. A pinned Skill activation fixes the skill id, revision, branches,
 * phase and the exact tool identities it may use; a later schema change or grant withdrawal
 * invalidates the pin instead of silently re-authorizing it.
 */

export interface FullToolIdentity {
	serviceId: string;
	toolName: string;
	accountId: string;
	resourceId: string;
	schemaDigest: string;
}

export function toolIdentityDigest(identity: FullToolIdentity): string {
	return digest(["tool-identity", identity]);
}

export interface SchemaRegistration {
	serviceId: string;
	toolName: string;
	schemaDigest: string;
	registeredAt: number;
}

export class SchemaDriftError extends Error {
	readonly serviceId: string;
	readonly toolName: string;
	constructor(serviceId: string, toolName: string) {
		super(`Tool schema changed or missing; reactivate the skill: ${serviceId}/${toolName}`);
		this.serviceId = serviceId;
		this.toolName = toolName;
	}
}

/** Registry of the CURRENT schema digest per (service, tool); M2's catalog keeps the full history. */
export class ToolSchemaRegistry {
	private readonly current = new Map<string, SchemaRegistration>();

	register(serviceId: string, toolName: string, schemaDigest: string, now: number): SchemaRegistration {
		this.validateKey(serviceId, toolName);
		if (!schemaDigest || schemaDigest.length > 200 || !Number.isFinite(now)) throw new Error("Invalid schema registration");
		const key = `${serviceId}/${toolName}`;
		const existing = this.current.get(key);
		if (existing && existing.schemaDigest === schemaDigest) return { ...existing };
		const registration: SchemaRegistration = { serviceId, toolName, schemaDigest, registeredAt: now };
		this.current.set(key, registration);
		return { ...registration };
	}

	currentSchema(serviceId: string, toolName: string): SchemaRegistration | undefined {
		this.validateKey(serviceId, toolName);
		const registration = this.current.get(`${serviceId}/${toolName}`);
		return registration ? { ...registration } : undefined;
	}

	/** True when the pinned digest no longer matches the live schema (including unknown tools). */
	drifted(identity: FullToolIdentity): boolean {
		const registration = this.current.get(`${identity.serviceId}/${identity.toolName}`);
		return registration?.schemaDigest !== identity.schemaDigest;
	}

	private validateKey(serviceId: string, toolName: string): void {
		if (!serviceId || serviceId.length > 200 || !toolName || toolName.length > 200 ||
			serviceId.includes("/") || toolName.includes("/")) throw new Error("Invalid tool identity key");
	}
}

export interface ActivationPin {
	skillId: string;
	skillRevision: string;
	branchIds: string[];
	phase: string;
	tools: FullToolIdentity[];
	pinDigest: string;
	createdAt: number;
}

/** Creates an immutable, content-addressed pin; the running task keeps this version until it ends. */
export function pinActivation(input: Omit<ActivationPin, "pinDigest">): ActivationPin {
	if (!input.skillId || input.skillId.length > 200 || !input.skillRevision || input.skillRevision.length > 200 ||
		!input.phase || input.phase.length > 120 || !Number.isFinite(input.createdAt)) throw new Error("Invalid activation pin input");
	if (!input.branchIds.length || new Set(input.branchIds).size !== input.branchIds.length ||
		input.branchIds.some((branch) => !branch || branch.length > 200)) throw new Error("Activation pins need distinct branches");
	if (!input.tools.length) throw new Error("Activation pins need at least one tool binding");
	for (const tool of input.tools) {
		if (!tool.serviceId || !tool.toolName || !tool.accountId || !tool.resourceId || !tool.schemaDigest) {
			throw new Error("Incomplete tool identity in activation pin");
		}
	}
	const distinct = new Set(input.tools.map(toolIdentityDigest));
	if (distinct.size !== input.tools.length) throw new Error("Duplicate tool identity in activation pin");
	const pin: ActivationPin = { ...structuredClone(input), pinDigest: "" };
	pin.pinDigest = digest(["activation-pin", pin.skillId, pin.skillRevision, pin.branchIds, pin.phase, pin.tools]);
	return pin;
}

export function grantCovers(grants: readonly ToolGrant[], identity: FullToolIdentity): boolean {
	return grants.some((grant) => grant.serviceId === identity.serviceId && grant.toolName === identity.toolName &&
		grant.accountId === identity.accountId && grant.resourceIds.includes(identity.resourceId));
}

/**
 * Per-call authorization: the binding must exist in the pin, remain covered by the CURRENT
 * grants, and match the CURRENT schema. A changed schema raises SchemaDriftError; the caller
 * must re-derive a new activation pin instead of retrying the stale one.
 */
export function validateInvocation(pin: ActivationPin, registry: ToolSchemaRegistry, grants: readonly ToolGrant[],
	request: { serviceId: string; toolName: string; accountId: string; resourceId: string }): FullToolIdentity {
	if (!request.serviceId || !request.toolName || !request.accountId || !request.resourceId) throw new Error("Invalid tool request");
	const binding = pin.tools.find((tool) => tool.serviceId === request.serviceId && tool.toolName === request.toolName &&
		tool.accountId === request.accountId && tool.resourceId === request.resourceId);
	if (!binding) throw new Error("Tool call is not part of the pinned activation");
	if (!grantCovers(grants, binding)) throw new Error("Tool call not authorized by current grants");
	if (registry.drifted(binding)) throw new SchemaDriftError(binding.serviceId, binding.toolName);
	return structuredClone(binding);
}
