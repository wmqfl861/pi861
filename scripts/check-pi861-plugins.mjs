#!/usr/bin/env node
// Installation checks only: no external model, search, or MCP calls.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadExtensions } from "../packages/coding-agent/src/core/extensions/loader.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const expected = {
  "pi-mcp-adapter": "5.0.0",
  "pi-subagents": "0.74.0",
  "pi-web-access": "0.35.0",
  "pi-hermes-memory": "0.9.9",
};
const settings = JSON.parse(readFileSync(join(root, ".pi/settings.json"), "utf8"));
const home = mkdtempSync(join(tmpdir(), "pi861-plugins-check-"));
const agentDir = join(home, ".pi/agent"), workspace = join(home, "project");
mkdirSync(agentDir, { recursive: true });
mkdirSync(workspace);
// Affect this verification process only, never the user's saved configuration.
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.XDG_CONFIG_HOME = join(home, ".config");
process.env.XDG_CACHE_HOME = join(home, ".cache");
writeFileSync(join(agentDir, "hermes-memory-config.json"), JSON.stringify({
  reviewEnabled: false, flushOnCompact: false, flushOnShutdown: false,
  autoConsolidate: false, correctionDetection: false,
}));
let result;
let hermes;
const ctx = { cwd: workspace, hasUI: false, ui: { notify() {} }, sessionManager: { getSessionFile() {} } };
try {
  const paths = Object.entries(expected).flatMap(([name, version]) => {
    assert.ok(settings.packages.includes(`npm:${name}@${version}`), `Missing project pin for ${name}`);
    const directory = join(root, ".pi/npm/node_modules", name);
    const metadata = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    assert.equal(metadata.version, version, `Installed version drift for ${name}`);
    assert.ok(metadata.pi.extensions.length > 0);
    return metadata.pi.extensions.map((entry) => join(directory, entry));
  });
  result = await loadExtensions(paths, workspace);
  assert.deepEqual(result.errors, [], JSON.stringify(result.errors));
  assert.equal(result.extensions.length, 4);
  const tools = result.extensions.flatMap((extension) => [...extension.tools.keys()]);
  assert.equal(new Set(tools).size, tools.length, "Duplicate community tool names");
  for (const tool of ["mcp", "subagent", "web_search", "memory_add", "memory_search", "memory_remove"]) {
    assert.ok(tools.includes(tool), `Missing tool ${tool}`);
  }
  console.log(JSON.stringify({ installed: expected, tools, commands: result.extensions.flatMap((extension) => [...extension.commands.keys()]) }, null, 2));
  const require = createRequire(join(root, ".pi/npm/package.json"));
  const Database = require("better-sqlite3"), db = new Database(":memory:");
  try {
    db.exec("CREATE VIRTUAL TABLE notes USING fts5(content)");
    db.prepare("INSERT INTO notes(content) VALUES (?)").run("pi861 installation fixture");
    assert.equal(db.prepare("SELECT count(*) AS n FROM notes WHERE notes MATCH 'pi861'").get().n, 1);
  } finally { db.close(); }
  hermes = result.extensions.find((extension) => extension.tools.has("memory_add"));
  const call = (name, args) => hermes.tools.get(name).definition.execute("installation-check", args, undefined, undefined, ctx);
  const marker = "PI861PLUGININSTALLATIONFIXTURE";
  const added = await call("memory_add", { target: "memory", content: `${marker} is test data, not a user fact.` });
  assert.equal(added.details.success, true, JSON.stringify(added));
  const found = await call("memory_search", { query: marker });
  assert.equal(found.details.success, true);
  assert.equal(found.details.count, 1, JSON.stringify(found));
  const removed = await call("memory_remove", { target: "memory", old_text: marker });
  assert.equal(removed.details.success, true, JSON.stringify(removed));
  console.log("PASS: four plugin factories; unique tools; native SQLite FTS5; Hermes add/search/remove. No model/search/MCP service invoked.");
} finally {
  try {
    for (const handler of hermes?.handlers.get("session_shutdown") ?? []) {
      await handler({ type: "session_shutdown", reason: "reload" }, ctx);
    }
  } finally {
    result?.runtime.invalidate("Installation verification finished");
    rmSync(home, { recursive: true, force: true });
  }
}
