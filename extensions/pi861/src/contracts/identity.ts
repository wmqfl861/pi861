import { digest } from "./hash.ts";

/**
 * C1 identity contract: trusted principals, roles, authorization scopes, outbound policy and the
 * execution identity chain. Credentials are minted ONLY by an IdentityAuthority constructed from
 * trusted host configuration; values supplied by a model (tenant/role/scope fields) can never mint
 * or widen a credential. Wire-level authentication for remote nodes is layered on top by M4.
 */

export type ScopeKind = "user" | "project" | "group" | "agent" | "task" | "shared";
const SCOPE_PATTERN = /^(user|project|group|agent|task|shared):[a-z0-9][a-z0-9._/-]{0,200}$/;

export interface ScopeId {
	kind: ScopeKind;
	key: string;
}

export function formatScope(scope: ScopeId): string {
	return `${scope.kind}:${scope.key}`;
}

export function parseScope(value: string): ScopeId {
	if (typeof value !== "string" || !SCOPE_PATTERN.test(value))
		throw new Error(`Invalid authorization scope: ${value}`);
	const separator = value.indexOf(":");
	const kind = value.slice(0, separator) as ScopeKind;
	return { kind, key: value.slice(separator + 1) };
}

export function isValidScope(value: string): boolean {
	try {
		parseScope(value);
		return true;
	} catch {
		return false;
	}
}

function intersect(left: readonly string[], right: readonly string[]): string[] {
	return left.filter((value) => right.includes(value));
}

/** One outbound allowance. `hostPattern` is an exact host or a `*.example.com` suffix pattern. */
export interface OutboundRule {
	hostPattern: string;
	protocols: ("https" | "http")[];
	allowPrivateNetworks: boolean;
}

export interface ResolvedOutbound {
	rules: OutboundRule[];
	allowPrivateNetworks: boolean;
}

function normalizeHostPattern(pattern: string): string {
	const host = pattern.trim().toLowerCase();
	if (!host || host.includes("/") || host.includes(":") || host.includes("@"))
		throw new Error("Invalid outbound host pattern");
	if (host.startsWith("*.")) {
		const suffix = host.slice(2);
		if (!/^[a-z0-9.-]+$/.test(suffix) || suffix.startsWith(".") || suffix.endsWith("."))
			throw new Error("Invalid outbound wildcard pattern");
		return host;
	}
	if (!/^[a-z0-9.-]+$/.test(host)) throw new Error("Invalid outbound host pattern");
	return host;
}

function hostMatches(pattern: string, host: string): boolean {
	if (pattern.startsWith("*.")) {
		const suffix = pattern.slice(1); // ".example.com"
		return host === pattern.slice(2) || host.endsWith(suffix);
	}
	return host === pattern;
}

/** Literal-address guard for the private, loopback, link-local and cloud-metadata ranges. */
export function isPrivateNetworkHost(host: string): boolean {
	const literal = host.trim().toLowerCase();
	if (literal === "localhost" || literal.endsWith(".localhost") || literal.endsWith(".internal")) return true;
	if (literal.includes(":")) {
		const zone = literal.split("%", 1)[0] ?? literal;
		const firstGroup = zone.split(":")[0] ?? "";
		if (
			zone === "::" ||
			zone === "::1" ||
			firstGroup === "fe80" ||
			literal.startsWith("fc") ||
			literal.startsWith("fd")
		)
			return true;
		return false;
	}
	const groups = literal.split(".");
	if (groups.length !== 4 || groups.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return false;
	const first = Number(groups[0]);
	const second = Number(groups[1] ?? 0);
	return (
		first === 0 ||
		first === 10 ||
		first === 127 ||
		(first === 100 && second >= 64 && second <= 127) ||
		(first === 169 && second === 254) ||
		(first === 172 && second >= 16 && second <= 31) ||
		(first === 192 && second === 168) ||
		(first === 198 && (second === 18 || second === 19))
	);
}

export function outboundAllows(outbound: ResolvedOutbound, url: URL): boolean {
	if (url.username || url.password) return false;
	const protocol = url.protocol.replace(":", "");
	if (protocol !== "https" && protocol !== "http") return false;
	const host = url.hostname
		.trim()
		.toLowerCase()
		.replace(/^\[|\]$/g, "");
	if (!host) return false;
	const rule = outbound.rules.find(
		(candidate) =>
			hostMatches(candidate.hostPattern, host) && candidate.protocols.some((allowed) => allowed === protocol),
	);
	if (!rule) return false;
	if (!outbound.allowPrivateNetworks && isPrivateNetworkHost(host)) return false;
	return true;
}

export function resolveOutbound(rules: readonly OutboundRule[]): ResolvedOutbound {
	if (!rules.length) return { rules: [], allowPrivateNetworks: false };
	const normalized = rules
		.map((rule) => ({
			hostPattern: normalizeHostPattern(rule.hostPattern),
			protocols: [...new Set(rule.protocols.filter((protocol) => protocol === "https" || protocol === "http"))],
			allowPrivateNetworks: rule.allowPrivateNetworks === true,
		}))
		.filter((rule) => rule.protocols.length > 0);
	if (!normalized.length) throw new Error("Outbound rules lack a usable protocol");
	return { rules: normalized, allowPrivateNetworks: normalized.every((rule) => rule.allowPrivateNetworks) };
}

/** A tool grant names the exact service/account/resources a role may bind into Skill activations. */
export interface ToolGrant {
	serviceId: string;
	toolName: string;
	accountId: string;
	resourceIds: string[];
}

/** A role definition is trusted configuration; revisions are immutable once accepted. */
export interface RoleDefinition {
	id: string;
	revision: string;
	readScopes: string[];
	writeScopes: string[];
	outbound: OutboundRule[];
	toolGrants: ToolGrant[];
}

export interface PrincipalCredential {
	credentialId: string;
	tenantId: string;
	principalId: string;
	kind: "agent" | "subagent";
	roleIds: string[];
	parentPrincipalId?: string;
	readScopes: string[];
	writeScopes: string[];
	outbound: ResolvedOutbound;
	toolGrants: ToolGrant[];
	serial: number;
	issuedAt: number;
	issuerId: string;
	intentDigest: string;
}

export interface PrincipalRestriction {
	readScopes?: string[];
	writeScopes?: string[];
	outboundHostPatterns?: string[];
	toolGrants?: ToolGrant[];
}

export interface AuthoritySnapshot {
	version: 2;
	authorityId: string;
	tenantId: string;
	epoch: number;
	roles: RoleDefinition[];
	credentials: Omit<PrincipalCredential, "issuerId">[];
	revokedPrincipalIds: string[];
}

function credentialIntent(credential: PrincipalCredential): string {
	const { issuerId: _issuerId, intentDigest: _intentDigest, ...issued } = credential;
	return digest(["principal-v2", issued]);
}

function validateRole(role: RoleDefinition): void {
	if (!role.id || !/^[a-z0-9][a-z0-9-]{0,120}$/.test(role.id) || !role.revision || role.revision.length > 64) {
		throw new Error("Invalid role identity");
	}
	if (!role.readScopes.every(isValidScope) || !role.writeScopes.every(isValidScope))
		throw new Error("Role scopes must be canonical");
	if (role.writeScopes.some((scope) => !role.readScopes.includes(scope)))
		throw new Error("Role write scopes must be a subset of read scopes");
	for (const grant of role.toolGrants) {
		if (
			!grant.serviceId ||
			!grant.toolName ||
			!grant.accountId ||
			!grant.resourceIds.length ||
			grant.resourceIds.some((resource) => !resource)
		)
			throw new Error("Incomplete role tool grant");
	}
}

function resolveRoles(
	roles: readonly RoleDefinition[],
	roleIds: readonly string[],
): {
	readScopes: string[];
	writeScopes: string[];
	outbound: ResolvedOutbound;
	toolGrants: ToolGrant[];
} {
	const selected = roleIds.map((id) => {
		const role = roles.find((candidate) => candidate.id === id);
		if (!role) throw new Error(`Unknown role: ${id}`);
		return role;
	});
	if (!selected.length) throw new Error("A principal requires at least one role");
	const readScopes = [...new Set(selected.flatMap((role) => role.readScopes))];
	const writeScopes = [...new Set(selected.flatMap((role) => role.writeScopes))].filter((scope) =>
		readScopes.includes(scope),
	);
	const outbound = resolveOutbound(selected.flatMap((role) => role.outbound));
	const toolGrants = selected.flatMap((role) => role.toolGrants);
	return { readScopes: [...readScopes].sort(), writeScopes: [...writeScopes].sort(), outbound, toolGrants };
}

function applyRestriction(
	resolved: {
		readScopes: string[];
		writeScopes: string[];
		outbound: ResolvedOutbound;
		toolGrants: ToolGrant[];
	},
	restriction: PrincipalRestriction | undefined,
): void {
	if (!restriction) return;
	if (restriction.readScopes) {
		const allowed = intersect(resolved.readScopes, restriction.readScopes);
		resolved.writeScopes = intersect(resolved.writeScopes, allowed);
		resolved.readScopes = allowed;
	}
	if (restriction.writeScopes) resolved.writeScopes = intersect(resolved.writeScopes, restriction.writeScopes);
	if (restriction.outboundHostPatterns) {
		const patterns = restriction.outboundHostPatterns.map(normalizeHostPattern);
		resolved.outbound = {
			rules: resolved.outbound.rules.filter((rule) => patterns.includes(rule.hostPattern)),
			allowPrivateNetworks: resolved.outbound.allowPrivateNetworks,
		};
	}
	if (restriction.toolGrants) {
		resolved.toolGrants = resolved.toolGrants.filter((grant) =>
			restriction.toolGrants?.some(
				(limit) =>
					limit.serviceId === grant.serviceId &&
					limit.toolName === grant.toolName &&
					limit.accountId === grant.accountId &&
					grant.resourceIds.every((resource) => limit.resourceIds.includes(resource)),
			),
		);
	}
}

/**
 * Trusted issuance point. The host constructs exactly one authority per process from verified
 * configuration; `verify()` rejects any credential this authority did not issue or has revoked.
 */
export class IdentityAuthority {
	readonly authorityId: string;
	readonly tenantId: string;
	private readonly roles = new Map<string, RoleDefinition>();
	private readonly credentials = new Map<string, PrincipalCredential>();
	private readonly revoked = new Set<string>();
	private serial = 0;
	private epoch = 1;

	constructor(options: { authorityId: string; tenantId: string; roles: RoleDefinition[] }) {
		if (
			!options.authorityId ||
			options.authorityId.length > 200 ||
			!options.tenantId ||
			options.tenantId.length > 200
		) {
			throw new Error("Authority identity required");
		}
		this.authorityId = options.authorityId;
		this.tenantId = options.tenantId;
		for (const role of options.roles) this.defineRole(role);
	}

	defineRole(role: RoleDefinition): void {
		validateRole(role);
		const existing = this.roles.get(role.id);
		if (existing && existing.revision === role.revision && digest(existing) !== digest(role)) {
			throw new Error("Role revisions are immutable");
		}
		this.roles.set(role.id, structuredClone(role));
	}

	/** Issues a first-class agent credential from trusted role assignments; restrictions only narrow. */
	issue(
		principalId: string,
		options: { roleIds: string[]; restriction?: PrincipalRestriction; now?: number },
	): PrincipalCredential {
		const resolved = resolveRoles([...this.roles.values()], options.roleIds);
		applyRestriction(resolved, options.restriction);
		return this.record(principalId, "agent", options.roleIds, undefined, resolved, options.now ?? Date.now());
	}

	/** Sub-agent inheritance: starts from the parent's already-resolved permissions and only narrows. */
	deriveSubordinate(
		parent: PrincipalCredential,
		principalId: string,
		options: {
			restriction: PrincipalRestriction;
			now?: number;
		},
	): PrincipalCredential {
		const verified = this.verify(parent);
		const inherited: {
			readScopes: string[];
			writeScopes: string[];
			outbound: ResolvedOutbound;
			toolGrants: ToolGrant[];
		} = {
			readScopes: [...verified.readScopes],
			writeScopes: [...verified.writeScopes],
			outbound: {
				rules: [...verified.outbound.rules],
				allowPrivateNetworks: verified.outbound.allowPrivateNetworks,
			},
			toolGrants: verified.toolGrants.map((grant) => ({ ...grant, resourceIds: [...grant.resourceIds] })),
		};
		applyRestriction(inherited, options.restriction);
		return this.record(
			principalId,
			"subagent",
			[...verified.roleIds],
			verified.principalId,
			inherited,
			options.now ?? Date.now(),
		);
	}

	private record(
		principalId: string,
		kind: "agent" | "subagent",
		roleIds: string[],
		parentPrincipalId: string | undefined,
		resolved: { readScopes: string[]; writeScopes: string[]; outbound: ResolvedOutbound; toolGrants: ToolGrant[] },
		now: number,
	): PrincipalCredential {
		if (!principalId || principalId.length > 200 || !Number.isFinite(now))
			throw new Error("Invalid principal identity");
		if (resolved.writeScopes.some((scope) => !resolved.readScopes.includes(scope)))
			throw new Error("Write scopes must stay within read scopes");
		const credential: PrincipalCredential = {
			credentialId: digest([this.authorityId, principalId, this.serial + 1]),
			tenantId: this.tenantId,
			principalId,
			kind,
			roleIds: [...new Set(roleIds)].sort(),
			...(parentPrincipalId !== undefined ? { parentPrincipalId } : {}),
			readScopes: resolved.readScopes,
			writeScopes: resolved.writeScopes,
			outbound: resolved.outbound,
			toolGrants: resolved.toolGrants,
			serial: ++this.serial,
			issuedAt: now,
			issuerId: this.authorityId,
			intentDigest: "",
		};
		credential.intentDigest = credentialIntent(credential);
		this.credentials.set(credential.credentialId, credential);
		return structuredClone(credential);
	}

	/** Rejects forged, tampered, revoked and foreign credentials. A model-supplied shape never verifies. */
	verify(value: unknown): PrincipalCredential {
		if (!value || typeof value !== "object") throw new Error("Untrusted identity");
		const candidate = value as Partial<PrincipalCredential>;
		if (
			typeof candidate.credentialId !== "string" ||
			candidate.tenantId !== this.tenantId ||
			candidate.issuerId !== this.authorityId ||
			typeof candidate.principalId !== "string"
		)
			throw new Error("Untrusted identity");
		const record = this.credentials.get(candidate.credentialId);
		if (!record || record.principalId !== candidate.principalId) throw new Error("Untrusted identity");
		if (digest(record) !== digest(candidate)) throw new Error("Identity content does not match its issuance record");
		if (this.revoked.has(record.principalId)) throw new Error("Identity has been revoked");
		return structuredClone(record);
	}

	revoke(principalId: string): void {
		if (!principalId) throw new Error("Principal identity required");
		const pending = [principalId];
		const visited = new Set<string>();
		while (pending.length) {
			const current = pending.pop()!;
			if (visited.has(current)) continue;
			visited.add(current);
			this.revoked.add(current);
			for (const credential of this.credentials.values()) {
				if (credential.parentPrincipalId === current) pending.push(credential.principalId);
			}
		}
		this.epoch++;
	}

	get revokedPrincipalIds(): string[] {
		return [...this.revoked];
	}

	assertRead(principal: PrincipalCredential, scope: string): void {
		const verified = this.verify(principal);
		if (!verified.readScopes.includes(scope)) throw new Error(`Read not authorized for scope ${scope}`);
	}

	assertWrite(principal: PrincipalCredential, scope: string): void {
		const verified = this.verify(principal);
		if (!verified.writeScopes.includes(scope)) throw new Error(`Write not authorized for scope ${scope}`);
	}

	assertOutbound(principal: PrincipalCredential, url: URL): void {
		const verified = this.verify(principal);
		if (!outboundAllows(verified.outbound, url)) throw new Error(`Outbound access not authorized: ${url.host}`);
	}

	exportState(): AuthoritySnapshot {
		return {
			version: 2,
			authorityId: this.authorityId,
			tenantId: this.tenantId,
			epoch: this.epoch,
			roles: [...this.roles.values()].map((role) => structuredClone(role)),
			credentials: [...this.credentials.values()].map(({ issuerId: _issuerId, ...credential }) =>
				structuredClone(credential),
			),
			revokedPrincipalIds: [...this.revoked].sort(),
		};
	}

	/** Restoring re-derives issuance records; the epoch advances so pre-restore in-flight claims restale. */
	restore(snapshot: AuthoritySnapshot): void {
		if (
			snapshot.version !== 2 ||
			snapshot.authorityId !== this.authorityId ||
			snapshot.tenantId !== this.tenantId ||
			!Number.isSafeInteger(snapshot.epoch) ||
			snapshot.epoch < 1 ||
			!Array.isArray(snapshot.roles) ||
			!Array.isArray(snapshot.credentials) ||
			!Array.isArray(snapshot.revokedPrincipalIds) ||
			snapshot.revokedPrincipalIds.some((id) => typeof id !== "string" || !id || id.length > 200) ||
			new Set(snapshot.revokedPrincipalIds).size !== snapshot.revokedPrincipalIds.length
		)
			throw new Error("Invalid authority snapshot");
		const roles = new Map<string, RoleDefinition>();
		for (const role of snapshot.roles) {
			validateRole(role);
			roles.set(role.id, structuredClone(role));
		}
		const credentials = new Map<string, PrincipalCredential>();
		let serial = this.serial;
		for (const stored of snapshot.credentials) {
			const credential: PrincipalCredential = { ...structuredClone(stored), issuerId: this.authorityId };
			if (
				credentialIntent(credential) !== credential.intentDigest ||
				credential.tenantId !== this.tenantId ||
				!Number.isSafeInteger(credential.serial) ||
				credential.serial < 1 ||
				credentials.has(credential.credentialId)
			) {
				throw new Error("Restored credential fails integrity re-derivation");
			}
			credentials.set(credential.credentialId, credential);
			serial = Math.max(serial, credential.serial);
		}
		const revoked = new Set(snapshot.revokedPrincipalIds);
		for (const credential of credentials.values()) {
			if (
				credential.parentPrincipalId &&
				revoked.has(credential.parentPrincipalId) &&
				!revoked.has(credential.principalId)
			) {
				throw new Error("Invalid authority snapshot: missing descendant revocation");
			}
		}
		this.roles.clear();
		for (const [id, role] of roles) this.roles.set(id, role);
		this.credentials.clear();
		for (const [id, credential] of credentials) this.credentials.set(id, credential);
		this.revoked.clear();
		for (const id of revoked) this.revoked.add(id);
		this.serial = serial;
		this.epoch = snapshot.epoch + 1;
	}
}

/** The execution identity chain every workspace, request, session and artifact must carry. */
export interface ExecutionIdentity {
	tenantId: string;
	projectId: string;
	goalId: string;
	runId: string;
	taskId: string;
	attempt: number;
}

function identityPart(value: string): string {
	if (!value || value.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value))
		throw new Error("Invalid execution identity part");
	return value;
}

export function validateExecutionIdentity(identity: ExecutionIdentity): ExecutionIdentity {
	if (!Number.isSafeInteger(identity.attempt) || identity.attempt < 1) throw new Error("Attempts start at 1");
	return {
		tenantId: identityPart(identity.tenantId),
		projectId: identityPart(identity.projectId),
		goalId: identityPart(identity.goalId),
		runId: identityPart(identity.runId),
		taskId: identityPart(identity.taskId),
		attempt: identity.attempt,
	};
}

export function executionPath(identity: ExecutionIdentity): string {
	const valid = validateExecutionIdentity(identity);
	return [valid.tenantId, valid.projectId, valid.goalId, valid.runId, valid.taskId, String(valid.attempt)]
		.map(encodeURIComponent)
		.join("/");
}

export function parseExecutionPath(path: string): ExecutionIdentity {
	const parts = path.split("/").map(decodeURIComponent);
	if (parts.length !== 6) throw new Error("Execution identity paths have six parts");
	const attempt = Number(parts[5]);
	return validateExecutionIdentity({
		tenantId: parts[0] ?? "",
		projectId: parts[1] ?? "",
		goalId: parts[2] ?? "",
		runId: parts[3] ?? "",
		taskId: parts[4] ?? "",
		attempt,
	});
}
