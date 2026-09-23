import type { Attempt } from "../routing.ts";

/** Structural subset of Pi's AssistantMessage; host metadata is preserved by the generic message type. */
export type StreamJson = null | boolean | number | string | readonly StreamJson[] | { [key: string]: StreamJson };
export interface StreamToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: { [key: string]: StreamJson };
}
export interface StreamText {
	type: "text";
	text: string;
}
export interface StreamThinking {
	type: "thinking";
	thinking: string;
}
export interface StreamMessage {
	content: (StreamText | StreamThinking | StreamToolCall)[];
}
export type BridgeEvent<M extends StreamMessage> =
	| { type: "start"; partial: M }
	| { type: "text_start" | "thinking_start" | "toolcall_start"; contentIndex: number; partial: M }
	| { type: "text_delta" | "thinking_delta" | "toolcall_delta"; contentIndex: number; delta: string; partial: M }
	| { type: "text_end" | "thinking_end"; contentIndex: number; content: string; partial: M }
	| { type: "toolcall_end"; contentIndex: number; toolCall: StreamToolCall; partial: M }
	| { type: "done"; reason: "stop" | "length" | "toolUse" | "deferred"; message: M }
	| { type: "error"; reason: "error" | "aborted"; error: M };
export interface StreamOwnership {
	attempt: Attempt;
	tentative: boolean;
}

/** Text is tentative until commit; tool arguments stay private until the successful attempt commits. */
export class AttemptStreamBridge<M extends StreamMessage> {
	private owner: Attempt | undefined;
	private signal: AbortSignal | undefined;
	private terminal: Extract<BridgeEvent<M>, { type: "done" }> | undefined;
	private closed = false;
	private started = false;
	private readonly emit: (event: BridgeEvent<M>, ownership: StreamOwnership) => void;
	private readonly validate: (tool: StreamToolCall) => boolean;
	constructor(
		emit: (event: BridgeEvent<M>, ownership: StreamOwnership) => void,
		validate: (tool: StreamToolCall) => boolean,
	) {
		this.emit = emit;
		this.validate = validate;
	}
	begin(attempt: Attempt, signal: AbortSignal): void {
		if (this.closed) throw new Error("Stream is already committed");
		if (this.owner && attempt.generation <= this.owner.generation)
			throw new Error("Stream attempt generation must advance");
		signal.throwIfAborted();
		this.owner = { ...attempt };
		this.signal = signal;
		this.terminal = undefined;
	}
	private owns(attempt: Attempt): boolean {
		return (
			!this.closed &&
			!this.signal?.aborted &&
			this.owner?.generation === attempt.generation &&
			this.owner.configId === attempt.configId &&
			this.owner.configRevision === attempt.configRevision
		);
	}
	push(attempt: Attempt, event: BridgeEvent<M>): boolean {
		if (!this.owns(attempt) || this.terminal) return false;
		if (event.type === "error") {
			this.signal = AbortSignal.abort();
			return false;
		}
		if (event.type === "done") {
			this.terminal = structuredClone(event);
			return true;
		}
		if (event.type.startsWith("toolcall")) return true;
		const partial = {
			...structuredClone(event.partial),
			content: structuredClone(event.partial.content.filter((block) => block.type !== "toolCall")),
		};
		if (!this.started) {
			this.emit(
				{ type: "start", partial: { ...partial, content: [] } },
				{ attempt: { ...attempt }, tentative: true },
			);
			this.started = true;
		}
		if (event.type === "start") return true;
		const block = event.partial.content[event.contentIndex];
		if (!block || block.type === "toolCall") return false;
		const contentIndex = event.partial.content
			.slice(0, event.contentIndex)
			.filter((item) => item.type !== "toolCall").length;
		this.emit({ ...event, contentIndex, partial }, { attempt: { ...attempt }, tentative: true });
		return true;
	}
	/** Invoke only after ModelRuntime.call returned successfully and no unknown side effect remains. */
	commit(attempt: Attempt, pendingOperations = 0): boolean {
		if (!this.owns(attempt) || !this.terminal) return false;
		if (pendingOperations !== 0) throw new Error("Reconcile pending operations before committing a stream");
		const event = structuredClone(this.terminal);
		const tools = event.message.content.filter((block) => block.type === "toolCall");
		const ids = new Set<string>();
		for (const tool of tools) {
			if (!tool.id || ids.has(tool.id) || !this.validate(structuredClone(tool)))
				throw new Error("Tool arguments or binding are invalid");
			ids.add(tool.id);
		}
		this.signal?.throwIfAborted();
		this.closed = true;
		const ownership = { attempt: { ...attempt }, tentative: false };
		if (!this.started) this.emit({ type: "start", partial: { ...event.message, content: [] } }, ownership);
		for (const [contentIndex, tool] of event.message.content.entries()) {
			if (tool.type !== "toolCall") continue;
			this.emit({ type: "toolcall_start", contentIndex, partial: event.message }, ownership);
			this.emit({ type: "toolcall_end", contentIndex, toolCall: tool, partial: event.message }, ownership);
		}
		this.emit(event, ownership);
		return true;
	}
	/** Cancellation/error output is the host's single terminal error; no buffered tools survive it. */
	cancel(): void {
		this.closed = true;
		this.terminal = undefined;
		this.owner = undefined;
	}
}
