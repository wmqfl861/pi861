#!/usr/bin/env node
// Developer tooling only. Does not change the product's execution architecture.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateGeneratedModelData } from "../packages/ai/scripts/model-data.ts";
import { hydrateTestCatalog } from "./hydrate-pi861-test-catalog.mjs";

const script = fileURLToPath(import.meta.url);
const root = resolve(dirname(script), "..");
const artifacts = join(root, ".artifacts/pi861-dev");
const pin = JSON.parse(readFileSync(join(root, "scripts/pi861-test-catalog.json"), "utf8"));
const node = process.execPath;
const help = `Pi861 development commands (Node 24, Linux dev container):
  setup       Install locked dependencies and verified release model data
  doctor      Check the toolchain, dependencies and model-data integrity
  check       Run the full repository check and extension entry type checks
  smoke       Run focused regressions and the real source-host fixture
  test        Run all extension *.test.mjs tests (known timing issue documented)
  postgres    Test the dedicated dev-container PostgreSQL database
  demo        Execute the full runtime using a local deterministic provider
  verify      doctor + check + smoke + postgres + demo
No command configures real model/search/MCP credentials or pushes Git.
See DEVELOPMENT.md for interactive development and saving changes.
`;

export function testEnvironment(source, workspace) {
  const allowed = ["PATH", "SystemRoot", "WINDIR", "TMP", "TEMP", "TMPDIR", "LANG", "LC_ALL", "TZ", "TERM"];
  const env = Object.fromEntries(allowed.filter((key) => typeof source[key] === "string").map((key) => [key, source[key]]));
  const home = join(workspace, ".artifacts/pi861-dev/test-home");
  return { ...env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"), PI_CODING_AGENT_DIR: join(home, ".pi/agent"),
    PI861_WEB_SEARCH_ENABLED: "0", NO_COLOR: "1" };
}

export function fixtureConfig(directory) {
  return { version: 2, projectId: "pi861-dev-demo", stateDirectory: join(directory, "state"),
    role: { id: "developer", skillIds: [], grants: [] },
    models: {
      targets: ["cheap", "strong"].map((id, index) => ({ id, revision: "1", provider: "pi861-fixture",
        model: id, quality: index + 1, costRank: index + 1, contextWindow: 200000,
        capabilities: ["tools"], enabled: true })),
      preferred: "cheap", intakeId: "cheap", enableRouting: false,
      requirements: { minQuality: 1, contextTokens: 100, capabilities: ["tools"], allowedIds: ["cheap", "strong"] },
      recovery: { failoverEnabled: true, failbackEnabled: false, probeIntervalMs: 1000,
        maxProbeIntervalMs: 5000, requiredProbeSuccesses: 2 },
      maxAttempts: 2, requestTimeoutMs: 10000, maxRequests: 20, maxProbeRequests: 1 },
    memory: { autoRecall: true, autoCapture: true, autoEnrich: false, modelId: "strong" },
    budget: { maxRequests: 20 } };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", timeout: 600000, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${basename(command)} failed: ${result.status ?? result.signal}`);
  return result;
}

function setup() {
  run("npm", ["ci", "--ignore-scripts"]);
  run("npm", ["ci", "--prefix", "extensions/pi861", "--ignore-scripts"]);
  run("npm", ["ci", "--prefix", ".devcontainer/driver", "--ignore-scripts"]);
  mkdirSync(artifacts, { recursive: true });
  const temporary = mkdtempSync(join(artifacts, "catalog-"));
  try {
    const spec = `${pin.packageName}@${pin.version}`;
    run("npm", ["pack", "--ignore-scripts", "--pack-destination", temporary, spec]);
    const archives = readdirSync(temporary).filter((entry) => entry.endsWith(".tgz"));
    if (archives.length !== 1) throw new Error("Expected exactly one pinned package archive");
    run("tar", ["-xzf", join(temporary, archives[0]), "-C", temporary]);
    console.log(hydrateTestCatalog(join(temporary, "package"), join(root, "packages/ai")));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  doctor();
  console.log("Setup complete. Next: node scripts/pi861-dev.mjs smoke");
}

function doctor() {
  for (const file of ["node_modules/tsx/dist/cli.mjs", "node_modules/typescript/bin/tsc",
    "extensions/pi861/node_modules/typebox/package.json", ".devcontainer/driver/node_modules/pg/package.json"]) {
    if (!existsSync(join(root, file))) throw new Error(`Missing ${file}; run setup`);
  }
  validateGeneratedModelData(join(root, "packages/ai"));
  const pg = JSON.parse(readFileSync(join(root, ".devcontainer/driver/node_modules/pg/package.json"), "utf8"));
  if (pg.version !== "8.16.3") throw new Error("PostgreSQL development driver drift");
  run("git", ["--version"]);
  console.log(`Node ${process.version}; dependencies and model data valid.`);
  console.log("Database connectivity is checked only by the explicit postgres command.");
}

function check() {
  run("npm", ["run", "check"]);
  for (const config of ["tsconfig.json", "tsconfig.entries.json", "tsconfig.host-source.json"]) {
    run(node, ["node_modules/typescript/bin/tsc", "--noEmit", "-p", `extensions/pi861/${config}`]);
  }
}

function smoke() {
  const env = testEnvironment(process.env, root);
  mkdirSync(env.HOME, { recursive: true });
  run(node, ["--test", "scripts/pi861-dev.test.mjs", "scripts/hydrate-pi861-test-catalog.test.mjs",
    "extensions/pi861/test/acceptance.test.mjs", "extensions/pi861/test/line-process.test.mjs"], { env });
  run(node, ["--test", "extensions/pi861/test/pi-host.integration.mjs", "extensions/pi861/test/runtime-host.integration.mjs"],
    { env: { ...env, PI861_REQUIRE_HOST_TESTS: "1", PI861_TEST_SOURCE_HOST: "1", PI861_TEST_TIMEOUT_MS: "180000" } });
}

function postgres() {
  if (process.env.PI861_DEV_CONTAINER !== "1") throw new Error("postgres requires the dedicated dev container; no external database override is accepted");
  const env = testEnvironment(process.env, root);
  mkdirSync(env.HOME, { recursive: true });
  run(node, ["--test", "extensions/pi861/test/postgres.integration.mjs"], { env: { ...env,
    PI861_ALLOW_TEST_DATABASE: "1",
    PI861_TEST_POSTGRES_URL: "postgresql://postgres:pi861-dev-only@127.0.0.1:5432/pi861_test",
    PI861_TEST_DRIVER_ROOT: join(root, ".devcontainer/driver") } });
}

function demo() {
  mkdirSync(artifacts, { recursive: true });
  const directory = mkdtempSync(join(artifacts, "demo-"));
  const workspace = join(directory, "workspace"), home = join(directory, "home");
  mkdirSync(workspace); mkdirSync(home);
  const config = join(directory, "runtime.json");
  writeFileSync(config, JSON.stringify(fixtureConfig(directory), null, 2));
  const env = { ...testEnvironment(process.env, root), HOME: home, USERPROFILE: home,
    PI_CODING_AGENT_DIR: join(home, ".pi/agent"), PI861_CONFIG: config };
  console.log(`LOCAL FIXTURE ONLY; no real model. Demo files: ${directory}`);
  run(node, [join(root, "node_modules/tsx/dist/cli.mjs"), "--tsconfig", join(root, "tsconfig.json"),
    join(root, "packages/coding-agent/src/experimental/cli.ts"),
    "--print", "--no-session", "--no-extensions", "--no-skills", "--provider", "pi861-fixture", "--model", "cheap",
    "-e", join(root, "extensions/pi861/test/fixtures/native-provider.mjs"),
    "-e", join(root, "extensions/pi861/runtime.ts"),
    "fixture-write: write fixture.txt once using the write tool"
  ], { cwd: workspace, env, timeout: 60000 });
  if (readFileSync(join(workspace, "fixture.txt"), "utf8") !== "written through real Pi") throw new Error("Runtime demo did not produce the expected tool result");
  console.log("Full runtime demo passed: real source host, local fixture provider, write tool and state directory.");
}

export function main(args) {
  const [command = "help"] = args;
  if (["help", "--help", "-h"].includes(command)) { console.log(help); return; }
  if (args.length !== 1) throw new Error("Expected one command; see --help");
  if (!["setup", "doctor", "check", "smoke", "test", "postgres", "demo", "verify"].includes(command)) throw new Error(`Unknown development command: ${command}`);
  if (Number(process.versions.node.split(".")[0]) !== 24) throw new Error("This development recipe requires Node 24.x; open the dev container");
  if (command === "setup") setup();
  else if (command === "doctor") doctor();
  else if (command === "check") check();
  else if (command === "smoke") smoke();
  else if (command === "postgres") postgres();
  else if (command === "demo") demo();
  else if (command === "test") {
    const env = testEnvironment(process.env, root);
    mkdirSync(env.HOME, { recursive: true });
    const directory = join(root, "extensions/pi861/test");
    run(node, ["--test", ...readdirSync(directory).filter((name) => name.endsWith(".test.mjs")).sort().map((name) => join(directory, name))], { env });
  } else {
    doctor(); check(); smoke(); postgres(); demo();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === script) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
