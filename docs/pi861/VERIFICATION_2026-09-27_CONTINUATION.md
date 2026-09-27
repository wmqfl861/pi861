# Pi861 续开发（2026-09-23 continuation）验证报告

- 日期：2026-09-27（Asia/Taipei）。编制：P4-D（`p4-delivery`，L 角色，纯文档交付；本报告为新增唯一序号文件，旧 [VERIFICATION.md](VERIFICATION.md) 原件未动，仅作历史证据）。
- 权威输入：P4-R 最终独立审核报告 `C:\Albert\project\pi861-briefs\continuation-20260923-execution\P4-R\p4r-final\REPORT.md`（2026-09-27，判定**通过（本地必需范围）**）。本报告汇编其结论与证据指针，不另行虚构任何检查；未运行的检查一律标注未运行。
- 计划：`docs/pi861/CONTINUATION_PLAN_2026-09-23.md`（主树 SHA256 `77d1b0516d7382e9d7ae40cff80422805d8ced0a25bb35771c2001b7da0fef82`，未提交文件）。
- **本报告是文档交付，不改变任何被测代码**：被测代码 SHA 即第 1 节锚定的 5cacec62e；本报告与台账更新只写入 P4-D 分支。

## 1. 版本锚与仓库状态

### 1.1 SnapshotID-3（最终候选，本报告全部结论绑定）

| 项 | 值 |
| --- | --- |
| 基线（八树保全的主树 HEAD） | `d28044896a9ccd0bc81fb9a1d0d28eee7e9f86d5`（分支 `feat/pi861-runtime-v1`） |
| 最终 HEAD | `5cacec62e2750214d99c5bba31659cf2f198fe21`（分支 `feat/pi861-runtime-v1-cont-20260923-p3-integration`，工作树 clean，46 commits 自基线） |
| 143 文件内容清单 digest | `88b5c12cf800365982b333abf3a741433958d55a983f5a4a62b437d76afbfb7f`（清单文件：`P3-I/5cacec62e/content-manifest.sha256`；P4-R 与 P3-X review-2 双独立复算 143/143 吻合。**清单值为原始文件字节 SHA256**——旧标签"git-blob SHA256"系措辞失真，见第 7 节 C4） |
| AX 测试层（P3-X） | `df44a16d5`（分支 `feat/pi861-runtime-v1-cont-20260923-p3-acceptance`；其被测运行时 ≡ 5cacec62e，P3-X review-2 `verify-manifest.mjs` 143/143 证明，差异仅 5 个 P3-X 测试文件） |
| 合并链 | 14/16 任务分支按合并序为最终 HEAD 祖先；`p1-ledger`（纯台账）与 `p3-acceptance`（测试层只读消费合并）不在链内属设计内分工（P4-R T1，logs/t1-merge-chain.log） |

### 1.2 未推送状态（P4-D 交付时实测复核）

- 17 个 `cont-20260923` 分支中 16 个为 LOCAL_ONLY（`p0-preserve` 与基线同 commit，被 `origin/feat/pi861-runtime-v1` 包含，非新增推送）；7 个 `pi861/*` 旧分支中 6 个 LOCAL_ONLY（`integration-check-checkpoint` 同理被基线远端包含）。全部无任何远端新增提交。
- 主树 `C:\Albert\project\pi861` 遗留 70 项预存 dirty（P0-A 保全的 2026-09-22 原输入，非本轮产物；`CONTINUATION_PLAN_2026-09-23.md` 与主树 AGENTS.md 流程章为其中未提交项，提交须另行授权）。
- 本报告所属分支：`feat/pi861-runtime-v1-cont-20260923-p4-delivery`（worktree `C:\Albert\project\pi861-cont-20260923\p4-delivery`，自 5cacec62e 派生并合入 `p1-ledger@5349ace1a` 台账文档；本地提交，未 push——推送由主会话在文档独立审核通过后统一执行）。

## 2. P4-R 检查链结论表（K1–K8 + K10，42 份日志汇编）

全部结论来自 P4-R 独立实跑（环境：Windows 10.0.26200 / Git Bash / Node v26.4.0 / npm 11.17.0 / Docker 29.7.2；宿主 CLI `C:/Albert/pi861-host`，`@earendil-works/pi-coding-agent` 0.86.1 实测核验）。日志根：`P4-R/p4r-final/logs/`（42 件）+ `evidence/`（5 件）。本表不复制日志内容，只登记命令、退出码、结果与指针。

| 检查组 | 命令（cwd） | 退出码 | 结果 | 日志 |
| --- | --- | --- | --- | --- |
| 环境备置 | `npm ci --ignore-scripts`（仓库根） | 0 | 345 包 | npm-ci.log |
| K1 前置水合 | `npm run hydrate:model-data`（仓库根） | 0 | 补 gitignored 生成数据目录（`models.generated.ts` 已在树内提交） | k1-hydrate.log |
| K1 根检查 | `npm run check`（仓库根） | 2（仅 tsgo 阶段） | biome 1459 文件 0 修复（检查后 tracked 树 0 差异）；pinned-deps/runtime-deps/ts-imports/entry-graphs/pi861-entries/shrinkwrap/install-lock 全过；tsgo 22 错（定性见 2.1） | k1-full-check.log, k1-post-status.txt, k1-tsgo-hydrated.log |
| K1 browser-smoke | `npm run check:browser-smoke`（&& 链被 tsgo 截断后单独补跑） | 0 | 通过 | k1-browser-smoke.log |
| K2 扩展类型① | `tsc --noEmit -p tsconfig.json`（extensions/pi861） | 0 | 0 错 | k2-tsc-main.log |
| K2 扩展类型② | `tsc --noEmit -p tsconfig.entries.json` | 0（水合后） | 0 错；水合前 90 错（manifest 级联）——干净检出必须先水合（第 5 节步骤 3） | k2-tsc-entries{,-hydrated}.log |
| K2 模块套件（model） | routing + live-models + model-service + stream-bridge | 0 | 72/72 | k2-suite-model.log |
| K2 模块套件（skill-mcp） | capabilities + live-skills + live-skill-validation + live-mcp + live-operations | 0 | 66/66 | k2-suite-skillmcp.log |
| K2 模块套件（memory） | memory + live-memory + result-store | 0 | 44/44 | k2-suite-memory.log |
| K2 50 文件全量确定性扫 | 按 P3-I filelist 独立重跑 | 1 | 518 tests / 517 pass / 1 fail / 0 skip；唯一失败 live-guard symlink EPERM（Windows 非开发者模式；纯净基线同测同败 → 环境性，见 2.1） | k2-full-sweep-p4r.log, k2-base-liveguard.log |
| K3 published 安装 | `npm install --no-save --ignore-scripts @earendil-works/pi-coding-agent@0.86.1`（extensions/pi861） | 0 | 实测 version=0.86.1；**未装包则 tsconfig.host.json 44 错**（第 5 节步骤 6） | k3-install-published.log |
| K3 类型（published） | `tsc -p tsconfig.host.json` | 0（装包后） | 0 错 | k3-tsc-host{,2}.log |
| K3 类型（源码宿主） | `tsc -p tsconfig.host-source.json` | 0 | 0 错 | k3-tsc-host-source.log |
| K3 宿主运行（published） | `PI861_REQUIRE_HOST_TESTS=1 PI861_TEST_PI_CLI=<宿主cli.js> node --test test/pi-host.integration.mjs test/runtime-host.integration.mjs`；tsx `test/host-install.integration.mjs` | 0 / 0 | 4/4 + 3/3（真实发布宿主） | k3-host-published-run.log, k3-host-install-published.log |
| K3 宿主运行（源码宿主） | 同上 + `PI861_TEST_SOURCE_HOST=1` | 0 / 0 | 4/4 + 3/3 | k3-host-source-run.log, k3-host-install-source.log |
| K3 负例 | REQUIRE=1 且去除 CLI/源码 env | 1 | 显式失败"skip 不是通过"，门真实生效 | k3-negative-no-cli.log |
| K4 PG17 | P1-Q fixture（`PI861_PG17_TESTS=1`，`test/fixtures/pg17.mjs` 起独立容器 postgres:17，server_version_num=170011=PG 17.11，版本门 [170000,180000) 通过；runtime 受限角色实测非 super/bypassrls/createdb/createrole；驱动根自装 pg@8.23.0） | 0/0/0 | postgres.integration 14/14；postgres-recovery 5/5；storage-service 12 pass + 1 env-gated skip（TLS 子块） | k4-runner.log, k4-{postgres,postgres-recovery,storage-service}.integration.mjs.log, k4-pgdriver-install.log |
| K4 TLS 补强 | P2-D review-2（独立）@ c8b274f36（= p2-storage 合入 HEAD，代码即最终组合所含） | — | 32/32 全过含 TLS 三例 → K4 整体通过；TLS 证据 = 该交接 + 本审核非 TLS 31/31 实测 | P2-D review-2 k4-pg17.log |
| K5 MCP 双传输 | `node --test test/live-mcp.test.mjs test/mcp-http-fixture.test.mjs test/live-operations.test.mjs` | 0 | 30/30 pass / 0 fail / 0 skip；真实 stdio 子进程 + 真实本地 HTTP/SSE fixture（握手协商、404 会话、分页、SSE 通知、取消、schema 漂移）。文件名映射注记见第 7 节 C5 | k5-mcp-dual-transport.log |
| K6 web 安全 | `node --test test/web-security.test.mjs test/web-read.test.mjs test/web-host.test.mjs test/search.test.mjs` | 0 | 62/62；点名反例：授权前 DNS/连接零发生（含 DNS rebinding 钉扎）；100ms 抽取预算实测 102ms 收敛返回超时（旧 28.9s 缺陷反例在当前版本通过） | k6-web-suites.log |
| K7 双 Worker | `worker-pair.integration.mjs` | 0 | 1/1：两个真实 `scripts/worker-service.mjs` 进程（独立端口/检出/token），驱动真实发布 Pi 0.86.1（确定性 provider），bundle+SHA256 运输校验 | k7-worker-pair.log |
| K7 隔离 | `worker-isolation.integration.mjs` | 0 | 7/7：伪造身份/过期租约/错 token 拒绝、越界 diff 零候选、心跳丢失、被杀 worker 不伪造 done、git index 锁阻断、rpcTimeoutMs 生效、**真实 OCI 容器隔离**（node:22-alpine，拒绝网络与凭据、诚实能力报告） | k7-worker-isolation.log |
| K8 AX/闭环 | 未重复复跑；证据审计 + 交叉复验判定 | 0 | P3-X k8-final @ df44a16d5：33 tests / 31 pass / 0 fail / 2 skipped / exit 0（2 skip 为 AX7/AX8 PG17 fixture 诚实层级标记，语义为"真实 PG 组合步骤已运行才跳过占位"，不推高通过）；十份 axN-evidence.json 全 passed；AX10 20/20 步全链（真实 Pi 宿主 → /goal → 只读 planner 子进程 → 真实 PG17 协调者 → 两个真实同机 Worker → 审核失败注入 → 返工 → 屏障断言 → 唯一集成权 → check.mjs 实文件验证 → 人工 accept → 空闲唤醒 generation 2 → 重复 resume 不推进）；P3-X review-2 独立复跑两次同结果 + 3 项故意破坏（N1/N2/N3）均按预期失败且首败存档 | P3-X/5cacec62e/k8-final-run.log、k8-final/；P3-X/review-2/zcode-r2/（k8-rerun-run.log、neg/、verify-manifest.mjs）；P4-R evidence/k8-report-inventory.txt |
| K10 真实外部服务 | `node scripts/real-acceptance/{real-model,real-search,real-mcp}.mjs`（无授权 env）×3；acceptance 门测试 | 0 | 3/3 输出 `deferred / requests=0 / 待授权`——默认拒绝、零请求、不冒充通过；acceptance/real-acceptance 门 18/18（含反 skip 误计回归用例） | k10-refuse-*.log, k10-acceptance-gates.log |

### 2.1 两项环境定性（三重证据，非本轮引入）

1. **tsgo 22 错**：水合后 `packages/ai/test/*` 恰 22 错（fireworks 13 + empty-signature 5 + sse 2 + prompt-cache 2），成因 models.dev 目录漂移（kimi-k2p6/glm-5p2 等被 glm-5p3 等取代）。三重证据：P4-R 纯净基线 d28044896 独立对照 829=829 错误集合逐字节相同（evidence/tsgo-cand-vs-base.diff）；`git diff d28044896 5cacec62e -- packages/ai/` 为空（continuation 全程未触碰）；P2-D review-2 的 22=22 对照互证。→ 上游环境性阻塞，已登记，不计通过也不计失败。
2. **live-guard symlink EPERM**：Windows 未开开发者模式导致 symlink 用例失败（518 扫唯一失败）；纯净基线同测同败 → 既有环境性（Linux 原生行为见第 4 节待验证清单）。

## 3. 需求覆盖终判（87 R 子项 + G8 + AX10，四态）

四态词表：**代码完成 / 审核通过 / 已接入 / 集成通过**（分别登记，不相互替代）。完整逐条终态表已按 P4-R 第 3 节采纳登记于 [ACCEPTANCE_MATRIX.md](ACCEPTANCE_MATRIX.md) 第 0.7 节（本报告不重复排版，以该节为台账权威落点）。摘要：

- R1（9）除 R1.8 登记边界外全部**集成通过**；R1.8 **集成通过（登记边界）**——接待/编译/提炼/planner 端口/独立 reviewer 均走共享 C3 计量，planner 只读子进程与 Worker 进程自身的模型调用不经宿主 C3 计量（边界申报与代码一致）。
- R2（10）、R4（10）、R5（12）、R8（8）、G8、AX1–AX10：全部**集成通过**。
- R3（13）全部**集成通过**；R3.8 附同机边界如实标注（真实 OCI 容器隔离实测，可信本地模式如实标注非沙箱）；R3.9 附观察项（`.intlock` 互斥为行为级间接覆盖，无直接磁盘观察断言——第 7 节备注 2）。
- R6（18）：15 条**集成通过**；R6.3 **集成通过（4/5 转换）**（node-switch 无宿主事件，登记 TODO）；R6.15 **已接入（部分）**（运行时权威=文件 LayeredMemory+状态级 PostgresStateStore，StorageService 逐记录 DB 会话权威未作生产权威，登记 TODO①）；R6.16 pgvector **fail-closed**（启用即抛错，非装饰性开关，未实现如实标注）。
- R7（7）：R7.1–R7.6 **集成通过**（R7.6 网页正文读取为已交付必需项）；R7.7 **已接入（登记残留）**（web 引用为会话内 ResultStore，runtime 未注入持久 store，登记 TODO④）。
- R8.6 附登记残留：reviewer 独立身份已修复（runtime.ts:1182 `reviewerId: reviewer-<agentId>`）；reviewer 复用 plannerModelId 配置面为登记 TODO③。

**登记残留全集（P4-D 不升格，逐项保留）**：R1.8 边界、R6.3 node-switch TODO、R6.15 TODO①、R7.7 TODO④、R8.6 TODO③、stream-claims ledger 进程内不跨重启（MCP 业务回执已有持久 OperationJournal）、K 侧 bindingName 解析端口未导出（H 重实现公式，漂移=零派发，P3-I r3 审核逐字段核对一致）、同机多进程边界。P4-R 对 5 项 TODO 的申报诚实性逐一源码复核属实，无虚报完成项。

## 4. 真实/模拟界限与待授权隔离清单

**真实（本地实测）**：真实发布 Pi 0.86.1 宿主与源码宿主加载/运行；真实 PG17（17.11）容器、受限角色、RLS、迁移、备份恢复；真实 stdio MCP 子进程与真实本地 HTTP/SSE fixture 服务器；两个真实 worker-service.mjs 进程驱动真实 Pi（确定性 provider）；真实 OCI 容器隔离（node:22-alpine）；真实 Git 临时仓库闭环（AX10）。

**模拟/fixture（如实标注，不冒充）**：全部模型面为确定性 fixture/native provider（AX10 明示"模型为 fixture"，不宣称真实智能质量）；搜索为 Brave 兼容本地 fixture（真实 Brave 零调用）；多节点为**同机多进程**（loopback、独立检出、独立 token；跨主机未验证，不写成多服务器验证）。

**PG 版本边界**：K4 权重证据为真 17.11（版本门 [170000,180000)）；宿主 5432 上的 pgvector 18.6 容器零触碰；M3 历史 18.6 日志仅附历史，不替代 17 证据。pgvector 未实现且 fail-closed（O1 如实）。

**待授权（K10 层，默认拒绝已实测；未授权不计通过）**：

| 项 | 状态 | 下一步 |
| --- | --- | --- |
| 真实付费模型质量验收 | 待授权（real-model deferred/0 请求） | 用户授权后运行 `scripts/real-acceptance/real-model.mjs`（凭据 env 注入、预算上限、清理方法按计划第 8 节审核） |
| 真实 Brave 搜索 | 待授权（real-search deferred/0） | 同上（real-search.mjs） |
| 业务 MCP 验收 | 待授权（real-mcp deferred/0） | 同上（real-mcp.mjs） |
| 业务数据库验收 | 待授权（测试仅 loopback pi861_test，宿主 5432 零触碰） | 用户指定受控业务库环境后另行验收 |
| 跨主机多节点 | 环境未具备 | 具备独立主机后执行 R3.7 跨节点验收 |
| Linux 原生行为（K9 部分） | 未验证（本机 Windows；live-guard symlink、路径大小写等） | Linux CI/主机复跑 K1/K2 相应面 |

**禁止表述**：本报告不允许"全场景生产就绪"声明；正确表述为"本地必需范围（K1–K7 独立实跑 + K8 证据审计）通过，上述外部缺口待授权/待环境"。

## 5. 干净检出最短重现步骤（C2 补全：两步前置为必做）

以下步骤自 5cacec62e 干净检出重现全部本地检查（P4-R 以同路径在独立 worktree 实测，正例=读者按记录重建相同快照：143/143 清单复算 + digest 一致 + 全部检查同结果）。

```sh
# 0) 干净检出（worktree 或 clone），锚定最终 HEAD
git worktree add <dir> 5cacec62e2750214d99c5bba31659cf2f198fe21
cd <dir>

# 1) 安装依赖（不跑生命周期脚本）
npm ci --ignore-scripts

# 2) 【C2 前置步骤一，必做】模型数据水合（补 gitignored 生成数据目录）。
#    缺此步：tsc entries 90 错、tsgo 829 错（环境性级联，非代码错误）。
npm run hydrate:model-data

# 3) K1 根检查（预期：除 tsgo 22 错登记项外全过；&& 链被 tsgo 截断后单跑 browser-smoke）
npm run check
npm run check:browser-smoke

# 4) K2 扩展类型与确定性测试（cwd: extensions/pi861）
cd extensions/pi861
node ../../node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
node ../../node_modules/typescript/bin/tsc --noEmit -p tsconfig.entries.json
node --experimental-strip-types --test test/*.test.mjs   # 50 文件全量扫，Windows 预期 517/518（live-guard EPERM 环境性）

# 5) 【C2 前置步骤二，K3 published 类型检查必做】安装精确锁定的发布包（写入本目录 node_modules）。
#    缺此步：tsc -p tsconfig.host.json 44 错（Cannot find module 级联）。
npm install --no-save --ignore-scripts @earendil-works/pi-coding-agent@0.86.1

# 6) K3 两类宿主类型 + 运行（需仓库根依赖已装；宿主 CLI 指向本地已安装的发布宿主）
node ../../node_modules/typescript/bin/tsc -p tsconfig.host.json
node ../../node_modules/typescript/bin/tsc -p tsconfig.host-source.json
PI861_REQUIRE_HOST_TESTS=1 PI861_TEST_PI_CLI=/path/to/pi-host/dist/bundle/cli.js \
  node --test test/pi-host.integration.mjs test/runtime-host.integration.mjs
PI861_REQUIRE_HOST_TESTS=1 PI861_TEST_SOURCE_HOST=1 PI861_TEST_PI_CLI=/path/to/pi-host/dist/bundle/cli.js \
  node --test test/pi-host.integration.mjs test/runtime-host.integration.mjs
# 负例（缺配置必须失败，不是 skip）：
PI861_REQUIRE_HOST_TESTS=1 node --test test/pi-host.integration.mjs   # 预期 exit 1

# 7) K5/K6（同 cwd extensions/pi861）
node --test test/live-mcp.test.mjs test/mcp-http-fixture.test.mjs test/live-operations.test.mjs
node --test test/web-security.test.mjs test/web-read.test.mjs test/web-host.test.mjs test/search.test.mjs

# 8) K4 PG17（独立容器，随机端口；驱动根为隔离安装的 pg@8.23.0）
#    以 PI861_PG17_TESTS=1 经 test/fixtures/pg17.mjs 起容器，注入
#    PI861_TEST_POSTGRES_URL / PI861_ALLOW_TEST_DATABASE=1 / PI861_TEST_DRIVER_ROOT，
#    依次 --test test/postgres.integration.mjs test/postgres-recovery.integration.mjs test/storage-service.integration.mjs
#    （P4-R scripts/k4-run.mjs 为可参考的编排实现；TLS 子块本机无 TLS 服务器时 env-gated skip，
#     真实通过存证见 P2-D review-2 @ c8b274f36）

# 9) K7 双 Worker / 隔离（同 cwd）
node --test test/worker-pair.integration.mjs        # 需真实发布 Pi CLI env
node --test test/worker-isolation.integration.mjs   # OCI 容器用例需 Docker

# 10) K8 AX：于 df44a16d5（P3-X 分支）运行 k8 套件（P3-X/review-2 的 run-k8.sh 为参考编排）

# 11) K10 默认拒绝自证（无授权 env）
node scripts/real-acceptance/real-model.mjs   # 预期 deferred / requests=0（×3 同理）
```

Windows 注意：步骤 4 的全量扫在未开开发者模式时 live-guard symlink 用例 EPERM 失败（517/518，环境性，纯净基线同败）；开启开发者模式或 Linux 下为 518/518。

## 6. 启动命令与脱敏配置示例

两入口互斥，重复加载拒载（实测）。配置为可信绝对路径 JSON；凭据只存环境变量名（G8：`database.urlEnv` / `remoteWorkers[].tokenEnv`，运行时从环境读取，不进模型上下文与日志）。

```sh
# 完整运行入口（清单 pi.extensions 指向）
PI861_CONFIG=/absolute/path/to/pi861-config.json pi -e ./extensions/pi861/runtime.ts
# 基础组合入口（不自动续跑 /goal 编排器）
pi -e ./extensions/pi861/index.ts
```

脱敏配置骨架（字段名经 CONFIGURATION.md 登记；值示例均为占位，非真实凭据）：

```json
{
  "projectId": "pi861-local",
  "agentId": "main",
  "roles": { "dev": { "skillIds": ["debug-toolkit@1"], "grants": [] } },
  "database": { "urlEnv": "PI861_DATABASE_URL", "tls": "require" },
  "remoteWorkers": [ { "id": "worker-b", "endpoint": "https://worker-b.internal:8443", "tokenEnv": "PI861_WORKER_B_TOKEN" } ]
}
```

升级/恢复/回滚可用项：`sql/memory-v1.sql` 增量迁移（迁移账号执行）；Skill `/skills rollback ID REVISION`；模型路由 checkpoint 恢复（policyHash 校验、generation+1）；`/goal` 动词全集（new/status/edit/pause/resume/budget/unblock/accept/clear+cancel，GoalCommandService）；备份恢复路径 K4 实测。未实现项单列见第 3 节登记残留。

## 7. P4-R 可行动问题处置记录（C1–C7）

| # | 问题 | 处置（本报告/台账落点） | 状态 |
| --- | --- | --- | --- |
| C1 | 五台账与 README"当前交付边界"为基线旧版（README 低报失真） | 本报告 + ACCEPTANCE_MATRIX 第 0.7 节（覆盖终判）+ REQUIREMENTS 第 14 节 + ARCHITECTURE 第 10 节 + CONFIGURATION 第 11 节 + HANDOFF 收口段 + DISPATCH_REGISTRY 全表更新 + README 边界表重写，全部绑定 SnapshotID-3 | 已闭环（本提交） |
| C2 | 干净检出缺两步文档（hydrate / K3 published 安装） | 第 5 节步骤 2 与步骤 5（命令+缺失后果+预期结果）；README"开发和验证"节同步补注 | 已闭环（本提交） |
| C3 | K3 published tsc 依赖本地装发布包（环境步骤） | 第 5 节步骤 5 文档化为环境前置；CONFIGURATION 第 11 节登记 | 已闭环（文档层） |
| C4 | 清单标签"git-blob SHA256"实为原始文件 SHA256 | 第 1.1 节更正措辞；台账引用一律写"原始文件字节 SHA256"；原清单文件为证据原件不改 | 已闭环（措辞） |
| C5 | 计划 K5 文件名 `mcp-transports.integration.mjs` 未创建，覆盖由 live-mcp + mcp-http-fixture 承担（30/30） | 第 2 节 K5 行注记 + ACCEPTANCE_MATRIX 第 0.7 节映射注记 | 已登记 |
| C6 | P3-I 接线提交对 K/M 所属文件（skill-repository/mcp/result-store）纯 biome 格式化触碰（零行为差异，已申报） | DISPATCH_REGISTRY 变更记录 + ARCHITECTURE 第 10 节登记为轻微所有权偏离；后续冻结文件格式触碰逐一登记 | 已登记 |
| C7 | P3-X REPORT 第 5 行"6 files"应为 5；p1-ledger 文档未并入 | 勘误关联：P3-I CORRECTION-1-manifest.md（R3-E1）为权威更正，P3-X REPORT 原件保留不改；p1-ledger@5349ace1a 已合入本分支（单一权威） | 已闭环 |

### 7.1 P3-X review-2 三条备注处置

1. **browser-smoke 措辞（minor）**：P3-X 时该腿仅在 snapshot-2 有记录；P4-R 已于 5cacec62e 独立补跑 `check:browser-smoke` exit 0（k1-browser-smoke.log）→ 表述失真已被当前版本实测证据闭合。本报告第 2 节按"独立补跑通过"登记。
2. **`.intlock` 无直接磁盘观测（observation）**：AX9 集成互斥覆盖为**行为级间接覆盖**（guard 拒绝、generation 保持、单次集成），`.intlock` 目录本身无断言观察。本报告与台账一律使用"间接覆盖"表述，不写"intlock 磁盘观测"。
3. **`PI861_AX_COMPOSITE_SNAPSHOT` 声明式锚定（observation）→ future note**：测试只检查非空、不校验树内容与 SnapshotID 绑定；P3-X review-2 已用 143/143 manifest 比对独立补强。**未来注记**：建议把清单 digest 校验纳入 k8 harness（一次性消除"声明与树不符"的可能），登记为后续工作，不阻塞本轮交付。

## 8. 第三方依赖与许可

- 本轮新增依赖仅 `@types/pg@8.23.1`（dev，MIT，锁文件精确固定）；扩展自身零新增运行时依赖。
- 未复制 OpenViking、gbrain 或第三方编排插件源码（README"参考及许可"声明与 diff 事实一致，P4-R 核验）；借鉴仅限概念与测试场景。
- 凭据零泄漏：diff（d28044896→5cacec62e）无密钥/真实端点新增；证据树扫描零命中（唯一 `sk-ant-oat` 命中为上游源码模式判断代码，非泄漏）。

## 9. 四态退出条件（完成/未完成/待授权/环境阻塞均有下一步）

| 态 | 范围 | 下一步 |
| --- | --- | --- |
| 完成 | 本地必需范围：K1–K7 独立实跑通过（K1 含 2 项登记环境定性）、K8 证据审计 + 交叉复验通过、K10 默认拒绝自证通过；19 工作包全部交付且各自独立审核通过；五台账 + 本报告绑定 SnapshotID-3 | 文档独立审核者按第 5 节复现并核对结论与证据（审核者不得参与本轮任何实现/测试/审核） |
| 未完成（登记残留，不升格） | R6.3 node-switch TODO、R6.15 TODO①、R7.7 TODO④、R8.6 TODO③、stream-claims 跨重启持久化、bindingName 端口导出 | 由对应所有者（M/D/E/G/H）按计划领取；实质变更接口前先补 Codex 规划 |
| 待授权 | 真实付费模型 / 真实 Brave / 业务 MCP / 业务数据库 / 跨主机 | 用户明确授权后运行 K10 脚本（第 4 节表） |
| 环境阻塞 | tsgo 22 错（上游 models.dev 目录漂移）、live-guard EPERM（Windows symlink）、Linux 原生行为未验证 | 上游目录稳定后由 T 复跑 tsgo；开发者模式/Linux 环境复跑对应面；不视为产品缺陷 |

**无误报声明**：本文档任何"集成通过"均绑定第 2 节实测或 P3-X/review-2 存证；登记残留不升格；文档更新日期不作为代码通过日期（被测代码 SHA=5cacec62e）；未推送、未运行 CI——本轮全部证据为本地实跑，不存在虚构 CI 运行。

## 10. 证据与产物指针

- P4-R 终审：`C:\Albert\project\pi861-briefs\continuation-20260923-execution\P4-R\p4r-final\`（REPORT.md、logs/ 42 件、evidence/ 5 件、scripts/）。
- 各包证据与审核：`C:\Albert\project\pi861-briefs\continuation-20260923-execution\<包ID>\`（19 包 + review 目录，索引见 DISPATCH_REGISTRY）。
- P3-X AX 证据：`…\P3-X\5cacec62e\`（k8-final/、axN-evidence.json）与 `…\P3-X\review-2\zcode-r2\`。
- 本包（P4-D）交付证据：`…\P4-D\<交付提交短SHA>\`（DELIVERY-REPORT.md、commands.log、文件 SHA256）。
- 台账更新落点：ACCEPTANCE_MATRIX 第 0.7 节、REQUIREMENTS 第 14 节、ARCHITECTURE 第 10 节、CONFIGURATION 第 11 节、HANDOFF 收口段、DISPATCH_REGISTRY、README"当前交付边界"。
