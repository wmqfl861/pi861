# Pi861 cloud continuation — 2026-10-01

## Authorization and baseline

The user explicitly requested development in the current cloud/project environment, not on their personal computer, and automatic upload of the changes to this repository.

- Baseline: `feat/pi861-runtime-v1` at `77e94602d69694b42da833b6d1302a765fa56b4e`.
- Isolated delivery branch: `feat/pi861-runtime-v1-cloud-20261001`.
- Do not modify or merge `main`, force push, publish packages, deploy services, access business databases, or invoke paid model/search/MCP services.
- Retain the original R1–R8 requirements, AX1–AX10 acceptance scope, historical plans and evidence. This iteration repairs existing verification failures; it is not a new architecture or a claim that all requirements have passed.

## Execution and evidence boundaries

The current session has an isolated Linux container and an authorized GitHub connector. Direct `git ls-remote` failed with `Could not resolve host: github.com`. The connector can read/write branch-scoped Git objects and retrieve Actions artifacts. No connection to the user's computer is needed or used for this iteration.

Use a read-only-permissions Actions workspace preparation job to obtain the checked-out source and locked dependencies as a short-lived artifact. Install only with `npm ci --ignore-scripts`; do not export credentials or the runner home. Changes are developed in the session workspace and uploaded to the isolated branch. GitHub Actions provides clean-environment verification. A pushed candidate is not an accepted release.

Codex CLI and built-in subagent execution are unavailable in this session. No Codex plan, parallel agent execution, or independent human/agent review is claimed. This document is the session's repair plan, not a substitute attestation that those historical workflow gates ran. Independent review and full AX acceptance remain outstanding unless separately evidenced.

## Work packages

### C1 — Restore a usable cloud workspace

Inputs: root `AGENTS.md`, previous continuation/verification documents, `.github/workflows/pi861-runtime.yml`, baseline CI run `36304656464`.

Prepare source and dependencies through an isolated Actions checkout with credential persistence disabled and `contents: read`. Retrieve the archive into the current session. Record the exact source SHA and inspect applicable directory rules. Do not copy any user-local worktree, configuration, credentials, or processes.

Exit: a version-bound source workspace is available, or the precise failure is recorded without claiming a successful clone.

### C2 — Repair existing CI portability and reproducibility failures

Read the complete files before editing. Initial confirmed failures:

1. Published Windows host archive uses `$RUNNER_TEMP` as a GNU tar archive name. The drive-letter colon is interpreted as a remote archive (`Cannot connect to D`). Use a portable local archive path and retain the host checks.
2. Repository type checking fails after model catalog generation because tests reference catalog entries that have changed. Inspect catalog hydration/generation and the relevant tests before choosing a fix. Preserve API-specific type checking and behavioral coverage; do not add `any`, suppress diagnostics, or skip failed tests.
3. Inspect the deterministic job's first failure rather than assuming the two items above explain every failed job.

Shared workflow/configuration has one writer: this session. Keep runtime interfaces unchanged unless a demonstrated defect requires a narrowly documented repair.

Exit: regression checks for changed behavior and the relevant existing checks pass, or remaining failures are reported with logs and exact SHAs.

### C3 — Verification and delivery

Run `npm run check` with complete logs when the workspace is available. Run each added/modified test and the relevant deterministic/host checks. Clean Actions jobs must retain nonzero exit codes and uploaded failure logs. Do not run a full provider e2e suite or use real credentials. Do not mistake a skipped check or merely queued job for a pass.

Upload only this session's explicit changed paths to the isolated branch, using non-forced ref updates. Re-read the resulting commit and CI status. Record baseline/final SHA, changed paths, actual commands/results, unrun checks, review limitations and next blockers in a new verification document. Do not overwrite historical evidence.
