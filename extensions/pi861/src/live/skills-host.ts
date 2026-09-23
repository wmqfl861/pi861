import type { PiContext, PiHost } from "../../index.ts";
import { type Activation, authorizeInvocation, type Role, type ToolBinding } from "../capabilities.ts";
import { type ExecutionIdentity, validateExecutionIdentity } from "../contracts/identity.ts";
import type { FullToolIdentity } from "../contracts/capability.ts";
import { digest } from "../memory.ts";
import { record } from "../search.ts";
import { type McpClient, McpFailure, type McpTool } from "./mcp.ts";
import type { OperationJournal } from "./operations.ts";
import type { SkillRepository } from "./skill-repository.ts";

export interface CapabilityHost extends PiHost {
	getActiveTools(): string[];
	setActiveTools(names: string[]): void;
}
export interface ResourceRule {
	toolId: string;
	accountId: string;
	resourceId: string;
	equals?: Record<string, unknown>;
	/** Explicit operator assertion: this dedicated endpoint already confines the resource. */
	endpointConfined?: boolean;
	/** Trusted classification, never copied from server annotations. */
	readOnly?: boolean;
	/** Stable business domain; arguments identify each distinct intent within it. */
	operationName?: string;
}
export interface CapabilityOptions {
	repository: SkillRepository;
	role: () => Role;
	clients: McpClient[];
	environment: string[];
	resourceRules: ResourceRule[];
	baseTools?: string[];
	maxResultBytes?: number;
	operations?: OperationJournal;
	/** Trusted task identity pins revisions until this attempt ends. */
	executionIdentity?: () => ExecutionIdentity | undefined;
	/**
	 * C7 scope for controlled references to oversized tool results. When supplied, stored
	 * references become scope-guarded: only roles whose readScopes include it can read them.
	 */
	resultScope?: string;
	deploymentMode?: "trusted-local" | "isolated";
	isolationEnforced?: boolean;
}
function requireText(value: unknown): string {
	if (typeof value !== "string" || !value.trim()) throw new Error("Nonempty string required");
	return value;
}
function array(value: unknown): string[] {
	if (!Array.isArray(value) || value.some((part) => typeof part !== "string"))
		throw new Error("String array required");
	return value;
}
/** Full dispatch identity: one server tool used by two accounts must never share a metadata entry. */
function bindingKey(binding: ToolBinding): string {
	return digest(binding);
}
function bindingName(activation: Activation, binding: ToolBinding): string {
	return `pi861_mcp_${digest([activation.skillId, activation.skillRevision, activation.branchIds, activation.phase, binding]).slice(0, 24)}`;
}
/** Splits "server/tool" into the C5 full tool identity tuple carried by operation intents. */
function c5Identity(binding: ToolBinding): { tool: FullToolIdentity } {
	const separator = binding.toolId.indexOf("/");
	if (separator <= 0 || separator === binding.toolId.length - 1)
		throw new McpFailure("MCP tool id must be namespaced as server/tool", "not_dispatched");
	return {
		tool: {
			serviceId: binding.toolId.slice(0, separator),
			toolName: binding.toolId.slice(separator + 1),
			accountId: binding.accountId,
			resourceId: binding.resourceId,
			schemaDigest: binding.schemaHash,
		},
	};
}

export function installCapabilities(pi: CapabilityHost, options: CapabilityOptions): { close(): Promise<void> } {
	if (options.deploymentMode === "isolated" && !options.isolationEnforced)
		throw new Error("Isolated capabilities require an enforced deployment boundary");
	// Two clients for one (server id, account) pair would make dispatch ambiguous; binding resolution
	// legitimately uses different accounts of the same server id, but never two clients for the same account.
	const endpoints = new Set<string>();
	for (const client of options.clients) {
		const endpoint = `${client.server.id}\u0000${client.server.accountId}`;
		if (endpoints.has(endpoint))
			throw new Error(
				`Duplicate MCP endpoint identity for server ${client.server.id} and account ${client.server.accountId}`,
			);
		endpoints.add(endpoint);
	}
	const activations = new Map<string, Activation>();
	const registered = new Set<string>();
	const pins = new Map<string, { execution: string; revision: string }>();
	let initial: string[] = [];
	let initialized = false;
	let epoch = 0;
	let base: string[] = [];
	function initialize(): void {
		if (initialized) return;
		initial = pi.getActiveTools();
		base = options.baseTools ?? initial.filter((name) => !name.startsWith("mcp_") && !name.startsWith("pi861_mcp_"));
		initialized = true;
	}
	function refresh(): void {
		if (!initialized) return;
		const names = [...activations.values()].flatMap((activation) =>
			activation.tools.map((binding) => bindingName(activation, binding)),
		);
		pi.setActiveTools([...new Set([...base, "pi861_capabilities", ...names])]);
	}
	function save(): void {
		pi.appendEntry(
			"pi861.capabilities.v2",
			[...activations.values()].map((value) => ({
				skillId: value.skillId,
				revision: value.skillRevision,
				branches: value.branchIds,
				phase: value.phase,
			})),
		);
	}
	async function describe(
		bindings: ToolBinding[],
		signal: AbortSignal,
	): Promise<Map<string, { client: McpClient; tool: McpTool }>> {
		const map = new Map<string, { client: McpClient; tool: McpTool }>();
		for (const binding of bindings) {
			const client = options.clients.find(
				(client) =>
					binding.toolId.startsWith(`${client.server.id}/`) && binding.accountId === client.server.accountId,
			);
			if (!client) throw new Error("Authorized MCP endpoint is not configured");
			const name = binding.toolId.slice(client.server.id.length + 1);
			const tool = (await client.tools(signal)).find((tool) => tool.name === name);
			if (!tool || tool.schemaHash !== binding.schemaHash) throw new Error("MCP metadata changed; rebuild binding");
			// Keyed by the complete binding identity: the same toolId under another account resolves
			// to that account's client and must not overwrite this entry.
			map.set(bindingKey(binding), { client, tool });
		}
		return map;
	}
	function enforceResource(binding: ToolBinding, args: Record<string, unknown>): void {
		const rule = options.resourceRules.find(
			(rule) =>
				rule.toolId === binding.toolId &&
				rule.accountId === binding.accountId &&
				rule.resourceId === binding.resourceId,
		);
		if (!rule || (!rule.endpointConfined && !Object.keys(rule.equals ?? {}).length))
			throw new Error("Missing executable resource confinement policy");
		for (const [path, value] of Object.entries(rule.equals ?? {})) {
			if (path.split(".").some((key) => ["__proto__", "prototype", "constructor"].includes(key)))
				throw new Error("Unsafe resource selector");
			let actual: unknown = args;
			for (const key of path.split(".")) {
				const object = record(actual);
				actual = object && Object.hasOwn(object, key) ? object[key] : undefined;
			}
			if (actual === undefined || digest(actual) !== digest(value))
				throw new Error("Tool arguments exceed resource authorization");
		}
	}
	// Resolve planned bindings without bypassing the catalog's grant check. It exposes no original source text.
	async function load(
		id: string,
		revision: string,
		branches: string[],
		phase: string,
		signal: AbortSignal,
	): Promise<Activation> {
		initialize();
		const execution = options.executionIdentity?.();
		const executionKey = execution ? digest(validateExecutionIdentity(execution)) : undefined;
		const pin = pins.get(id);
		if (executionKey && pin?.execution === executionKey && pin.revision !== revision)
			throw new Error("Running task Skill version is pinned");
		const generation = epoch;
		const catalog = await options.repository.catalog();
		const planned = await options.repository.bindingPlan(
			id,
			revision,
			branches,
			phase,
			options.role(),
			options.environment,
		);
		const metadata = await describe(planned, signal);
		const definitions = planned.map((binding) => {
			const entry = metadata.get(bindingKey(binding));
			if (!entry) throw new Error("Tool metadata missing");
			return { id: binding.toolId, schemaHash: entry.tool.schemaHash };
		});
		const activation = catalog.activate(
			options.role(),
			id,
			revision,
			branches,
			phase,
			options.environment,
			definitions,
		);
		if (
			generation !== epoch ||
			executionKey !== (options.executionIdentity?.() ? digest(options.executionIdentity?.()) : undefined)
		)
			throw new Error("Session or task changed during skill activation");
		if (executionKey) pins.set(id, { execution: executionKey, revision });
		for (const binding of activation.tools) {
			const entry = metadata.get(bindingKey(binding));
			if (!entry) throw new Error("Tool metadata missing");
			const name = bindingName(activation, binding);
			if (registered.has(name)) continue;
			registered.add(name);
			const identity = digest(activation);
			pi.registerTool({
				name,
				label: entry.tool.name,
				description: `${entry.tool.description}\nTool: ${binding.toolId}. Skill: ${activation.skillId}@${activation.skillRevision}.\nBound resource: ${binding.resourceId}. Use only for the activated Skill.`,
				parameters: entry.tool.inputSchema,
				execute: async (callId, args, inputSignal, _onUpdate, ctx) => {
					const effectiveSignal = inputSignal ?? new AbortController().signal;
					const callEpoch = epoch;
					const guard = (): void => {
						try {
							const current = activations.get(id),
								role = options.role();
							if (callEpoch !== epoch || !current || digest(current) !== identity)
								throw new Error("Skill is no longer active");
							if (executionKey && digest(options.executionIdentity?.()) !== executionKey)
								throw new Error("Skill task attempt ended");
							authorizeInvocation(
								current,
								role,
								[{ id: binding.toolId, schemaHash: binding.schemaHash }],
								binding,
							);
							enforceResource(binding, args);
						} catch (error) {
							throw new McpFailure(
								error instanceof Error ? error.message : "Skill authorization failed",
								"not_dispatched",
							);
						}
					};
					guard();
					const dispatch = async () => {
						const response = await entry.client.call(
							entry.tool.name,
							args,
							binding.schemaHash,
							effectiveSignal,
							guard,
						);
						const serialized = JSON.stringify(response);
						const maxBytes = options.maxResultBytes ?? 32_000;
						if (Buffer.byteLength(serialized) > maxBytes) {
							const producedBy = options.executionIdentity?.();
							if (producedBy) validateExecutionIdentity(producedBy);
							const reference = await options.repository.storeResult(response, {
								roleId: options.role().id,
								skillId: activation.skillId,
								binding,
								...(options.resultScope !== undefined ? { scope: options.resultScope } : {}),
								...(producedBy ? { producedBy } : {}),
							});
							return {
								content: [
									{
										type: "text" as const,
										text: JSON.stringify({
											resultRef: reference,
											bytes: Buffer.byteLength(serialized),
											complete: false,
											instruction:
												"Use pi861_capabilities action=result to read pages. Do not treat this as the full result.",
										}),
									},
								],
								details: { reference },
							};
						}
						return {
							content: [{ type: "text" as const, text: serialized }],
							details: { toolId: binding.toolId },
							isError: record(response)?.isError === true,
						};
					};
					if (!options.operations) return dispatch();
					const rule = options.resourceRules.find(
						(rule) =>
							rule.toolId === binding.toolId &&
							rule.accountId === binding.accountId &&
							rule.resourceId === binding.resourceId,
					);
					const resource = digest([binding.toolId, binding.accountId, binding.resourceId]);
					return (await options.operations.run(
						{
							requestId: digest([ctx.sessionManager.getSessionId(), callId]),
							principal: options.role().id,
							operationId: rule?.readOnly
								? undefined
								: digest([resource, rule?.operationName ?? binding.toolId, args]),
							resource,
							fingerprint: digest(args),
							readOnly: rule?.readOnly === true,
							// C5 full tool identity: the stable business id binds the exact
							// service/tool/account/resource/schema tuple, not just its digest.
							...c5Identity(binding),
						},
						dispatch,
					)) as Awaited<ReturnType<typeof dispatch>>;
				},
			});
		}
		activations.set(id, activation);
		refresh();
		save();
		return activation;
	}
	pi.registerTool({
		name: "pi861_capabilities",
		label: "Skill capabilities",
		description:
			"Browse approved capabilities, inspect branch conditions, activate a published Skill phase, or read bounded runtime resources/results. Tool access is role-checked; source Skill packages are not auto-loaded.",
		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: ["browse", "search", "branches", "activate", "deactivate", "resource", "result"],
				},
				path: { type: "string" },
				query: { type: "string" },
				field: { type: "string" },
				skillId: { type: "string" },
				revision: { type: "string" },
				branches: { type: "array", items: { type: "string" } },
				phase: { type: "string" },
				sourceId: { type: "string" },
				resultRef: { type: "string" },
				offset: { type: "integer", minimum: 0 },
			},
			required: ["action"],
			additionalProperties: false,
		},
		execute: async (_id, args, signal) => {
			const role = options.role();
			let value: unknown;
			if (args.action === "browse")
				value = await options.repository.browse(role, typeof args.path === "string" ? args.path : "");
			else if (args.action === "search") value = await options.repository.search(role, requireText(args.query));
			else if (args.action === "branches")
				value = (await options.repository.catalog()).branches(role, requireText(args.skillId));
			else if (args.action === "activate")
				value = await load(
					requireText(args.skillId),
					requireText(args.revision),
					array(args.branches),
					requireText(args.phase),
					signal ?? new AbortController().signal,
				);
			else if (args.action === "deactivate") {
				activations.delete(requireText(args.skillId));
				refresh();
				save();
				value = { deactivated: true };
			} else if (args.action === "resource") {
				const active = activations.get(requireText(args.skillId));
				if (!active) throw new Error("Activate the Skill before reading its runtime resources");
				const file = await options.repository.resource(
					active.skillId,
					active.skillRevision,
					requireText(args.sourceId),
					requireText(args.path),
					role,
				);
				const buffer = Buffer.from(file.base64, "base64"),
					offset = Number(args.offset ?? 0);
				if (!Number.isSafeInteger(offset) || offset < 0 || offset > buffer.length)
					throw new Error("Invalid resource offset");
				value = {
					path: file.path,
					content: buffer.subarray(offset, offset + 16_000).toString("utf8"),
					bytes: buffer.length,
					offset,
					nextOffset: Math.min(offset + 16_000, buffer.length),
					complete: offset + 16_000 >= buffer.length,
				};
			} else if (args.action === "result")
				value = await options.repository.readResult(
					requireText(args.resultRef),
					role,
					Number(args.offset ?? 0),
					typeof args.field === "string" ? args.field : undefined,
				);
			else throw new Error("Invalid capability action");
			return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} };
		},
	});
	pi.on("before_agent_start", async (raw) => {
		initialize();
		const event = record(raw),
			options = record(event?.systemPromptOptions);
		if (!options) throw new Error("Pi host does not support managed Skill prompt sections");
		options.skills = []; // Explicit /skill:name invocation still works; only passive discovery is replaced.
		const sections = record(options.sections);
		if (sections)
			sections.pi861_capabilities =
				"Use pi861_capabilities to browse role-scoped categories. Activate only relevant branches and phases. Original installed Skills are available only by explicit invocation.";
		refresh();
	});
	pi.on("tool_call", (raw) => {
		const event = record(raw);
		if (
			typeof event?.toolName === "string" &&
			event.toolName.startsWith("pi861_mcp_") &&
			![...activations.values()].some(
				(activation) =>
					options.role().skillIds.includes(activation.skillId) &&
					activation.tools.some((tool) => bindingName(activation, tool) === event.toolName),
			)
		)
			return { block: true, reason: "MCP capability is not active" };
		return undefined;
	});
	const restore = async (_raw: unknown, ctx: PiContext): Promise<void> => {
		initialize();
		epoch++;
		activations.clear();
		refresh();
		let saved: unknown;
		for (const value of ctx.sessionManager.getBranch()) {
			const entry = record(value);
			if (entry?.customType === "pi861.capabilities.v2") saved = entry.data;
		}
		if (!Array.isArray(saved)) return;
		for (const value of saved) {
			const item = record(value);
			if (!item) continue;
			try {
				await load(
					requireText(item.skillId),
					requireText(item.revision),
					array(item.branches),
					requireText(item.phase),
					new AbortController().signal,
				);
			} catch {
				ctx.ui.notify(
					"A previously active Skill could not be restored; check authorization and endpoint health",
					"warning",
				);
			}
		}
	};
	pi.on("session_start", restore);
	pi.on("session_tree", restore);
	async function close(): Promise<void> {
		epoch++;
		activations.clear();
		pins.clear();
		if (initialized) pi.setActiveTools(initial);
		await Promise.all(options.clients.map((client) => client.close()));
	}
	pi.on("session_shutdown", close);
	refresh();
	return { close };
}
