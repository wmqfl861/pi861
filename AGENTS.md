# Development Rules

## Conversational Style

- Keep answers short and concise
- No emojis in commits, issues, PR comments, or code
- No fluff or cheerful filler text (e.g., "Thanks @user" not "Thanks so much @user!")
- Technical prose only, be direct
- Use concise, clear, simple language. Define unavoidable jargon before using it.
- Explain non-trivial designs and problems as: problem, concrete example or short trace, then solution. State why the solution is necessary and distinguish it from optional complexity.
- Prefer concrete behavior and small illustrations over abstract summaries, dense terminology, or unexplained lists of changes.
- When the user asks a question, answer it first before making edits or running implementation commands.
- When responding to user feedback or an analysis, explicitly say whether you agree or disagree before saying what you changed.

## Code Quality

- Read files in full before wide-ranging changes, before editing files you have not fully inspected, and when asked to investigate or audit. Do not rely on search snippets for broad changes.
- No `any` unless absolutely necessary.
- Inline single-line helpers that have only one call site.
- Check node_modules for external API types; don't guess.
- **No inline imports** (`await import()`, `import("pkg").Type`, dynamic type imports). Top-level imports only.
- Never remove or downgrade code to fix type errors from outdated deps; upgrade the dep instead.
- Use only erasable TypeScript syntax (Node strip-only mode) in code checked by the root config (`packages/*/src`, `packages/*/test`, `packages/coding-agent/examples`): no parameter properties, `enum`, `namespace`/`module`, `import =`, `export =`, or other constructs needing JS emit. Use explicit fields with constructor assignments.
- Always ask before removing functionality or code that appears intentional.
- Do not preserve backward compatibility unless the user asks for it.
- Never hardcode key checks (e.g. `matchesKey(keyData, "ctrl+x")`). Add defaults to `DEFAULT_EDITOR_KEYBINDINGS` or `DEFAULT_APP_KEYBINDINGS` so they stay configurable.
- Never modify `packages/ai/src/models.generated.ts` directly; update `packages/ai/scripts/generate-models.ts` instead, then regenerate. Including the resulting `models.generated.ts` diff is always OK, even if regeneration includes unrelated upstream model metadata changes.

## Commands

- After code changes (not docs): `npm run check` (full output, no tail). Fix all errors, warnings, and infos before committing. Does not run tests.
- Never run `npm run build` or `npm test` unless requested by the user.
- Never run the full vitest suite directly: it includes e2e tests that activate when endpoint/auth env vars are present. For all non-e2e tests, run `./test.sh` from the repo root. Otherwise run specific tests from the package root:
  - Vitest: `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/specific.test.ts`
  - `packages/tui` (`node:test`): `node --test test/specific.test.ts`
- If you create or modify a test file, run it and iterate on test or implementation until it passes.
- For `packages/coding-agent/test/suite/`, use `test/suite/harness.ts` + the faux provider. No real provider APIs, keys, or paid tokens.
- When regressions tests for fixing a github issue, add a comment with the github issue number next to the test.
- For ad-hoc scripts, `write` them to a temp file (e.g. `/tmp`), run, edit if needed, remove when done. Don't embed multi-line scripts in `bash` commands.
- Never commit unless the user asks.

## Dependency and Install Security

- Treat npm dep and lockfile changes as reviewed code. Direct external deps stay pinned to exact versions.
- When updating `undici`, you MUST read its changelog/release notes for the target version and evaluate whether any changes may affect functionality before applying the update.
- Hydrate/update locally with `npm install --ignore-scripts`; clean/CI-style with `npm ci --ignore-scripts`. Don't run lifecycle scripts unless the user asks.
- If dep metadata changes, refresh `package-lock.json` with `npm install --package-lock-only --ignore-scripts`.
- If `packages/coding-agent/npm-shrinkwrap.json` needs regen, run `node scripts/generate-coding-agent-shrinkwrap.mjs` (verify with `--check` or `npm run check`). New deps with lifecycle scripts require review and an explicit allowlist entry in that script; never add one silently.
- Pre-commit blocks lockfile commits unless `PI_ALLOW_LOCKFILE_CHANGE=1`. Don't bypass unless the user wants the lockfile change committed.

## Git

Multiple pi sessions may be running in this cwd at the same time, each modifying different files. Git operations that touch unstaged, staged, or untracked files outside your own changes will stomp on other sessions' work. Follow these rules:

Committing:

- Only commit files YOU changed in THIS session.
- Stage explicit paths (`git add <path1> <path2>`); never `git add -A` / `git add .`.
- Before committing, run `git status` and verify you are only staging your files.
- `packages/ai/src/models.generated.ts` may always be included alongside your files.
- Message format: `{feat,fix,docs}[(ai,tui,agent,coding-agent)]: <commit message> (optionally multiple lines)`. Message is informative and concise.

Never run (destroys other agents' work or bypasses checks):

- `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git add -A`, `git add .`, `git commit --no-verify`.

If rebase conflicts occur:

- Resolve conflicts only in files you modified.
- If a conflict is in a file you did not modify, abort and ask the user.
- Never force push.

## Issues and PRs

See `CONTRIBUTING.md` for the contributor gate (auto-close workflows, `lgtm`/`lgtmi`, quality bar).

When reviewing PRs:

- Do not run `gh pr checkout`, `git switch`, or otherwise move the worktree to the PR branch unless the user explicitly asks.
- Use `gh pr view`, `gh pr diff`, `gh api`, and local `git show`/`git diff` against fetched refs to inspect PR metadata, commits, and patches without changing branches.
- If you need PR file contents, fetch/read them into temporary files or use `git show <ref>:<path>` without switching branches.

When creating issues:

- Add `pkg:*` labels for affected packages (`pkg:agent`, `pkg:ai`, `pkg:coding-agent`, `pkg:tui`); use all that apply.

When posting issue/PR comments:

- Write the comment to a temp file and post with `gh issue/pr comment --body-file` (never multi-line markdown via `--body`).
- Keep comments concise, technical, in the user's tone.
- End every AI-posted comment with the AI-generated disclaimer line specified by the originating prompt (e.g. `This comment is AI-generated by `/wr``).

When closing issues via commit:

- Include `fixes #<number>` or `closes #<number>` in the message so merging auto-closes the issue. For multiple issues, repeat the keyword per issue (`closes #1, closes #2`); a shared keyword (`closes #1, #2`) only closes the first.

## Testing pi Interactive Mode with tmux

For testing pi's interactive mode, load and follow [.pi/skills/interactive-testing.md](.pi/skills/interactive-testing.md).

## Changelog

Location: `packages/*/CHANGELOG.md` (one per package).

Sections under `## [Unreleased]`: `### Breaking Changes` (API changes requiring migration), `### Added`, `### Changed`, `### Fixed`, `### Removed`.

Rules:

- All new entries go under `## [Unreleased]`. Read the full section first and append to existing subsections; never duplicate them.
- Released version sections (e.g. `## [0.12.2]`) are immutable; never modify them.
- Do not create changelog entries when working on a branch other than `main` or pull request

Attribution:

- Internal (from issues): `Fixed foo bar ([#123](https://github.com/earendil-works/pi/issues/123))`
- External contributions: `Added feature X ([#456](https://github.com/earendil-works/pi/pull/456) by [@username](https://github.com/username))`

## Releasing

For release preparation, publishing, verification, or recovery, load and follow [.pi/skills/release.md](.pi/skills/release.md).

## User Override

If the user's instructions conflict with any rule in this document, ask for explicit confirmation before overriding. Only then execute their instructions.

## pi861 本地开发流程规则（用户指定 2026-09-22，2026-09-23 更新）

本章适用于 pi861 的新功能、修复、重构、测试、集成与续开发。仓库既有规则继续有效；本章补充执行顺序、角色和验收门槛。当前准备阶段只清理已确认的旧执行、整理本章和生成计划，不修改产品实现，不 commit/push。准备阶段结束条件为：本章已落盘、旧进程归属核查完成、完整 Codex 计划已写入新文件且调用证据齐全；满足后由主会话转入用户已授权的开发阶段，按下文派发本会话子代理开发和独立审核。

### 1. 接手与旧执行清理

- 开工前记录各工作区的路径、分支、完整 HEAD、index 和未提交差异；原需求为 `docs/pi861/HANDOFF_PROMPT_2026-09-22.md`，历史计划与证据保留原件。
- 用户本轮明确要求“清理原本的子代理”，据此由主会话查询并停止旧内置任务句柄；具体本地进程清理由获派的本会话子代理按下条归属证据执行。`No task found` 仅表示任务句柄不可见，不证明执行已经停止。
- 只停止命令行、父子关系、工作目录或日志能够确认属于上一轮 pi861 任务的残留进程。记录 PID、归属证据、停止动作和复查结果；归属不明项单列，不全局停止 node/Codex/ZCode，不影响当前会话或其他项目。
- 保留代码、分支、worktree、提交、未提交差异、日志和审核原件。清理后派发新的本会话子代理，旧代理不恢复；已有成果经版本与差异核验后作为接手输入。
- 每个新子代理都读取本文件和适用子目录规则。旧 worktree 的 AGENTS.md 若落后，派发时明确附上 `C:\Albert\project\pi861\AGENTS.md` 这一当前流程来源，不能以旧副本省略本章要求。

### 2. Codex 先出详细计划

- 开发开始或范围、接口、验收发生实质变化前，由本会话子代理调用 Codex 做只读规划。用户指定命令为 `codex exec -m gpt-6-astra -c model_reasoning_effort="max" --sandbox read-only`；模型和思考等级不得擅换，持久 LLM 配置、端点和凭据不得修改。
- 此授权仅覆盖详细规划。Codex 读取当前规则、原 R1–R8、历史计划、实际代码/差异和独立审核证据，输出计划；实现、测试修改、开发命令、提交与审核由本会话内置子代理承担，不转交 Codex 或其他外部 Agent。开发工具不进入产品执行架构。
- 新计划保存为 `docs/pi861/CONTINUATION_PLAN_<日期>[_序号].md`；保留完整 Codex 输出，不覆盖 `DEVELOPMENT_PLAN.md` 等历史计划。记录基线 HEAD、dirty 差异摘要/校验值、输入证据路径、脱敏 argv、实际 model/reasoning/sandbox banner、退出码和完整日志路径。
- 计划逐项对应原需求与实际差距，列明工作包的目标、现有成果、具体文件/接口、前置依赖、独占分支/worktree、开发与交付依赖、检查命令、确定性与真实本地 fixture、独立审核标准、失败恢复和交付条件。R1–R8 和 AX1–AX10 的范围完整保留。
- 规划完成条件：指定模型与等级的调用成功，计划原文已落盘，工作包有可检查的范围和退出条件。调用失败保留首次错误，只做有界恢复；需要改模型、等级、端点、凭据或扩大权限时，仅阻塞该部分并报告所需授权。

### 3. 本会话子代理开发与持续并发

- 主会话仅派发、监控和转达；每个工作包由新的本会话内置子代理按最新有效计划执行。派发包含用户要求、原资料路径、适用计划及约束、交付要求；子代理负责具体分析和执行。
- 领取前登记工作包、执行代理、基线/差异、分支/worktree、独占文件、共享接口版本、端口/数据库/测试目录等资源、依赖与状态。只在 `feat/pi861-runtime-v1` 及其派生任务分支开发；不同写入者使用独立 worktree，远程节点使用独立检出。
- `runtime.ts`、`index.ts`、共享编译器、`src/contracts/`、根配置、依赖/锁文件和 CI 等共享面，按计划指定唯一写入子代理。模块开发者提出接口变更，由所有者处理并通知消费者；同一文件或不可隔离资源不并行写入。
- 在提供方实际并发额度内，持续并行推进相互独立的模块、节点和工作包。一个工作包完成或解除依赖即重新检查就绪队列，空闲代理领取已就绪且无所有权冲突的任务，不等待整批最慢任务。
- 就绪必须同时满足开发依赖、已冻结的共享接口、文件/资源所有权、授权和可用容量。交付依赖仍需实际集成验收；分支完成不能直接标成项目已采用。
- 有限资源同时覆盖开发、检查、审核、返工和集成；审核积压时保留审核容量。显示未满并发的实际原因。没有真实远程节点时将同机多进程如实标注，不虚报多服务器验证。
- 代码修改后依既有 Commands 规则运行 `npm run check`，保存完整输出；会自动格式化的全仓检查在隔离工作区运行并核对差异。新增或修改的测试必须实际运行。安装依赖使用 `--ignore-scripts`。

### 4. 独立审核与阶段完成

- 开发者交付计划工作包、完整 SHA 或可复现差异/文件哈希、修改范围、命令与退出码、完整日志、首次失败、重跑结果、未跑/skip 和剩余缺口。
- 另派未参与该工作包实现或测试修改的本会话内置子代理，按同一计划、原需求和实际成果进行独立审核。共享接线与最终集成另行审核，不能用模块审核代替。
- 审核检查入口行为、权限/故障不变量、测试差异、共享接口及需求覆盖；实际运行计划要求的安全检查与本地 fixture。记录代码版本、环境和证据。类/文件/测试数量、开发者自报完成、旧版本通过日志均不等于需求验收通过。
- 审核发现问题返回对应所有者修复，由独立审核者复核。实质改变范围或接口时先补 Codex 计划；按既有计划修复失败用例可直接继续。失败现场与原始日志保留，未解决项不转为通过。
- 阶段完成要求对应需求、检查和独立审核均有当前成果证据；最终集成重新执行计划的检查链和 AX1–AX10。明确区分确定性/真实本地协议、发布/源码宿主、临时 PostgreSQL/业务库、同机/跨主机和真实模型质量；未执行、skip 与待授权均不计通过。
- 更新需求/验收/交接台账时绑定实际验证版本，不覆盖历史证据。仍有就绪工作包则继续派发；无法继续时给出保存状态、具体阻断与下一项操作，不把计划完成当产品完成。

### 5. 授权边界

- 不直接修改或合并 `main`，不 force push，不发布包或部署生产服务。
- 不擅自运行付费模型/真实搜索/业务 MCP 验收，不使用真实业务数据或数据库；发现本机凭据不构成授权。此处的 Codex 规划调用授权不等于产品真实服务验收授权。
- 不修改任何持久 LLM 配置、端点、凭据、模型默认值或思考等级；单次规划仅使用用户明确指定的模型与等级。
- 提交与推送按当前任务的明确授权执行；本次准备阶段不提交、不推送，也不暂存其他会话的改动。其余既有安全、Git 和依赖规则继续有效。
