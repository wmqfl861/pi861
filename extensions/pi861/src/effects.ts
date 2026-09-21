import { digest, type Json, requireCondition } from "./core.ts";
import type { StateStore } from "./store.ts";

/** Intent is committed before dispatch. Unknown outcomes are never automatically replayed. */
export class EffectLedger {
	private store: StateStore;
	constructor(store: StateStore) {
		this.store = store;
	}
	async begin(taskId: string, attemptToken: string, callId: string, tool: string, args: Json): Promise<string> {
		const effectId = digest([taskId, attemptToken, callId]);
		await this.store.transact((state) => {
			const owner = state.goals
				.flatMap((goal) => (goal.status === "cancelled" ? [] : goal.tasks))
				.find(
					(task) =>
						task.id === taskId &&
						task.status === "running" &&
						task.lease?.token === attemptToken &&
						task.lease.expiresAt > Date.now(),
				);
			requireCondition(owner, "STALE_LEASE", "Tool dispatch lost its execution authority");
			requireCondition(
				!state.effects[effectId],
				"DUPLICATE_EFFECT",
				"Tool call already dispatched; reconcile rather than repeat",
			);
			state.effects[effectId] = {
				id: effectId,
				taskId,
				attemptToken,
				tool,
				argumentsHash: digest(args),
				status: "started",
				updatedAt: Date.now(),
			};
		});
		return effectId;
	}
	async settle(effectId: string, success: boolean): Promise<void> {
		await this.store.transact((state) => {
			const effect = state.effects[effectId];
			requireCondition(effect, "NOT_FOUND", "Operation intent is missing");
			if (effect.status === "completed") return;
			effect.status = success ? "completed" : "unknown";
			effect.updatedAt = Date.now();
		});
	}
}
