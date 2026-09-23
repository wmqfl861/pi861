# Pi861 交接说明（HANDOFF）

- 首版日期：2026-09-22（P1 阶段交付，随五份台账首版建立；后续每个阶段更新）。
- 代码基线：`e3f07a789b7648f26ec72ce65fa5856046dbd6d3`（分支 `feat/pi861-runtime-v1`，与 main `c7cdb460a` 隔离，未合并）。

## 2026-09-23 continuation 接手段（P1-L 登记）

- **本轮计划**：`C:\Albert\project\pi861\docs\pi861\CONTINUATION_PLAN_2026-09-23.md`，SHA256 `77d1b0516d7382e9d7ae40cff80422805d8ced0a25bb35771c2001b7da0fef82`（P1-L 实测与 P0-A 登记一致；该文件在主树为未跟踪文件，未随 d28044896 提交，接手者按此指针读取，勿凭记忆转述）。计划确认 R1–R8、G1–G8、AX1–AX10 全范围保留；O2（网页正文读取）纠正为 R7 必需项（P2-E 交付）、O4（源码宿主验证）纠正为检查链必需项（K3，P0-T/P0-H/P3-I）；O1（pgvector）、O3（多搜索后端）仍为可选。
- **八树保全（P0-A 已完成）**：证据 `C:\Albert\project\pi861-briefs\continuation-20260923-execution\P0-A\d2804489\attempt-1\`（`workspaces.json`、`handoff-manifest.json`、分树 content-manifest/staged/unstaged patch/untracked、`process-attribution.json`、rebuild/conflict 验证）。八树 SnapshotID（= HEAD + 内容清单 SHA256，非 Git commit）登记于 [ACCEPTANCE_MATRIX.md](ACCEPTANCE_MATRIX.md) 第 0.1 节。旧 integration-check 树不能整树覆盖；`runtime.ts` 在主树与旧 ICT 中不同，由唯一所有者 H 依完整差异合成并记录来源。
- **工作区命名规则（计划第 5 节）**：本轮工作区根 `C:\Albert\project\pi861-cont-20260923`；分支 `feat/pi861-runtime-v1-cont-20260923-<slug>`；目录 `<根>\<slug>`。路径或分支已存在时保留原件、登记递增序号后新建，不复用未知 dirty 目录。全部新分支自 `feat/pi861-runtime-v1` 记录基线 `d28044896a9ccd0bc81fb9a1d0d28eee7e9f86d5` 派生。不创建产品提交、不 push；交付采用基线 SHA＋patch＋文件 SHA256 清单（除非另有明确授权）。
- **滚动派发表**：[DISPATCH_REGISTRY.md](DISPATCH_REGISTRY.md)（本轮 P1-L 新建）。19 个工作包（P0-A…P4-D）的领取状态、独占路径、输入 SnapshotID 登记于此；主会话与各包领取/交付/审核时更新。状态只依实际证据，不以自报完成提升。
- **本轮台账更新（P1-L attempt-1）**：ACCEPTANCE_MATRIX 第 0 节（G8+R87+AX10 逐条本轮状态，绑定 SnapshotID）、第 0.5 节 O2/O4 纠正、第 4 节历史标注；REQUIREMENTS 第 11 节 O2/O4 纠正、第 13 节工作包映射；ARCHITECTURE 第 9 节、CONFIGURATION 第 10 节共享所有权登记。第 1–6 节与 2026-09-22 段全部保留为历史；旧 VERIFICATION.md 原件未动。
- **规则来源**：`C:\Albert\project\pi861\AGENTS.md`（含 pi861 本地开发流程规则章节，2026-09-22 用户指定）。

## 2026-09-22 继续执行记录（集成进行中）

- 本轮主工作区起点为 `d28044896a9ccd0bc81fb9a1d0d28eee7e9f86d5`，分支 `feat/pi861-runtime-v1`；开始时工作树干净，较远端多 2 个提交。主工作区由共享集成代理唯一写入；M1–M5 在各自 worktree 并行开发。
- P0 代码已经提交为 `6501e8ffa2f5556b0bab34de246bac4c1dac68cb`。P1 契约原提交为 `cdaf20dde10266710082222c92e7ff90bc63c75a`，本轮以 `cherry-pick --no-commit` 应用供集成验证，尚未形成主分支提交。
- 当前 Node 为 `v26.4.0`；根依赖已存在。已发布宿主依赖通过 `extensions/pi861/node_modules` 链接到 `C:\Albert\pi861-host\node_modules`。P1 应用后的独立扩展 `tsc --noEmit --project extensions/pi861/tsconfig.json` 本轮退出 0。
- 已落地：根 biome/tsconfig 覆盖扩展 TS 和生产 MJS；新增 `tsconfig.entries.json`（checkJs）；CI 任务分支与根配置触发、发布/源码宿主 Linux+Windows 矩阵、强制缺配置失败及完整日志。尚未 push，CI 未运行，完整 `npm run check` 与组合验收尚未执行，不能计通过。
- 模块结果仅按各自提供的已验证完整 SHA 集成，不读取其中断未提交代码作为完成证据。共享 `runtime.ts`、`index.ts`、`compilers.ts`、`src/contracts/`、`line-process.ts`、根配置和 CI 由集成代理负责。
- P0/契约独立审核已经提供失败反例；主工作区不接受旧提交作为通过。契约修复专属代理在 `pi861-wt-contracts` 继续，只读主工作区契约直至其固定 SHA；因此本轮尚未执行会自动改契约的全仓 `npm run check`。在最终独立审核结论前不 push。
- P0 入口整改已在本工作树实现：多宿主安装 WeakMap、底层事件总线 probe（真实 Pi 每个扩展的 events facade 不同）、显式真实事件重载适配和返回值校验；M2/M4 共用 LineProcess 关闭拥有的进程树、等待 close，保留调用方 wire id 并拒绝重复在途 id。共享编译器去除双重断言并验证嵌套输出；`managedSearch` 避免完整网页宿主重复注册。

本轮检查日志位于 `C:\Albert\project\pi861-briefs\integration-logs`。均为 Windows 11 / Node 26.4.0、起点 d28044896 加本轮尚未提交改动；不能替代最终集成 SHA 验收。首次失败、修复后重跑和未跑分开记录：

| 检查 | 实际结果 | 完整日志 |
| --- | --- | --- |
| 多宿主安装反例初跑 | exit 1，16 pass / 1 fail / 0 skip | `01-host-first-failure.log` |
| 源码宿主类型初跑 | exit 2，既有 `/v` 正则要求 ES2024 | `02-source-types.log` |
| 发布宿主类型 | exit 0 | `03-published-types.log`、最新 `13-adapter-published-types.log` |
| host 契约修复重跑 | exit 0，17 pass / 0 fail / 0 skip | `04-host-rerun.log` |
| 发布宿主真实进程 | exit 0，2 pass / 0 fail / 0 skip；本地确定性 provider | `05-published-host.log`、最新 `15-published-host-adapter.log` |
| 源码宿主真实进程 | exit 0，2 pass / 0 fail / 0 skip；本地确定性 provider | `06-source-host.log`、最新 `16-source-host-adapter.log` |
| 源码宿主类型 ES2024 重跑 | exit 0 | `07-source-types-rerun.log`、最新 `12-adapter-source-types.log` |
| 实际加载器多 facade 与重载保护 | exit 0，原 1 项；补事件适配后 2 项通过 | `08-real-host-install-guard.log`、最新 `14-host-adapter-tests.log` |
| host + 父子进程退出回归 | exit 0，19 pass / 0 fail / 0 skip | `09-process-host-tests.log` |
| 编译器输出校验 | exit 0，3 pass / 0 fail / 0 skip | `10-compilers.log` |
| 生产 MJS 类型初跑 | exit 2，postgres 示例缺 pg 类型及 pi 隐式 any；M3 负责修复 | `11-production-entry-types-first.log` |
| 共享 4 个生产文件 biome | exit 0，已实际检查 runtime/index/compilers/line-process；首次 unused execute 警告已处理 | 工具输出；最终根完整日志待跑 |
| 根 npm run check、最终全确定性测试、AX1–AX10、PostgreSQL17、多Worker闭环、Linux实测 | 尚未跑，等待模块和契约固定提交，不计通过 | 无 |

最短局部复现（仓库根目录，测试无真实模型凭据）：

```sh
node node_modules/typescript/bin/tsc --project extensions/pi861/tsconfig.host-source.json
node --experimental-strip-types --test extensions/pi861/test/host.test.mjs extensions/pi861/test/line-process.test.mjs extensions/pi861/test/compilers.test.mjs
node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.json --test extensions/pi861/test/host-install.integration.mjs
PI861_REQUIRE_HOST_TESTS=1 PI861_TEST_SOURCE_HOST=1 PI861_TEST_TIMEOUT_MS=180000 node --experimental-strip-types --test extensions/pi861/test/pi-host.integration.mjs extensions/pi861/test/runtime-host.integration.mjs
```
- 本轮不修改任何实际 LLM 配置，不运行真实付费模型/搜索/MCP 账户验收，不操作未知本机服务。M3 的 PostgreSQL 17 镜像拉取失败，改在其专用 PostgreSQL 18.6 临时容器验证；该结果不能替代计划要求的 PostgreSQL 17 证据。
- 下方第 1–6 节保留文档首版历史状态，绑定 `e3f07a789`；其中的 TS1005 阻塞与未提交规则描述已经被 P0/文档提交取代，不代表本轮当前状态。最终验收尚待模块接线后绑定新代码版本。

## 1. 首版进度（历史，绑定 e3f07a789）

今日已完成：

1. **规则与任务书入库**：任务书落盘为 [HANDOFF_PROMPT_2026-09-22.md](HANDOFF_PROMPT_2026-09-22.md)，仓库级开发规则经 AGENTS.md 更新（当前为未提交的工作区改动，见第 2 节）。
2. **codex 开发计划生成**：[DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md)（codex `gpt-6-astra`、read-only 沙箱、基于 e3f07a789 只读规划），确立 P0–P4 五阶段与 M1–M5 模块划分。
3. **P1 文档台账首版（本文所属交付）**：[REQUIREMENTS.md](REQUIREMENTS.md)（109 条编号需求）、[ACCEPTANCE_MATRIX.md](ACCEPTANCE_MATRIX.md)（需求×入口×测试×证据×状态，绑定 e3f07a789）、[ARCHITECTURE.md](ARCHITECTURE.md)、[CONFIGURATION.md](CONFIGURATION.md)、本文件。

进行中（并行子代理）：

- **P0：修复 runtime.ts 并恢复四层检查链**。目标：修复 `runtime.ts(212,307)` TS1005（memory.put 外层对象缺一闭合括号，经复核确认）及随后暴露的全部类型/API/运行问题；消除双重断言（`runtime.ts:92,305`）与检查盲区（`extensions/tsconfig.json` 不含 runtime.ts、根 tsconfig/biome 不含扩展目录）；恢复"根检查 / 扩展独立 tsc / 真实 Pi 类型 / 实际宿主测试"四层，并补源码宿主验证。**本文档批次未触碰 extensions/ 下任何文件。**

## 2. 工作区状态（本文写作时）

- 分支 `feat/pi861-runtime-v1`，HEAD `e3f07a789`。
- 工作区改动：`AGENTS.md` 已修改（未提交）；`docs/pi861/HANDOFF_PROMPT_2026-09-22.md`、`docs/pi861/DEVELOPMENT_PLAN.md` 未跟踪；本批次新增五份台账文档（REQUIREMENTS / ACCEPTANCE_MATRIX / ARCHITECTURE / CONFIGURATION / HANDOFF，均未提交）。
- **本批次遵守约束：未修改 extensions/、packages/、根配置与任何测试文件；未创建提交、未 push。**
- 无未推送的服务器端提交记录需要说明（文档均在工作区）。

## 3. 重现方式（当前版本可执行的检查）

环境：Node >=22.19.0；`npm ci --ignore-scripts`；全仓检查前需 `npm --prefix packages/ai run generate-models`。

| 层 | 命令（cwd） | 当前预期结果 @ e3f07a789 |
| --- | --- | --- |
| ① 根检查 | `npm run check`（仓库根） | 通过（CI repository-check 已证） |
| ② 扩展独立 tsc | `node ../../node_modules/typescript/bin/tsc --noEmit --project tsconfig.json`（extensions/pi861） | 通过（不含 runtime.ts——P0 将消除该盲区） |
| ③ 真实 Pi 类型 | `tsc --project tsconfig.host.json`（对照已发布 Pi 0.86.1） | **失败：runtime.ts(212,307) TS1005**（P0 修复中） |
| ④ 实际宿主测试 | `PI861_TEST_PI_CLI=… node --experimental-strip-types --test test/pi-host.integration.mjs test/runtime-host.integration.mjs` | 因 ③ 失败无法运行；不可计通过 |
| 确定性测试 | `node --experimental-strip-types --test test/*.test.mjs` | 通过（16 个 .test.mjs 文件约 123 用例，CI deterministic 已证） |
| SQL 集成 | 见 README（loopback pi861_test 专用变量） | 通过（CI postgres：真实 PostgreSQL 17） |

CI 基线 run：<https://github.com/wmqfl861/pi861/actions/runs/35687924923>（deterministic / postgres / repository-check 通过，pi-host 失败）。

## 4. 下一步（按 DEVELOPMENT_PLAN 顺序）

1. **P0 完成**（并行子代理）：修复合入后，更新 ACCEPTANCE_MATRIX 中被标"阻塞"的 6 条 P0 相关条目（G6、R1.2、R1.8、R2.7、R6.6、R8.6）与行号引用，重跑四层检查并记录新 SHA。
2. **P1 剩余**：落地共享契约 `src/contracts/`（C1–C7）；解除并行开发的共享文件冲突（runtime.ts/index.ts/compilers.ts/根配置/CI 归协调子代理；如拆 compilers.ts 先做纯移动）。
3. **P2 五模块纵向开发**（M1 模型可靠性 / M2 Skill 与 MCP / M3 记忆与 PostgreSQL / M4 调度与 Goal / M5 搜索与验收），优先消化 ACCEPTANCE_MATRIX 中的"未实现"19 条与"仅内核"23 条（即 M1–M5 工作清单输入）。
4. **P3 集成与十条反例**（AX1–AX10，当前 3 受控 / 4 仅内核 / 3 未实现）。
5. **P4 独立审核与文档定稿**（未参与开发的子代理复核）。

## 5. 阻断项

| 阻断 | 影响 | 解法 |
| --- | --- | --- |
| runtime.ts TS1005（212:307） | 完整入口不可运行；pi-host CI 失败；6 条需求端到端阻塞 | P0 修复（进行中） |
| 双重断言与检查盲区 | 类型安全证据不完整（G6） | P0：显式适配函数 + 覆盖表 |
| 真实模型/真实搜索/获准 MCP 验收未授权 | 相关条目只能停在"受控协议验证通过"，不得虚报 | 任务书规定：默认关闭的验收脚本 + 明确凭据变量/预算/清理，待用户授权后运行 |
| 跨主机多节点环境未具备 | R3.7 只到 loopback fixture | 需要独立检出/主机环境后执行 M4 验收 |
| Windows/Linux 差异覆盖不全 | 平台特定行为（路径大小写、文件锁恢复等）未验证 | P3 按具备执行条件的平台分别标注"未验证" |

## 6. 台账使用约定

- 每次状态变更必须：绑定新代码 SHA、更新 [ACCEPTANCE_MATRIX.md](ACCEPTANCE_MATRIX.md) 对应行、必要时同步 [REQUIREMENTS.md](REQUIREMENTS.md)（不得降低范围）。
- 未跑与 skip 不计通过；fixture 只证协议与安全，不证真实模型任务质量。
- 历史报告 [VERIFICATION.md](VERIFICATION.md) 保留为历史证据（绑定 90295c195 及更早），不作为当前 HEAD 通过证明。
