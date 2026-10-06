export type AlphaPhase = "queued" | "researching" | "reviewing" | "accepted" | "blocked" | "cancelled";

export interface AlphaEventEnvelope {
	eventId: string;
	taskId: string;
	agentId: string;
	time: number;
	version: string;
	artifactHash?: string;
}

export type AlphaEvent = AlphaEventEnvelope &
	(
		| { type: "admit"; mainModel: string; shadowModel: string }
		| { type: "shadow-prepared"; evidenceRefs: string[]; checks: string[] }
		| { type: "candidate" }
		| { type: "review"; verdict: "pass" | "changes" | "blocked" }
		| { type: "cancel" }
	);

export interface AlphaPairState {
	pairId: string;
	taskId: string;
	version: string;
	phase: AlphaPhase;
	mainModel: string;
	shadowModel: string;
	mainAgentId: string;
	shadowAgentId: string;
	lastEventIds: string[];
	shadowPrepared: boolean;
	evidenceRefs: string[];
	checks: string[];
	artifactHash?: string;
	review?: { verdict: "pass" | "changes" | "blocked"; eventId: string };
}

function require(value: boolean, message: string): void {
	if (!value) throw new Error(message);
}

function nonEmpty(value: string): boolean {
	return typeof value === "string" && value.trim().length > 0;
}

function nonEmptyList(values: string[]): boolean {
	return values.length > 0 && values.every((value) => nonEmpty(value));
}

function validEnvelope(state: AlphaPairState, event: AlphaEvent): void {
	require(nonEmpty(event.eventId) && nonEmpty(event.taskId) && nonEmpty(event.agentId), "invalid event envelope");
	require(Number.isFinite(event.time) && event.time > 0, "invalid event time");
	require(event.taskId === state.taskId && event.version === state.version, "stale event version");
	require(!state.lastEventIds.includes(event.eventId), "duplicate event");
}

function validHash(hash: string | undefined): void {
	require(typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash), "invalid artifact hash");
}

export function createAlphaPair(pairId: string, taskId: string, version: string): AlphaPairState {
	require(nonEmpty(pairId) && nonEmpty(taskId) && nonEmpty(version), "pair identity required");
	return {
		pairId,
		taskId,
		version,
		phase: "queued",
		mainModel: "",
		shadowModel: "",
		mainAgentId: "",
		shadowAgentId: "",
		lastEventIds: [],
		shadowPrepared: false,
		evidenceRefs: [],
		checks: [],
	};
}

/** Offline host-event fixture. Does not launch models, tools, or production dispatch. */
export function applyAlphaPairEvent(state: AlphaPairState, event: AlphaEvent): AlphaPairState {
	validEnvelope(state, event);
	require(!["accepted", "blocked", "cancelled"].includes(state.phase), "terminal state");
	const next = structuredClone(state);
	next.lastEventIds.push(event.eventId);

	switch (event.type) {
		case "admit":
			require(state.phase === "queued", "invalid admission phase");
			require(nonEmpty(event.mainModel) && nonEmpty(event.shadowModel), "model identity required");
			require(event.mainModel !== event.shadowModel, "main and shadow require different identities");
			next.phase = "researching";
			next.mainModel = event.mainModel;
			next.shadowModel = event.shadowModel;
			next.mainAgentId = event.agentId;
			return next;
		case "shadow-prepared":
			require(event.agentId === state.shadowAgentId || nonEmpty(state.shadowAgentId), "invalid shadow actor");
			require(state.phase === "researching", "shadow prepared before research");
			require(nonEmptyList(event.evidenceRefs) && nonEmptyList(event.checks), "missing shadow evidence");
			next.shadowPrepared = true;
			next.shadowAgentId = event.agentId;
			next.evidenceRefs = [...event.evidenceRefs];
			next.checks = [...event.checks];
			return next;
		case "candidate":
			require(state.phase === "researching" && state.shadowPrepared, "candidate requires shadow preparation");
			validHash(event.artifactHash);
			next.phase = "reviewing";
			next.artifactHash = event.artifactHash;
			return next;
		case "review":
			require(state.phase === "reviewing", "review outside review phase");
			require(event.agentId === state.shadowAgentId, "invalid review actor");
			require(state.artifactHash === event.artifactHash, "review artifact mismatch");
			next.review = { verdict: event.verdict, eventId: event.eventId };
			next.phase = event.verdict === "pass" ? "accepted" : event.verdict === "blocked" ? "blocked" : "researching";
			return next;
		case "cancel":
			next.phase = "cancelled";
			return next;
		default:
			throw new Error("unknown alpha event");
	}
}
