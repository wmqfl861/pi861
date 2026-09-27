import type { Attempt } from "../routing.ts";
import { record } from "../search.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import { AttemptStreamBridge, type BridgeEvent, type StreamMessage } from "./stream-bridge.ts";

/**
 * H-owned managed-provider adapter. The buffered wrapper that waited for a whole
 * AssistantMessage before emitting anything is replaced by this incremental wiring:
 * provider events flow tentatively through the AttemptStreamBridge while the attempt
 * runs, tool arguments stay private until the successful attempt commits, and the
 * terminal message is emitted only after commit (R2.10, AX4 stream discipline).
 *
 * The adapter stays dependency-free (like the index.ts host port): the message type,
 * output sink and error-message factory are supplied by the caller, which keeps it
 * deterministically testable and lets runtime.ts bind the real Pi types.
 */

/** Minimal terminal state the adapter checks on the runtime's response message. */
export type ManagedMessage = StreamMessage & { stopReason?: string };

/** One managed model call carried into the runtime's infer callback. */
export interface ManagedRequest<TTranscript, TOptions> {
	transcript: TTranscript;
	options?: TOptions;
	stream?: ManagedStreamState;
}
export interface ManagedStreamState {
	bridge: AttemptStreamBridge<ManagedMessage>;
	attempt?: Attempt;
}
export interface ManagedStreamOutput {
	push(event: BridgeEvent<ManagedMessage>): void;
}

/**
 * Builds the streamSimple entry for the "pi861-runtime" provider registration.
 * `failureMessage` renders the single terminal error the host emits on failure.
 * The output type is generic so the caller can bind the real event-stream class.
 */
export function managedStream<
	TTranscript,
	TOptions extends { signal?: AbortSignal },
	TOutput extends ManagedStreamOutput,
>(
	runtime: () => ModelRuntime<ManagedRequest<TTranscript, TOptions>, ManagedMessage> | undefined,
	createOutput: () => TOutput,
	failureMessage: (error: unknown, reason: "error" | "aborted") => ManagedMessage,
): (_model: unknown, transcript: TTranscript, options?: TOptions) => TOutput {
	return (_model, transcript, options) => {
		const output = createOutput();
		void (async () => {
			const stream: ManagedStreamState = {
				bridge: new AttemptStreamBridge<ManagedMessage>(
					(event) => {
						output.push(event);
					},
					(tool) =>
						Boolean(tool.id) &&
						typeof tool.name === "string" &&
						Boolean(tool.name) &&
						record(tool.arguments) !== null &&
						!Array.isArray(tool.arguments),
				),
			};
			try {
				const live = runtime();
				if (!live) throw new Error("Model runtime not initialized");
				const message = await live.call(
					{ transcript, options, stream },
					options?.signal ?? new AbortController().signal,
				);
				if (!["stop", "length", "toolUse"].includes(message.stopReason ?? "")) {
					throw new Error("Managed model returned an unresolved stop reason");
				}
				if (!stream.attempt || !stream.bridge.commit(stream.attempt, 0))
					throw new Error("Managed stream ended without a committable attempt");
			} catch (error) {
				stream.bridge.cancel();
				const reason = options?.signal?.aborted ? "aborted" : "error";
				output.push({ type: "error", reason, error: failureMessage(error, reason) });
			}
		})();
		return output;
	};
}
