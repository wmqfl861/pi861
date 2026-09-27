/**
 * P2-M automatic memory governance unit tests (AX7/AX8 module scope).
 * The authority is the file-backed LayeredMemory; PostgreSQL-path governance is
 * covered by test/memory-service.integration.mjs (K4-related).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LayeredMemory, emptyLayeredMemory } from "../src/live/layered-memory.ts";
import {
	attachMemoryGovernance,
	auxiliaryExtractor,
	MemoryGovernanceAlreadyInstalled,
} from "../src/live/memory-service.ts";
import { MemoryCommitPending } from "../src/live/memory-pending.ts";
import { FileStateStore } from "../src/live/store.ts";
import { digest } from "../src/memory.ts";

const principal = { tenantId: "t", principalId: "agent", readScopes: ["project:p"], writeScopes: ["project:p"] };
const widePrincipal = {
	tenantId: "t",
	principalId: "writer",
	readScopes: ["project:p", "project:secret"],
	writeScopes: ["project:p", "project:secret"],
};
const scope = "project:p";

function setup(t, options = {}) {
	const dir = mkdtempSync(join(tmpdir(), "pi861-governance-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const memoryStore = new FileStateStore(join(dir, "memory.json"), emptyLayeredMemory("t"));
	const memory = new LayeredMemory(memoryStore, principal);
	const pendingStore = new FileStateStore(join(dir, "pending.json"), { version: 1, entries: [] });
	const host = {};
	const governance = attachMemoryGovernance(host, {
		authority: memory,
		pending: pendingStore,
		scope,
		...(options.owner !== undefined ? { owner: options.owner } : {}),
		...(options.resultPageSize !== undefined ? { resultPageSize: options.resultPageSize } : {}),
	});
	return { dir, memoryStore, memory, pendingStore, host, governance };
}

/** Authority proxy whose put fails while the link is down; every other method passes through. */
function gatedAuthority(memory) {
	let down = false;
	return {
		memory,
		setDown(value) {
			down = value;
		},
		get: (s, id) => memory.get(s, id),
		put: (input) => {
			if (down) return Promise.reject(new Error("simulated connection failure"));
			return memory.put(input);
		},
		withdraw: (requestId, s, id, revision) => memory.withdraw(requestId, s, id, revision),
		assemble: (options) => memory.assemble(options),
		delta: (...args) => memory.delta(...args),
		listJobs: () => memory.listJobs(),
		requeueJob: (jobId) => memory.requeueJob(jobId),
		enrich: (extractor, options) => memory.enrich(extractor, options),
	};
}

const parseAssembled = (result) => result.text.split("\n").filter(Boolean).map((line) => JSON.parse(line));

test("every lifecycle transition assembles fixed constraints and working state directly", async (t) => {
	const { governance } = setup(t);
	await governance.captureUserStatement({ sessionId: "s1", sequence: 1, text: "所有提交必须先通过独立审核", kind: "constraint" });
	await governance.captureUserStatement({ sessionId: "s1", sequence: 2, text: "正在修复 result-store 的分页边界", kind: "working" });
	await governance.captureUserStatement({ sessionId: "s1", sequence: 3, text: "项目目标：交付受控引用服务", kind: "project" });
	await governance.authority.put({
		requestId: "exp-1",
		expectedRevision: null,
		item: {
			id: "exp-1",
			scope,
			kind: "experience",
			status: "candidate",
			abstract: "经验",
			overview: "经验",
			full: "上次集成时先迁移后切换减少了冲突",
			source: { kind: "user", ref: "event:exp" },
		},
	});
	for (const transition of ["startup", "takeover", "model-switch", "compaction", "node-switch"]) {
		const assembled = parseAssembled(await governance.assembleContext(transition));
		const kinds = assembled.map((line) => line.kind);
		// Boot transitions install constraints/working/project directly - no keyword
		// hit is involved, and the CJK constraint text never matched any query.
		assert.deepEqual(kinds.slice().sort(), ["constraint", "project", "working"], `${transition} sections`);
		assert.ok(assembled.some((line) => line.content.includes("独立审核")), `${transition} constraint body`);
	}
	// Event recall adds experience; boot modes never leak it.
	const recall = parseAssembled(await governance.recallContext());
	assert.ok(recall.some((line) => line.kind === "experience"));
	assert.ok(!parseAssembled(await governance.assembleContext("startup")).some((line) => line.kind === "experience"));
});

test("tool_execution_end captures are persisted immediately, not at session end", async (t) => {
	const { governance, memory } = setup(t);
	const outcome = await governance.captureToolExecutionEnd({
		sessionId: "s1",
		toolCallId: "call-1",
		toolName: "fs.read",
		result: { path: "a.txt", bytes: 120 },
	});
	assert.equal(outcome.status, "captured");
	const id = digest(["s1", "call-1"]);
	const stored = await memory.get(scope, id);
	assert.ok(stored, "record exists right after the tool event");
	assert.equal(stored.source.kind, "tool");
	assert.equal(stored.source.ref, "pi-session:s1/tool:call-1");
	// Same tool event captured again replays the same receipt - no duplicate record.
	const replay = await governance.captureToolExecutionEnd({
		sessionId: "s1",
		toolCallId: "call-1",
		toolName: "fs.read",
		result: { path: "a.txt", bytes: 120 },
	});
	assert.equal(replay.id, outcome.id);
	const delta = await governance.changes();
	assert.equal(delta.changes.filter((change) => change.id === id).length, 1);
});

test("oversized tool results become durable controlled references and are never dropped", async (t) => {
	const { governance } = setup(t, { resultPageSize: 1000 });
	const payload = JSON.stringify({ tool: "web.read", result: "z".repeat(80_000), isError: false });
	const outcome = await governance.captureToolExecutionEnd({
		sessionId: "s1",
		toolCallId: "call-2",
		toolName: "web.read",
		result: payload,
	});
	assert.equal(outcome.status, "referenced");
	const record = await governance.authority.get(scope, outcome.id);
	const body = JSON.parse(record.full);
	assert.equal(body.durable, true);
	assert.match(body.resultRef, /^[0-9a-f]{64}$/);
	// The full oversized payload is retrievable through the reference, in pages.
	let text = "";
	let offset = 0;
	for (;;) {
		const page = await governance.readResultReference(body.resultRef, offset);
		text += page.text;
		offset = page.nextOffset;
		if (page.complete) break;
	}
	assert.equal(JSON.parse(text).result, payload);
});

test("durable references survive distillation, and reference records never reach the model (review-1 F1)", async (t) => {
	const { governance, memory } = setup(t, { resultPageSize: 128_000 });
	const payload = JSON.stringify({ tool: "web.read", result: "n".repeat(80_000), isError: false });
	const outcome = await governance.captureToolExecutionEnd({
		sessionId: "s1",
		toolCallId: "call-distill",
		toolName: "web.read",
		result: payload,
	});
	assert.equal(outcome.status, "referenced");
	const resultRef = JSON.parse((await governance.authority.get(scope, outcome.id)).full).resultRef;
	// Governance distill completes the chunk/manifest jobs without a model call.
	const modeled = [];
	await governance.captureUserStatement({ sessionId: "s1", sequence: 1, text: "普通记录：需要提炼", kind: "project" });
	const stats = await governance.distill(
		(_context, record) => {
			modeled.push(record.id);
			return Promise.resolve({ abstract: "摘要", overview: "普通记录的概览。", facts: [] });
		},
		{},
		"fixture-model",
		{ signal: new AbortController().signal },
	);
	assert.ok(stats.completed >= 2, JSON.stringify(stats));
	// The capture descriptor record is ordinary evidence and may be distilled;
	// the reference storage records (chunk + manifest) must never reach the model.
	const owner = `pi861:${scope}`;
	const referenceIds = new Set([
		digest(["pi861.result.chunk", owner, resultRef, 0]),
		digest(["pi861.result.manifest", owner, resultRef]),
	]);
	assert.ok(modeled.includes(digest(["pi861.user", "s1", 1])), "the user record reached the model");
	assert.deepEqual(modeled.filter((id) => referenceIds.has(id)), [], "reference storage records never reached the model");
	// A second reference stored after the governance pass still has queued jobs;
	// a raw authority enrich (bypassing the governance wrapper) projects its
	// chunk/manifest records, and the reference must keep working regardless.
	const secondPayload = JSON.stringify({ tool: "web.read", result: "m".repeat(80_000), isError: false });
	const second = await governance.captureToolExecutionEnd({
		sessionId: "s1",
		toolCallId: "call-distill-raw",
		toolName: "web.read",
		result: secondPayload,
	});
	assert.equal(second.status, "referenced");
	const raw = await memory.enrich(
		{
			modelId: "fixture",
			async extract() {
				return { abstract: "模型摘要", overview: "投影覆盖了原字段。", facts: [] };
			},
		},
		{ signal: new AbortController().signal },
	);
	assert.ok(raw.completed >= 2, `raw pass distilled reference records: ${JSON.stringify(raw)}`);
	const rawRef = JSON.parse((await governance.authority.get(scope, second.id)).full).resultRef;
	let text = "";
	for (let offset = 0; ; ) {
		const page = await governance.readResultReference(rawRef, offset);
		text += page.text;
		offset = page.nextOffset;
		if (page.complete) break;
	}
	assert.equal(JSON.parse(text).result, secondPayload);
	assert.equal(await governance.revokeResultReference("revoke-post-distill", rawRef), 2);
	assert.equal(await governance.readResultReference(rawRef).then(
		() => "readable",
		(error) => error.message,
	), "Result not found");
});

test("oversized captures park through the pending queue during an authority outage (review-1 F2)", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pi861-governance-outage-big-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const memory = new LayeredMemory(
		new FileStateStore(join(dir, "memory.json"), emptyLayeredMemory("t")),
		principal,
	);
	const gate = gatedAuthority(memory);
	const pendingStore = new FileStateStore(join(dir, "pending.json"), { version: 1, entries: [] });
	const governance = attachMemoryGovernance({}, { authority: gate, pending: pendingStore, scope, resultPageSize: 128_000 });
	gate.setDown(true);
	const payload = JSON.stringify({ tool: "web.read", result: "b".repeat(80_000), isError: false });
	const outcome = await governance.captureToolExecutionEnd({
		sessionId: "s1",
		toolCallId: "call-outage",
		toolName: "web.read",
		result: payload,
	});
	// Same pause boundary as every other capture: checkpoint-uncommitted, parked
	// locally, no raw connection error, nothing readable from a local authority.
	assert.equal(outcome.status, "failed");
	assert.match(outcome.error, /checkpoint uncommitted/);
	const parked = JSON.parse(readFileSync(join(dir, "pending.json"), "utf8"));
	assert.ok(parked.entries.length >= 1, "the chunk write parked as uncommitted");
	assert.ok(parked.entries.every((entry) => entry.state === "uncommitted"));
	assert.equal((await memory.search("bbbbbbbbbbbb")).length, 0);
	// Recovery: flush replays the parked chunk; retrying the capture completes
	// the manifest and descriptor idempotently, then the payload reads back.
	gate.setDown(false);
	const flushed = await governance.flushPending();
	assert.equal(flushed.committed, parked.entries.length);
	const retried = await governance.captureToolExecutionEnd({
		sessionId: "s1",
		toolCallId: "call-outage",
		toolName: "web.read",
		result: payload,
	});
	assert.equal(retried.status, "referenced");
	const resultRef = JSON.parse((await memory.get(scope, retried.id)).full).resultRef;
	let text = "";
	for (let offset = 0; ; ) {
		const page = await governance.readResultReference(resultRef, offset);
		text += page.text;
		offset = page.nextOffset;
		if (page.complete) break;
	}
	assert.equal(JSON.parse(text).result, payload);
});

test("sensitive payloads are withheld from every storage layer", async (t) => {
	const { governance, memory } = setup(t);
	const secret = `config: password=super-secret-value-1234567890 and ${"a".repeat(80_000)}`;
	const outcome = await governance.captureToolExecutionEnd({
		sessionId: "s1",
		toolCallId: "call-3",
		toolName: "fs.read",
		result: secret,
	});
	assert.equal(outcome.status, "referenced");
	const record = await governance.authority.get(scope, outcome.id);
	assert.ok(!record.full.includes("super-secret-value"));
	const body = JSON.parse(record.full);
	assert.equal(body.withheld, "sensitive");
	// The secret never entered any stored record, summary included.
	assert.equal((await memory.search("super-secret-value-1234567890")).length, 0);
	assert.ok(!JSON.stringify(await memory.search("password")).includes("super-secret"));
});

test("recall output is never accepted as new evidence and inference cannot self-promote", async (t) => {
	const { governance } = setup(t);
	await assert.rejects(
		governance.authority.put({
			requestId: "recall-1",
			expectedRevision: null,
			item: {
				id: "r",
				scope,
				kind: "working",
				status: "candidate",
				abstract: "a",
				overview: "o",
				full: "remembered content",
				source: { kind: "recall", ref: "recall:whatever" },
			},
		}),
		/Recalled memory is not new evidence/,
	);
	await assert.rejects(
		governance.authority.put({
			requestId: "inf-1",
			expectedRevision: null,
			item: {
				id: "i",
				scope,
				kind: "working",
				status: "confirmed",
				abstract: "a",
				overview: "o",
				full: "inferred",
				source: { kind: "inference", ref: "model:x" },
			},
		}),
		/cannot promote itself/,
	);
	await assert.rejects(
		governance.authority.put({
			requestId: "inf-2",
			expectedRevision: null,
			item: {
				id: "i2",
				scope,
				kind: "constraint",
				status: "candidate",
				abstract: "a",
				overview: "o",
				full: "inferred policy",
				source: { kind: "inference", ref: "model:x" },
			},
		}),
		/cannot promote itself/,
	);
});

test("authority failure parks the write locally, never mints a local authority", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pi861-governance-down-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const memory = new LayeredMemory(
		new FileStateStore(join(dir, "memory.json"), emptyLayeredMemory("t")),
		principal,
	);
	const gate = gatedAuthority(memory);
	const pendingStore = new FileStateStore(join(dir, "pending.json"), { version: 1, entries: [] });
	const governance = attachMemoryGovernance({}, { authority: gate, pending: pendingStore, scope });
	gate.setDown(true);
	const outcome = await governance.captureUserStatement({ sessionId: "s1", sequence: 9, text: "数据库迁移前必须备份", kind: "constraint" });
	assert.equal(outcome.status, "failed");
	assert.match(outcome.error, /checkpoint uncommitted/);
	// The real authority has nothing; the pending queue is not a read backend.
	assert.equal(await memory.get(scope, digest(["pi861.user", "s1", 9])), undefined);
	const parked = JSON.parse(readFileSync(join(dir, "pending.json"), "utf8"));
	assert.equal(parked.entries.length, 1);
	assert.equal(parked.entries[0].state, "uncommitted");
	// Recovery replays the original requestId through the authority.
	gate.setDown(false);
	const flushed = await governance.flushPending();
	assert.deepEqual(flushed, { committed: 1, pending: 0 });
	const stored = await memory.get(scope, digest(["pi861.user", "s1", 9]));
	assert.equal(stored.full, "数据库迁移前必须备份");
});

test("withdrawal propagates to the change feed and revokes existing references at once", async (t) => {
	const { governance } = setup(t);
	await governance.captureUserStatement({ sessionId: "s1", sequence: 1, text: "临时约束：周五前完成迁移", kind: "constraint" });
	const id = digest(["pi861.user", "s1", 1]);
	const before = await governance.authority.get(scope, id);
	await governance.withdrawSource("withdraw-1", scope, id, before.revision);
	assert.equal(await governance.authority.get(scope, id), undefined);
	assert.ok(!parseAssembled(await governance.assembleContext("startup")).some((line) => line.id === id));
	// Index consumers see the withdrawal in the monotonic feed.
	const feed = await governance.changes();
	assert.ok(feed.changes.some((change) => change.id === id && change.withdrawn));
	// Replaying the original capture returns the historical receipt only; the
	// record stays withdrawn - the withdrawal is never resurrected.
	const replayed = await governance.captureUserStatement({ sessionId: "s1", sequence: 1, text: "临时约束：周五前完成迁移", kind: "constraint" });
	assert.equal(replayed.status, "captured");
	assert.equal(await governance.authority.get(scope, id), undefined);
	// The same content under a new request identity is blocked by the tombstone
	// (the rejection parks as an uncommitted checkpoint, never as stored content).
	const reentered = await governance.captureUserStatement({ sessionId: "s1", sequence: 2, text: "临时约束：周五前完成迁移", kind: "constraint" });
	assert.equal(reentered.status, "failed");
	assert.match(reentered.error, /checkpoint uncommitted/);
	assert.equal(await governance.authority.get(scope, digest(["pi861.user", "s1", 2])), undefined);
});

test("distillation runs through the P1-S enrich port and publishes derived views only", async (t) => {
	const { governance } = setup(t);
	await governance.captureUserStatement({ sessionId: "s1", sequence: 1, text: "会议决定：搜索链路先做授权前 DNS 拦截。", kind: "project" });
	const seen = [];
	const stats = await governance.distill(
		(context, record, signal) => {
			seen.push({ context, record, aborted: signal.aborted });
			return Promise.resolve({
				abstract: "搜索链路决定",
				overview: "已决定先做授权前 DNS 拦截。",
				facts: [{ text: "先做 DNS 拦截", quote: "先做授权前 DNS 拦截" }],
			});
		},
		{ credential: "fixture", scope, taskId: null },
		"fixture-model",
		{ signal: new AbortController().signal },
	);
	assert.equal(stats.completed, 1);
	assert.deepEqual(seen[0].context, { credential: "fixture", scope, taskId: null });
	assert.equal(seen[0].record.source.kind, "user");
	const stored = await governance.authority.get(scope, digest(["pi861.user", "s1", 1]));
	assert.equal(stored.abstract, "搜索链路决定");
	assert.equal(stored.revision, 1); // projection is a derived view, not a new revision
	const jobs = await governance.distillationJobs();
	assert.equal(jobs.filter((job) => job.state === "done").length, 1);
	// The derived view never becomes independent evidence: every feed entry still
	// references the same record and revision; no new record identity appeared.
	const feed = await governance.changes();
	assert.ok(feed.changes.length >= 1);
	assert.ok(feed.changes.every((change) => change.id === stored.id));
	assert.ok(feed.changes.every((change) => change.revision === 1 && !change.withdrawn));
});

test("transient distillation failures back off and recover; invalid output parks terminally", async (t) => {
	const { governance } = setup(t);
	await governance.captureUserStatement({ sessionId: "s1", sequence: 1, text: "工期约定：两周内完成存储切换。", kind: "project" });
	let attempts = 0;
	const stats = await governance.distill(
		(_context, _record, _signal) => {
			attempts++;
			if (attempts < 3) return Promise.reject(new Error("model endpoint overloaded"));
			return Promise.resolve({ abstract: "工期摘要", overview: "两周内完成存储切换。", facts: [] });
		},
		{},
		"fixture-model",
		{ signal: new AbortController().signal, maxJobs: 5, backoffBaseMs: 0, backoffCapMs: 1 },
	);
	assert.equal(stats.failed, 2);
	assert.equal(stats.completed, 1);
	const [job] = await governance.distillationJobs();
	assert.equal(job.state, "done");
	assert.equal(job.failures, 2);

	// A second record whose extractor returns a non-literal quote parks terminally.
	await governance.captureUserStatement({ sessionId: "s1", sequence: 2, text: "第二条记录", kind: "project" });
	await governance.distill(
		() => Promise.resolve({ abstract: "a", overview: "o", facts: [{ text: "t", quote: "不存在的引用" }] }),
		{},
		"fixture-model",
		{ signal: new AbortController().signal },
	);
	const failed = (await governance.distillationJobs()).find((entry) => entry.state === "failed");
	assert.ok(failed, "invalid output is terminal");
	assert.equal(failed.failureClass, "invalid_output");
	const requeued = await governance.requeueDistillation(failed.id);
	assert.equal(requeued.state, "queued");
	assert.equal(requeued.failures, 0);
});

test("auxiliaryExtractor adapts the frozen port shape", async (t) => {
	const extractor = auxiliaryExtractor("m", (ctx, record) => Promise.resolve({ ctx, record }), { id: 7 });
	assert.equal(extractor.modelId, "m");
	const result = await extractor.extract({ id: "r", revision: 1, text: "x", source: { kind: "user", ref: "e" } }, new AbortController().signal);
	assert.deepEqual(result.ctx, { id: 7 });
	assert.equal(result.record.id, "r");
	assert.throws(() => auxiliaryExtractor("", () => {}), /model id/);
});

test("only one governance collector can be installed per host", async (t) => {
	const first = setup(t);
	assert.throws(() => {
		attachMemoryGovernance(first.host, {
			authority: first.memory,
			pending: new FileStateStore(join(first.dir, "pending2.json"), { version: 1, entries: [] }),
			scope,
		});
	}, MemoryGovernanceAlreadyInstalled);
	first.governance.detach();
	assert.equal(first.host.memoryGovernance, undefined);
	const second = attachMemoryGovernance(first.host, {
		authority: first.memory,
		pending: new FileStateStore(join(first.dir, "pending3.json"), { version: 1, entries: [] }),
		scope,
	});
	assert.equal(first.host.memoryGovernance, second);
});

test("private-scope records and their derived views never leak into a narrow principal", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pi861-governance-scope-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const memoryStore = new FileStateStore(join(dir, "memory.json"), emptyLayeredMemory("t"));
	const wide = new LayeredMemory(memoryStore, widePrincipal);
	await wide.put({
		requestId: "pub-1",
		expectedRevision: null,
		item: {
			id: "pub",
			scope,
			kind: "constraint",
			status: "confirmed",
			abstract: "公开约束",
			overview: "公开约束",
			full: "公开约束：所有变更需要审核",
			source: { kind: "user", ref: "event:pub" },
		},
	});
	await wide.put({
		requestId: "priv-1",
		expectedRevision: null,
		item: {
			id: "priv",
			scope: "project:secret",
			kind: "constraint",
			status: "confirmed",
			abstract: "私有约束",
			overview: "私有约束",
			full: "私有约束：收购谈判细节不得外传",
			source: { kind: "user", ref: "event:priv" },
		},
	});
	// Distill both records; each derived view derives from its own source text only.
	await wide.enrich(
		{
			modelId: "fixture",
			async extract(input) {
				return {
					abstract: input.id === "priv" ? "私有摘要" : "公开摘要",
					overview: input.text.slice(0, 12),
					facts: [],
				};
			},
		},
		{ signal: new AbortController().signal },
	);
	const governance = attachMemoryGovernance({}, {
		authority: new LayeredMemory(memoryStore, principal),
		pending: new FileStateStore(join(dir, "pending.json"), { version: 1, entries: [] }),
		scope,
	});
	const assembled = parseAssembled(await governance.assembleContext("startup"));
	assert.ok(assembled.some((line) => line.content.includes("公开约束")));
	assert.ok(!assembled.some((line) => line.content.includes("收购谈判")));
	assert.ok(!assembled.some((line) => line.content.includes("私有摘要")));
	// Direct reads, searches and jobs of the private scope stay invisible.
	assert.equal(await governance.authority.get("project:secret", "priv"), undefined);
	assert.equal((await governance.authority.search("收购谈判")).length, 0);
	assert.equal((await governance.distillationJobs()).filter((job) => job.scope === "project:secret").length, 0);
});

test("adoption requires a C7 acceptance digest and only promotes candidates", async (t) => {
	const { governance } = setup(t);
	// Candidates start unconfirmed; adoption is the only promotion path with a digest.
	await governance.authority.put({
		requestId: "candidate-1",
		expectedRevision: null,
		item: {
			id: "candidate",
			scope,
			kind: "project",
			status: "candidate",
			abstract: "候选事实",
			overview: "候选事实",
			full: "候选事实：存储切换完成",
			source: { kind: "tool", ref: "check:storage" },
		},
	});
	const recordId = "candidate";
	const evidenceDigest = "a".repeat(64);
	const receipt = await governance.adoptFromAcceptance({
		version: 1,
		recordId,
		scope,
		adoptedAt: Date.now(),
		acceptanceEvidenceDigest: evidenceDigest,
		adoptedBy: "integration-check",
	});
	assert.equal(receipt.revision, 2);
	const adopted = await governance.authority.get(scope, recordId);
	assert.equal(adopted.status, "confirmed");
	assert.equal(adopted.source.kind, "verified");
	assert.equal(adopted.source.ref, `adoption:${evidenceDigest}`);
	// Branch completion carries no digest and must fail the C6 gate.
	await assert.rejects(
		governance.adoptFromAcceptance({
			version: 1,
			recordId,
			scope,
			adoptedAt: Date.now(),
			acceptanceEvidenceDigest: "not-a-digest",
			adoptedBy: "branch-merge",
		}),
		/Invalid adoption event/,
	);
	// Already-confirmed records cannot be adopted a second time.
	await assert.rejects(
		governance.adoptFromAcceptance({
			version: 1,
			recordId,
			scope,
			adoptedAt: Date.now(),
			acceptanceEvidenceDigest: evidenceDigest,
			adoptedBy: "integration-check",
		}),
		/Only candidate records/,
	);
});

test("same requestId replays the same receipt; different intent conflicts", async (t) => {
	const { governance, memory } = setup(t);
	const observation = { sessionId: "s1", toolCallId: "call-9", toolName: "fs.stat", result: { size: 1 } };
	const first = await governance.captureToolExecutionEnd(observation);
	const second = await governance.captureToolExecutionEnd(observation);
	assert.equal(first.id, second.id);
	const delta = await governance.changes();
	assert.equal(delta.changes.length, 1);
	// A different result under the same tool-call identity is an intent conflict.
	const divergent = await governance.captureToolExecutionEnd({ ...observation, result: { size: 2 } });
	assert.equal(divergent.status, "failed");
	assert.match(divergent.error, /idempotency conflict/);
	assert.equal((await memory.get(scope, first.id)).full.includes('"size":2'), false);
});
