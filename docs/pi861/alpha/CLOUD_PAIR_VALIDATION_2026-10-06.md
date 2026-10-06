# Alpha 主影 fixture 云端定向验证 — 2026-10-06

## 验证版本与范围

AKS 云端独立定向复验绑定代码 [2525c7491fe3b43e38854eb61d1afc66a3b20bc7](https://github.com/wmqfl861/pi861/commit/2525c7491fe3b43e38854eb61d1afc66a3b20bc7)，分支 `feat/pi861-runtime-v1-cloud-20261001`。

该版本包含运行时修复 `e3713ffe5ff31615ed3473c3f5fc0dc071c1f94c` 与测试更新 `9558923bc5d674c4af92bdc0efd6da989c3a7769`。最终 `2525c749` 仅把 `AlphaPhase` 联合类型从七行格式化为一行，没有行为或其他文件变更。

环境：Node 24.19.0、TypeScript 5.9.3、Biome 2.3.5。本文新增是验证记录，不是新的产品实现；下述结果仅绑定上述代码版本。

## 实际执行结果

- 新增主影测试：5/5 通过
- 原先五项独立拒绝/证据保留探针，保持测试内容不变重跑：5/5 通过
- 既有 Alpha 契约测试：43/43 通过
- 合计：**53 通过、0 失败、0 跳过**
- 全仓只读 Biome：检查 1460 个文件，通过，未应用修复
- 新模块严格 no-emit TypeScript 检查：通过
- 验证前后源码和 index 保持干净

此前独立复现的空模型、未知事件、空证据、未知审核结论、证据保留五项问题，以及格式化阻塞，均已在对应精确测试用例范围关闭。首次失败与后续修复记录继续保留，不用成功结果覆盖失败历史。

测试入口为 `scripts/pi861-alpha-pair-runtime.test.mjs`、`scripts/pi861-alpha.test.mjs` 及五项独立探针。静态检查使用只读 `biome check --error-on-warnings .`；模块类型检查目标为 `extensions/pi861/src/live/alpha-pair-runtime.ts`，使用 strict、noEmit、NodeNext、ES2023、allowImportingTsExtensions、verbatimModuleSyntax、erasableSyntaxOnly、noUncheckedIndexedAccess 和 skipLibCheck 选项。独立探针及原始日志未随本公开摘要上传；本段不声称仓库内已有完整复现证据包。

## 尚未完成的验收

本轮没有重跑完整 `npm run check` 聚合链；只读全仓 Biome 和单模块严格类型通过，不能改写为完整聚合检查或完整 runtime 验收通过。

当前新增模块仍是纯内存、离线状态机 fixture，仅由测试导入。以下 A1/A5 内容仍未验收完成：

- A1 缺失的记录 schema 与完整契约
- 实际主 Agent / 影子 Agent 子会话和双槽同批准入
- 可信宿主事件传输及执行接线
- 持久事件日志与跨进程重启恢复
- 执行者权限约束
- 模型、工具、权限、预算的集成准入
- A5 真实主影执行闭环验收

下一步由原项目会话继续实现这些缺口，交付新代码 SHA、具体运行入口与验收命令，再由 AKS 进行相应云端验证。无需为已完成的定向测试重新开启付费冒烟。

## 安全与证据边界

验证过程复用依赖工具，没有重新进行重型安装，没有读取凭据或发出模型/API 请求，没有修改、自动格式化或提交产品源码。此文仅公开脱敏摘要；未上传私有环境路径、端点或原始会话。fixture 结果不证明真实模型质量、持续调度、业务 MCP、生产存储或生产就绪。
