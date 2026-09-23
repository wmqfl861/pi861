# Pi861 production entry registry

Owner: P0-T (toolchain). This document and `scripts/pi861-production-entries.json` are the
registry required by CONTINUATION_PLAN_2026-09-23 P0-T. Check coverage is owned by P0-T;
each entry's file content belongs to its module owner (last column).

A production entry is a file a host or operator actually starts. Everything else under
`extensions/pi861/` is library code reached only through these entries.

## Registry

| Entry | Kind | Lint | Type | Actual startup | Content owner |
| --- | --- | --- | --- | --- | --- |
| `extensions/pi861/runtime.ts` | Pi extension entry, declared in `package.json#pi.extensions` | root `biome.json` | ext `tsconfig.json`, `tsconfig.entries.json`, `tsconfig.host.json` (published host), `tsconfig.host-source.json` (source host), root `tsconfig.json` (tsgo) | CI `pi-host` matrix (published+source x linux+windows): `test/pi-host.integration.mjs`, `test/runtime-host.integration.mjs`; duplicate-install guard `test/host-install.integration.mjs` | P0-H / P3-I |
| `extensions/pi861/index.ts` | programmatic install entry (`installPi861`) | root `biome.json` | same five tsconfigs | loaded by the CI host matrix through `runtime.ts` and by the composition example | P0-H / P3-I |
| `extensions/pi861/scripts/run-acceptance.mjs` | operator CLI (trusted acceptance runner) | root `biome.json` | `tsconfig.entries.json` (checkJs) | `node extensions/pi861/scripts/run-acceptance.mjs ABS_CONFIG [ABS_REPORT]`; refuses non-absolute paths, exits 1 without a trusted config | P1-Q |
| `extensions/pi861/scripts/real-acceptance/real-model.mjs` | operator CLI, default closed | root `biome.json` | `tsconfig.entries.json` (checkJs) | no env set: performs zero requests, reports `status=deferred` (exit 0 means the runner ran; deferred is never a pass); real run only under explicit authorization (K10) | P1-Q |
| `extensions/pi861/scripts/real-acceptance/real-search.mjs` | operator CLI, default closed | root `biome.json` | `tsconfig.entries.json` (checkJs) | same pattern; authorization: `PI861_REAL_SEARCH_ACCEPTANCE=1` | P1-Q |
| `extensions/pi861/scripts/real-acceptance/real-mcp.mjs` | operator CLI, default closed | root `biome.json` | `tsconfig.entries.json` (checkJs) | same pattern; authorization: `PI861_REAL_MCP_ACCEPTANCE=1` | P1-Q |
| `extensions/pi861/examples/postgres-extension.mjs` | composition example | root `biome.json` | `tsconfig.entries.json` (checkJs) | operator composition: install `pg` in a separate operator-owned extension dir and start Pi with this file; no automatic startup, lint+type coverage is its acceptance correspondence | P2-D |

Reserved future entries (not yet landed; already covered by today's globs so they cannot
ship unchecked):

| Entry | Planned by | Check group |
| --- | --- | --- |
| `extensions/pi861/scripts/worker-service.mjs` | P2-W | K7 |
| `extensions/pi861/scripts/storage-service.mjs` | P2-D | K4 |
| `extensions/pi861/src/live/web-extract-process.ts` (or equivalent controlled extract entry) | P2-E | K6 |

## Enforcement

`node scripts/check-pi861-entries.mjs` (`npm run check:pi861-entries`, part of `npm run check`)
fails when:

- any required coverage pattern is missing from `biome.json`, root `tsconfig.json` or
  `extensions/pi861/tsconfig.entries.json`;
- a registered entry is not matched by the actual include lists (catches reorganized globs
  that silently drop a file);
- root `tsconfig.json` `exclude` matches an entry;
- `tsconfig.entries.json` drops `allowJs`/`checkJs`;
- `extensions/pi861/package.json` `pi.extensions` stops being exactly `["runtime.ts"]`;
- a registered entry file or a declared entry is missing;
- a reserved future entry would not be covered by the current globs;
- a new `.mjs` under `extensions/pi861/scripts/**` or `extensions/pi861/examples/**`
  (or a changed set of declared TS entries) is not registered, or vice versa.

`@types/pg` is pinned as a root devDependency (type-only; the runtime `pg` driver stays
operator-installed per the example's contract) so `checkJs` resolves `import pg from "pg"`
against the real published types instead of skipping the example.

## Missing-host behavior

Host acceptance runs with `PI861_REQUIRE_HOST_TESTS=1`: if no host CLI is resolvable,
`test/pi-host.integration.mjs` throws ("a skipped host test is not a pass") instead of
skipping. The CI `pi-host` job sets this for both hosts on both operating systems, and
`tsconfig.host.json` fails outright when the published host package is absent.

## Provenance

Baseline: `d28044896a9ccd0bc81fb9a1d0d28eee7e9f86d5` on
`feat/pi861-runtime-v1-cont-20260923-p0-toolchain`. The pre-existing toolchain files
(`biome.json`, root `tsconfig.json`, `extensions/pi861/tsconfig.host-source.json`,
`extensions/pi861/tsconfig.entries.json`, `.github/workflows/pi861-runtime.yml`) and the
imported entry substrate files were taken byte-identical from the P0-A preserved main-tree
snapshot (SHA256-verified against its content manifest).
