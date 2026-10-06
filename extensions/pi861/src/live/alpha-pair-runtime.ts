export type AlphaPhase =
	| "queued"
	| "researching"
	| "reviewing"
	| "accepted"
	| "blocked"
	| "cancelled";

export type AlphaEvent =
	| { type: "admit"; requirementVersion: string; mainModel: string; shadowModel: string }
	| { type: "shadow-prepared"; requirementVersion: string; evidenceRefs: string[]; checks: string[] }
	| { type: "candidate"; requirementVersion: string; artifactHash: string }
	| { type: "review"; requirementVersion: string; artifactHash: string; verdict: "pass" | "changes" | "blocked" }
	| { type: "cancel"; requirementVersion: string };

export interface AlphaPairState {
	pairId: string;
	requirementVersion: string;
	phase: AlphaPhase;
	mainModel: string;
	shadowModel: string;
	shadowPrepared: boolean;
	evidenceRefs: string[];
	checks: string[];
	artifactHash?: string;
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

export function createAlphaPair(pairId: string, requirementVersion: string): AlphaPairState {
	require(nonEmpty(pairId) && nonEmpty(requirementVersion), "pair identity required");
	return {
		pairId,
		requirementVersion,
		phase: "queued",
		mainModel: "",
		shadowModel: "",
		shadowPrepared: false,
		evidenceRefs: [],
		checks: [],
	};
}

/** Offline host-event fixture. Does not launch models or tools. */
export function applyAlphaPairEvent(state: AlphaPairState, event: AlphaEvent): AlphaPairState {
	require(event.requirementVersion === state.requirementVersion, "stale requirement version");
	require(!["accepted", "blocked", "cancelled"].includes(state.phase), "terminal state");

	const next = structuredClone(state);
	switch (event.type) {
		case "admit":
			require(state.phase === "queued", "invalid admission phase");
			require(nonEmpty(event.mainModel) && nonEmpty(event.shadowModel), "model identity required");
			require(event.mainModel !== event.shadowModel, "main and shadow require different identities");
			next.phase = "researching";
			next.mainModel = event.mainModel;
			next.shadowModel = event.shadowModel;
			return next;
		case "shadow-prepared":
			require(state.phase === "researching", "shadow prepared before research");
			require(nonEmptyList(event.evidenceRefs) && nonEmptyList(event.checks), "missing shadow evidence");
			next.shadowPrepared = true;
			next.evidenceRefs = [...event.evidenceRefs];
			next.checks = [...event.checks];
			return next;
		case "candidate":
			require(state.phase === "researching", "candidate outside research");
			require(state.shadowPrepared, "candidate requires shadow preparation");
			require(/^[a-f0-9]{64}$/.test(event.artifactHash), "invalid artifact hash");
			next.phase = "reviewing";
			next.artifactHash = event.artifactHash;
			return next;
		case "review":
			require(state.phase === "reviewing", "review outside review phase");
			require(state.artifactHash === event.artifactHash, "review artifact mismatch");
			require(["pass", "changes", "blocked"].includes(event.verdict), "invalid review verdict");
			next.phase = event.verdict === "pass" ? "accepted" : event.verdict === "blocked" ? "blocked" : "researching";
			return next;
		case "cancel":
			next.phase = "cancelled";
			return next;
		default:
			throw new Error("unknown alpha event");
	}
}
