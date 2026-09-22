import { digest, type MemoryBackend, type MemoryReceipt, type MemoryWrite, validateMemory } from "../memory.ts";
import type { StateStore } from "./store.ts";

export interface PendingMemoryState {
	version: 1;
	entries: { request: MemoryWrite; digest: string; state: "uncommitted" | "committed"; receipt?: MemoryReceipt }[];
}
export class MemoryCommitPending extends Error {
	readonly requestId: string;
	constructor(requestId: string) {
		super("Memory checkpoint is uncommitted; pause this execution boundary and reconcile before continuing");
		this.requestId = requestId;
	}
}
/** A bounded local delivery queue, not a second read backend. Host must stop the
 * corresponding execution boundary on MemoryCommitPending. Replay uses the original
 * requestId and immutable payload; database idempotency adjudicates lost responses.
 */
export class PendingMemoryWrites {
	private readonly store: StateStore<PendingMemoryState>;
	private readonly backend: Pick<MemoryBackend, "put">;
	private readonly maxEntries: number;
	constructor(store: StateStore<PendingMemoryState>, backend: Pick<MemoryBackend, "put">, maxEntries = 100) {
		if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 10_000)
			throw new Error("Invalid pending memory capacity");
		this.store = store;
		this.backend = backend;
		this.maxEntries = maxEntries;
	}
	async put(request: MemoryWrite): Promise<MemoryReceipt> {
		validateMemory(request);
		const copy = structuredClone(request),
			hash = digest(copy);
		const replay = await this.store.update((state) => {
			if (state.version !== 1) throw new Error("Unsupported pending memory version");
			const entry = state.entries.find((entry) => entry.request.requestId === copy.requestId);
			if (entry) {
				if (entry.digest !== hash) throw new Error("Pending memory idempotency conflict");
				return entry.receipt;
			}
			state.entries = state.entries.filter((entry) => entry.state !== "committed");
			if (state.entries.length >= this.maxEntries) throw new Error("Pending memory capacity exhausted");
			state.entries.push({ request: copy, digest: hash, state: "uncommitted" });
			return undefined;
		});
		if (replay) return replay;
		let receipt: MemoryReceipt;
		try {
			receipt = await this.backend.put(copy);
		} catch {
			throw new MemoryCommitPending(copy.requestId);
		}
		await this.store.update((state) => {
			const entry = state.entries.find(
				(entry) => entry.request.requestId === copy.requestId && entry.digest === hash,
			);
			if (!entry) throw new Error("Pending memory entry missing");
			entry.state = "committed";
			entry.receipt = receipt;
		});
		return receipt;
	}
	async flush(): Promise<{ committed: number; pending: number }> {
		const snapshot = await this.store.read();
		let committed = 0,
			pending = 0;
		for (const entry of snapshot.entries.filter((entry) => entry.state === "uncommitted")) {
			try {
				await this.put(entry.request);
				committed++;
			} catch (error) {
				if (!(error instanceof MemoryCommitPending)) throw error;
				pending++;
			}
		}
		return { committed, pending };
	}
}
