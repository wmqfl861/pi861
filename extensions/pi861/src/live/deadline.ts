/** Cancelling the wait does not prove cancellation of an external operation. */
export async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	signal.throwIfAborted();
	let abort: (() => void) | undefined;
	try {
		return await Promise.race([work, new Promise<never>((_resolve, reject) => {
			abort = () => reject(signal.reason);
			signal.addEventListener("abort", abort, { once: true });
		})]);
	} finally { if (abort) signal.removeEventListener("abort", abort); }
}
