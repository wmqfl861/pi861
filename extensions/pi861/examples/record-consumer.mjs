/**
 * P2-D record-level consumer example for P2-M (memory governance) and P3-I wiring.
 *
 * The item facade (MemoryInput) carries a single source and no derivation links, so
 * adoption chains ([original source, verified]) and distilled summaries that derive
 * from other records cannot be expressed through it. Both authorities now expose the
 * record surface instead:
 *
 *   - file authority:  RecordMemory (src/live/record-store.ts) over a StateStore
 *     (FileStateStore for local mode, PostgresStateStore for shared state);
 *   - database authority: PostgresMemory.putRecord / StorageSession.putRecord and
 *     the authenticated "putRecord" operation of scripts/storage-service.mjs.
 *
 * Withdrawal is recursive on both authorities through the same frozen C6 planner:
 * withdrawing a source withdraws its derivatives transitively and tombstones their
 * fingerprints, so old sources cannot revive through a later put.
 *
 * Usage:
 *   node --experimental-strip-types examples/record-consumer.mjs            # file authority
 *   PI861_RECORD_EXAMPLE_URL=postgres://... node --experimental-strip-types examples/record-consumer.mjs
 * The database part expects the memory-v3 + storage-v4 migrations to be applied.
 */
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyAdoption, validateMemoryRecord } from "../src/contracts/memory.ts";
import { digest } from "../src/contracts/hash.ts";
import { FileStateStore } from "../src/live/store.ts";
import { RecordMemory, emptyRecordStoreState } from "../src/live/record-store.ts";
import { PostgresMemory } from "../src/postgres.ts";

const principal = {
	tenantId: "demo",
	principalId: "memory-service",
	readScopes: ["project:demo"],
	writeScopes: ["project:demo"],
};

function sourceRecord() {
	return {
		id: "finding-1",
		scope: { kind: "project", key: "demo" },
		purpose: "project",
		abstract: "candidate finding from integration evidence",
		overview: "integration evidence recorded for the acceptance phase",
		full: "the integration run produced evidence E-1 with digest d1f0...",
		provenance: [{ sourceKind: "user", ref: "event:run-42", at: Date.now() }],
		derivedFrom: [],
		revision: 1,
		status: "candidate",
		updatedAt: Date.now(),
	};
}

function derivedRecord(sourceScope, sourceId, sourceRevision) {
	return {
		id: `summary-of-${sourceId}`,
		scope: { kind: "project", key: "demo" },
		purpose: "experience",
		abstract: "distilled summary",
		overview: "summary overview bound to the source revision",
		full: "distilled: the run produced evidence E-1",
		provenance: [{ sourceKind: "inference", ref: `distill:${sourceId}@${sourceRevision}`, at: Date.now() }],
		derivedFrom: [{ scope: sourceScope, id: sourceId, revision: sourceRevision }],
		revision: 1,
		status: "candidate",
		updatedAt: Date.now(),
	};
}

/** The same consumer flow against any record-level authority (file or database). */
async function run(label, authority) {
	// 1. Record the candidate evidence.
	const put = await authority.putRecord({ requestId: `${label}:put`, expectedRevision: null, record: sourceRecord() });
	// 2. Integration acceptance adopts it: verified provenance is APPENDED by the
	//    frozen contract (branch completion alone can never mint it).
	const adopted = applyAdoption(await authority.getRecord("project:demo", put.id), {
		version: 1,
		recordId: put.id,
		scope: "project:demo",
		adoptedAt: Date.now(),
		acceptanceEvidenceDigest: digest(["acceptance", "evidence", label]),
		adoptedBy: "goal-acceptance",
	});
	const promoted = await authority.putRecord({ requestId: `${label}:adopt`, expectedRevision: put.revision, record: adopted });
	validateMemoryRecord(await authority.getRecord("project:demo", put.id));
	// 3. Distillation writes a derivative bound to the adopted revision; withdrawal of
	//    the source (or any upstream record) will withdraw it transitively.
	await authority.putRecord({
		requestId: `${label}:derive`,
		expectedRevision: null,
		record: derivedRecord("project:demo", put.id, promoted.revision),
	});
	// 4. Withdraw the adopted source: the derivative dies with it, tombstoned.
	await authority.withdraw(`${label}:withdraw`, "project:demo", put.id, promoted.revision);
	console.log(
		`[${label}] adopted revision ${promoted.revision}; source after withdrawal: ${String(
			await authority.getRecord("project:demo", put.id),
		)}; derivative after withdrawal: ${String(await authority.getRecord("project:demo", `summary-of-${put.id}`))}`,
	);
}

// File authority (local mode): single writer through the StateStore lock; the state
// file lives in a throwaway temp directory, never inside the repository.
const stateDir = await mkdtemp(join(tmpdir(), "pi861-record-example-"));
try {
	const file = new RecordMemory(new FileStateStore(join(stateDir, "records.json"), emptyRecordStoreState()), principal);
	await run("file", file);
} finally {
	await rm(stateDir, { recursive: true, force: true });
}

// Database authority: same surface, same recursive semantics, RLS-scoped.
if (process.env.PI861_RECORD_EXAMPLE_URL) {
	const require = createRequire(
		process.env.PI861_TEST_DRIVER_ROOT ? `${process.env.PI861_TEST_DRIVER_ROOT}/package.json` : import.meta.url,
	);
	const { Pool } = require("pg");
	const pool = new Pool({
		connectionString: process.env.PI861_RECORD_EXAMPLE_URL,
		options: process.env.PI861_RECORD_EXAMPLE_SCHEMA
			? `-c search_path=${process.env.PI861_RECORD_EXAMPLE_SCHEMA}`
			: undefined,
	});
	try {
		await run("db", new PostgresMemory(pool, { ...principal, principalId: "record-example" }));
	} finally {
		await pool.end();
	}
} else {
	console.log("[db] skipped: set PI861_RECORD_EXAMPLE_URL (and optional PI861_RECORD_EXAMPLE_SCHEMA)");
}
