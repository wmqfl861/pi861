import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readGateway } from "./pi861-alpha-local-smoke.mjs";
function fixture(t, patch = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pi-alpha-private-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "gateway.json");
  const config = { baseUrl: "https://fixture.invalid/v1", apiKey: "fixture-key", model: "gpt-6-luna", thinking: "max", ...patch };
  writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
  return { path, config, dir };
}
test("loads the specified Luna max private configuration without changing model settings", (t) => {
  const { path, config } = fixture(t); assert.deepEqual(readGateway(path), config);
});
test("does not silently lower reasoning or replace model", (t) => {
  assert.throws(() => readGateway(fixture(t, { thinking: "high" }).path));
  assert.throws(() => readGateway(fixture(t, { model: "other" }).path));
});
test("rejects missing credentials or unknown executable settings", (t) => {
  assert.throws(() => readGateway(fixture(t, { apiKey: "" }).path));
  assert.throws(() => readGateway(fixture(t, { command: "unexpected" }).path));
});
test("private configuration cannot be world-readable on POSIX", (t) => {
  if (process.platform === "win32") { t.skip("POSIX mode check"); return; }
  const { path } = fixture(t); chmodSync(path, 0o644);
  assert.throws(() => readGateway(path), /mode 600/);
});
test("does not follow a credential-file symlink", (t) => {
  const { path, dir } = fixture(t), link = join(dir, "link.json");
  symlinkSync(path, link); assert.throws(() => readGateway(link), /regular private/);
});
