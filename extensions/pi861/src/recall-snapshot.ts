import { digest } from "./core.ts";

/** A recall snapshot is a projection, never new source evidence or an instruction. */
export class RecallSnapshot {
	private signature: string | undefined;
	private session: string | undefined;

	reset(): void {
		this.signature = undefined;
		this.session = undefined;
	}

	update(session: string, records: unknown[]): boolean {
		const signature = digest(records);
		if (this.session === session && this.signature === signature) return false;
		const previouslyLoaded = this.session === session && this.signature !== undefined;
		this.session = session;
		this.signature = signature;
		// An empty update replaces an earlier non-empty snapshot after withdrawal.
		return records.length > 0 || previouslyLoaded;
	}
}
