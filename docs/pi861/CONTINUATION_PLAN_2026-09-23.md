**CONTINUATION_PLAN_2026-09-23**

本计划为只读续开发规划，依据本次注入的调查结果、工作区快照、原需求、历史计划和交接记录编写。本次没有调用工具、读取磁盘、启动代理、修改文件或配置，也没有运行检查、测试、安装、提交或推送。下文命令均为后续执行要求，不能作为已经执行的证据。

本计划保留 R1–R8、G1–G8 和 AX1–AX10 的完整范围。网页正文读取和工作树源码宿主验证是必需项；旧台账将其列为 O2、O4 可选增强的分类必须纠正。pgvector 是可选增强，多搜索供应商扩展可以后续开展，Brave 完整链路必须交付。

本正文应由调用方完整保存为 `docs/pi861/CONTINUATION_PLAN_2026-09-23.md`。若该路径已有文件，使用新的序号文件，保留已有原件。实际调用 banner、退出码、输出文件校验值及落盘结果由调用方据实补入独立调用记录；本计划不推断或声称这些动作已经完成。

**1．证据边界与实际接手版本**

本次输入包括：

- 当前根 `AGENTS.md`，以 `C:\Albert\project\pi861\AGENTS.md` 为后续派发的规则来源。
- `docs/pi861/HANDOFF_PROMPT_2026-09-22.md`、`REQUIREMENTS.md`、`DEVELOPMENT_PLAN.md`、`HANDOFF.md` 的注入正文。
- 八个工作区的完整 HEAD、状态、index SHA256、dirty 文件 SHA256。
- 上次 Codex 调查旁述及本会话核查摘要。
- 准备证据根目录：`C:\Albert\project\pi861-briefs\continuation-20260923-prepare`。
- 历史集成日志目录：`C:\Albert\project\pi861-briefs\integration-logs`。

`IMPLEMENTATION_PLAN.md`、`INTEGRATION_PLAN.md`、旧 `VERIFICATION.md`、原始模块审核报告及其完整日志的正文并未全部注入。本计划仅引用本次材料已经明确转述的结论，不声称本次读过或重新核实过这些文件。后续接手代理保存其实际路径、版本和摘要，开发者在修改前完整阅读相关源码及适用规则。

八个工作区的注入快照如下。这里的“clean”只表示该次快照没有未提交差异，不表示实现通过验收。

| 工作区 | 分支 | 完整 HEAD | 已提交、暂存及未暂存状态 |
|---|---|---|---|
| `C:\Albert\project\pi861` | `feat/pi861-runtime-v1` | `d28044896a9ccd0bc81fb9a1d0d28eee7e9f86d5` | 快照有 68 项预存 dirty：49 项 index 差异、12 项未暂存修改、7 项未跟踪文件；包含契约、M2、M5 文件级接手成果及共享入口整改，尚非新的集成提交 |
| `C:\Albert\project\pi861-integration-check` | `pi861/integration-check-checkpoint` | `d28044896a9ccd0bc81fb9a1d0d28eee7e9f86d5` | 大量未暂存及未跟踪集成副本；部分文件与主树不同，不能整树覆盖或当作最终成果 |
| `C:\Albert\project\pi861-wt-contracts` | `pi861/p1-contracts` | `a7243e84df97d61d01020df46dbddca9d3d1470f` | clean；契约修复已提交 |
| `C:\Albert\project\pi861-wt-m1` | `pi861/m1-routing` | `6cf376f0e82893078790b6a258f2acf2d384393d` | 已提交路由、计量、共享健康服务；另有 8 项 staged 后续成果 |
| `C:\Albert\project\pi861-wt-m2` | `pi861/m2-skill-mcp` | `6f53f124bd8cee22566276adbe7686b9d6c77b04` | clean；Skill/MCP 及发布证据类型修复已提交 |
| `C:\Albert\project\pi861-wt-m3` | `pi861/m3-memory-pg` | `7ae1aeab3ed254b59eb5b3bb1c96830cb4bf8f79` | clean；逐记录持久化、记忆治理和迁移恢复后续成果已提交 |
| `C:\Albert\project\pi861-wt-m4` | `pi861/m4-goal-multinode` | `bd855c4ef3aec169f2bb0c04e6c4e2a003b0899d` | 8 项未暂存修改、5 项未跟踪文件；包含 Goal 命令、持续队列、租约、Worker 服务后续成果 |
| `C:\Albert\project\pi861-wt-m5` | `pi861/m5-search-acceptance` | `457ccf273670374560d5824625b6178bb7c0493d` | 4 项未暂存修改；主体提交已存在，审核指出的生产安全修复尚未完成 |

上述 index 的 SHA256 是保全校验值，不能在接手时重建旧 index 后冒充原件。

| 工作区简称 | index SHA256 |
|---|---|
| 主树 | `f24b95c544db9cad86d19c3ef9b9831b228fcdb73b57fc88bfe8b0922edf5265` |
| 旧 integration-check | `7c0e8d2b7bda9d00163aeb82b0a36d55e4d35822a9d2d8aaa8a1812385812349` |
| contracts | `5923b9631d2f947c790b58982d9ffe34075e050ec994b150b4ec61a3202b8c5b` |
| M1 | `b274f94c90cd19c5370feed119b8e702eb9a18672325491bbdc851b8285e530f` |
| M2 | `d96999e3fe433dc3d34218a528ce7054dddb40da3ada4922c88cf78d4fded3bc` |
| M3 | `123046128b569cae7b6f3af9bf628945833418d4dc226c022cbc77c26384158b` |
| M4 | `dddce90b96ab13b5aff47dbad0c6a17cbdf99472e66aa07c8d4069ff89b714ac` |
| M5 | `5ab13a0259ca071c39294984d3c7f9fef3b110f7a33edc679ffed250a53181f3` |

关键版本关系和限制：

1. P0 语法及检查链修复提交为 `6501e8ffa2f5556b0bab34de246bac4c1dac68cb`，已在主树 HEAD 的历史中。不得继续把旧 TS1005 描述为当前唯一阻塞。
2. 契约原提交为 `cdaf20dde10266710082222c92e7ff90bc63c75a`，后续修复为 `a7243e84df97d61d01020df46dbddca9d3d1470f`。主树已有修复文件，不代表已经形成包含该修复的集成提交。
3. 本地 `origin/feat/pi861-runtime-v1` 仍是 `e3f07a789b7648f26ec72ce65fa5856046dbd6d3`。没有 fetch，`+2` 只相对该本地远端引用成立。
4. M1 的 8 项 staged 文件必须逐文件接手：`health-service.ts`、`model-runtime.ts`、`model-service.ts`、`stream-bridge.ts`、`routing.ts` 及三个对应测试。历史 71 项局部测试不能替代这些文件接入当前入口后的检查和独立审核。
5. M4 的 13 项 dirty 必须连同未跟踪文件保存，尤其是 `goal-command.ts`、`worker-service.ts` 和对应测试；不能只复制已提交 HEAD。
6. M5 的四项后续差异，以结构化快照为准：`src/search.ts`、`test/acceptance.test.mjs`、`test/search.test.mjs`、`test/web-host.test.mjs`。不能把摘要中的测试类别描述当成另外几份文件已经修改，也不能把 `endpoint` 类型字段当成安全问题已修复。
7. 根 AGENTS 流程章节修改发生于准备过程；68 项是注入的预存 dirty 快照，不能据此推断修改 AGENTS 后的最新 dirty 数量或哈希。准备材料称八树既有 HEAD、index 和原 dirty 文件哈希未变；该结论作为既有证据保留，本次未复核。

历史证据须按以下范围使用：

| 证据 | 可支持的结论 | 不能支持的结论 |
|---|---|---|
| 集成日志 `01`–`16` 及 HANDOFF 表格 | Windows 11 / Node 26.4.0 下部分宿主、事件适配、编译器、进程退出检查曾成功，并保留首次失败 | 最终集成版本通过、Linux 通过、全部生产入口通过 |
| M1 历史 71 项局部用例 | 模块曾执行局部检查 | 当前 staged 文件、主入口、统一预算已独立验收 |
| M3 PostgreSQL 18.6 临时容器日志 | PostgreSQL 18.6 的真实局部协议证据 | PostgreSQL 17 验收 |
| M5 独立审核 | 已确认授权前 DNS、同步抽取超时失效、skip 计通过等问题 | 四项 dirty 已修复这些问题 |
| 标称 100ms、实际约 28.9 秒成功的网页测试 | 超时断言失效的反例 | 超时控制通过 |
| 历史 CI run `35687924923` | 旧版本部分 job 通过、pi-host 失败 | 当前 HEAD 加 dirty 的通过状态 |

首次规划尝试 exit 0，但只有 101 字节的不完整输出，归档为 `codex-attempt-1-incomplete.txt`；第二次 exit 137，`codex-plan-retry1.log` 约 1.74MB，没有最终正文。这两次均不算计划交付。本次为指定的最后一次受控输出尝试，不安排为了重新调查同一范围再次调用 Codex。

调用方必须归档本次脱敏 argv、实际 `gpt-6-astra` / `max` / `read-only` banner、退出码、完整输出和 SHA256。指定命令形式为：

```text
codex exec -m gpt-6-astra -c model_reasoning_effort="max" --sandbox read-only
```

这是调用证据的记录标准，不是本计划要求现在再次执行的命令。

**2．保全、旧执行清理与隔离接手**

准备快照没有确认仍属于上一轮 pi861 的执行，因此没有 kill。PID 12436、4156 的命令行指向其他 `m2-wt` / `mt5` 项目，必须保护；ZCode 宿主及共享 gbrain 未完成归属认定，不得终止。旧任务句柄返回 `No task found` 仅证明句柄不可见。第二次中断后的快照未见当前 pi861 规划残留 node/codex，但不是对以后时刻的保证。

后续接手按顺序执行：

1. 主会话只查询、停止可确认的旧内置任务句柄，不恢复旧 Agent。具体 OS 进程归属核查交给新的接手子代理。
2. 保存八树路径、分支、完整 HEAD、index 原件与哈希、staged patch、unstaged patch、未跟踪文件清单及内容哈希。补丁用二进制安全格式保存，不能把 staged 和 unstaged 合成一份后丢失层次。
3. 日志、审核报告、失败现场、旧 worktree 和旧分支保留。检查点副本只作为输入来源，不成为默认更高优先级版本。
4. 仅在命令行、父子关系、cwd 或日志能证明属于旧 pi861 执行时停止进程。记录 PID、创建时间、父 PID、脱敏证据、动作和复查结果，防止 PID 复用误杀。
5. 归属不明的进程单列。若它可能写入某来源目录，该来源保持只读，相关接手包等待稳定快照；其他独立包继续。
6. 新任务分支全部从 `feat/pi861-runtime-v1` 的记录基线派生，使用新 worktree。接手成果以限定路径的 patch 或文件清单导入，不在旧树重置、stash、clean 或重新暂存。
7. 若同一文件存在多个来源，由唯一文件所有者依据完整差异合成，并记录每段来源；禁止按整个目录“取最新”覆盖。`runtime.ts` 在主树与旧 integration-check 中不同，必须特别处理。
8. 不创建产品提交、不推送。未经新的明确授权，交付采用“完整基线 SHA＋可复现 patch＋文件 SHA256 清单”。临时 Git fixture 的合成提交仅存在于测试专用仓库，不是对产品分支提交的授权。

后续版本统一表示为：

```text
SnapshotID = 基线完整 Git HEAD + 内容清单 SHA256
```

内容清单必须包括修改、新增、删除路径及文件字节摘要、来源 patch 摘要、适用契约版本。它不是 Git commit SHA，报告中不得混称。

准备阶段退出条件仍为：规则章节已落盘、旧执行归属核查已归档、完整计划已保存且调用证据齐全。条件满足后，主会话按本计划派发新的本会话内置子代理。若执行环境仍只有只读权限，文件写入工作等待具备写权限的执行环境；本次输出不扩大沙箱权限。

**3．需求差距映射**

下面的状态用于表达本次输入能够支持的结论：

- **入口待接**：已有模块成果，但当前完整 runtime 尚未使用新路径。
- **部分接入**：入口或服务已存在，仍有明确行为缺口。
- **待补/待证**：材料指出缺口，或没有足够证据确认实现及验收。
- **历史局部**：已有局部检查记录，未取得最终版本的独立审核结论。
- **待授权**：真实模型、真实搜索、业务 MCP 等外部服务验收尚未获准。

所有表格的通过要求都指向后续当前版本证据。表中没有任何一行因类、文件或测试数量而被标为完成。

来源简称：`主` 为主树快照；`契` 为契约修复 HEAD；`M1`–`M5` 为第一节对应 HEAD 加列明 dirty；`H0` 为历史共享入口整改。工作包 ID 在第五节定义，检查组在第七节定义。

| 编号 | 子需求与现有来源 | 差距和状态 | 负责包 | 必须取得的验收 |
|---|---|---|---|---|
| G1 | 可信主体、岗位、scope；契/C1 与主配置 | 跨 Worker 身份与服务边界待证，模型字段不能授予权限 | P1-C、P2-D、P2-W、P3-I | 伪造 tenant/role/scope 全部拒绝；默认 local/main 仅属可信本地模式 |
| G2 | requestId、意图摘要、持久回执；契/C4、M2 operations、M3 | 跨服务原子性及重放冲突待证 | P1-C、P2-D、P2-S | 同 ID 同意图返回同回执，异意图冲突 |
| G3 | CAS、不可变 Skill、计划版本；契及各模块 | 主入口未形成统一版本校验 | P1-C、P2-S、P2-D、P2-G | 过期 revision/version、修改不可变版本均失败 |
| G4 | 取消与未知副作用分离；契、M2、M1 | 断流、重启和实际派发链待接 | P2-B、P2-S、P2-G | AX4、AX9；unknown 不自动重发 |
| G5 | 锁内无外部调用；M3 与 store | DB 实际事务路径待审 | P2-D、P2-M | 模型等待期间另一事务可提交；提交前重验租约与来源 |
| G6 | 严格类型和完整入口覆盖；H0 | 部分历史通过；生产 MJS 曾失败，最终链未证 | P0-H、P0-T、P3-I | K1–K3 全部实际通过，无逃避检查 |
| G7 | 确定性、协议、质量、skip 分层；M5 acceptance | skip 误计通过已确认，待修复 | P1-Q、P3-X、P4-R | 故意缺配置/skip 时不能生成通过报告 |
| G8 | 凭据只由宿主环境解析；契配置 | 子进程继承、日志、远程配置待证 | P1-C、P2-W、P2-D | 模型、产物、日志无秘密；Worker 无 DB 凭据 |

| 编号 | 子需求与现有入口/来源 | 差距和状态 | 负责包 | 必须取得的验收 |
|---|---|---|---|---|
| R1.1 | 多配置身份、版本、能力、窗口、成本、故障域、出站；M1 routing | 主入口仍旧路径，完整配置筛选待接 | P2-A、P3-I | 能力/窗口/授权不合格目标不可选 |
| R1.2 | 接待一次决定 direct/fixed/dynamic；主 direct、compilers | direct 与辅助调用存在绕过风险 | P1-S、P2-A、P3-I | direct 一次完成，不额外启动路由执行器 |
| R1.3 | fixed 异常升级、dynamic 事件重评估；M1 | 入口事件与证据传递待证 | P2-A、P3-I | 固定模式常规阶段不重选；动态只在规定事件调用 |
| R1.4 | 质量优先，价格不代表能力；M1 | 硬过滤和验证证据组合待证 | P2-A | 廉价但能力不足者被拒，批量可验证任务可选低价配置 |
| R1.5 | 阶段、reason、失败、无进展、范围变化；M1 后续代码 | 主 `pi861_model_route` 校验 reason 却未传递 | P2-A、P3-I | 实际宿主调用中记录完整决策输入 |
| R1.6 | 安全升级、条件降级；M1/M2 操作状态 | 未决工具边界未完成组合验收 | P2-A、P2-B | 未决操作阻止不安全切换 |
| R1.7 | failover/failback 四组合及继承、运行时修改；M1 | 主入口及子任务继承待接 | P1-C、P2-A、P3-I | AX3；已在备用时关闭 failover 不强制迁移 |
| R1.8 | 主执行、接待、规划、提炼、编译共用服务；主仍旧 RequestBudget | 明确入口缺口 | P1-S、P2-A、P3-I | 所有调用具有同一根预算下的 attempt 记录 |
| R1.9 | 每次尝试、缓存、费用、探测及未知用量；M1 staged | 历史局部，当前入口未接 | P2-A、P2-D | 失败尝试计量；未知不写零，不释放未确认费用 |

| 编号 | 子需求与现有入口/来源 | 差距和状态 | 负责包 | 必须取得的验收 |
|---|---|---|---|---|
| R2.1 | preferred/active 分离；M1 routing | 运行时与恢复待证 | P2-A | failover 只改 active |
| R2.2 | 开关独立，关闭回切取消专用 probe；M1 health | 四组合及运行中变更未最终验收 | P2-A | 关闭 failback 不再为本任务发回切探测 |
| R2.3 | 分类、连接/首响应/进展/总截止、重试、退避、Retry-After、稳定确认 | M1 有后续成果，真实流式路径待接 | P2-A、P2-B | 分类不绕过拒绝；所有等待有总期限 |
| R2.4 | 取消、迟到响应、确认结果与 unknown；M1/M2 | 跨宿主执行权待证 | P2-B、P2-S | AX4；旧 attempt 无工具执行权 |
| R2.5 | 仅合格备用，无备用则检查点暂停 | M1 内核与 M3 持久化未闭合 | P2-A、P2-D、P3-I | 无授权备用时无额外出站，保存后暂停 |
| R2.6 | 共享故障域健康、单飞、有预算和背压；M1 health | 跨调用/跨 Worker 共享待证 | P2-A、P2-D | 多请求者共享一次 probe，预算归属可追踪 |
| R2.7 | direct/generator/planner 无绕过 | 主旧接线明确不满足 | P1-S、P3-I | 禁止裸 provider 路径；fixture 请求账本一致 |
| R2.8 | route reason 与新证据实际影响判断 | 主参数丢失明确 | P2-A、P3-I | 同初始输入、不同验证证据产生可解释决策 |
| R2.9 | 会话/任务/暂停恢复策略与 generation | M1、M4 成果未组合 | P2-A、P2-G | 新 preferred 不被旧 probe 覆盖；旧响应拒绝 |
| R2.10 | 增量流式、完整工具参数后派发 | 主仍缓冲；M1 stream-bridge staged | P2-B、P3-I | 首段文本在结束前可见；半截工具零派发 |

| 编号 | 子需求与现有入口/来源 | 差距和状态 | 负责包 | 必须取得的验收 |
|---|---|---|---|---|
| R3.1 | Goal/计划/任务/尝试/产物/验收分开，持续小组；M4 | 入口未接；默认 2 并发、2 attempts、100 tasks 待固定 | P2-G | 执行者替换不丢队列，配置边界有断言 |
| R3.2 | 就绪持续补位；M4 scheduler dirty | 历史成果，未独立审核 | P2-G | AX1 的 A.accepted < C.started < B.finished |
| R3.3 | 空闲后所有规定事件唤醒；M4 runner dirty | 待实际事件与重启验证 | P2-G | 无运行任务时追加仍被处理 |
| R3.4 | 依赖、写域、能力、租约、attempt 与拒环 | M4/契 | 共享资源和过期执行权待证 | P1-C、P2-G、P2-W | 冲突任务不并写；旧租约提交失败 |
| R3.5 | 有预算滚动规划、低水位、调整、CAS | M4 有 append，完整链未证 | P1-S、P2-G | 计划追加来自受控 planner；冲突及环被拒 |
| R3.6 | 全树容量覆盖规划/审核/返工/集成/远程 | M4 与 M1 未统一 | P2-A、P2-G | 父等待释放名额，后代仍受根容量和费用限制 |
| R3.7 | 独立检出、版本协议、bundle+SHA256、重验差异 | M4 transport | 两真实 Worker 尚未验收；跨主机待环境 | P2-W、P3-X | 伪造产物声明无效，实际差异越界拒绝 |
| R3.8 | OS 隔离限制凭据/网络/进程/宿主文件 | 当前无 OS 沙箱 | P2-W | 容器隔离负例实际执行；不可用则该项阻塞 |
| R3.9 | 单一集成执行权和旧 Git 进程收敛 | M4 租约 dirty | 跨进程最终验收缺失 | P2-G、P2-W | AX9；旧进程未退出时不得交接同一目录 |
| R3.10 | 失败保留现场并可返工，不锁死其他队列 | M4 | 恢复路径待证 | P2-G、P3-X | 失败任务保留证据，独立任务仍可验证 |
| R3.11 | goal/run/task/attempt 全身份 | M4 workspace dirty | 重用 taskId 场景待证 | P2-W | 不同 Goal 同 taskId 不碰撞 |
| R3.12 | pause/cancel/resume、迟到拒绝、unknown 核对 | M4 | 生命周期组合待证 | P2-G、P2-W | 暂停不派发；恢复更换代际；unknown 不盲重放 |
| R3.13 | 可启动认证 Worker、心跳租约、容量、取消关闭 | M4 worker-service 未跟踪 | 生产入口和双进程未验收 | P2-W、P0-T | 启动/认证/重启/失联/关闭均有实际进程证据 |

| 编号 | 子需求与现有入口/来源 | 差距和状态 | 负责包 | 必须取得的验收 |
|---|---|---|---|---|
| R4.1 | 全包不可变归档，原始隐藏但可显式调用；M2 | 入口和资源边界待验 | P2-S、P3-I | 2MiB/文件、1000文件、16MiB总量及必要资源完整 |
| R4.2 | 全文整合、通用去重、分支/补充、约束保留；M2 | 真实三包行为待证 | P2-S | AX5；安全条件未被压缩丢失 |
| R4.3 | chooseSkillGroup 自动归组 | M2 已有接口；主仍强制 GROUP | P2-S、P3-I | 无 GROUP 安装可自动归组，人工组仅覆盖 |
| R4.4 | 目录/搜索同记录，激活完整约束 | M2 capabilities/skills-host | 宿主上下文待验 | P2-S | 检索与目录一致，激活加载全部必要约束 |
| R4.5 | 候选/验证/发布独立、不可变、任务固定 | M2 发布分层；主旧签名 | P2-S、P3-I | 发布后不可改；运行中版本不漂移 |
| R4.6 | approvedBindings 实际传入编译 | M2 接口已有，共享 compilers 待接 | P1-S、P2-S | 编译输入存在真实批准绑定，伪造绑定拒绝 |
| R4.7 | 稳定资源ID、链接/穿越/二进制/大小/空格路径 | M2 | 硬链接等边界需独立复核 | P2-S | AX5 资源 fixture 与 Windows 路径负例 |
| R4.8 | 安装不运行来源脚本 | M2 安装路径 | 实际包行为待证 | P2-S | 带触发标记脚本安装后标记不存在 |
| R4.9 | 结构/行为/审核/人工接受分层 | M2 修复提交已有 | runtime 旧发布链、验收聚合待修 | P2-S、P1-Q、P3-I | 人工点击不生成自动行为通过 |
| R4.10 | 更新/卸载/重建/回滚/固定版本 | M2 | 实际宿主闭环待证 | P2-S | AX5 全流程及撤权即时生效 |

| 编号 | 子需求与现有入口/来源 | 差距和状态 | 负责包 | 必须取得的验收 |
|---|---|---|---|---|
| R5.1 | 岗位精确到服务、工具、账户、资源、出站 | 契/M2 | 可信身份及每次参数校验待证 | P1-C、P2-S | 伪造只读注解、跨账户、越界资源拒绝 |
| R5.2 | 开放 MCP 有已发布 Skill 入口，发现不激活 | M2 refresh/capabilities | 主链待验 | P2-S、P3-I | refresh 后业务调用和全工具注入均为零 |
| R5.3 | 分支/阶段懒加载，隐藏名直调拒绝 | M2 | 实际宿主注册边界待验 | P2-S | AX6 |
| R5.4 | 激活/恢复/调用重鉴权，schema 变化失效 | M2 | 通知/重连后的旧绑定待证 | P2-S | schemaHash 变化必须重新激活 |
| R5.5 | 服务/账户/资源/schema/激活身份 | M2 修复成果 | 多 Skill 闭包不串权待证 | P2-S | 同名、多账户、重复绑定 AX6 |
| R5.6 | stdio/HTTP/SSE 握手、分页、通知、取消、404、限额 | M2 客户端 | 两种真实传输及异常流待验 | P2-S、P1-Q | K5，SSE 早断为 unknown，不重发写操作 |
| R5.7 | 浏览无写入，撤权影响调用和引用 | M2 | 引用服务与入口组合待证 | P2-S、P2-M | 撤权后已激活工具及旧引用均拒绝 |
| R5.8 | 大结果受控引用、分页、完整性、原权限 | 主 result-store/M5/M2 | 共用存储、跨节点恢复待接 | P2-D、P2-M、P2-S | 分页一致，越权读取不泄漏计数/内容 |
| R5.9 | 稳定操作ID、持久回执、unknown 核对 | M2 operations 已有 | 实际断连和重启链待验 | P2-S、P2-D | 换 toolCallId 不重发同一未决业务意图 |
| R5.10 | Shell/脚本/扩展不能绕过岗位 | M4 guard 与 M2 | OS 隔离当前缺失 | P2-W、P2-S | 默认 Shell 关闭；启用后仍有真实隔离 |
| R5.11 | 可信本地与生产隔离模式明确 | 当前仅有限本地保护 | 生产隔离待实现 | P2-W、P4-D | 能力报告准确，隔离缺失时拒绝生产隔离模式 |
| R5.12 | 每次搜索/读取鉴权及出站控制 | M5 | 授权前 DNS 缺陷已确认 | P2-E | 拒绝请求的 DNS/连接计数均为零 |

| 编号 | 子需求与现有入口/来源 | 差距和状态 | 负责包 | 必须取得的验收 |
|---|---|---|---|---|
| R6.1 | 用途/scope/深度独立，摘要关联源版本 | M3 memory/layered-memory | 主旧存储路径；层次行为待验 | P2-M、P3-I | 短记录可单层，摘要不脱离源 revision |
| R6.2 | 显式 scope，写⊆读，不泄漏未授权存在性 | M3/契 | DB 服务端及图查询待验 | P2-D、P2-M | 未授权查询、摘要、计数、关系无泄漏 |
| R6.3 | 启动/接手/换模型/压缩/换节点直接装配 | M3 成果未接 | 入口缺口 | P2-M、P3-I | AX7，不靠关键词命中固定约束 |
| R6.4 | 事件召回、去重、6000字节默认、delta、撤回 | M3 | 实际数据库分页增量待证 | P2-M、P2-D | 稳定前缀、增量不重复、撤回即时失效 |
| R6.5 | interactive/rpc 候选采集、敏感过滤、截断、不回显 | 主/H0 与 M3 | 单采集器及配置继承待验 | P2-M、P3-I | 关闭生效；刚采集输入不重复注入 |
| R6.6 | tool_execution_end 及时采集，排除自身工具 | H0 修复已有 | 新权威服务未接 | P2-M、P3-I | 工具结束即持久化，非会话结束才保存 |
| R6.7 | 大/敏感结果安全引用与必要状态 | 原路径存在丢弃缺口 | P2-M、P2-D | 大结果不丢执行状态；秘密不进摘要 |
| R6.8 | 持久提炼任务、租约、版本、撤回、事务外调用 | M3 后续成果 | 真实 PG 生命周期待证 | P2-M、P2-D | 租约过期及来源变化时拒绝派生提交 |
| R6.9 | 暂时失败退避、有限重试、人工处理 | M3 已有治理成果 | 当前入口与耗尽恢复待验 | P2-M | AX8；默认最多3次，永久失败可见 |
| R6.10 | user/tool/inference/recall 来源及原文引用 | M3 | 完整来源链写入尚须补齐 | P2-M、P2-D | 转述不增证据，推断不能自升 constraint |
| R6.11 | tombstone、摘要/任务/outbox/索引级撤回 | M3 | DB 递归传播待实现/待证 | P2-D、P2-M | AX7，旧任务和迁移输入不能复活内容 |
| R6.12 | 集成后才发布采用事实；经验走 Skill 候选 | M3/M4/M2 | 验收事件链未闭合 | P2-M、P2-G、P3-I | 分支完成只记录候选，集成验收后升格 |
| R6.13 | 正文/来源/回执/ACL/outbox 原子提交，未知 COMMIT | M3 逐记录成果 | 主仍整块 JSON，权威路径待切换 | P2-D、P3-I | AX8；同 requestId 恢复原提交 |
| R6.14 | 外部 PG、TLS/CA、池/超时、账号分离、备份恢复 | M3；18.6 局部证据 | PG17及运维闭环未验收 | P2-D | K4 的真实17、限制角色和恢复验证 |
| R6.15 | 单一记忆权威及显式迁移 | 主 StateStore 与旧 SQL 并存 | 明确整合缺口 | P2-D、P2-M、P3-I | 切换后只读写一种权威，不双写分叉 |
| R6.16 | 中文/代码符号/路径关键词基线；向量可选 | M3 | 实际查询与索引待验 | P2-D、P2-M | DB 侧检索和分页；无 pgvector 不虚报向量能力 |
| R6.17 | DB 故障无第二真相，待同步未提交，检查点失败暂停 | 主旧路径/M3 | 待同步及关键执行边界待接 | P2-D、P2-M、P2-G | 断库不静默降级；恢复后按同ID核对 |
| R6.18 | 召回/采集/提炼/主动工具独立开关及继承 | 主 runtime-configuration 未跟踪 | 完整继承行为待接 | P1-C、P1-S、P3-I | 全局/项目/岗位/Agent/子Agent矩阵，权限不扩张 |

| 编号 | 子需求与现有入口/来源 | 差距和状态 | 负责包 | 必须取得的验收 |
|---|---|---|---|---|
| R7.1 | 复用 Pi 本地工具，联网与推理模型解耦 | 主/M5 | 最终双宿主待验 | P2-E、P3-I | 原生 grep/find/ls/read 行为保留 |
| R7.2 | Brave 地址、header 凭据、命令及模型工具 | M5 已提交；endpoint 后续类型 | 生产允许地址和 fixture 注入边界待修 | P2-E | 凭据不入 URL；模型不能改 endpoint |
| R7.3 | 来源/时间/范围/截断，错误不伪造零命中 | M5 | 畸形响应与引用链待证 | P2-E | 无配置、缺密钥、错误 JSON 明确失败 |
| R7.4 | 默认关闭、隐私出站、外部内容不可信 | M5 | 授权前 DNS 缺陷明确 | P2-E | 未授权无 DNS；网页指令不能扩权 |
| R7.5 | Abort、15秒默认、5/10条、256KiB、查询限额 | M5 | 实际取消与全部限额待验 | P2-E | 延迟/大响应/取消有墙钟和资源断言 |
| R7.6 | 必需网页正文读取、DNS/IP/重定向/解压/超时 | M5 web-read/web-control | 同步抽取超时无效，生产修复待做 | P2-E | K6，100ms案例不能等28.9秒才成功 |
| R7.7 | 长内容共用受控引用、分页 | 主 result-store/M5 | 持久权限服务待接 | P2-E、P2-M | 撤权后旧网页引用不可读 |

| 编号 | 子需求与现有入口/来源 | 差距和状态 | 负责包 | 必须取得的验收 |
|---|---|---|---|---|
| R8.1 | create/status/edit/pause/resume/budget/accept/clear及取消 | M4 goal-command 未跟踪；主旧命令 | 完整入口未接 | P2-G、P3-I | 动词完整；edit 先暂停；预算不清已用量 |
| R8.2 | runToken、进度、证据；完成申请只进 review | goal/M4 | 队列与验收证据待接 | P2-G | 无证据不得完成，旧 token 不生效 |
| R8.3 | 默认20轮、usedRuns单调、两次无进展暂停 | 基础 goal/M4 | 全树预算及统一入口待证 | P2-G、P2-A | 用户输入/中止/错误不自动重放 |
| R8.4 | 同一个 coordinator，managedGoal 防双循环 | H0/M4 | 新 Goal 接线未完成 | P0-H、P2-G、P3-I | 重复安装只有一个所有者和续跑源 |
| R8.5 | 恢复 active→paused，清 token/report | goal/M4 | 实际进程重启待验 | P2-G | 重启不自动执行，需显式 resume |
| R8.6 | 受控 planner→队列→Worker→检查→集成 | 主 planner/M4 | 辅助预算与真实纵向未闭合 | P1-S、P2-G、P3-I、P3-X | AX10，planner只能选可信model/role/check ID |
| R8.7 | 显示并发未满原因 | M4 | 完整状态汇总待实现/待证 | P2-G | 依赖/预算/资源/审核/权限/故障逐项可解释 |
| R8.8 | 目标合同决定完成，独立审核/人工接受分层 | M4/M5 | skip、审核、完成事件组合待修 | P2-G、P1-Q、P3-X | 重复settle不重复计数；模型done不直接完成 |

真实模型质量、真实 Brave 服务和业务 MCP 账户的验收统一保留“待授权”层。它们不阻止上述确定性、真实本地协议和安全检查；本地 fixture 通过也不会自动把该层改为通过。

AX1–AX10 的组合缺口和验收如下：

| 编号 | 当前差距/来源 | 负责包 | 必须保留的判定 |
|---|---|---|---|
| AX1 | M4 有持续队列后续成果，未完成主入口证明 | P2-G、P3-X | 用屏障记录 `A.accepted < C.started < B.finished`；空闲后追加无需重建 Runner |
| AX2 | 提交、审核、返工、依赖解锁链未闭合 | P2-G、P2-M、P3-X | 仅提交不解锁；失败关联原产物和attempt；验收前不发布采用事实 |
| AX3 | M1 局部历史证据，当前入口未接 | P2-A、P3-X | 四组合、probe预算、连续稳定、首选变更、取消、迟到响应 |
| AX4 | 流式桥与MCP回执未完成真实宿主组合 | P2-B、P2-S、P3-X | 文本/参数中途、派发前后、回执丢失逐点断流；副作用不重复 |
| AX5 | M2主体已有，主仍人工GROUP/旧发布签名 | P2-S、P3-X | 实装两通用Debug与一专项包；自动整合、分支、更新、回滚、版本固定 |
| AX6 | M2权限成果未完成实际宿主全面验收 | P2-S、P3-X | 懒加载、撤权、跨账户、同名、多Skill绑定、schema漂移、隐藏名直调 |
| AX7 | M3成果未进主权威链，DB递归撤回缺口 | P2-D、P2-M、P3-X | 自动记录提炼、跨会话/模型/节点恢复；各类派生读取不泄漏、不复活 |
| AX8 | 18.6局部证据；17和故障恢复不足 | P2-D、P2-M、P3-X | 暂时失败恢复、耗尽可处理、同requestId确认提交、本地未提交不冒充共享 |
| AX9 | M4租约/恢复dirty未完整验收 | P2-G、P2-W、P3-X | 双协调者竞争、重复resume、旧节点恢复、计划CAS、旧Git进程收敛 |
| AX10 | 无最终闭环证据 | P3-I、P3-X、P4-R | 临时真实Git、两个实际Pi Worker、Skill/MCP、PG17、检查、独立审核、受控集成；模型为fixture |

**4．共享接口、唯一所有者与纵向设计**

下列是本计划确定的实现边界。具体 TypeScript 符号可沿用现有类型，但语义不能由主会话临时重新设计。P1-C 负责将其写成冻结的接口清单和契约测试；实现者发现实质冲突时提交差异说明，进入补充规划流程。

| 契约 | 冻结内容 | 提供者及消费者 |
|---|---|---|
| C1 身份与配置 | 可信 principal/tenant/role/scope、模型配置revision、出站边界、goal/run/task/attempt、配置继承；权限上限只可收紧 | P1-C定义；P1-S解析；所有模块消费 |
| C2 生命周期 | generation、attempt执行权、pause/cancel/resume、租约、取消传播、持久唤醒事件 | P1-C定义；M1/M3/M4/MCP消费 |
| C3 预算与容量 | 根预算ID、子预算、每次物理请求预留/结算、未知用量、任务容量、probe单飞费用归属 | P2-A实现调用计量，P2-D提供原子存储，P2-G管理任务容量 |
| C4 持久提交 | requestId+意图hash、expectedRevision/version、回执、unknown commit、outbox、分页/delta、锁内无外部调用 | P2-D唯一存储实现；模块通过接口访问 |
| C5 能力与操作 | Skill版本固定、批准绑定、完整工具身份、稳定业务操作ID、派发claim、unknown与核对 | P2-S实现；模型/Goal/引用服务消费 |
| C6 记忆 | 用途/scope/depth、来源DAG、源revision、派生物、tombstone、装配与采用事件 | P2-M服务、P2-D持久化 |
| C7 产物与验收 | 受控引用、hash、分页/完整性、权限；结构/行为/独立审核/人工接受证据；pass/fail/skip/not-run/blocked分离 | P1-Q证据、P2-M引用、P2-G验收消费 |

冻结产物包括接口版本、源码 SHA256、运行时校验规则、契约测试版本、消费者清单。不得仅以“都使用 C1–C7”替代实际版本锁定。

共享文件和服务的唯一写入所有者：

| 文件或共享面，相对 `extensions/pi861/`，注明者除外 | 唯一所有者 | 其他包协作方式 |
|---|---|---|
| `runtime.ts`、`index.ts`，宿主组合测试 | H：P0-H / P3-I | 模块提供安装端口、接线说明和限定补丁建议，H实际修改 |
| `src/contracts/**`、`test/contracts-*.test.mjs` | C：P1-C | 提交接口变更请求；未冻结前消费者不自行扩签名 |
| `src/live/compilers.ts`、`runtime-configuration.ts`、`deadline.ts`、`line-process.ts`及对应单测 | S：P1-S | 路由/Skill/记忆/Goal只调用冻结端口 |
| `src/routing.ts`、model-runtime/model-service/health-service/stream-bridge及模块测试 | A：P2-A / P2-B | H负责入口；DB负责持久预算接口 |
| `src/capabilities.ts`、skill-repository/skills-host/skill-validation/mcp/operations及模块测试 | K：P2-S | 不直接修改共享compiler、store或runtime |
| `src/live/store.ts`、`src/postgres.ts`、新增存储服务、全部SQL/迁移、PG示例 | D：P2-D | 记忆/Goal/MCP提交事务需求，D实现 |
| `src/memory.ts`、`src/live/layered-memory.ts`、`src/result-store.ts`、记忆/引用服务及模块测试 | M：P2-M | SQL交D；宿主生命周期接线交H |
| `src/goal.ts`、`src/scheduler.ts`、coordinator/project-runner/goal-command及模块测试 | G：P2-G | Worker/Git进程端口交W；持久租约交D |
| pi-rpc/remote-worker/workspace/worker-guard/worker-service、Worker启动入口 | W：P2-W | line-process改动交S；Goal接线交G/H |
| search/web-control/web-read/web-host、新增抽取子进程及网页模块测试 | E：P2-E | 共享引用交M；fixture交Q |
| 根配置、依赖、lock/shrinkwrap、全部tsconfig、扩展package入口声明、CI | T：P0-T | 其他包只报需求，不自行安装或改锁文件 |
| `test/fixtures/**`、acceptance/real-acceptance服务与脚本、跨模块集成测试 | Q：P1-Q / P3-X | 包括接手M5验收代码、M4 pi-worker fixture；模块不再并写 |
| 需求/配置/架构/交接台账、包登记、证据索引 | L：P1-L / P4-D | 接收开发和审核证据后更新，不依据自报完成提升状态 |

所有者是职责，不意味着同时启动十余个代理。实际执行代理按容量逐次领取；更换所有者必须先停止旧写入、保存快照并登记交接。新文件按所属服务归属，不能通过新建另一个共享服务绕过唯一所有权。

必须形成的纵向行为如下。

**模型链：**可信任务上下文进入统一模型服务；接待、主执行、planner、Skill编译、记忆提炼、probe 都在实际请求前预留同一根预算。每个 attempt 独立记录请求、失败、输入/输出/缓存用量及费用，未知字段保留未知并保守占用预算，不能结算为零。共享健康按配置版本、账户、端点和故障域隔离；一个物理 probe 只计一次费用，多消费者不能重复计费或形成探测风暴。

文本可以增量显示，但工具执行必须等参数完整、schema验证、当前权限和attempt执行权全部成立。文本已经显示后发生重试，要保留尝试归属；不得把不同尝试的工具参数拼接。工具已经成功但回执丢失时，先按稳定业务操作ID核对；本地UUID不能保证任意外部系统严格只执行一次。

**Skill/MCP链：**真实包归档 → 全文自动归组 → 带 approvedBindings 编译 → 候选 → 结构检查 → 实际行为证据/独立审核或规定人工接受 → 不可变发布 → 任务固定版本 → 分支激活 → 每次调用重新鉴权。原始包显式调用也受岗位和执行环境约束。发现、目录浏览、编译和激活均不能产生业务写入。

MCP结果、网页结果、记忆证据共用受控引用机制。引用包含原操作、主体、scope、资源和版本信息；读取时校验当前授权，撤权即时影响已存在引用。对不可核对的外部写入，只能报告 unknown 并暂停相应意图。

**记忆/PG链：**逐记录SQL模型成为共享记忆唯一权威；正文、来源、revision、ACL、回执、派生任务和outbox按同一提交协议落盘。控制状态可以保留适合的状态表，但不能再保存另一份可独立修改的完整记忆真相。多节点Worker通过认证服务调用有范围的操作，不能持有共享数据库凭据或通过自填tenant取得权限。

迁移先备份和生成冲突报告，再导入、核对数量/摘要/来源关系，最后显式切换。旧数据保留只读恢复材料，不能长期双写。撤回在数据库中递归传播至来源依赖、摘要、索引、待执行任务和缓存失效事件。外部模型提炼在事务外运行；提交时重新验证来源、tombstone、租约和版本。

**Goal链：**创建目标合同 → 受控planner产生有界计划 → 程序检查依赖/权限/预算/资源 → 持续队列 → Worker产物 → 可信检查 → 独立审核 → 返工或集成 → 目标验收 → 发布项目采用事实。开发依赖可以引用已冻结接口；交付依赖必须等待真实集成验收。模型自报done、分支提交或检查skip都不能解锁强依赖。

集成租约使用持久代际校验，并结合专用集成目录互斥和所属进程监管。租约失效只会阻止回执提交，不能停止已经运行的Git进程，因此交接前还必须确认旧Git进程树退出；不能确认时冻结该集成资源，其他独立开发与审核继续。

**Worker隔离：**本计划选择“可信本地进程模式”和“Linux OCI容器隔离模式”两种明确模式。前者如实标为无OS沙箱；后者要求非root、移除额外capability、不挂载宿主凭据或容器管理socket、限定可写工作目录、进程/CPU/内存限制、默认禁止非批准网络。容器管理由可信宿主完成。非loopback远程服务必须使用经过验证的TLS和强认证。环境不支持容器时，R3.8和生产隔离验收保持阻塞，不能靠worktree替代。

**网页链：**先完成可信权限、查询数据出站和URL语法检查，再做DNS解析；解析结果与实际连接地址绑定，禁止连接时再次落入未经校验的地址。逐次拒绝或重新验证重定向，防护IPv4/IPv6、映射地址、内网和元数据地址。明确批准的内部MCP走独立策略，不能借此开放通用网页内网访问。

正文抽取必须放入可终止的受控子进程或等效可强制终止边界，限制输入、解压量、输出、时间和资源。不能用同一事件循环中的 `Promise.race` 给同步长计算制造假超时。

**5．P0–P4工作包与直接领取说明**

后续工作区根固定为：

```text
C:\Albert\project\pi861-cont-20260923
```

每包使用下表slug，分支和worktree的确切生成规则为：

```text
分支：feat/pi861-runtime-v1-cont-20260923-<slug>
目录：C:\Albert\project\pi861-cont-20260923\<slug>
```

该命名避免把现有 `feat/pi861-runtime-v1` 当作Git分支目录前缀。若路径或分支已存在，保留原件，登记递增序号后创建新的任务位置，不复用未知dirty目录。

| 工作包 | slug | 角色 |
|---|---|---|
| P0-A | `p0-preserve` | 接手、归属与基线保全 |
| P0-H | `p0-host` | H，宿主与完整入口基础 |
| P0-T | `p0-toolchain` | T，检查链/根配置/依赖/CI |
| P1-C | `p1-contracts` | C，共享契约 |
| P1-S | `p1-services` | S，共享编译/配置/进程服务 |
| P1-Q | `p1-fixtures` | Q，fixture和验收运行器 |
| P1-L | `p1-ledger` | L，需求及接手台账 |
| P2-A | `p2-model` | A，模型策略/预算/健康 |
| P2-B | `p2-stream` | A，流式执行权 |
| P2-S | `p2-skill-mcp` | K，Skill/MCP |
| P2-D | `p2-storage` | D，PG/存储服务/迁移 |
| P2-M | `p2-memory` | M，记忆治理/引用 |
| P2-G | `p2-goal` | G，持续调度/Goal/审核 |
| P2-W | `p2-worker` | W，Worker/Git/隔离 |
| P2-E | `p2-web` | E，搜索/网页安全 |
| P3-I | `p3-integration` | H，唯一共享接线 |
| P3-X | `p3-acceptance` | Q，AX和纵向测试 |
| P4-R | `p4-independent-review` | 独立最终审核 |
| P4-D | `p4-delivery` | L，证据和交付文档 |

每个工作包继承以下交付字段，不能省略：

- 输入SnapshotID、适用原需求/计划、完整读取的文件清单。
- 独占路径、接口版本、端口/数据库/临时目录/容器资源登记。
- 实际修改文件和patch/hash；代码包运行根 `npm run check` 及指定检查组。
- 新增或修改的每个测试实际运行，保存首次失败和修复后结果。
- 完整命令、cwd、脱敏环境、退出码、pass/fail/skip/not-run、日志路径。
- 正反例及未通过项；交付依赖状态。
- 独立审核记录。审核者不得参与该包实现或测试修改。
- 代码完成、审核通过、已接入、集成通过分别登记，不能相互替代。

分支使用相同Git基线并不意味着输入相同；每包只导入登记过的必要来源文件和已冻结依赖快照，避免重复叠加主树已有的M2/M5代码。

**P0-A：保全与可复现接手。**目标是得到不破坏旧成果的输入清单。输入为八树快照、当前规则、准备日志；只创建新的证据文件和隔离工作区，不修改产品源码。新增 `workspaces.json`、分层patch、文件摘要、`process-attribution.json`、`handoff-manifest.json`，存于新的证据批次。无开发依赖；交付依赖是计划原文和调用证据落盘。可与P1-L文档整理并行。检查K0；正例是新隔离副本重建后内容匹配，反例是旧index或dirty变化立即报告冲突。独立审核逐树比较保全摘要，确认未恢复旧代理、未误杀其他项目。退出条件是每个可用来源都有可复现快照，归属不明项和受影响包单列。

**P0-H：保留并完成宿主基础。**输入为主树H0的runtime/index及宿主测试，不能退回仅修括号。修改范围是唯一安装、真实事件适配、基础/完整入口组合、关闭顺序；后续接线由同一H角色在P3-I继续。已有文件为 `runtime.ts`、`index.ts`、host与三项host integration测试；必要新增明确的宿主适配文件，归H。开发依赖P0-A；交付依赖P0-T、P1-C、P1-S。可与契约、fixture、网页模块并行。检查K1–K3和安装/进程退出负例。正例为发布与源码宿主均加载且唯一注册；反例为多facade重复加载仍只有一套Goal/模型/采集器。独立审核必须实际启动两类宿主，并核查旧测试改写。退出条件是基础接线和关闭不变量通过；它不代表M1–M4新服务已接入。

**P0-T：覆盖全部生产入口的检查链。**输入为主树根配置、CI、tsconfig差异，以及H0生产MJS首败日志。独占根 `biome.json`、`tsconfig.json`、相关package/lock/shrinkwrap、扩展tsconfig/package入口配置、`.github/workflows/pi861-runtime.yml`。新增生产入口清单，纳入后续Worker/存储服务/抽取子进程。开发依赖P0-A；交付依赖各生产入口最终路径，可增量接收。可与全部模块代码包并行，禁止同时修改其源码。检查K1–K3、K9。正例为每个生产入口均有lint/type/实际启动对应；反例为删掉某入口配置或缺宿主时验收明确失败。依赖变更须固定版本；undici升级先审阅目标发布说明。独立审核验证覆盖清单、无排除降级、完整根日志与格式化差异。退出条件是检查链可强制失败、平台配置真实，最终通过在P3复跑。

**P1-C：固定C1–C7。**输入为契约修复 `a7243…` 及主树契约文件差异。只修改contracts及契约单测，新增接口清单和版本摘要交L归档。开发依赖P0-A；交付依赖独立契约审核。可与P0-H/T、P1-Q并行。检查K1/K2及全部contracts单测。正例为重复相同请求恢复相同回执；反例包括伪造身份、异意图重放、过期租约、超预算、撤权、冲突版本、unknown回执错误变成功。审核复用并重新执行旧失败反例。退出条件是消费者可按已冻结版本编译；任何未确定的跨模块字段必须在本包解决，不能留给主会话设计。

**P1-S：统一共享调用与生命周期服务。**输入为主树compilers/line-process/runtime-configuration后续文件、M1接口、旧deadline实现。独占第四节S范围，新增辅助模型端口适配文件时归S，不另建裸provider客户端。开发依赖P1-C冻结；交付依赖P2-A实际模型服务及H接线。可与各模块内部开发并行。检查K1/K2、compilers、runtime-configuration、line-process测试。正例为classifier/compile/enrich/planner均接受同一执行上下文、预算和signal；反例为未传approvedBindings、无预算、重复wire ID、关闭后新请求均拒绝。审核检查编译器嵌套输出校验、进程树真实退出及存储锁外调用。退出条件是共享端口固定、消费者无需改共享文件即可开发。

**P1-Q：可信fixture与验收证据。**输入为主树/M5 acceptance、real-acceptance、run-acceptance和fixtures，接手M4的pi-worker fixture。只修改Q范围；新增 `test/fixtures/mcp-http-server.mjs`、PG17/双Worker/故障代理fixture、验收manifest schema和证据报告器。开发依赖P0-A、C7冻结；交付依赖相关模块提供真实入口。可与P0及模块开发并行。检查K1/K2、acceptance/real-acceptance测试。正例为真实执行产生带代码摘要的证据；反例为skip、缺配置、测试未启动、错误版本PG、只有一个Worker时不能报pass。真实服务脚本默认关闭，普通local profile不能调用它们。独立审核故意制造假绿输入验证报告器。退出条件是fixture和证据机制可用，不把业务场景尚未运行记为通过。

**P1-L：修正台账与派发登记。**输入为本计划、旧五份台账和P0-A清单。只写文档/登记，保留旧历史段和VERIFICATION。开发无产品接口依赖；交付依赖P0-A事实清单。可立即开展内容准备。新增本轮需求状态和所有权登记；纠正O2/O4，将历史统计明确标为历史。检查K0的引用一致性，不因纯文档改动运行无关产品测试。正例是条目绑定SnapshotID；反例是旧日志被标为当前通过时拒绝更新。独立审核检查R/G/AX无遗漏、授权未扩张。退出条件是所有工作包可直接领取且状态可追踪。

**P2-A：模型策略、计量与健康。**输入为M1 HEAD加全部8项staged、C1–C4和共享服务端口；沿用已有成果。独占routing/model-runtime/model-service/health-service及对应测试，stream桥留给同角色P2-B顺序处理。开发依赖P1-C、P1-S接口；交付依赖P2-D预算原子持久化、P3-I主辅接线。可与Skill、PG、网页、Goal内部工作并行。检查K1/K2和routing/live-models/model-service测试。正例覆盖一次接待、证据路由、备用回切、每attempt计量；反例覆盖四组合、取消/拒绝不绕过、无备用暂停、未知usage、probe风暴和旧preferred恢复。独立审核从实际调用账本核对所有请求，不接受只检查计数器内部值。退出条件是模块AX3通过且没有辅助裸连；全入口通过另由P3确认。

**P2-B：增量流式与工具执行权。**输入为M1 staged stream-bridge及P2-A冻结结果。独占stream-bridge及对应模型文件的必要改动；同A角色领取，P2-A未交接前不并写。开发依赖P2-A、C2/C5；交付依赖P2-S操作回执、P3-I宿主provider接线。可与其他所有非A文件包并行。检查K1/K2、stream-bridge测试及AX4局部。正例为流未结束即可观察文本；反例在文本、参数、派发前后、取消、旧响应到达时注入故障，半截参数零调用，unknown进入核对。审核运行真实宿主provider fixture并计数实际副作用。退出条件是流式体验和执行安全同时通过，不允许恢复缓冲wrapper冒充解决。

**P2-S：Skill与MCP完整链。**输入为M2 `6f53…`、主树已有文件、C1–C7、P1-S编译端口。独占K范围及模块测试；新增绑定/协议适配文件仍归K。开发依赖P1-C、P1-S；交付依赖P2-A、P2-D/M引用与回执、P2-W隔离、P3-I。可与PG、记忆、Goal、网页并行。检查K1/K2、capabilities/live-skills/live-skill-validation/live-mcp/live-operations，K5及AX5/6。正例为三包自动整合和两传输实际调用；反例包括链接穿越、安装脚本、错误绑定、同名串权、撤权、schema漂移、SSE早断和重复业务意图。协议库以实际锁定依赖类型为准，必要依赖申请交T，不猜API或并行重写解析器。独立审核从实际宿主命令进入链路，并确认浏览写入次数为零。退出条件是模块行为、协议和权限通过，主入口接入单列。

**P2-D：唯一存储、PG17与可信服务。**输入为M3 `7ae1…`、契约修复、现有SQL和主StateStore路径。独占D范围；新增 `src/live/storage-service.ts`、`scripts/storage-service.mjs`、版本化SQL迁移和 `test/storage-service.integration.mjs`、`test/postgres-recovery.integration.mjs`。开发依赖P1-C冻结；交付依赖P2-M/G/S真实消费及P3-I。可与模型、Skill、Goal、网页开发并行。修改覆盖逐记录权威、细粒度请求/回执/outbox、租约/预算事务、来源递归撤回、服务端身份映射、TLS/账号分离、旧数据迁移和备份恢复。检查K1/K2/K4。正例为PG17并发CAS和回执恢复；反例为跨scope、异意图重放、失联、COMMIT后断线、旧来源复活、运行角色迁移、错误CA。独立审核用真实17受限账户执行并验证备份恢复后的正文/回执/来源摘要。退出条件是单一权威与服务边界通过，18.6日志仅附历史。

**P2-M：自动记忆、治理与受控引用。**输入为M3治理代码、主result-store及P2-D接口。独占M范围及记忆/result-store测试；新增来源治理或引用服务文件归M。开发依赖P1-C、P1-S、P2-D接口冻结；不必等待PG全部实现即可写契约消费者。交付依赖P2-A提炼服务、P2-D实际PG、P3-I生命周期。可与Goal、Worker、网页并行。检查K1/K2、memory/live-memory/result-store及K4关联用例。正例为各生命周期装配、及时工具采集、暂时提炼失败恢复；反例为私有摘要/图边泄漏、recall自我增证据、撤回后旧任务提交、超大结果静默丢失、DB失败生成本地权威。审核跨会话/模型/节点执行AX7/8，确认只有一套采集器。退出条件是自动读写、来源、撤回、引用和故障边界通过。

**P2-G：持续Goal队列、审核与单一集成权。**输入为M4 HEAD及G所属dirty、C1–C7、P1-Splanner端口。独占G范围及Goal/scheduler/project模块测试；新增审核/返工状态测试。开发依赖P1-C、P1-S和D/W接口冻结；交付依赖P2-A/D/M/W、P3-I。可与Worker传输开发并行，双方不修改对方文件。检查K1/K2、goal/scheduler/live-project/goal-command/goal-recovery和AX1/2/9。正例为持续补位、空闲唤醒、低水位滚动计划、审核返工后验收；反例为循环依赖、计划CAS冲突、模型任意check命令、预算穿透、提交即done、双resume和旧租约集成。审核必须观察实际状态事件和资源锁，不只读任务文本。退出条件是持续调度和完成合同成立；两个Worker和最终Git集成在P3再验。

**P2-W：真实Worker、产物运输及隔离。**输入为M4的W所属dirty、worker-service未跟踪文件、H0进程退出成果。独占W范围；新增 `scripts/worker-service.mjs`、容器执行适配和 `test/worker-pair.integration.mjs`、`test/worker-isolation.integration.mjs`。共享fixture由Q提供。开发依赖C1/C2/C4/C7、P1-S进程接口；交付依赖P2-G/D、P0-T生产入口覆盖及实际容器环境。可与G/Skill/记忆/网页并行。检查K1–K3相关入口、K7。正例为两个真实服务分别运行实际Pi、独立检出并传输校验产物；反例为伪造身份/能力、越界diff、旧租约、错误token、心跳丢失、Git未退出交接、读取宿主凭据和未批准网络。审核记录两个PID或容器ID、启动配置、实际Pi版本和进程树退出。退出条件分别报告可信本地和容器隔离，不把同机写成跨主机。

**P2-E：搜索与网页安全修复。**输入为M5 HEAD及其四项dirty，旧审核反例必须保留。独占E范围及search/web-host/web-read/web-security测试；新增 `src/live/web-extract-process.ts` 或等效受控抽取入口，并纳入T检查。开发依赖C1/C2/C7、Q提供HTTP fixture；交付依赖M引用服务和H接线。可在模型/PG未完成时独立推进。检查K1/K2/K6。正例为Brave兼容本地fixture搜索、正文提取和分页；反例为授权拒绝前DNS、DNS重绑定、私网/元数据、重定向、解压炸弹、同步抽取阻塞、撤权后引用读取。100ms预算使用独立墙钟监测，超时后应在规定收敛余量内终止抽取并返回超时，不能等待约28.9秒成功。审核独立运行旧失败输入并确认生产修复实际存在。退出条件是三个已知缺陷对应的当前版本反例均通过；skip修复由Q交付。

**P3-I：按就绪事件滚动共享接线。**输入为审核通过的模块快照及H基础代码。独占runtime/index及宿主组合测试；不代替模块所有者修其内部文件。开发依赖相应模块端口与审核结果，不等待所有模块齐备才开始；最终交付依赖全部必需模块。按顺序接入统一模型/预算、Skill自动归组与新发布签名、PG记忆/引用、Goal/Worker和web。每轮记录新增模块SnapshotID和组合SnapshotID。检查K1–K3及对应AX子集；最终运行K8。正例为命令、工具、生命周期均实际进入新服务；反例为旧RequestBudget、缓冲wrapper、旧发布签名、整块记忆JSON、第二Goal循环仍被调用时失败。由未参与接线的代理独立审核，模块审核不能替代。退出条件是全部真实纵向入口闭合。

**P3-X：AX1–AX10和本地闭环。**输入为P3-I组合快照、Q fixture和各模块审核。独占跨模块测试，新增 `test/goal-e2e.integration.mjs`、`test/ax-runtime.integration.mjs` 和必要场景文件，生产修复退回原所有者。开发可在接口冻结后准备场景；交付依赖实际模块接入。可与下一轮独立模块修复并行，测试目标快照保持只读稳定。检查K4–K8。正例为真实临时Git/PG17/MCP/两个Pi Worker闭环；反例逐项执行AX，另加网页/权限故障。审核由未修改这些测试的代理从独立快照复跑，确保断言不是只比较fixture自报事件。退出条件是所有必需本地场景实际运行且无skip，失败现场和复核证据齐全。

**P4-R：最终独立审核。**输入为最终组合SnapshotID、全部差异、完整检查日志和原R/G/AX。本包不修产品代码和测试；使用新的审核worktree，只有审核证据输出。开发依赖最终候选冻结；交付依赖所有失败已由所有者修复并复核。独立性要求覆盖被审核实现、测试和共享接线，最终审核代理不得先参与这些开发。检查K1–K8，在独立环境运行计划要求的安全及本地fixture；K9平台缺失据实阻塞相应声明。正例为从基线加patch重现相同内容和行为；反例为缺失文件、旧日志、skip、错误PG版本或单Worker均使审核失败。退出条件是必需本地范围通过，外部授权及环境缺口明确隔离。

**P4-D：证据绑定与交付。**输入为P4-R结论、最终SnapshotID、命令清单及限制。独占L文档，不修改旧VERIFICATION原件；新增 `VERIFICATION_2026-09-23_CONTINUATION.md` 或新的唯一序号文件，更新五份台账当前段。开发可持续收集；交付依赖P4-R。检查内容摘要、链接、命令可复现性和需求映射，不虚构CI运行。正例为读者按记录重建相同快照；反例为“文档更新日期”被当作代码通过日期时拒绝交付。由文档独立审核者检查结论与证据。退出条件是完成/未完成/待授权/环境阻塞均有下一步，无产品完成误报。

**6．首批就绪与事件驱动派发**

本会话显示的并发上限为4个活动代理，包含主会话，因此最多同时有3个活动子代理。主会话只派发、监控、转达和更新调度视图，不承担产品分析、代码、测试修改或审核。职责多于并发槽时顺序复用槽位，不虚报同时运行。

有待审核成果时，子代理容量按“最多2个开发/检查＋至少1个独立审核”分配。没有审核积压时，第3个槽可执行独立开发、接手或fixture准备；出现审核就绪事件后优先释放给审核。全仓检查本身占资源，不能以“只是检查”为由无限并发。

首批安排：

| 触发条件 | 立即领取 | 同时允许 | 暂不领取及原因 |
|---|---|---|---|
| 计划已落盘、调用证据完整、执行环境允许 | P0-A；P1-L资料整理 | 两者文件/资源隔离 | 产品写入等待来源保全和所有权登记 |
| P0-A交付第一个可复现完整来源 | 独立审核P0-A；P1-C；P0-T | 3个子代理以内 | P0-H等待空闲槽；不是等待整批完成 |
| P0-A审核通过且有槽 | P0-H或P1-Q | 与契约/工具链并行 | P2依赖契约冻结 |
| C1/C2/C7冻结 | P2-E、P1-Q | 可先修网页明确缺陷 | 不因M1/M3未完成而等待 |
| 全部C1–C7及S端口冻结 | P2-A、P2-D优先；随后P2-S/P2-G/P2-W | 根据资源和审核容量选择 | 同一共享文件或同一DB实例竞争者不能并行 |

以后按事件领取，不设置“整批完成再开始下一批”的屏障：

| 事件 | 下一个动作 |
|---|---|
| 任一包完成实现和规定检查 | 分配未参与该包的审核者；开发槽领取最高优先级无冲突就绪包 |
| P2-A审核通过 | A角色接P2-B；H可接统一模型服务，S验证辅助调用接线 |
| P2-D接口冻结 | P2-M及G/K存储消费者开始；PG实现和消费者可并行 |
| P2-D实际服务审核通过 | 执行记忆/MCP回执/Goal租约真实适配，替换开发替身 |
| P2-S审核通过 | H接自动归组、发布和懒加载；Q开始宿主AX5/6 |
| P2-G或P2-W先完成 | 先独立审核，后领取其他无冲突包；两者均就绪立即做双Worker验收 |
| P2-E审核通过 | H接完整网页链，Q执行入口授权前DNS与超时负例 |
| 任一共享接线轮完成 | 独立接线审核；Q在该固定组合快照运行对应AX |
| 审核失败 | 原所有者领取修复；审核者保留独立性并复核；其他安全包继续 |
| 依赖解除、节点恢复、权限补齐 | 重新计算就绪集合，立即补位 |
| 审核积压 | 降低开发占槽，优先清审核；不继续堆积未审产物 |
| 无可领取工作 | 明确显示依赖、预算、资源、审核、权限、环境、故障或无合格任务的原因 |

就绪谓词必须同时满足：开发依赖已满足、共享接口已冻结、文件和资源已登记、所需授权存在、环境可执行、容量可用。交付依赖未满足的包只能标“模块审核通过、待集成”，不能标“需求完成”。

每次派发必须附本计划、当前根AGENTS路径、原任务书路径、包ID、SnapshotID、来源patch、所有权和资源清单、检查组、正反例、交付模板及独立性约束。主会话不再要求子代理重新决定项目架构。

**7．后续验收命令、cwd、环境与证据**

所有命令在新的隔离worktree执行。证据根使用新的目录，例如：

```text
C:\Albert\project\pi861-briefs\continuation-20260923-execution\<包ID>\<SnapshotID短标识>\<attempt>
```

这只是规划路径，不表示目录已经存在。每次命令记录完整argv、cwd、开始/结束时间、Node/npm/OS、脱敏环境键、输入SnapshotID、退出码、完整stdout/stderr及文件摘要。首次失败文件不可覆盖。

测试进程由可信运行器构造环境白名单，不继承真实模型、Brave、业务MCP和业务DB凭据；不修改持久配置。fixture的短期令牌仅存在于测试子进程环境，不写日志。共享测试资源使用操作系统分配的空闲端口、每次唯一数据库/目录/容器名称，登记实际值。

| 检查组 | cwd与后续命令 | 环境和通过要求 |
|---|---|---|
| K0 基线与保全 | 各旧树只读：`git rev-parse HEAD`、`git status --porcelain=v2 --branch --untracked-files=all`、`git diff --binary`、`git diff --cached --binary`；新副本比对文件SHA256 | 不改变旧index；保存staged/unstaged/未跟踪层次；调用方保存本次完整计划及banner |
| K1 根检查 | 对应隔离worktree根：`npm run check` | 完整输出，不tail；检查前后比较差异，自动格式化仅由文件所有者接收；errors/warnings/infos全部解决 |
| K2 扩展类型与单测 | `extensions/pi861`：下方列明tsc及指定测试命令 | 无真实凭据；所有修改测试实际执行；不运行全量Vitest |
| K3 发布/源码宿主 | `extensions/pi861`：两种环境分别运行宿主命令 | 两类类型与实际宿主分别通过；缺配置失败，不能skip |
| K4 PG17与恢复 | `extensions/pi861`：PG集成命令 | 真正PostgreSQL17、独立临时库、受限角色、迁移/备份恢复/TLS/断连；18.6不能替代 |
| K5 MCP真实协议 | `extensions/pi861`：MCP单测及传输集成 | 真实stdio子进程和本地HTTP/SSE服务；每种协议有独立结果 |
| K6 搜索/网页 | `extensions/pi861`：search/web-*指定测试 | 本地HTTP/DNS/抽取故障fixture；无真实Brave；实际墙钟、字节和进程退出断言 |
| K7 双Worker/隔离 | `extensions/pi861`：Worker集成命令 | 至少两个实际Worker、独立检出、真实Pi、认证/租约/故障；容器保护单独实测 |
| K8 AX/最终闭环 | `extensions/pi861`：AX和Goal E2E命令 | 最终组合SnapshotID，AX1–AX10各自明确pass，无skip；同时重跑K1–K7要求链 |
| K9 平台/CI/依赖 | 各隔离环境根；依赖准备与针对性回归 | Windows/Linux分别记录；CI未触发就写未运行；不为触发CI而擅自push |
| K10 外部真实服务 | 默认关闭脚本，只检查拒绝默认运行与配置校验 | 没有新授权不得调用真实模型/搜索/业务MCP；该组不算本地通过证据 |

依赖准备命令仅在需要时执行：

```text
npm ci --ignore-scripts
npm --prefix packages/ai run generate-models
```

本地补齐依赖使用 `npm install --ignore-scripts`；依赖元数据实际变化后由T运行：

```text
npm install --package-lock-only --ignore-scripts
node scripts/generate-coding-agent-shrinkwrap.mjs --check
```

需要重建shrinkwrap时按仓库脚本执行，不擅自新增生命周期allowlist。模型目录只能由生成器生成，记录来源和生成摘要；获取上游元数据受网络限制时记录该具体阻塞，不能手改生成文件。检查环境以实际支持的Node版本为准，至少满足历史要求的 `>=22.19.0`；历史Node26.4.0不代表后续环境已经相同。

K2基本命令，cwd为 `extensions/pi861`：

```text
node ../../node_modules/typescript/bin/tsc --noEmit --project tsconfig.json
node ../../node_modules/typescript/bin/tsc --noEmit --project tsconfig.entries.json
node --experimental-strip-types --test test/host.test.mjs test/line-process.test.mjs test/compilers.test.mjs test/runtime-configuration.test.mjs
```

各包运行其第五节列出的测试文件，例如：

```text
node --experimental-strip-types --test test/routing.test.mjs test/live-models.test.mjs test/model-service.test.mjs test/stream-bridge.test.mjs
node --experimental-strip-types --test test/capabilities.test.mjs test/live-skills.test.mjs test/live-skill-validation.test.mjs test/live-mcp.test.mjs test/live-operations.test.mjs
node --experimental-strip-types --test test/memory.test.mjs test/live-memory.test.mjs test/postgres.test.mjs test/result-store.test.mjs
node --experimental-strip-types --test test/goal.test.mjs test/scheduler.test.mjs test/live-project.test.mjs test/goal-command.test.mjs test/goal-recovery.test.mjs test/worker-service.test.mjs
node --experimental-strip-types --test test/search.test.mjs test/web-host.test.mjs test/web-read.test.mjs test/web-security.test.mjs
node --experimental-strip-types --test test/acceptance.test.mjs test/real-acceptance.test.mjs
```

最终扩展确定性集合为 `test/*.test.mjs`。运行器先枚举并保存实际文件清单，再作为独立argv传给Node，避免Windows shell通配符差异；必须排除隐式外部服务调用。`real-acceptance.test.mjs`只能测试默认关闭和配置/预算门禁，不能启动真实服务脚本。

K3的类型命令：

```text
node ../../node_modules/typescript/bin/tsc --noEmit --project tsconfig.host.json
node ../../node_modules/typescript/bin/tsc --noEmit --project tsconfig.host-source.json
```

发布宿主依赖安装在独立宿主目录，从已经检查的包清单取得真实包名并精确锁定Pi 0.86.1，不猜包名或CLI路径。记录发布包完整版本、lock摘要、实际CLI绝对路径及解析目录。

发布宿主测试子进程设置：

```text
PI861_REQUIRE_HOST_TESTS=1
PI861_TEST_PI_CLI=<已核实的隔离发布宿主CLI绝对路径>
PI861_TEST_TIMEOUT_MS=180000
```

源码宿主测试子进程设置：

```text
PI861_REQUIRE_HOST_TESTS=1
PI861_TEST_SOURCE_HOST=1
PI861_TEST_TIMEOUT_MS=180000
```

两种环境分别运行：

```text
node --experimental-strip-types --test test/pi-host.integration.mjs test/runtime-host.integration.mjs
node ../../node_modules/tsx/dist/cli.mjs --tsconfig ../../tsconfig.json --test test/host-install.integration.mjs
```

源码宿主从当前被验收工作树经已核实的tsx启动方式加载，记录源码SnapshotID与实际启动argv。不能用发布宿主跑两遍冒充源码验证；也不能只有源码类型检查而没有源码宿主实际进程。

K4后续命令：

```text
node --experimental-strip-types --test test/postgres.integration.mjs test/postgres-recovery.integration.mjs test/storage-service.integration.mjs
```

后两项由P2-D新增，缺失时验收失败。PG fixture由Q的受控脚本建立并输出连接manifest；连接串通过manifest指定的测试专用环境变量传入。运行前查询并记录 `server_version_num`，要求 `170000 <= version < 180000`。运行账号不是superuser、不是BYPASSRLS，不能迁移；迁移账号与运行账号分离。TLS测试包含可信CA成功、错误CA和主机名不匹配失败。

必须执行：

- 空库迁移及旧JSON/逐记录数据迁移，冲突不自动覆盖。
- 并发CAS、相同requestId重放、不同意图冲突。
- 提交成功后切断响应，以原requestId查明结果。
- 递归撤回、来源链授权、摘要/计数/图边不泄漏。
- 数据库不可用时检查点暂停、本地待同步保持未提交。
- 备份恢复到另一临时数据库，核对正文、revision、来源、回执、tombstone和outbox。
- 服务端身份绑定，Worker自填scope不能扩权。

K5后续命令：

```text
node --experimental-strip-types --test test/live-mcp.test.mjs test/live-operations.test.mjs test/mcp-transports.integration.mjs
```

`mcp-transports.integration.mjs`由Q新增，实际启动stdio和HTTP/SSE fixture。覆盖握手版本、分页、通知、schema漂移、取消、超时、404会话重建、响应大小、SSE早断、成功回执丢失。read操作可按明确策略恢复；未知写操作不因重连自动重发。

K6后续命令：

```text
node --experimental-strip-types --test test/search.test.mjs test/web-read.test.mjs test/web-host.test.mjs test/web-security.test.mjs
```

最低断言包括：

- 授权失败时DNS、socket和HTTP请求次数全部为零。
- 解析允许地址后发生重绑定，实际连接仍不能访问禁止地址。
- loopback/private/link-local/metadata、IPv6映射及禁止端口被拒。
- 每次重定向重新验证或明确拒绝。
- 压缩输入和解压输出各有限额。
- 100ms超时用例在测试合同规定的收敛余量内返回超时；记录实际elapsed，抽取子进程确认退出。
- 父进程仍能响应取消及其他请求，CPU阻塞不能藏在“最终成功”里。
- 外部正文不获得指令或权限地位。

K7后续命令：

```text
node --experimental-strip-types --test test/worker-pair.integration.mjs test/worker-isolation.integration.mjs
```

测试启动两个 `scripts/worker-service.mjs` 实际入口；每个入口使用独立绝对路径配置、认证token、端口、agent数据目录和Git检出，并通过pi-rpc启动真实Pi宿主，模型为本地确定性provider。不能用两个普通HTTP假对象代替两个Worker服务。

记录两个Worker的PID/容器ID、父子关系、实际Pi CLI、任务身份、心跳与租约、产物bundle和SHA256。故障注入包含Worker退出、协调者重启、迟到产物、取消、Git子进程不及时退出、认证失败和容量不足。容器隔离检查不得skip后计通过；缺容器环境时单独阻塞R3.8。

K8后续命令：

```text
node --experimental-strip-types --test test/ax-runtime.integration.mjs test/goal-e2e.integration.mjs
```

AX10测试合同固定为：

1. 创建测试专用真实Git仓库和合成需求，从实际完整runtime `/goal`入口开始。
2. 本地确定性provider驱动真实Pi planner，产生A、慢B和依赖A的C，不能绕开真实规划调用端口直接注入最终done状态。
3. 两个真实Pi Worker分别领取任务，真实安装并激活测试Skill，通过stdio及HTTP/SSE MCP执行受限操作。
4. 工具回执、记忆、来源、预算和计划事件写入真实临时PG17。
5. 产物进入可信检查和独立审核；至少注入一次审核失败并形成返工，不解锁强依赖。
6. A验收后C在B结束前开始；空闲追加仍唤醒；重复resume不启动第二集成执行者。
7. 在唯一集成目录应用已验证产物，运行真实仓库检查，验证实际文件/程序行为。
8. 目标合同满足后发布采用事实，关闭所属Worker/子进程并保存全部证据。
9. 报告明确“实际宿主与本地协议闭环，模型为fixture”，不声称真实模型智能质量已验收。

K9包括Windows与Linux各自的空格路径、链接、大小写、文件锁、父子进程退出和宿主启动。没有Linux执行环境就写未验证，不从CI配置推断已通过。需要全仓非e2e回归时仅使用根 `./test.sh`；具体包测试按AGENTS指定入口执行。

任何阶段均不执行 `npm run build`、`npm test` 或全量Vitest。CI发布、push和外部服务调用不在这些检查命令的隐含授权内。

P1-Q应将现有 `scripts/run-acceptance.mjs` 固定为可信运行器。计划新增CLI合同为：

```text
node scripts/run-acceptance.mjs --suite <unit|hosts|pg17|mcp|web|workers|ax|local> --manifest <绝对路径> --evidence <绝对路径>
```

该接口是待实现合同，不能声称现有脚本已经支持。运行器只从可信清单选命令，记录底层真实命令和结果，不能接受模型生成的任意shell。缺必需测试、skip、版本不符或超时均不能聚合为pass。真实服务使用独立显式授权入口，不能被 `local` 套件间接触发。

**8．失败恢复、独立审核与阻断处理**

失败发生后，先记录现场，再修复，不覆盖原始日志：

1. 保存失败SnapshotID、命令、cwd、脱敏环境、退出码、请求/操作/attempt/租约ID、进程与资源清单。
2. 保留失败工作区、数据库快照或fixture数据、原始产物和输出；不得用reset、stash、clean或force操作制造干净现场。
3. 按所有权退回对应开发者。审核者可以补充独立观察和复现证据，但不直接修改被审核实现或测试。
4. 修复后生成新SnapshotID，运行受影响的规定检查，再由独立审核者复核；最终集成重跑必需链。
5. 旧失败、旧通过、新通过分别存档，不能用新文件覆盖旧 `VERIFICATION.md` 或首次失败日志。
6. 若问题可在既定接口与验收内修复，直接继续；实质改变需求、共享接口或验收标准时，保存具体冲突及候选差异，由本会话子代理按指定模型/等级进行补充只读规划。不得擅自换模型、端点、凭据或扩大权限。
7. 接手或集成出现非本包文件冲突时，停止该应用操作，交文件所有者处理；不覆盖其他会话index或dirty。
8. 数据库迁移失败使用保留的备份恢复到新测试库核对，不能直接对业务库试错。
9. 未知副作用保持unknown，核对后才决定是否允许新意图；不通过“重新生成toolCallId”绕过。
10. 租约失效但旧Git/工具进程仍运行时不交接同一资源；保留现场并限制阻塞范围。

以下事项单列，不能阻止其他已就绪的本地工作：

| 阻断 | 受影响范围 | 解除条件 |
|---|---|---|
| 真实模型/搜索/业务MCP未授权 | 外部服务与真实质量验收 | 明确服务、账户、数据范围、费用/请求上限及清理授权 |
| 无跨主机节点 | 跨主机部署验证 | 提供获准主机、独立检出、认证与网络范围；同机结果仍独立有效 |
| 无PG17运行条件 | K4及依赖真实17的AX7/8/10 | 可用的测试专用PG17；18.6只作补充 |
| 无Linux/OCI隔离条件 | Linux行为、R3.8生产隔离 | 可用执行环境；不能降级宣称沙箱通过 |
| 只读执行环境 | 文件修改、worktree创建、开发检查的写入部分 | 后续执行环境具备相应权限；本次计划不改变权限 |
| 依赖/镜像获取受限 | 具体安装或fixture准备 | 使用已审查缓存或获准网络；不改持久端点绕过 |
| 产品commit/push未授权 | 产品仓库提交、远端CI触发 | 新的明确授权；此前可交付patch、摘要和本地证据 |
| 旧进程归属不明且可能写入来源 | 对应来源接手 | 归属查明或得到稳定独立快照；不全局kill |

真实服务脚本即使默认关闭，也需被审核：凭据变量名、预算上限、允许数据、目标地址、清理方法和拒绝默认执行行为必须完整。未授权状态不能伪装为测试skip后整体通过。

**9．最终交付与停止条件**

最终交付必须同时包含：

- 本计划原文、调用日志、实际banner、退出码、输出SHA256及所有历史失败规划原件。
- 八树起始版本、index/dirty保全清单和旧执行归属记录；明确没有证据支持“旧执行全部清空”的部分。
- 各工作包输入/输出SnapshotID、完整patch和文件摘要、分支/worktree、所有权与资源登记。
- R1–R8、G1–G8、AX1–AX10逐项入口、测试、实际环境、日志和独立审核结论。
- 最终根检查、扩展类型、生产入口类型、发布宿主类型及运行、源码宿主类型及运行的完整证据。
- PG17、真实stdio与HTTP/SSE MCP、两个实际Worker、网页安全、最小Goal闭环及失败恢复证据。
- 用户实际启动完整runtime、存储服务和Worker的命令及脱敏配置示例；发布宿主与源码宿主分别说明。
- 升级、迁移、暂停、取消、停机、恢复和回滚方法；所有未实现、未执行、skip、待授权和环境阻塞单列。
- 第三方依赖/复制代码的锁定版本、来源、许可证和修改记录；原理借鉴与代码引入分别说明。
- 产品仓库最终HEAD、未提交差异、是否有新提交/推送的准确状态。若没有新提交，用基线SHA＋patch＋manifest交付，不编造最终提交SHA。
- 最后只有文档变化时，列出实际被测试的代码SnapshotID和后续纯文档差异。

“本地续开发范围完成”要求：所有必需实现接入真实入口，规定本地检查和AX1–AX10在同一最终组合版本实际通过，共享接线与最终成果取得独立审核。网页正文读取、源码宿主、PG17、实际Worker和安全反例不得转成可选项。pgvector未实现可以明确列为可选未实现，不影响关键词基线交付。

真实模型质量、真实搜索、业务MCP、跨主机及特定平台结论必须与实际授权和环境证据匹配。存在这些缺口时可以报告已通过的本地范围，但不得声称全场景生产就绪。

只要存在满足依赖、所有权、授权和容量的就绪工作包，就继续派发。确实无法继续时，交付已保存的快照、具体阻断、受影响需求和下一条可执行动作；不能把计划完成、模块测试通过或文档更新当作产品完成，也不能承诺对话结束后仍会自行后台推进。

<!-- CONTINUATION_PLAN_COMPLETE -->