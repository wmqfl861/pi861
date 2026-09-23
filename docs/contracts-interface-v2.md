# Pi861 共享契约接口清单与版本摘要（contracts-interface-v2）

- 版本：**v2（冻结版）**。本文件由 P1-C 工作包产出，供 P1-L 归档；消费者（P1-S、P2-A/B/D/G/M/S/W/E、P3-I、P3-X）按本清单编译与集成。
- 生成工作区：`C:\Albert\project\pi861-cont-20260923\p1-contracts`，分支 `feat/pi861-runtime-v1-cont-20260923-p1-contracts`（基线 `d28044896a9ccd0bc81fb9a1d0d28eee7e9f86d5`）。
- 输入来源：契约修复提交 `a7243e84df97d61d01020df46dbddca9d3d1470f`（worktree `C:\Albert\project\pi861-wt-contracts`，分支 `pi861/p1-contracts`；其父提交为原始契约提交 `cdaf20dde10266710082222c92e7ff90bc63c75a`）。主树 d28044896 staged 的契约副本经逐文件 blob 比对与 a7243e84 完全一致，无额外差异需要合并。
- 导入方式：`git checkout a7243e84 -- <contracts 路径>` 精确检出后修改；`git diff a7243e84 -- extensions/pi861/src/contracts extensions/pi861/test` 可完整重现本包增量。
- 计划依据：`docs/pi861/CONTINUATION_PLAN_2026-09-23.md` 第 4 节（C1–C7 冻结内容）、第 3 节（差距映射中归 P1-C 的行）、第 5 节 P1-C、第 7 节 K1/K2。
- 需求依据：`docs/pi861/REQUIREMENTS.md`（G1–G8、R1–R8 相关条目在文中逐项标注）。

## 1. SnapshotID

```text
SnapshotID = 基线 Git HEAD（d28044896a9ccd0bc81fb9a1d0d28eee7e9f86d5）
           + 输入契约提交 a7243e84df97d61d01020df46dbddca9d3d1470f
           + 本包最终提交完整 SHA（见交付报告）
           + 第 5 节文件 SHA256 清单
```

内容清单、命令、退出码、日志路径见交付报告（`C:\Albert\project\pi861-briefs\continuation-20260923-execution\P1-C\<短SHA>\`）。

## 2. 本包冻结决定（对照计划第 3/4 节的未定点，全部关闭）

以下字段/语义在 v1（a7243e84）中不存在或未定，本包明确冻结为保守设计，**没有留给主会话决定的项**：

| # | 未定点（计划出处） | 冻结结果 |
|---|---|---|
| D1 | G1「默认 local/main 仅属可信本地模式」 | `identity.ts` 新增常量 `TRUSTED_LOCAL_TENANT_ID="local"`、`TRUSTED_LOCAL_PRINCIPAL_ENV="PI861_AGENT_ID"`、`TRUSTED_LOCAL_FALLBACK_PRINCIPAL_ID="main"` 与解析函数 `trustedLocalPrincipalId()`；`IdentityAuthority` 构造新增 `trustedLocal?: boolean`（默认 false），tenantId 为 `local` 且未置 true 时直接抛错——远端/多节点服务永远无法构造 local 租户的 authority，自报 tenant=local 无验证者。 |
| D2 | C1「模型配置revision」 | 模型配置的类型本体归 P2-A（`src/routing.ts` 的 `ModelTarget.id/revision`，M1 已实现 preferred/active 分离、attempt 记录 configRevision、快照 revision 漂移拒绝）。契约侧冻结的绑定规则：所有 revision 为不可变字符串（角色 revision、配置文档 revision 已在契约内强制不可变）；路由/检查点引用的模型配置 revision 必须随决策与 attempt 持久化；P2-A 不得另行发明第二套 revision 语义。契约不重复定义模型类型，避免与 A 所有权冲突。 |
| D3 | C3「根预算ID」 | `TaskTreeBudget` 构造新增可选 `options.budgetId`；缺省生成 `budget-<uuid>`（两棵树绝不碰撞）；`budgetId` 进入 exportState/restore（快照版本 1→2），持久层（P2-D）以 `(budgetId, reservationId)` 作为预留的全局键。 |
| D4 | C3「probe 单飞费用归属」 | `reserve()` 新增第 5 参 `options.probeKey`（仅 kind="probe" 可携带）；同一 probeKey 存在未结算预留时再次 reserve 抛 `ProbeInFlight`。冻结规则：一个物理探测 = 恰好一个预留 = 恰好一次计费；共享消费者加入在飞预留（等待其结算），不重复开预留；结算/释放后同 key 表示新的物理探测可再用。快照恢复拒绝重复开放 key 与非 probe kind 携带 key。 |
| D5 | C3「任务容量」+ R3.1「默认 2 并发、2 attempts、100 tasks 待固定」 | `budget.ts` 新增 `SchedulingDefaults`/`DEFAULT_SCHEDULING = { maxConcurrentTasks: 2, attemptsPerTask: 2, maxProjectTasks: 100 }`（R3.1 原文默认值，均可由分层配置覆盖）与 `TaskTreeCapacity`：全树并发槽位账本；`start`（注册态/等待态→运行态，全树运行数达上限抛 `CapacityExhausted`）、`beginWaiting`（父等待后代即释放自身槽位，R3.6）、`finish`（终态释放槽位但仍计入项目任务总数）、`registerTask`（≤ maxProjectTasks、无环树）。调度时机归 P2-G，边界归本契约。attemptsPerTask 的强制执行载体是 `BudgetLimits.maxAttempts`（任务注册子预算），默认值 2 由 DEFAULT_SCHEDULING 固定。 |
| D6 | C6「采用事件」+ R6.12 | `memory.ts` 新增 `AdoptionEvent`（version、recordId、scope、adoptedAt、`acceptanceEvidenceDigest`=C7 `evidenceDigest()` 输出的 64 位十六进制摘要、adoptedBy）与 `applyAdoption()`：仅 candidate 可升格；升格追加 `verified` 来源（ref=`adoption:<digest>`）、revision+1、status→confirmed；无 C7 验收证据摘要的事件在类型与校验上均不可表达；constraint 升格仍被 `validateMemoryRecord` 强制要求直接 user 来源。分支完成自身无法产生采用事实。 |
| D7 | C7「pass/fail/skip/not-run/blocked 分离」+ G7/R4.9 | `acceptance.ts` 新增 `CheckOutcome = "pass"|"fail"|"skip"|"not-run"|"blocked"`；`AcceptanceEvidence` 新增可选 `outcome`（存在时必须与 `passed` 一致：仅 `pass` ⟺ `passed===true`），record 与 restore 都执行该一致性校验；非 pass 的四种 outcome 永不满足条款；`summarizeOutcomes()` 供报告分层计数（缺省 outcome 按 passed 推导 pass/fail）。字段可选是为了保持旧记录形状可继续写入（自动化证据仍受 exitCode===0 约束），但运行器（P1-Q）必须显式记录 outcome。 |
| D8 | G8「凭据只由宿主环境解析」 | `configuration.ts` 新增 `SecretEnvRef { envVar }` 与 `validateSecretEnvRef()`：环境变量名必须匹配 `^[A-Z][A-Z0-9_]{0,99}$`；配置中的数据库/Worker 凭据字段（`database.urlEnv`、`remoteWorkers[].tokenEnv`）一律用该形状，值形态（URL、token 字面量）在契约层即非法。运行时只在可信宿主内解析（P1-S/P2-D/P2-W 消费）。 |
| D9 | R3.4/R3.11 执行身份与拒环 | 沿用既有冻结：`ExecutionIdentity` 六段（tenant/project/goal/run/task/attempt）含 goalId，不同 Goal 同 taskId 经 `executionPath` 不碰撞（F14 已测）；依赖环检测归 P2-G 调度器，契约提供 `dependsOn` 语义所需的身份与 CAS（C4 expectedVersion）基元。 |

未改动即视为冻结的既有语义：C1 出站边界（私有网/环回/链路本地/元数据地址字面量守卫、wildcard 仅后缀匹配）、配置继承（behavior 可调、ceilings 只可收紧、子代理继承行为不缩权限）、C2 世代失效与恢复世代+1、租约 token+generation+过期、持久唤醒事件按摘要幂等、C4 requestId+意图摘要幂等回执/unknown/回滚/outbox 原子提交/分页与增量游标（d2 稳定行序）、C5 激活 pin 不可变/调用时重鉴权/schema 漂移强制重激活/操作账本 at-most-once、C6 来源链/撤回传播/必要上下文装配、C7 受控引用统一失败形态/四类证据互不替代。

## 3. C1–C7 接口清单

符号均自 `extensions/pi861/src/contracts/*.ts` 导出；「测试」列为 `extensions/pi861/test/contracts-*.test.mjs` 中的对应用例组。

### C1 身份与配置（identity.ts / configuration.ts）——P1-S 解析，所有模块消费

| 导出 | 语义 | 测试 |
|---|---|---|
| `ScopeKind`/`ScopeId`/`formatScope`/`parseScope`/`isValidScope` | 规范 scope `(user\|project\|group\|agent\|task\|shared):key` | identity |
| `OutboundRule`/`ResolvedOutbound`/`resolveOutbound`/`outboundAllows`/`isPrivateNetworkHost` | 出站白名单与私网字面量守卫；凭据入 URL 一律拒绝 | identity |
| `ToolGrant`/`RoleDefinition` | 岗位到 service/tool/account/resource 的精确授权；revision 不可变 | identity |
| `PrincipalCredential`/`PrincipalRestriction`/`AuthoritySnapshot`(v2)/`IdentityAuthority` | 唯一签发点：issue/deriveSubordinate（只收窄）/verify（伪造、篡改、吊销、外来全拒）/revoke（级联后代）/exportState/restore（epoch+1） | identity, F01/F02 |
| `TRUSTED_LOCAL_TENANT_ID`/`TRUSTED_LOCAL_PRINCIPAL_ENV`/`TRUSTED_LOCAL_FALLBACK_PRINCIPAL_ID`/`trustedLocalPrincipalId` | G1 默认主体；local 租户仅 trusted-local 模式 | identity（本包新增） |
| `ExecutionIdentity`/`validateExecutionIdentity`/`executionPath`/`parseExecutionPath` | goal/run/task/attempt 六段身份，路径分隔转义无碰撞 | identity, F14 |
| `ConfigLayerName`/`BehaviorPreferences`/`PermissionCeilings`/`BehaviorPatch`/`CeilingsPatch`/`ConfigDocument`(v1)/`ResolvedConfiguration`/`ConfigPin`/`ConfigurationRegistry`/`deriveSubagentConfiguration` | 分层配置：behavior 任意层可调；ceilings 只取交/取 min，绝不扩张；revision 不可变；epoch 前进；pin 固定在飞执行 | configuration, F04/F05 |
| `SecretEnvRef`/`validateSecretEnvRef` | G8 凭据按环境变量名引用 | configuration（本包新增） |

BehaviorPreferences 固定字段集（冻结）：`executionModePreference`、`failoverEnabled`、`failbackEnabled`（R1.7 独立开关）、`memory.{autoRecall,autoCapture,autoDistill,activeTools,defaultReadDepth}`（R6.18 四开关+读深）、`planning.{lowWatermarkTasks,maxPlanTasks}`、`search.enabled`。新增行为字段必须走契约变更流程。

### C2 生命周期（lifecycle.ts）——M1/M3/M4/MCP 消费

`ControlledPhase`、`SessionToken`、`ExecutionPermit`、`DispatchRecord`、`LifecycleSnapshot`(v1)、`PermitOutcome`、`SessionLifecycle`（pause/resume/requestCancel/completeCancel/settle/beginExecution/settleExecution/recordDispatch/settleSideEffect/exportState/restore：控制态与副作用态分离，恢复世代+1）；`PersistentLease`/`issueLease`/`leaseValid`（token+generation+过期窗口，R3.4 旧租约提交失败由消费者用 leaseValid 拒绝）；`WakeReason`/`WakeEvent`(v1)/`WakeQueue`（七类持久唤醒事件按摘要幂等、ack 恰一次）/`wakeEligible`。测试：lifecycle。

### C3 预算与容量（budget.ts）——P2-A 计量调用、P2-D 原子存储、P2-G 容量管理

| 导出 | 语义 | 测试 |
|---|---|---|
| `MeteredKind`/`UsageMeasure`/`BudgetLimits`/`UsageReservation`/`TaskUsageSummary`/`BudgetExhausted` | 七类计量（含 probe/auxiliary）、预留-结算、未知用量保守入账不为零 | budget |
| `TaskTreeBudget`（`budgetId`、registerTask 子预算、reserve/settle/settleUnknown/release、exportState/restore v2） | 全树预算；结算沿祖先上卷不双记；快照含根预算ID | budget, F03/F03b |
| `ProbeInFlight`、reserve 第 5 参 `probeKey` | 探测单飞：一个物理探测恰好一个预留一次计费 | budget（本包新增） |
| `SchedulingDefaults`/`DEFAULT_SCHEDULING`（2/2/100） | R3.1 冻结默认值，配置可覆盖 | budget（本包新增） |
| `TaskSlotState`/`TaskSlotSummary`/`CapacityExhausted`/`TaskTreeCapacity` | 全树并发槽位：start/beginWaiting（父等待释放）/finish；项目任务总数上限；快照完整性 | budget（本包新增） |

### C4 持久提交（storage.ts）——P2-D 唯一存储实现，模块经接口访问

`CommitState`/`TransactionReceipt`/`IdempotencyConflict`/`VersionConflict`/`ReceiptLog`（record/markUnknown/resolveUnknown/lookup/exportState/restore）；`OutboxEntry`/`OutboxOutcome`/`Outbox`（append 幂等/claim 只读/complete 退避）；`encodeCursor`/`decodeCursor`/`Page`/`paginate`；`IncrementalPosition`/`encodeIncrementalCursor`/`decodeIncrementalCursor`/`incrementalWindow`（d2 游标，并列版本按 id 稳定排序）；`TransactionPlan`（mutate 纯同步，锁内无外部调用）/`StoreSnapshot`(v2)/`TransactionalStore`（transact 原子提交回执+状态+outbox；persist 第 4 参完整快照；unknown 阻塞后续写；resolveUnknown 需权威快照且保全既有回执）。测试：storage, F06/F06b/F07/F08。

### C5 能力与操作（capability.ts / operation.ts）——P2-S 实现，模型/Goal/引用服务消费

`FullToolIdentity`/`toolIdentityDigest`/`SchemaRegistration`/`SchemaDriftError`/`ToolSchemaRegistry`/`ActivationPin`/`pinActivation`/`grantCovers`/`validateInvocation`（pin 不可变、逐调用重鉴权、漂移强制重激活）；`OperationStatus`/`BusinessOperation`/`OperationConflict`/`OperationSnapshot`/`OperationLedger`（prepare 幂等/派发 claim=markDispatched 独占转换（第二次 claim 抛错，即冻结的「派发claim」语义）/succeeded 不再派发/unknown 必经 reconcile，not-executed 恰一次重武装）。测试：capability, F15。

### C6 记忆（memory.ts）——P2-M 服务、P2-D 持久化

`MemoryPurpose`/`MemoryStatus`/`SourceKind`/`ProvenanceEntry`/`DerivationLink`/`MemoryRecord`/`MAX_MEMORY_BYTES`(262144)/`validateMemoryRecord`（inference 不得自确认为 confirmed；constraint 必须直接 user 来源）；`memoryFingerprints`（内容+来源指纹，撤回 tombstone）；`WithdrawalPlan`/`planWithdrawal`（递归传播，穿过已撤回中间层与环）；`AdoptionEvent`/`applyAdoption`（本包新增，R6.12）；`AssemblyMode`/`ContextAssemblyOptions`/`AssembledContext`/`assembleNecessaryContext`（启动类模式不装长期经验；按可读 scope 过滤；整条丢弃不截断；保留认识状态与完整来源）。测试：memory, F11/F12/F13。

### C7 产物与验收（artifact.ts / acceptance.ts）——P1-Q 证据、P2-M 引用、P2-G 验收消费

`ArtifactReference`/`ArtifactWindow`/`ArtifactUnavailable`/`contentDigestOf`/`verifyArtifactContent`/`ControlledArtifactStore`（内容寻址、有界窗口、scope/吊销/不存在统一失败形态不泄漏存在性）；`EvidenceKind`/`RecorderKind`/`CheckOutcome`（本包新增五态）/`AcceptanceEvidence`（含可选 outcome）/`GoalContractClause`/`AcceptanceEvaluation`/`AcceptanceSnapshot`/`AcceptanceLedger`（四类证据分层：自动化必须可信记录器+命令摘要+退出码，独立审核必须非实现者，人工接受必须 human；非零退出永不满足）/`evidenceDigest`/`summarizeOutcomes`（本包新增）。测试：artifact, F09/F10/F10b。

## 4. 与计划的差异说明

无实质冲突。两点边界说明：

1. 「模型配置revision」（C1 冻结内容第 2 项）的类型本体在 P2-A 的 `src/routing.ts`（M1 已有 id/revision 与漂移拒绝），本包冻结的是绑定语义而非重复类型（见 D2）。若 P2-A 后续要求契约层显式承载模型配置 revision 类型，走契约变更流程，不视为本次冻结缺口。
2. 探测单飞（D4）冻结在预留层（ProbeInFlight）。「同一时刻至多一个探测」的并发互斥由 P2-A 的健康服务实现，契约提供的是计费唯一性基元；两者配合满足 R2.6，契约不越权实现并发原语。

## 5. 文件 SHA256 清单（v2 冻结）

源码（11 文件）：

| 文件（相对仓库根） | SHA256 |
|---|---|
| `extensions/pi861/src/contracts/identity.ts` | `6f3d4e0ae99d562c4dc853978ec372ac2eeefa74f9c4cdf8919834eb241261b3` |
| `extensions/pi861/src/contracts/configuration.ts` | `2e8c15accd502f8585bd4150d3629047eb3ece1d1623b73d699722a7359c33ac` |
| `extensions/pi861/src/contracts/lifecycle.ts` | `835a5d0a9175080b90a1ba4340cc7106f3910ef6643caa9c8d0b8cf4aed96169` |
| `extensions/pi861/src/contracts/budget.ts` | `be85d37fa5cad8950b077e01d7f3c8985b832010538b1f3e1cc54b8bb4435b15` |
| `extensions/pi861/src/contracts/storage.ts` | `1a6504e44e27dde635cc6bd16e97aa0382d9984d6ed7786314fcb19f9a7c3372` |
| `extensions/pi861/src/contracts/capability.ts` | `2be9308f8157a76ded52c04805b0fa6374173d8b30f7aff4f77ce04cb2ef28f2` |
| `extensions/pi861/src/contracts/operation.ts` | `59f5ec35d7651df8c1b03446bf08811b42cf1ee3ff59d50b24ed2a5a7b0b55df` |
| `extensions/pi861/src/contracts/memory.ts` | `9dfbc6a037fc199970d41430e6b9392bd3c7a2fc086a4e046a7dca19c59977ea` |
| `extensions/pi861/src/contracts/artifact.ts` | `ff73cb2b9e619373edef39372cb6ed15b1e586efca7c2713abdf3df164a64ce9` |
| `extensions/pi861/src/contracts/acceptance.ts` | `d39627b63c79d22c67ec265785586c91beebaa30c2410f3d5fca358c05e931bc` |
| `extensions/pi861/src/contracts/hash.ts` | `169493ffb23a5fb0dbeda7bcf53939cf5c28b70831e14a6b31986d0c5bbc42a5` |

契约测试（8 文件，共 102 用例全过）：

| 文件 | SHA256 |
|---|---|
| `extensions/pi861/test/contracts-artifact.test.mjs` | `748f5ba87d7f0e887c98e109c3f4cd3a4f4663fe91cac1cbce6e7b5fc177fa72` |
| `extensions/pi861/test/contracts-budget.test.mjs` | `c0a4aae1c427fb8c37345396ffbae733c37a677454bb437724aac56d1e6c67aa` |
| `extensions/pi861/test/contracts-capability.test.mjs` | `4f5d01afbc8bdb47576e316f66fbf9db4134d727cc795992fb31c07a1b759b58` |
| `extensions/pi861/test/contracts-configuration.test.mjs` | `ce86c5c3abf0fe683cf84a64212f75e4cb6c831e1f4e07ba92517f39d0613b85` |
| `extensions/pi861/test/contracts-identity.test.mjs` | `ace6bfddeaef05a27f5af58b006c866edb2fce7a25c8ed7d7f3cc77e3894d1a4` |
| `extensions/pi861/test/contracts-lifecycle.test.mjs` | `04dcc874aa47fd80b6d9d2fc6ea0c187d53dbf0978985d1b0635516bb774684a` |
| `extensions/pi861/test/contracts-memory.test.mjs` | `2810a09599986a3aa7c5f43c1e1774996eb0a269d9753c3974ca3c6897bea211` |
| `extensions/pi861/test/contracts-storage.test.mjs` | `a59229e6115438a211100403f43f2f678d058fbe07da1f5182f98ee442e78022` |

哈希以本包最终提交内容为准；本文件自身的最终字节哈希记录在交付报告 manifest 中（避免自引用失真）。

## 6. 消费者接入说明

- 导入：`import { ... } from "../src/contracts/<file>.ts"`（同扩展内相对路径，`.ts` 后缀，Node `--experimental-strip-types` 直接加载；类型检查用仓库 tsconfig）。
- 运行时校验规则：所有 `restore()`/`record()`/`validate*()` 即校验边界；消费者不得在契约外绕过（例如不得自建第二份回执日志或第二套 scope 解析）。
- 契约测试命令（K2，cwd=`extensions/pi861`）：
  `node --experimental-strip-types --test test/contracts-artifact.test.mjs test/contracts-budget.test.mjs test/contracts-capability.test.mjs test/contracts-configuration.test.mjs test/contracts-identity.test.mjs test/contracts-lifecycle.test.mjs test/contracts-memory.test.mjs test/contracts-storage.test.mjs`
- 接口变更流程：消费者提交变更请求给 P1-C 所有者；未冻结前不得自行扩签名。快照版本（AuthoritySnapshot v2、budget exportState v2、StoreSnapshot v2、其余 v1）即版本锁定点，restore 拒绝不符版本。
