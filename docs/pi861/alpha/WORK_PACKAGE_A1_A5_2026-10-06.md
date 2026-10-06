# Pi Alpha 下一执行工作包 — A1/A5 主影真实运行闭环

日期：2026-10-06
分支：`feat/pi861-runtime-v1-cloud-20261001`

## 目标

完成 Alpha 从“角色配置和协议模拟”到“受控真实主 Agent + 影子 Agent 工作闭环”的最小版本。

本工作包不追求一次完成全部自动团队能力；目标是证明：

1. 一个任务可以形成版本化任务契约。
2. 主 Agent 和影子 Agent 同时准入，并保持独立上下文。
3. 影子从开始阶段准备研究依据和审核计划，而不是等待主 Agent 完成后才启动。
4. 主 Agent 提交真实版本化产物后，影子可以基于实际产物进行审核。
5. 中断、失败、预算限制可以被记录，而不是被隐藏。

## 当前基线

被测代码基线：`2f59cc467576c91ea8ac8a49e49732e32e3be2fe`

当前最新文档提交：`ff73f3a297feedcf2be551c29493a5c66f247e0e`

Luna/max 冒烟已经证明：14 角色同模型调用和 probe 工具往返可运行。
该结果不代表异模型审核、持续调度或生产就绪。

## 本工作包范围

### A1：任务与证据契约

新增或完善：

- MissionSpec
- ResearchDossier
- MethodCard
- TeamBlueprint
- ExecutionManifest
- ArtifactRecord
- ReviewRecord

要求：

- 每个字段有版本。
- 每个产物可追溯来源任务。
- 区分计划、执行、验证和审核。
- 不允许模型自行声明“已验证”。

### A5：主影运行适配

实现最小闭环：

```
Task Admission
      |
      +---- Main Agent
      |
      +---- Shadow Agent

Main Research
Shadow Preparation
      |
Candidate Artifact
      |
Shadow Review
      |
Pass / Changes / Blocked
```

## 明确不做

本工作包不包含：

- 自动持续运行服务。
- 无限 Agent 创建。
- 自动支付模型调用。
- 业务 MCP 接入。
- PostgreSQL 正式生产存储。
- dsh930 代码读取或比较。
- 修改 main 分支。

## 实现要求

### 主影调度

必须支持：

- 同一任务版本。
- 同批准入。
- 两个独立上下文。
- 主影不同身份记录。
- 影子准备事件先于最终审核。

### 状态记录

至少记录：

- taskId
- requirementVersion
- agentId
- modelId
- start/end
- artifact hash
- evidence refs
- review result
- blocked reason

### 失败处理

以下情况必须明确失败：

- 模型不存在。
- 工具未加载。
- 权限不足。
- 预算不足。
- 任务版本过期。
- 审核对象不是当前产物。

## 验收标准

### 必须通过

1. 本地 fixture 可以完整跑通一次主影流程。
2. 主 Agent 和影子 Agent 状态可以恢复。
3. 影子没有等待主产物才启动准备阶段。
4. 审核绑定实际 artifact hash。
5. 错误输入可以拒绝。
6. npm check 通过。
7. 新增测试全部执行并记录。

### 不算通过

以下不能作为完成证据：

- 创建角色文件。
- 两个模型返回相同答案。
- 模拟状态机通过但没有真实事件记录。
- Agent 自述完成。

## 环境要求

Node.js 24。

安装：

```bash
npm install --ignore-scripts
```

检查：

```bash
npm run check
node scripts/pi861-alpha.mjs check
node scripts/pi861-alpha.mjs simulate
```

真实模型测试需要用户明确授权，并提供：

- 模型池。
- 预算。
- 可用工具。
- 服务端点。

禁止提交凭据。

## 云端执行边界

需要安装、启动服务、真实模型调用、网络测试的步骤，由用户云端电脑执行并回传脱敏结果。

本工作包负责代码、协议、测试和文档，不重复修改云端测试环境。

## 后续

完成本工作包后，再进入：

- A2 深度研究闭环。
- A3 自动团队蓝图编译。
- A6 真实业务试点。

