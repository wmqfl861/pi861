import { nonempty, positive, requireCondition } from "./core.ts";
import type { StateStore } from "./store.ts";

export interface BudgetLimits {
	requests: number;
	tokens: number;
}
/** Shared across every worker, request retry and recovery probe in one goal. */
export class BudgetLedger {
	private store: StateStore;
	private key: string;
	private limits: BudgetLimits;
	constructor(store: StateStore, key: string, limits: BudgetLimits) {
		this.store = store;
		this.key = nonempty(key, "budget key", 200);
		this.limits = {
			requests: positive(limits.requests, "request budget"),
			tokens: positive(limits.tokens, "token budget"),
		};
	}
	async reserve(requestId: string, ceiling: number): Promise<void> {
		positive(ceiling, "request ceiling");
		await this.store.transact((state) => {
			const budget = state.budgets[this.key] ?? { requests: 0, chargedTokens: 0, reservations: {} };
			requireCondition(
				!budget.reservations[requestId],
				"DUPLICATE_REQUEST",
				"Each actual model attempt needs a new accounting id",
			);
			requireCondition(budget.requests < this.limits.requests, "BUDGET_EXHAUSTED", "Model request budget exhausted");
			requireCondition(
				budget.chargedTokens + ceiling <= this.limits.tokens,
				"BUDGET_EXHAUSTED",
				"Conservative token budget exhausted",
			);
			budget.requests++;
			budget.chargedTokens += ceiling;
			budget.reservations[requestId] = { ceiling, settled: false };
			state.budgets[this.key] = budget;
		});
	}
	async settle(requestId: string, actualTokens?: number): Promise<void> {
		await this.store.transact((state) => {
			const budget = state.budgets[this.key];
			const reservation = budget?.reservations[requestId];
			requireCondition(budget && reservation, "NOT_FOUND", "Request reservation missing");
			if (reservation.settled) return;
			// Unknown usage (including dropped response) conservatively retains the whole reservation.
			if (actualTokens !== undefined) {
				requireCondition(
					Number.isSafeInteger(actualTokens) && actualTokens >= 0,
					"INVALID_USAGE",
					"Invalid reported token usage",
				);
				budget.chargedTokens += actualTokens - reservation.ceiling;
			}
			reservation.settled = true;
		});
	}
	async status() {
		const state = await this.store.read();
		const budget = state.budgets[this.key] ?? { requests: 0, chargedTokens: 0, reservations: {} };
		return {
			requests: budget.requests,
			chargedTokens: budget.chargedTokens,
			limits: { ...this.limits },
			unsettled: Object.values(budget.reservations).filter((item) => !item.settled).length,
		};
	}
}
