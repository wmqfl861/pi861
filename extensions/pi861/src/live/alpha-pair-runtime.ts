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
  mainModel?: string;
  shadowModel?: string;
  shadowPrepared: boolean;
  artifactHash?: string;
}

function require(value: boolean, message: string): void {
  if (!value) throw new Error(message);
}

export function createAlphaPair(pairId: string, requirementVersion: string): AlphaPairState {
  require(Boolean(pairId) && Boolean(requirementVersion), "pair identity required");
  return {
    pairId,
    requirementVersion,
    phase: "queued",
    shadowPrepared: false,
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
      require(event.mainModel !== event.shadowModel, "main and shadow require different identities");
      next.phase = "researching";
      next.mainModel = event.mainModel;
      next.shadowModel = event.shadowModel;
      return next;
    case "shadow-prepared":
      require(state.phase === "researching", "shadow prepared before research");
      require(event.evidenceRefs.length > 0 && event.checks.length > 0, "missing shadow evidence");
      next.shadowPrepared = true;
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
      next.phase = event.verdict === "pass" ? "accepted" : event.verdict === "blocked" ? "blocked" : "researching";
      if (event.verdict === "changes") next.artifactHash = undefined;
      return next;
    case "cancel":
      next.phase = "cancelled";
      return next;
  }
}
