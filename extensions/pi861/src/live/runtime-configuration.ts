import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { Role } from "../capabilities.ts";
import { ModelRecovery } from "../routing.ts";
import { record } from "../search.ts";
import type { WorkerIdentity } from "./coordinator.ts";
import type { McpServer } from "./mcp.ts";
import type { ModelPolicy } from "./model-runtime.ts";
import type { ResourceRule } from "./skills-host.ts";
import type { CheckCommand } from "./workspace.ts";

/**
 * Structural port of P2-E's WebReadLimits (src/web-read.ts) until the web module lands on this
 * baseline. Fields are identical to the staged web-read.ts shape, so the swap to the real import
 * is a no-op; keeping a copy here lets the S-owned runtime configuration type-check standalone.
 */
export interface RuntimeWebReadLimits {
	maxBytes: number;
	maxRawBytes: number;
	timeoutMs: number;
	idleTimeoutMs: number;
	maxRedirects: number;
	inlineLimit: number;
}

/** Structural port of P2-E's WebAuthorization (src/live/web-host.ts: WebIdentity plus request kind). */
export interface RuntimeWebAuthorization {
	owner: string;
	scope: string;
	kind: "search" | "web-read" | "result";
	url?: string;
}

export interface RuntimeWebConfig {
	search?: {
		enabled: boolean;
		apiKeyEnv?: string;
		maxResults?: number;
		maxResponseBytes?: number;
		timeoutMs?: number;
	};
	read?: {
		enabled: boolean;
		allowedHosts: string[];
		limits?: Partial<RuntimeWebReadLimits>;
		allowLoopbackHttp?: boolean;
	};
	roleIds: string[];
	maxRequests: number;
	allowWorkerWeb?: boolean;
}

export interface RemoteWorkerEntry {
	identity: WorkerIdentity;
	url: string;
	tokenEnv: string;
	allowLoopbackHttp?: boolean;
}
export interface ProjectConfig {
	repository: string;
	worktreeRoot: string;
	cli: string;
	maxConcurrent: number;
	maxTasks?: number;
	checks: CheckCommand[];
	plannerModelId: string;
	allowWorkerShell?: boolean;
	workerEnv?: Record<string, string>;
	workerExtensionPaths?: string[];
	remoteWorkers?: RemoteWorkerEntry[];
	rpcTimeoutMs?: number;
}
export interface RuntimeConfig {
	version: 2;
	projectId: string;
	stateDirectory: string;
	tenantId?: string;
	agentId?: string;
	database?: { urlEnv: string; driverRoot?: string };
	role: Role;
	roles?: Role[];
	environment?: string[];
	mcp?: McpServer[];
	resourceRules?: ResourceRule[];
	models?: ModelPolicy & { intakeId: string; enableRouting?: boolean; maxOutputTokens?: number };
	memory?: {
		autoRecall?: boolean;
		autoCapture?: boolean;
		autoEnrich?: boolean;
		activeTools?: boolean;
		modelId?: string;
		maxJobsPerWake?: number;
	};
	skills?: { compilerModelId?: string };
	project?: ProjectConfig;
	budget?: { maxRequests: number };
	web?: RuntimeWebConfig;
}

function object(value: unknown, name: string): Record<string, unknown> {
	const result = record(value);
	if (!result) throw new Error(`Invalid runtime ${name}: object required`);
	return result;
}
function string(value: unknown, name: string): string {
	if (typeof value !== "string" || !value.trim() || value.includes("\0"))
		throw new Error(`Invalid runtime ${name}: nonempty string required`);
	return value;
}
function strings(value: unknown, name: string): string[] {
	if (
		!Array.isArray(value) ||
		!value.every((item): item is string => typeof item === "string" && !item.includes("\0"))
	) {
		throw new Error(`Invalid runtime ${name}: string array required`);
	}
	return value;
}
function integer(value: unknown, name: string, minimum = 1): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > 2_147_483_647)
		throw new Error(`Invalid runtime ${name}: bounded integer required`);
	return value;
}
function optionalBooleans(value: Record<string, unknown>, names: string[]): void {
	for (const name of names)
		if (value[name] !== undefined && typeof value[name] !== "boolean")
			throw new Error(`Invalid runtime ${name}: boolean required`);
}
function absolutePath(value: unknown, name: string): string {
	const path = string(value, name);
	if (!isAbsolute(path)) throw new Error(`Runtime ${name} must be an absolute trusted path`);
	return path;
}
function stringMap(value: unknown, name: string): void {
	const fields = object(value, name);
	for (const [key, item] of Object.entries(fields)) {
		if (["__proto__", "prototype", "constructor"].includes(key) || typeof item !== "string" || item.includes("\0"))
			throw new Error(`Invalid runtime ${name}`);
	}
}
function role(value: unknown): Role {
	const source = object(value, "role");
	if (!Array.isArray(source.grants)) throw new Error("Runtime role grants are required");
	return {
		id: string(source.id, "role.id"),
		skillIds: strings(source.skillIds, "role.skillIds"),
		grants: source.grants.map((raw) => {
			const grant = object(raw, "grant");
			return {
				toolId: string(grant.toolId, "toolId"),
				accountId: string(grant.accountId, "accountId"),
				resourceIds: strings(grant.resourceIds, "resourceIds"),
			};
		}),
	};
}

/** Validate trusted JSON before any service, process, database pool or model request is created. */
export function validateRuntimeConfig(input: unknown): RuntimeConfig {
	const value = object(input, "configuration");
	if (value.version !== 2 || !/^[a-zA-Z0-9_-]+$/.test(string(value.projectId, "projectId")))
		throw new Error("Invalid Pi861 runtime configuration version/projectId");
	absolutePath(value.stateDirectory, "stateDirectory");
	for (const name of ["tenantId", "agentId"]) if (value[name] !== undefined) string(value[name], name);
	const roles = [role(value.role)];
	if (value.roles !== undefined) {
		if (!Array.isArray(value.roles)) throw new Error("Invalid runtime roles");
		roles.push(...value.roles.map(role));
	}
	if (new Set(roles.map((item) => item.id)).size !== roles.length) throw new Error("Duplicate runtime role identity");
	if (value.environment !== undefined) strings(value.environment, "environment");
	if (value.database !== undefined) {
		const database = object(value.database, "database");
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(string(database.urlEnv, "database.urlEnv")))
			throw new Error("Database credentials must reference an environment variable");
		if (database.driverRoot !== undefined) absolutePath(database.driverRoot, "database.driverRoot");
	}
	if (value.memory !== undefined) {
		const memory = object(value.memory, "memory");
		optionalBooleans(memory, ["autoRecall", "autoCapture", "autoEnrich", "activeTools"]);
		if (memory.modelId !== undefined) string(memory.modelId, "memory.modelId");
		if (memory.maxJobsPerWake !== undefined) integer(memory.maxJobsPerWake, "memory.maxJobsPerWake");
	}
	if (value.budget !== undefined) integer(object(value.budget, "budget").maxRequests, "budget.maxRequests");
	if (value.skills !== undefined) {
		const skills = object(value.skills, "skills");
		if (skills.compilerModelId !== undefined) string(skills.compilerModelId, "skills.compilerModelId");
	}
	if (value.models !== undefined) {
		const models = object(value.models, "models");
		if (!Array.isArray(models.targets) || !models.targets.length) throw new Error("Runtime model targets required");
		for (const raw of models.targets) {
			const target = object(raw, "model target");
			for (const name of ["id", "revision", "provider", "model"]) string(target[name], name);
			strings(target.capabilities, "model capabilities");
			if (typeof target.enabled !== "boolean") throw new Error("Model enabled must be boolean");
			for (const name of ["quality", "costRank", "contextWindow"])
				if (typeof target[name] !== "number" || !Number.isFinite(target[name]))
					throw new Error(`Invalid model ${name}`);
		}
		const recovery = object(models.recovery, "model recovery");
		if (typeof recovery.failoverEnabled !== "boolean" || typeof recovery.failbackEnabled !== "boolean")
			throw new Error("Explicit recovery switches required");
		for (const name of ["probeIntervalMs", "maxProbeIntervalMs", "requiredProbeSuccesses"])
			integer(recovery[name], name);
		const requirements = object(models.requirements, "model requirements");
		strings(requirements.allowedIds, "allowed model ids");
		strings(requirements.capabilities, "required capabilities");
		if (
			typeof requirements.minQuality !== "number" ||
			!Number.isFinite(requirements.minQuality) ||
			typeof requirements.contextTokens !== "number" ||
			!Number.isFinite(requirements.contextTokens)
		)
			throw new Error("Invalid model requirements");
		for (const name of ["maxAttempts", "requestTimeoutMs", "maxRequests"]) integer(models[name], name);
		integer(models.maxProbeRequests, "maxProbeRequests", 0);
		optionalBooleans(models, ["enableRouting"]);
		if (models.maxOutputTokens !== undefined) integer(models.maxOutputTokens, "maxOutputTokens");
		string(models.preferred, "preferred");
		string(models.intakeId, "intakeId");
	}
	if (value.mcp !== undefined) {
		if (!Array.isArray(value.mcp)) throw new Error("Invalid MCP servers");
		const identities = new Set<string>();
		for (const raw of value.mcp) {
			const server = object(raw, "MCP server"),
				transport = object(server.transport, "MCP transport");
			const identity = JSON.stringify([string(server.id, "MCP id"), string(server.accountId, "MCP account")]);
			if (identities.has(identity)) throw new Error("Duplicate MCP server/account");
			identities.add(identity);
			if (transport.kind === "stdio") {
				const process = object(transport.process, "MCP process");
				string(process.command, "MCP command");
				strings(process.args, "MCP args");
				absolutePath(process.cwd, "MCP cwd");
				if (process.env !== undefined) stringMap(process.env, "MCP environment");
			} else if (transport.kind === "http") {
				const url = new URL(string(transport.url, "MCP URL"));
				if (url.username || url.password || !["https:", "http:"].includes(url.protocol))
					throw new Error("Invalid MCP URL");
				optionalBooleans(transport, ["allowLoopbackHttp"]);
				if (transport.headers !== undefined) stringMap(transport.headers, "MCP headers");
			} else throw new Error("Unsupported MCP transport");
		}
	}
	if (value.resourceRules !== undefined) {
		if (!Array.isArray(value.resourceRules)) throw new Error("Invalid resource rules");
		for (const raw of value.resourceRules) {
			const rule = object(raw, "resource rule");
			for (const name of ["toolId", "accountId", "resourceId"]) string(rule[name], name);
			optionalBooleans(rule, ["endpointConfined", "readOnly"]);
			if (rule.equals !== undefined) object(rule.equals, "resource equality constraints");
		}
	}
	if (value.project !== undefined) {
		const project = object(value.project, "project");
		for (const name of ["repository", "worktreeRoot", "cli"]) absolutePath(project[name], `project.${name}`);
		integer(project.maxConcurrent, "project.maxConcurrent");
		string(project.plannerModelId, "project.plannerModelId");
		for (const name of ["maxTasks", "rpcTimeoutMs"])
			if (project[name] !== undefined) integer(project[name], `project.${name}`);
		optionalBooleans(project, ["allowWorkerShell"]);
		if (!Array.isArray(project.checks) || !project.checks.length) throw new Error("Trusted project checks required");
		for (const raw of project.checks) {
			const check = object(raw, "project check");
			string(check.id, "check id");
			string(check.command, "check command");
			strings(check.args, "check args");
			if (check.timeoutMs !== undefined) integer(check.timeoutMs, "check timeout");
			if (check.env !== undefined) stringMap(check.env, "check environment");
		}
		if (project.workerEnv !== undefined) stringMap(project.workerEnv, "worker environment");
		if (project.workerExtensionPaths !== undefined)
			for (const path of strings(project.workerExtensionPaths, "worker extensions"))
				absolutePath(path, "worker extension");
		if (project.remoteWorkers !== undefined) {
			if (!Array.isArray(project.remoteWorkers)) throw new Error("Invalid remote workers");
			for (const raw of project.remoteWorkers) {
				const worker = object(raw, "remote worker"),
					identity = object(worker.identity, "worker identity");
				string(identity.id, "worker id");
				for (const name of ["capabilities", "roleIds", "modelIds"]) strings(identity[name], `worker ${name}`);
				string(worker.url, "worker URL");
				string(worker.tokenEnv, "worker credential variable");
				optionalBooleans(worker, ["allowLoopbackHttp"]);
			}
		}
	}
	if (value.web !== undefined) {
		const web = object(value.web, "web");
		const roleIds = strings(web.roleIds, "web.roleIds");
		if (roleIds.some((id) => !roles.some((role) => role.id === id))) throw new Error("Unknown web role grant");
		integer(web.maxRequests, "web.maxRequests");
		optionalBooleans(web, ["allowWorkerWeb"]);
		for (const name of ["search", "read"]) {
			if (web[name] === undefined) continue;
			const service = object(web[name], `web.${name}`);
			if (typeof service.enabled !== "boolean") throw new Error("Explicit web service enabled switch required");
			if (name === "search") {
				if (service.apiKey !== undefined || service.backend !== undefined || service.fetch !== undefined)
					throw new Error("Web JSON accepts credential variable names and the configured Brave provider only");
				if (
					service.apiKeyEnv !== undefined &&
					!/^[A-Za-z_][A-Za-z0-9_]*$/.test(string(service.apiKeyEnv, "search credential variable"))
				)
					throw new Error("Invalid search credential variable");
				for (const limit of ["maxResults", "maxResponseBytes", "timeoutMs"])
					if (service[limit] !== undefined) integer(service[limit], `search.${limit}`);
			} else {
				for (const host of strings(service.allowedHosts, "web.read.allowedHosts")) {
					const url = new URL(`https://${host}`);
					if (url.hostname !== host.toLowerCase() || url.port || url.username || url.pathname !== "/")
						throw new Error("Web read hosts must be exact hostname grants");
				}
				optionalBooleans(service, ["allowLoopbackHttp"]);
				if (service.limits !== undefined)
					for (const [limit, amount] of Object.entries(object(service.limits, "web read limits"))) {
						if (
							!["maxBytes", "maxRawBytes", "timeoutMs", "idleTimeoutMs", "maxRedirects", "inlineLimit"].includes(
								limit,
							)
						)
							throw new Error("Unknown web read limit");
						integer(amount, `web.read.${limit}`, limit === "maxRedirects" ? 0 : 1);
					}
			}
		}
	}
	// Reconstruct required fields after validating every optional component above.
	const config: RuntimeConfig = {
		...structuredClone(value),
		version: 2,
		projectId: string(value.projectId, "projectId"),
		stateDirectory: absolutePath(value.stateDirectory, "stateDirectory"),
		role: role(value.role),
	};
	if (config.models) {
		new ModelRecovery(
			config.models.targets,
			config.models.preferred,
			config.models.requirements,
			config.models.recovery,
		);
		const requested = [
			config.models.intakeId,
			config.memory?.modelId,
			config.skills?.compilerModelId,
			config.project?.plannerModelId,
		].filter((id): id is string => id !== undefined);
		if (requested.some((id) => !config.models?.targets.some((target) => target.id === id && target.enabled)))
			throw new Error("Auxiliary model target unavailable");
	} else if (config.project || config.memory?.autoEnrich || config.skills?.compilerModelId)
		throw new Error("Requested runtime services require configured model targets");
	return config;
}

/** Hot-read permission check; result pages retain the same URL and principal policy. */
export function authorizeRuntimeWeb(config: RuntimeConfig, roleId: string, request: RuntimeWebAuthorization): boolean {
	const web = config.web;
	if (!web || !web.roleIds.includes(roleId) || !request.url) return false;
	const scope = `project:${config.projectId}`;
	const owner = JSON.stringify([config.tenantId ?? "local", config.agentId ?? "main", roleId, scope]);
	if (request.owner !== owner || request.scope !== scope) return false;
	let url: URL;
	try {
		url = new URL(request.url);
	} catch {
		return false;
	}
	if (url.username || url.password) return false;
	const search =
		web.search?.enabled === true &&
		url.origin === "https://api.search.brave.com" &&
		url.pathname === "/res/v1/web/search";
	const read =
		web.read?.enabled === true &&
		(url.protocol === "https:" || (web.read.allowLoopbackHttp === true && url.protocol === "http:")) &&
		web.read.allowedHosts.some((host) => host.toLowerCase() === url.hostname.toLowerCase());
	return request.kind === "search" ? search : request.kind === "web-read" ? read : search || read;
}

export function loadRuntimeConfig(path = process.env.PI861_CONFIG): RuntimeConfig {
	if (!path || !isAbsolute(path)) throw new Error("Set PI861_CONFIG to an absolute trusted JSON configuration path");
	return validateRuntimeConfig(JSON.parse(readFileSync(path, "utf8")));
}
