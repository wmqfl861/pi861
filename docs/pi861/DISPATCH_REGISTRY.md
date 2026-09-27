# Pi861 派发登记表（DISPATCH_REGISTRY）

- 建立：2026-09-23，P1-L（`p1-ledger`，attempt-1）。维护：L 角色（P1-L/P4-D）与主会话；每次领取、状态变化、审核结论、交付时更新本表并保留变更记录。
- 计划：`C:\Albert\project\pi861\docs\pi861\CONTINUATION_PLAN_2026-09-23.md`（SHA256 `77d1b0516d7382e9d7ae40cff80422805d8ced0a25bb35771c2001b7da0fef82`）。规则来源：`C:\Albert\project\pi861\AGENTS.md`（pi861 流程章节）。
- 状态词表：**可领取**（就绪谓词满足，见计划第 6 节）/ **进行中**（附代理或工作区标识）/ **待依赖**（列明所待项）/ **完成**（必须有证据指针；不以自报为准）/ **阻塞**（列原因）。完成、审核通过、已接入、集成通过分别登记，不相互替代。
- 输入 SnapshotID 简码（主/契/M1–M5/旧ICT）按 [ACCEPTANCE_MATRIX.md](ACCEPTANCE_MATRIX.md) 第 0.1 节解析（P0-A 八树保全）；SnapshotID 非 Git commit SHA。

## 1. 工作包登记（19 包）

> 2026-09-27 P4-D 注：下表状态列为**终态登记**（绑定 SnapshotID-3：基线 d28044896 + HEAD 5cacec62e + 清单 digest 88b5c12c…fbfb7f）。2026-09-23 建表时的初始状态见第 3 节变更记录（历史）。各包终态依据：包 REPORT + 各自独立 review 目录（verdict 通过，P4-R 第 3/6 节逐一核对）+ P4-R 终审。证据根：`C:\Albert\project\pi861-briefs\continuation-20260923-execution\`。

| 包 | slug（角色） | 状态（2026-09-27 终态） | 独占路径（相对 `extensions/pi861/`，注明者除外） | 输入 SnapshotID | 证据 / 备注 |
| --- | --- | --- | --- | --- | --- |
| P0-A | `p0-preserve`（保全） | **完成 + 审核通过**（review-1） | 不改产品源码；证据批次 + 隔离工作区 | 八树全部 | `P0-A\d2804489\attempt-1\handoff-manifest.json` + `P0-A\review-1\`（rebuild 153 文件 0 差异、conflict 0） |
| P0-H | `p0-host`（H，宿主） | **完成 + 审核通过 + 已接入**（接线终态见 P3-I） | `runtime.ts`、`index.ts`、宿主组合测试 | 主@d28044896+02c505571039 | `P0-H\d28044896\` + `P0-H\review-1\`；分支合入最终 HEAD 链 |
| P0-T | `p0-toolchain`（T，检查链/根配置） | **完成 + 审核通过 + 已接入**（检查链经 P4-R K1 独立复跑） | 根配置、依赖、lock/shrinkwrap、全部 tsconfig、扩展 package 入口声明、CI（仓库根） | 主@d28044896+02c505571039 | `P0-T\d28044896\` + `P0-T\review-1\`；tsgo 22 错环境定性（三重证据）经其登记 |
| P1-C | `p1-contracts`（C，共享契约） | **完成 + 审核通过 + 已接入**（C1–C7 全员消费） | `src/contracts/**`、`test/contracts-*.test.mjs` | 契@a7243e84+486432e683b9（+主树契约文件差异） | `P1-C\e3c17e249\` + `P1-C\review-1\` |
| P1-S | `p1-services`（S，共享服务） | **完成 + 审核通过 + 已接入** | `src/live/compilers.ts`、`runtime-configuration.ts`、`deadline.ts`、`line-process.ts` 及对应单测 | 主+M1@6cf376f0+521e5022 | `P1-S\01d81de4\` + `P1-S\review-1\` |
| P1-Q | `p1-fixtures`（Q，fixture/验收） | **完成 + 审核通过（review-2 含 N1 修复）+ 已接入**（PG17/MCP/验收运行器为 K4/K5/K8/K10 底座） | `test/fixtures/**`、acceptance/real-acceptance 服务与脚本、跨模块集成测试 | 主+M5@457ccf27+218dd5a0+M4@bd855c4e+cb46d227 | `P1-Q\`（c76a4ad54 等多快照）+ `review-1\` + `review-2\` |
| P1-L | `p1-ledger`（L，台账/登记） | **完成 + 审核通过（review-1 + R8.6 补正 5349ace1）**；台账已由 P4-D 合入收口分支 | `docs/pi861/` 台账与登记文档 | 主（docs@d28044896）+P0-A 事实清单 | `P1-L\d28044896\attempt-1\` + `P1-L\review-1\`；分支 @ 5349ace1a 已并入 p4-delivery（单一权威） |
| P2-A | `p2-model`（A，模型策略/预算/健康） | **完成 + 审核通过 @ aefa5d4a1 + 集成通过**（AX3） | `src/routing.ts`、`model-runtime`/`model-service`/`health-service` 及模块测试（stream-bridge 归 P2-B 顺序处理） | M1@6cf376f0+521e5022（HEAD+8 staged） | `P2-A\30259fc\` + `P2-A\review-1\`；P4-R K2 model 套件 72/72 复跑 |
| P2-B | `p2-stream`（A，流式执行权） | **完成 + 审核通过 @ aefa5d4a1 + 集成通过**（AX4；stream-claims 经 P3-I r3/C5 接线） | `stream-bridge` 及对应模型文件的必要改动 | M1@6cf376f0+521e5022 | `P2-B\aefa5d4\` + `P2-B\review-1\`；P4-R 源码核实 stream-claims 在树 + wiring 6/6 |
| P2-S | `p2-skill-mcp`（K，Skill/MCP） | **完成 + 审核通过 + 集成通过**（AX5/AX6；K5 30/30） | `src/capabilities.ts`、`skill-repository`/`skills-host`/`skill-validation`/`mcp`/`operations` 及模块测试 | M2@6f53f124+4b64f32a3f11+主 | `P2-S\01d81de44\` + `P2-S\review-1\`；P3-I 对 K/M 文件的纯格式化触碰已登记（ARCHITECTURE 第 10 节，C6） |
| P2-D | `p2-storage`（D，PG/存储/迁移） | **完成 + 审核通过（review-2 @ c8b274f36，32/32 含 TLS）+ 集成通过**（K4 真 17.11） | `src/live/store.ts`、`src/postgres.ts`、新增存储服务、全部 SQL/迁移、PG 示例 | M3@7ae1aeab+9594d289ce63+契+主 | `P2-D\c8b274f36\` + `review-1\` + `review-2\`；TLS 真实通过存证 = review-2 交接 + P4-R 非 TLS 31/31 |
| P2-M | `p2-memory`（M，记忆治理/引用） | **完成 + 审核通过（review-2，F1/F2 闭环）+ 集成通过**（AX7/AX8） | `src/memory.ts`、`src/live/layered-memory.ts`、`src/result-store.ts`、记忆/引用服务及模块测试 | M3@7ae1aeab+9594d289ce63+主 | `P2-M\0de34bd72\` + `review-1\` + `review-2\` |
| P2-G | `p2-goal`（G，持续调度/Goal/审核） | **完成 + 审核通过（review-2）+ 集成通过**（AX1/AX2/AX9） | `src/goal.ts`、`src/scheduler.ts`、`coordinator`/`project-runner`/`goal-command` 及模块测试 | M4@bd855c4e+cb46d227（HEAD+dirty） | `P2-G\437572fc1\` + `review-1\` + `review-2\`（R8.7 未满并发解释实测） |
| P2-W | `p2-worker`（W，Worker/Git/隔离） | **完成 + 审核通过 + 集成通过**（K7 双 pid + 真实 OCI 容器；同机边界如实标注） | `pi-rpc`/`remote-worker`/`workspace`/`worker-guard`/`worker-service`、Worker 启动入口 | M4@bd855c4e+cb46d227+主（H0 进程退出成果） | `P2-W\e3c17e249\` + `P2-W\review-1\`；live-guard EPERM 为 Windows 环境性（三重证据） |
| P2-E | `p2-web`（E，搜索/网页安全） | **完成 + 审核通过 + 集成通过**（K6 62/62；100ms 反例 102ms 收敛） | `search`/`web-control`/`web-read`/`web-host`、新增抽取子进程及网页模块测试 | M5@457ccf27+218dd5a0（HEAD+4 dirty） | `P2-E\457ccf2\` + `P2-E\review-1\`；旧审核反例保留并复跑 |
| P3-I | `p3-integration`（H，唯一共享接线） | **完成 + 审核通过（review-1 合并审计 + r3 复验）+ 集成通过**（最终 HEAD 5cacec62e，46 commits） | `runtime`/`index` 及宿主组合测试（H 唯一接线） | 各模块审核通过快照（滚动） | `P3-I\5cacec62e\`（REPORT + content-manifest.sha256 + CORRECTION-1-manifest.md）+ `review-1\`；P4-R T1 合并链 14/16 祖先核验 + blob 等价抽验 |
| P3-X | `p3-acceptance`（Q，AX/纵向测试） | **完成 + 审核通过（review-2 独立复跑×2 + 3 项破坏负证）+ 集成通过**（AX1–AX10 @ df44a16d5） | 跨模块集成测试（`goal-e2e.integration.mjs`、`ax-runtime.integration.mjs` 等 5 文件） | P3-I 组合 SnapshotID-3 | `P3-X\5cacec62e\`（k8-final 33/31/0/2 + 十份 ax evidence）+ `review-2\zcode-r2\`；REPORT 第 5 行"6 files"勘误为 5（权威更正：P3-I CORRECTION-1 R3-E1，原件保留） |
| P4-R | `p4-independent-review`（独立最终审核） | **完成**（2026-09-27，判定通过-本地必需范围；C1/C2 交 P4-D 闭环） | 仅审核证据输出（新审核 worktree）；不改产品代码与测试 | 最终组合 SnapshotID-3 | `P4-R\p4r-final\REPORT.md`（logs 42 件 + evidence 5 件）；审核 worktree 与 PG17 容器审后销毁 |
| P4-D | `p4-delivery`（L，证据/交付） | **完成（待文档独立审核）**：VERIFICATION_2026-09-27_CONTINUATION.md + 五台账第 0.7/14/10/11 节 + 本表 + README 边界表；C1–C7 闭环 | `docs/pi861/` 台账；新增 `VERIFICATION_2026-09-27_CONTINUATION.md`（不动旧 VERIFICATION.md 原件） | P4-R 结论 + SnapshotID-3 | 分支 `feat/pi861-runtime-v1-cont-20260923-p4-delivery`（worktree `pi861-cont-20260923\p4-delivery`，基线 5cacec62e + 合入 p1-ledger@5349ace1a）；证据 `P4-D\<交付提交短SHA>\`；未 push（推送待文档审核通过后由主会话执行） |

## 2. 就绪谓词与更新规则（摘自计划第 6 节）

- 就绪 = 开发依赖已满足 ∧ 共享接口已冻结 ∧ 文件和资源已登记 ∧ 所需授权存在 ∧ 环境可执行 ∧ 容量可用。交付依赖未满足的包只能标"模块审核通过、待集成"，不能标"需求完成"。
- 本会话并发上限 4 个活动代理（含主会话），即至多 3 个活动子代理；审核积压时优先释放槽位给审核。事件驱动领取（P0-A 交付→审 P0-A/P1-C/P0-T；C 冻结→P2-E/P1-Q；C1–C7+S 冻结→P2-A/P2-D 优先，随后 P2-S/G/W），不设整批屏障；详见计划第 6 节两表。
- 表更新纪律：状态变化必须附证据指针（分支/工作区/日志/manifest）；旧日志不得标为当前通过；完成与审核分开登记。

## 3. 变更记录

| 日期 | 包 | 变更 |
| --- | --- | --- |
| 2026-09-23 | P1-L | 建表（attempt-1）：19 包登记；P0-A 完成（证据指针）、P0-H/P0-T/P1-C/P2-E 进行中（P0-T 工作区指针待补）、P1-L 完成待审、其余待依赖。 |
| 2026-09-27 | P4-D | 终态登记：19 包全部完成（各包 REPORT + review 目录 verdict 通过，P4-R 第 3/6 节核对）；P4-R 终审通过-本地必需范围（p4r-final）；P4-D 交付 VERIFICATION_2026-09-27_CONTINUATION.md + 台账五处更新 + README 边界表，绑定 SnapshotID-3；C1–C7 处置记录见 VERIFICATION 第 7 节（含 P3-I 对 K/M 文件格式化触碰登记 C6、P3-X REPORT"6 files"勘误关联 C7、p1-ledger@5349ace1a 合入本分支保持单一权威）。建表时初始状态转为历史（本表 2026-09-23 行）。 |
