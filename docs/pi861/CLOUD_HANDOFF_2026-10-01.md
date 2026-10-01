# Pi861 云端续开发交接 — 2026-10-01

## 工作区和交付方式

用户明确要求在云端/当前项目开发并自动上传，不在个人电脑开发。本轮未连接或修改用户电脑。原始基线为 `feat/pi861-runtime-v1@77e94602d69694b42da833b6d1302a765fa56b4e`；所有新增提交只在 `feat/pi861-runtime-v1-cloud-20261001`，未修改或合并 `main`，未推送到原运行时分支。

直接 Git 网络连接不可用，因此通过授权 GitHub 连接器提交，通过只读权限、关闭凭据持久化的 Actions 工作区准备任务取回完整源码和锁定依赖，再在本会话隔离 Linux 工作区开发。工作区路径 `/mnt/data/pi861`；Node 24.21.0；依赖安装均使用 `--ignore-scripts`。工作区准备成功不等同于产品验证通过。

计划为 [CONTINUATION_PLAN_2026-10-01_CLOUD.md](CONTINUATION_PLAN_2026-10-01_CLOUD.md)。原 R1–R8、AX1–AX10 和历史证据不改写。本会话没有 Codex 规划或内置子代理/独立审核执行能力，不声称这些历史流程门已完成。

## 已上传的修复

首轮修复代码 SHA：`a8e8797f338cc75867081a4c8162f97899f978a1`。

1. Windows 宿主依赖归档改用相对路径，避免 tar 将 `D:` 解析为远程主机。Windows 和 Linux 的真实发布宿主检查恢复执行。
2. `extensions/pi861/package.json` 声明精确版本 `typebox@1.3.27`，补齐 npm 生成并含 integrity 的独立锁文件。解决独立安装时找不到 `typebox/compile`、被根 node_modules 掩盖的问题。
3. Worker 证据正例不再写死 `C:/w1`，使用平台原生绝对路径；新增相对路径、无效 PID 和非法记录反例，生产校验器未放宽。
4. 增加 `scripts/hydrate-pi861-test-catalog.mjs` 和固定目录配置，检查包名、版本、41 个 provider、manifest SHA256、各文件 SHA256 和模型数据结构，全部验证后才替换 gitignored 数据。出错时保留原数据，替换失败尝试恢复；恢复失败保留备份路径。没有修改 `models.generated.ts` 或生产模型生成命令。
5. CI 采用 `pi-ai@0.86.1` 的哈希固定发布目录作为代码检查输入，不再让公开实时目录下架模型直接改变本次编译输入。正常实时目录更新仍可运行；这个固定目录不表示当前外部服务兼容性已验证。发布目录生成时间为 2026-09-20，manifest SHA256 为 `2a79d3741c6f048fe2f919877a7d016ba5ed2c7d6c7b898986d9ee73cc0fabe2`。
6. 本交接同一提交还包含进程测试的 Linux 容器适配：已退出但未被 PID 1 回收的 zombie 不再被当成仍运行的进程。保留对真实运行进程的拒绝反例，不改生产终止代码，不增加延迟掩盖活进程。诊断观察为 parent 已消失、descendant 为 `Z`/PPid=1，稍后才被回收。

## 已实测结果

### 第一轮干净 CI，绑定 a8e8797

运行：[36848013758](https://github.com/wmqfl861/pi861/actions/runs/36848013758)。已逐一读取 7 个 job 的结果，均为 `completed/success`：

| Job | ID | 结果 |
| --- | --- | --- |
| deterministic | 110322711077 | 通过 |
| repository-check | 110322711381 | 通过，包括完整 npm run check 和检查后无源文件改动 |
| postgres | 110322711373 | 通过，临时 PostgreSQL 17 容器 |
| source / Linux | 110322711281 | 通过 |
| source / Windows | 110322711389 | 通过 |
| published / Linux | 110322711370 | 通过 |
| published / Windows | 110322711512 | 通过，归档、真实发布类型和宿主运行均执行 |

矩阵中另一种 host 的条件步骤 skipped 是分支选择，不计作已执行检查。本交接同一提交的进程测试修订不在上述 a8e8797 CI 中；其后续 CI 另行绑定，不把旧结果移植给新 SHA。

### 当前会话隔离工作区

| 命令/检查 | 结果 |
| --- | --- |
| `npm run check`，实时 2026-10-01 目录 | 失败，40 处类型错误；首败日志保留 |
| `npm run check:model-data`，固定发布目录 | 通过 |
| `npm run check`，固定发布目录，修复后完整执行 | 通过，无自动源码修复；未降低 lint/类型要求 |
| `node --test scripts/hydrate-pi861-test-catalog.test.mjs` | 6/6 通过，包括篡改拒绝和失败保全；初次测试用例预期错误文本不匹配已修正，首败保留 |
| `node --test extensions/pi861/test/acceptance.test.mjs` | 15/15 通过 |
| `node --test extensions/pi861/test/line-process.test.mjs`，容器适配后 | 3/3 通过，包含仍运行进程反例 |
| 四个额外 AI 测试文件 | 68 tests / 67 pass / 1 fail；见下方未关闭项 |
| 50 文件确定性套件，初次本会话扫 | 519 tests / 518 pass / 1 fail：僵尸进程立即 ESRCH 断言；其后已定点修复 |
| 50 文件确定性套件，进程修订后再扫 | 520 tests / 519 pass / 1 fail：网页抽取超时正例，见下方未关闭项；没有算作全过 |

日志位于本会话 `/mnt/data/pi861-evidence/cloud/`。CI 完整日志在上述运行及其上传 artifacts 中；会话日志随交付提供独立归档，不冒充仓库外历史 Windows 路径证据。

## 尚未关闭的事项

### CLOUD-OPEN-1：固定发布目录与额外 AI 元数据断言不完全一致

实际运行：从 `packages/ai` 使用根 vitest，对 `fireworks-models.test.ts`、`anthropic-empty-thinking-signature-compat.test.ts`、`anthropic-sse-parsing.test.ts`、`openai-completions-prompt-cache.test.ts` 四文件运行；没有模型凭据或付费请求。

结果 67/68。失败为 Fireworks Kimi K3 的 `supportsStrictMode: true` 元数据断言：固定发布目录未显式包含此字段。没有删除断言、填写虚构模型能力或把这项额外检查算作通过。后续应对齐固定测试目录与当前生成器/运行时兼容性语义，并把相应 AI 回归纳入 CI；不能以本轮七 job 通过声称所有 AI 测试通过。

### CLOUD-OPEN-2：网页抽取超时测试依赖机器速度

`test/web-read.test.mjs:407` 使用 250,000 个 `<` 字符并强制要求 100ms 超时。本会话最后一次全套扫中该调用约 96ms 返回，断言报 `Missing expected rejection`。该观察不是越过期限的证据；说明以输入长度假定固定耗时的测试不稳定。首轮干净 CI 中现有用例通过。后续应使用可控抽取 fixture 检查超时，同时保留实际恶意输入和事件循环非阻塞覆盖，不把偶然快速完成认作产品失败，也不能放宽超时安全边界。生产逻辑本轮未修改。

### 项目级验收仍未替代

本轮没有重新完成全部 AX1–AX10、多台真实服务器、真实外部模型/搜索/MCP 验收，也没有独立审核或发布。付费 API、用户配置、凭据和业务数据库未访问。本分支为可审核的开发交付，不是已获独立验收的发布版本。

## 继续开发入口

以本云端分支最新 HEAD 为基线，先处理 CLOUD-OPEN-1 和 CLOUD-OPEN-2；保留首次失败与精确版本，新增确定性反例并运行对应测试、完整 npm run check。之后按既有需求台账推进缺口，不重新实现已经存在的模型路由、记忆、Skill/MCP、goal 和 Worker 模块。仅在独立审核与项目验收证据齐备后考虑合入原运行时分支；main 不自动合并。
