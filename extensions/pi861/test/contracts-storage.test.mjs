import assert from "node:assert/strict";
import { test } from "node:test";
import { TransactionalStore, ReceiptLog, Outbox, VersionConflict, IdempotencyConflict, paginate, incrementalWindow, decodeCursor } from "../src/contracts/storage.ts";

test("transactions commit with version compare-and-set and reject stale writers", () => {
	const store = new TransactionalStore({ count: 0 });
	store.transact({ requestId: "w1", contentDigest: "d1", expectedVersion: 0, mutate: (state) => ({ count: state.count + 1 }) });
	assert.deepEqual(store.current, { version: 1, state: { count: 1 } });
	assert.throws(() => store.transact({ requestId: "w2", contentDigest: "d2", expectedVersion: 0, mutate: (state) => ({ count: state.count + 99 }) }), VersionConflict);
	store.transact({ requestId: "w2", contentDigest: "d2", expectedVersion: 1, mutate: (state) => ({ count: state.count + 1 }) });
	assert.equal(store.current.state.count, 2);
});

test("request ids replay idempotently without re-running the mutation and conflict on different content", () => {
	const store = new TransactionalStore({ count: 0 });
	const first = store.transact({ requestId: "same", contentDigest: "d1", expectedVersion: 0, mutate: (state) => ({ count: state.count + 1 }) });
	const replay = store.transact({ requestId: "same", contentDigest: "d1", expectedVersion: 1, mutate: (state) => ({ count: state.count + 1 }) });
	assert.equal(replay.receipt.requestId, first.receipt.requestId);
	assert.equal(store.current.state.count, 1);
	assert.equal(store.current.version, 1);
	assert.throws(() => store.transact({ requestId: "same", contentDigest: "d9", expectedVersion: 1, mutate: (state) => ({ count: state.count + 1 }) }), IdempotencyConflict);
});

test("persist failures leave the in-memory state and receipt log untouched", () => {
	let failing = false;
	const store = new TransactionalStore({ count: 0 }, () => {
		if (failing) throw new Error("disk unavailable");
	});
	store.transact({ requestId: "ok", contentDigest: "d1", expectedVersion: 0, mutate: (state) => ({ count: state.count + 1 }) });
	const before = store.current;
	failing = true;
	assert.throws(() => store.transact({ requestId: "boom", contentDigest: "d2", expectedVersion: 1, mutate: (state) => ({ count: state.count + 1 }) }), /disk unavailable/);
	assert.deepEqual(store.current, before);
	failing = false;
	store.transact({ requestId: "boom", contentDigest: "d2", expectedVersion: 1, mutate: (state) => ({ count: state.count + 1 }) });
	assert.equal(store.current.state.count, 2);
});

test("interrupted commits resolve exactly once through the unknown-receipt path", () => {
	const log = new ReceiptLog();
	const unknown = log.markUnknown("req-1", "digest-a", 3);
	assert.equal(unknown.state, "unknown");
	log.resolveUnknown("req-1", { committed: { version: 3, contentDigest: "digest-a", at: 10 } }, 10);
	assert.equal(log.lookup("req-1")?.state, "committed");
	assert.throws(() => log.resolveUnknown("req-1", { notCommitted: true }, 11), /No unknown receipt/);
	const second = new ReceiptLog();
	second.markUnknown("req-2", "digest-b", 4);
	second.resolveUnknown("req-2", { notCommitted: true }, 5);
	assert.equal(second.lookup("req-2"), undefined);
	const retried = second.record("req-2", "digest-b", 5, 6);
	assert.equal(retried.state, "committed");
});

test("unresolved unknown commits refuse replay instead of guessing", () => {
	const store = new TransactionalStore({ count: 0 });
	store.markUnknown("req-1", "d1", 1);
	assert.throws(() => store.transact({ requestId: "req-1", contentDigest: "d1", expectedVersion: 0, mutate: (state) => ({ count: state.count + 1 }) }), /unresolved unknown commit/);
	store.resolveUnknown("req-1", { notCommitted: true });
	store.transact({ requestId: "req-1", contentDigest: "d1", expectedVersion: 0, mutate: (state) => ({ count: state.count + 1 }) });
	assert.equal(store.current.state.count, 1);
});

test("outbox entries are idempotent, claimed in order and retried with backoff", () => {
	const outbox = new Outbox({ baseRetryMs: 100, maxRetryMs: 1_000 });
	const first = outbox.append({ kind: "memory-captured", id: "m1" }, 1);
	assert.equal(outbox.append({ kind: "memory-captured", id: "m1" }, 2).entryId, first.entryId);
	const second = outbox.append({ kind: "memory-captured", id: "m2" }, 3);
	assert.deepEqual(outbox.claim(5, 10).map((entry) => entry.entryId), [first.entryId, second.entryId]);
	outbox.complete(first.entryId, "dispatched", 6);
	outbox.complete(second.entryId, { retryAfterMs: 50, error: "service down" }, 6);
	assert.deepEqual(outbox.claim(10, 10), []);
	assert.deepEqual(outbox.claim(56, 10).map((entry) => entry.entryId), [second.entryId]);
	outbox.complete(second.entryId, "failed-terminal", 60);
	assert.equal(outbox.pendingCount, 0);
	assert.deepEqual(outbox.claim(100, 10), []);
});

test("transaction commits append outbox events atomically", () => {
	const store = new TransactionalStore({ events: [] });
	store.transact({
		requestId: "w1", contentDigest: "d1", expectedVersion: 0,
		mutate: (state) => ({ events: [...state.events, "captured"] }),
		outboxEvents: [{ kind: "memory-captured", id: "m1" }],
	});
	assert.equal(store.outboxQueue.pendingCount, 1);
	const replay = store.transact({
		requestId: "w1", contentDigest: "d1", expectedVersion: 1,
		mutate: (state) => ({ events: [...state.events, "captured"] }),
		outboxEvents: [{ kind: "memory-captured", id: "m1" }],
	});
	assert.equal(store.outboxQueue.pendingCount, 1);
	assert.equal(replay.version, 1);
});

test("pagination walks pages with opaque cursors and rejects malformed ones", () => {
	const items = [1, 2, 3, 4, 5];
	const page1 = paginate(items, null, 2);
	assert.deepEqual(page1.items, [1, 2]);
	assert.equal(page1.hasMore, true);
	assert.equal(decodeCursor(page1.nextCursor ?? ""), 2);
	const page2 = paginate(items, page1.nextCursor, 2);
	const page3 = paginate(items, page2.nextCursor, 2);
	assert.deepEqual(page3.items, [5]);
	assert.equal(page3.nextCursor, null);
	assert.throws(() => paginate(items, "9", 2), /Malformed page cursor/);
	assert.throws(() => paginate(items, "c:x", 2), /Malformed page cursor/);
	assert.throws(() => paginate(items, "c:9", 2), /beyond the end/);
	assert.throws(() => paginate(items, null, 0));
});

test("incremental windows return strictly newer versions in ascending order", () => {
	const records = [{ id: "a", version: 3 }, { id: "b", version: 1 }, { id: "c", version: 5 }, { id: "d", version: 2 }];
	const window = incrementalWindow(records, 2, 2);
	assert.deepEqual(window.items.map((item) => item.id), ["a", "c"]);
	assert.equal(window.nextCursor, "d:5");
	const tail = incrementalWindow(records, 5, 2);
	assert.deepEqual(tail.items, []);
	assert.equal(tail.nextCursor, null);
});

test("store snapshots round-trip state, receipts and outbox", () => {
	const store = new TransactionalStore({ count: 0 });
	store.transact({ requestId: "w1", contentDigest: "d1", expectedVersion: 0, mutate: (state) => ({ count: state.count + 1 }),
		outboxEvents: [{ kind: "distill-task", id: "d1" }] });
	const snapshot = store.exportState();
	const restored = new TransactionalStore({ count: 99 });
	restored.restore(snapshot);
	assert.deepEqual(restored.current, { version: 1, state: { count: 1 } });
	assert.equal(restored.outboxQueue.pendingCount, 1);
	const replay = restored.transact({ requestId: "w1", contentDigest: "d1", expectedVersion: 1, mutate: (state) => ({ count: state.count + 1 }) });
	assert.equal(replay.version, 1);
	assert.equal(replay.state.count, 1);
});
