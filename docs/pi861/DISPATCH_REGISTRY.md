# Pi861 派发登记表（DISPATCH_REGISTRY）

- 建立：2026-09-23，P1-L（`p1-ledger`，attempt-1）。维护：L 角色（P1-L/P4-D）与主会话；每次领取、状态变化、审核结论、交付时更新本表并保留变更记录。
- 计划：`C:\Albert\project\pi861\docs\pi861\CONTINUATION_PLAN_2026-09-23.md`（SHA256 `77d1b0516d7382e9d7ae40cff80422805d8ced0a25bb35771c2001b7da0fef82`）。规则来源：`C:\Albert\project\pi861\AGENTS.md`（pi861 流程章节）。
- 状态词表：**可领取**（就绪谓词满足，见计划第 6 节）/ **进行中**（附代理或工作区标识）/ **待依赖**（列明所待项）/ **完成**（必须有证据指针；不以自报为准）/ **阻塞**（列原因）。完成、审核通过、已接入、集成通过分别登记，不相互替代。
- 输入 SnapshotID 简码（主/契/M1–M5/旧ICT）按 [ACCEPTANCE_MATRIX.md](ACCEPTANCE_MATRIX.md) 第 0.1 节解析（P0-A 八树保全）；SnapshotID 非 Git commit SHA。

## 1. 工作包登记（19 包）

| 包 | slug（角色） | 状态（2026-09-23 P1-L 建表时） | 独占路径（相对 `extensions/pi861/`，注明者除外） | 输入 SnapshotID | 证据 / 备注 |
| --- | --- | --- | --- | --- | --- |
| P0-A | `p0-preserve`（保全） | **完成**（attempt-1） | 不改产品源码；证据批次 + 隔离工作区 | 八树全部 | `C:\Albert\project\pi861-briefs\continuation-20260923-execution\P0-A\d2804489\attempt-1\handoff-manifest.json`（K0 正反例通过：rebuild 153 文件 0 差异、conflict 0；独立审核状态以该 manifest 为准） |
| P0-H | `p0-host`（H，宿主） | **进行中**（worktree `C:\Albert\project\pi861-cont-20260923\p0-host`，分支 `feat/pi861-runtime-v1-cont-20260923-p0-host` 已建立） | `runtime.ts`、`index.ts`、宿主组合测试 | 主@d28044896+02c505571039 | `C:\Albert\project\pi861-briefs\continuation-20260923-execution\P0-H\d28044896\`（现有 import-manifest-sha256.txt、npm-ci.log；成果与审核待其交付后登记） |
| P0-T | `p0-toolchain`（T，检查链/根配置） | **进行中**（主会话派发记录；截至本表建立时未观察到 p0-toolchain 工作区/分支/证据目录，工作区与证据指针待该包代理建立后补登） | 根配置、依赖、lock/shrinkwrap、全部 tsconfig、扩展 package 入口声明、CI（仓库根） | 主@d28044896+02c505571039 | 待补；主树 staged 中的 biome/tsconfig/CI 改动属 2026-09-22 旧集成轮成果（HANDOFF 2026-09-22 段），不算本轮 P0-T 交付 |
| P1-C | `p1-contracts`（C，共享契约） | **进行中**（worktree `C:\Albert\project\pi861-cont-20260923\p1-contracts` 已建立） | `src/contracts/**`、`test/contracts-*.test.mjs` | 契@a7243e84+486432e683b9（+主树契约文件差异） | 待其交付后登记 |
| P1-S | `p1-services`（S，共享服务） | 待依赖（P1-C 冻结） | `src/live/compilers.ts`、`runtime-configuration.ts`、`deadline.ts`、`line-process.ts` 及对应单测 | 主+M1@6cf376f0+521e5022 | — |
| P1-Q | `p1-fixtures`（Q，fixture/验收） | 待依赖（P0-A 已满足；待 C7 冻结） | `test/fixtures/**`、acceptance/real-acceptance 服务与脚本、跨模块集成测试 | 主+M5@457ccf27+218dd5a0+M4@bd855c4e+cb46d227 | — |
| P1-L | `p1-ledger`（L，台账/登记） | **完成**（attempt-1，本表与五份台账更新；**待独立审核**） | `docs/pi861/` 台账与登记文档（本表） | 主（docs@d28044896）+P0-A 事实清单 | `C:\Albert\project\pi861-briefs\continuation-20260923-execution\P1-L\d28044896\attempt-1\`（K0 一致性检查）；分支 `feat/pi861-runtime-v1-cont-20260923-p1-ledger` |
| P2-A | `p2-model`（A，模型策略/预算/健康） | 待依赖（P1-C、P1-S 接口） | `src/routing.ts`、`model-runtime`/`model-service`/`health-service` 及模块测试（stream-bridge 归 P2-B 顺序处理） | M1@6cf376f0+521e5022（HEAD+8 staged） | — |
| P2-B | `p2-stream`（A，流式执行权） | 待依赖（P2-A 交接；C2/C5） | `stream-bridge` 及对应模型文件的必要改动 | M1@6cf376f0+521e5022 | — |
| P2-S | `p2-skill-mcp`（K，Skill/MCP） | 待依赖（P1-C、P1-S） | `src/capabilities.ts`、`skill-repository`/`skills-host`/`skill-validation`/`mcp`/`operations` 及模块测试 | M2@6f53f124+4b64f32a3f11+主 | — |
| P2-D | `p2-storage`（D，PG/存储/迁移） | 待依赖（P1-C 冻结） | `src/live/store.ts`、`src/postgres.ts`、新增存储服务、全部 SQL/迁移、PG 示例 | M3@7ae1aeab+9594d289ce63+契+主 | — |
| P2-M | `p2-memory`（M，记忆治理/引用） | 待依赖（P1-C、P1-S、P2-D 接口冻结） | `src/memory.ts`、`src/live/layered-memory.ts`、`src/result-store.ts`、记忆/引用服务及模块测试 | M3@7ae1aeab+9594d289ce63+主 | — |
| P2-G | `p2-goal`（G，持续调度/Goal/审核） | 待依赖（P1-C、P1-S、D/W 接口冻结） | `src/goal.ts`、`src/scheduler.ts`、`coordinator`/`project-runner`/`goal-command` 及模块测试 | M4@bd855c4e+cb46d227（HEAD+dirty） | — |
| P2-W | `p2-worker`（W，Worker/Git/隔离） | 待依赖（C1/C2/C4/C7、P1-S 进程接口） | `pi-rpc`/`remote-worker`/`workspace`/`worker-guard`/`worker-service`、Worker 启动入口 | M4@bd855c4e+cb46d227+主（H0 进程退出成果） | — |
| P2-E | `p2-web`（E，搜索/网页安全） | **进行中**（worktree `C:\Albert\project\pi861-cont-20260923\p2-web` 已建立，git 端标 locked） | `search`/`web-control`/`web-read`/`web-host`、新增抽取子进程及网页模块测试 | M5@457ccf27+218dd5a0（HEAD+4 dirty） | 待其交付后登记；旧审核反例必须保留 |
| P3-I | `p3-integration`（H，唯一共享接线） | 待依赖（各模块审核通过快照，滚动领取） | `runtime`/`index` 及宿主组合测试（H 唯一接线，不代替模块所有者改其内部文件） | 待各模块审核通过后的新 SnapshotID | — |
| P3-X | `p3-acceptance`（Q，AX/纵向测试） | 待依赖（P3-I 组合快照、Q fixture） | 跨模块集成测试（新增 `goal-e2e.integration.mjs`、`ax-runtime.integration.mjs` 等） | 待 P3-I 组合 SnapshotID | — |
| P4-R | `p4-independent-review`（独立最终审核） | 待依赖（最终候选冻结） | 仅审核证据输出（新审核 worktree）；不改产品代码与测试 | 待最终组合 SnapshotID | — |
| P4-D | `p4-delivery`（L，证据/交付） | 待依赖（P4-R 结论） | `docs/pi861/` 台账；新增 `VERIFICATION_2026-09-23_CONTINUATION.md`（不动旧 VERIFICATION.md 原件） | 待 P4-R 结论与最终 SnapshotID | — |

## 2. 就绪谓词与更新规则（摘自计划第 6 节）

- 就绪 = 开发依赖已满足 ∧ 共享接口已冻结 ∧ 文件和资源已登记 ∧ 所需授权存在 ∧ 环境可执行 ∧ 容量可用。交付依赖未满足的包只能标"模块审核通过、待集成"，不能标"需求完成"。
- 本会话并发上限 4 个活动代理（含主会话），即至多 3 个活动子代理；审核积压时优先释放槽位给审核。事件驱动领取（P0-A 交付→审 P0-A/P1-C/P0-T；C 冻结→P2-E/P1-Q；C1–C7+S 冻结→P2-A/P2-D 优先，随后 P2-S/G/W），不设整批屏障；详见计划第 6 节两表。
- 表更新纪律：状态变化必须附证据指针（分支/工作区/日志/manifest）；旧日志不得标为当前通过；完成与审核分开登记。

## 3. 变更记录

| 日期 | 包 | 变更 |
| --- | --- | --- |
| 2026-09-23 | P1-L | 建表（attempt-1）：19 包登记；P0-A 完成（证据指针）、P0-H/P0-T/P1-C/P2-E 进行中（P0-T 工作区指针待补）、P1-L 完成待审、其余待依赖。 |
