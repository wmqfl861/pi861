import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fixtureConfig, testEnvironment } from "./pi861-dev.mjs";

test("test environment drops credentials, external service opt-ins and Node injection", () => {
  const env = testEnvironment({ PATH: "/bin", HOME: "/real-home", GITHUB_TOKEN: "secret", OPENAI_API_KEY: "secret",
    PI861_REAL_MODEL_ACCEPTANCE: "1", PI861_TEST_POSTGRES_URL: "production", NODE_OPTIONS: "--require injected", TZ: "UTC" }, tmpdir());
  assert.equal(env.PATH, "/bin"); assert.equal(env.TZ, "UTC");
  for (const key of ["GITHUB_TOKEN", "OPENAI_API_KEY", "PI861_REAL_MODEL_ACCEPTANCE", "PI861_TEST_POSTGRES_URL", "NODE_OPTIONS"]) assert.equal(env[key], undefined);
  assert.notEqual(env.HOME, "/real-home");
  assert.equal(env.PI861_WEB_SEARCH_ENABLED, "0");
});

test("full runtime demo config has local fixture targets and bounded budgets only", () => {
  const config = fixtureConfig(join(tmpdir(), "pi861 demo"));
  assert.equal(config.version, 2);
  assert.ok(config.models.targets.every((target) => target.provider === "pi861-fixture"));
  assert.equal(config.models.enableRouting, false);
  assert.equal(config.models.maxRequests, 20);
  assert.equal(config.memory.autoEnrich, false);
  assert.equal(config.workers, undefined);
});

test("development CLI rejects unknown commands without running setup", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./pi861-dev.mjs", import.meta.url)), "publish"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown development command/);
});

test("PostgreSQL command refuses non-development environments", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./pi861-dev.mjs", import.meta.url)), "postgres"],
    { encoding: "utf8", env: testEnvironment(process.env, tmpdir()) });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /dedicated dev container/);
});
