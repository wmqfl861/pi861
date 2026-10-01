import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createModelDataManifest, validateGeneratedModelData } from "../packages/ai/scripts/model-data.ts";
import { hydrateTestCatalog } from "./hydrate-pi861-test-catalog.mjs";

function fixture(t) {
	const directory = mkdtempSync(join(tmpdir(), "pi861 test catalog "));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const source = join(directory, "published");
	const target = join(directory, "source");
	mkdirSync(join(source, "dist/providers/data"), { recursive: true });
	mkdirSync(join(target, "src/providers/data"), { recursive: true });
	const metadata = { name: "@earendil-works/pi-ai", version: "0.86.1" };
	for (const path of [source, target]) writeFileSync(join(path, "package.json"), JSON.stringify(metadata));
	writeFileSync(join(target, "src/models.generated.ts"), 'import { TEST_MODELS } from "./providers/test.models.ts";\n');
	writeFileSync(join(target, "src/providers/test.models.ts"), "// fixture source shard\n");
	const model = { id: "fixture", name: "Fixture", api: "openai-completions", provider: "test", baseUrl: "http://127.0.0.1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 };
	const content = JSON.stringify({ "openai-completions": { fixture: model } });
	writeFileSync(join(source, "dist/providers/data/test.json"), content);
	const manifest = JSON.stringify(createModelDataManifest({ test: { fixture: "openai-completions" } }, { "test.json": content }, "2026-09-20T00:00:00.000Z"));
	writeFileSync(join(source, "dist/providers/data/.manifest.json"), manifest);
	writeFileSync(join(target, "src/providers/data/original.txt"), "preserve on failure");
	const pin = { packageName: metadata.name, version: metadata.version, manifestSha256: createHash("sha256").update(manifest).digest("hex") };
	return { source, target, pin };
}

function assertPreserved(target) {
	assert.equal(readFileSync(join(target, "src/providers/data/original.txt"), "utf8"), "preserve on failure");
	assert.equal(readdirSync(join(target, "src/providers")).some((name) => name.startsWith(".pi861-catalog-")), false);
}

test("pinned catalog hydration validates and replaces data without rewriting generated TypeScript", (t) => {
	const { source, target, pin } = fixture(t);
	const original = readFileSync(join(target, "src/models.generated.ts"), "utf8");
	assert.deepEqual(hydrateTestCatalog(source, target, pin), { version: pin.version, providers: 1, manifestSha256: pin.manifestSha256 });
	validateGeneratedModelData(target);
	assert.equal(readFileSync(join(target, "src/models.generated.ts"), "utf8"), original);
	assert.deepEqual(readdirSync(join(target, "src/providers/data")).sort(), [".manifest.json", "test.json"]);
	hydrateTestCatalog(source, target, pin);
	validateGeneratedModelData(target);
});

test("version drift fails before replacing existing data", (t) => {
	const { source, target, pin } = fixture(t);
	writeFileSync(join(source, "package.json"), JSON.stringify({ name: pin.packageName, version: "0.86.2" }));
	assert.throws(() => hydrateTestCatalog(source, target, pin), /requires/);
	assertPreserved(target);
});

test("manifest tampering is rejected against the independent pin", (t) => {
	const { source, target, pin } = fixture(t);
	writeFileSync(join(source, "dist/providers/data/.manifest.json"), "{}");
	assert.throws(() => hydrateTestCatalog(source, target, pin), /pinned SHA256/);
	assertPreserved(target);
});

test("data tampering fails full validation without replacing existing data", (t) => {
	const { source, target, pin } = fixture(t);
	const file = join(source, "dist/providers/data/test.json");
	const data = JSON.parse(readFileSync(file, "utf8"));
	data["openai-completions"].fixture.maxTokens = 101;
	writeFileSync(file, JSON.stringify(data));
	assert.throws(() => hydrateTestCatalog(source, target, pin), /manifest hash/);
	assertPreserved(target);
});

test("unrecognized provider files fail before copying anything", (t) => {
	const { source, target, pin } = fixture(t);
	writeFileSync(join(source, "dist/providers/data/unexpected.json"), "{}");
	assert.throws(() => hydrateTestCatalog(source, target, pin), /provider files/);
	assertPreserved(target);
});

test("missing shards in the source catalog fail staged validation", (t) => {
	const { source, target, pin } = fixture(t);
	rmSync(join(target, "src/providers/test.models.ts"));
	assert.throws(() => hydrateTestCatalog(source, target, pin), /provider shards do not match/);
	assertPreserved(target);
});
