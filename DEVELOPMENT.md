# Pi861 二次开发入口

这份说明面向修改源码、运行程序、添加测试和提交代码。它不是“全部产品需求已验收”的声明。
开发分支：`feat/pi861-runtime-v1-cloud-20261001`。不要从旧 `main` 开始。

## 1. 在浏览器中打开环境

**[打开 Codespaces 创建页面](https://codespaces.new/wmqfl861/pi861/tree/feat/pi861-runtime-v1-cloud-20261001)**（创建前确认分支和账户额度）。

打开 [当前开发分支](https://github.com/wmqfl861/pi861/tree/feat/pi861-runtime-v1-cloud-20261001)，
确认分支名，然后选择 **Code → Codespaces → Create codespace on 当前分支**。
需要选分支/机型时，选择 **New with options**。
环境启动配置在 `.devcontainer/`，会自动运行 `node scripts/pi861-dev.mjs setup`。

环境含 Node 24、Git、仓库锁定的 TypeScript/tsx/测试工具、单独的 PostgreSQL 17 测试容器。
编辑器和终端在浏览器里，不要求个人电脑安装 Node 或 Docker。
这是仓库里的可重建环境配置，不是已经替你创建的常驻机器。
Codespaces 的创建、额度和计费由你的 GitHub 账户控制；本会话没有创建付费实例。
镜像固定 Node 24 / Debian Bookworm 和 PostgreSQL 17 系列，安全更新可能改变补丁版本；
npm 依赖通过锁文件安装。实际环境版本以 `doctor` 和 CI 日志为准。

Codespaces `/workspaces` 中已保存文件可跨停止/启动与重建保留，但不是永久备份；
以提交并推送到 GitHub 的代码为正式保存点。停止环境会停止程序。
关闭浏览器标签不等于停止 Codespace；停止后可能仍计存储用量。

## 2. 第一轮运行

在仓库根目录终端执行：

```sh
node scripts/pi861-dev.mjs doctor
node scripts/pi861-dev.mjs smoke
node scripts/pi861-dev.mjs demo
```

`demo` 运行的是**真实源码 Pi 宿主 + 完整 runtime.ts + 本地确定性假模型**，
会经 `write` 工具产生 `fixture.txt`，并在打印出的 `.artifacts/pi861-dev/demo-*` 下保存状态。
这验证程序能运行和工具接线，不验证真实模型质量，也不会调用付费模型。
它不是静态截图，也不是 Web 聊天前端。

| 命令 | 用途 |
| --- | --- |
| `node scripts/pi861-dev.mjs setup` | 重新安装根仓库、扩展和数据库驱动的锁定依赖；补齐哈希校验后的发布模型目录 |
| `node scripts/pi861-dev.mjs doctor` | 工具链、依赖和模型数据完整性检查 |
| `node scripts/pi861-dev.mjs check` | 完整 `npm run check` 和扩展/源码宿主类型检查 |
| `node scripts/pi861-dev.mjs smoke` | 定点回归与真实源码宿主测试，不使用模型密钥 |
| `node scripts/pi861-dev.mjs test` | 扩展全部 `*.test.mjs`；已知超时用例不稳定问题见第 6 节 |
| `node scripts/pi861-dev.mjs postgres` | 当前专用容器的真实 PostgreSQL 集成测试 |
| `node scripts/pi861-dev.mjs demo` | 无密钥完整运行时演示 |
| `node scripts/pi861-dev.mjs verify` | doctor、check、smoke、postgres、demo，任一步失败即非零退出 |

`check` 中的 Biome 可能格式化源文件；运行后审查 `git diff`。
`setup` 的 `npm ci` 会重建对应 node_modules，不适合与正在运行的开发进程同时执行。
所有安装都使用 `--ignore-scripts`。不会自动更改用户的模型默认值、凭据或登录配置。

## 3. 修改哪里

| 路径 | 用途 |
| --- | --- |
| `extensions/pi861/runtime.ts` | 完整扩展装配入口；不要与 `index.ts` 同时加载 |
| `extensions/pi861/src/live/` | 模型服务、记忆、Goal、Worker、MCP、网页读取等运行模块 |
| `extensions/pi861/src/contracts/` | 共享协议与接口 |
| `extensions/pi861/test/` | 确定性与集成测试 |
| `extensions/pi861/sql/` | 数据库迁移 |
| `packages/coding-agent/src/` | Pi 宿主、命令行、会话与扩展加载 |
| `packages/ai/src/` | 模型与提供方 API 层 |
| `docs/pi861/` | 原需求、架构、配置、验收台账和历史交接 |
| `.devcontainer/` | 可重建云端开发环境 |
| `scripts/pi861-dev.mjs` | 本轮新增的开发入口，不属于产品执行架构 |

建议从扩展内一个模块开始，修改实现并添加对应测试，不重复实现已有模块。
单文件测试示例：

```sh
node --test extensions/pi861/test/acceptance.test.mjs
node scripts/pi861-dev.mjs check
```

源码通过 tsx 启动，修改后重启对应进程即可；此配方没有承诺热重载或启动前全仓构建。

## 4. 接入真实模型：单独的主动操作

无密钥模式足够编写代码和运行上述检查。真实模型需要你有权使用的提供方凭据，
以及符合 [配置说明](docs/pi861/CONFIGURATION.md) 的可信绝对路径 JSON 配置。
不要把密钥、登录文件或业务数据库放进仓库；Codespaces Secrets 或用户私有配置可用于注入。
参考 [完整运行时入口](extensions/pi861/README.md)，从源码启动：

```sh
PI861_CONFIG=/absolute/path/to/private-runtime.json \
  bash ./pi-test.sh --no-extensions --no-skills -e ./extensions/pi861/runtime.ts
```

这是交互终端程序，不是网站。不要把 demo 的 `pi861-fixture` 当成真实模型。
没有自动运行真实模型、Brave 搜索或业务 MCP 验收。
外部搜索/MCP/多 Worker 和真实 PostgreSQL 运行时需要按配置说明另行授权和配置。

PostgreSQL 容器只含测试库 `pi861_test`，密码是公开的测试值 `pi861-dev-only`。
没有发布宿主端口，没有自动转发数据库，不要放业务数据。
测试使用随机 schema/受限运行角色并清理其所属资源；管理员连接仅用于 fixture。
默认没有 Docker socket/特权模式，因此需要 OCI Docker 的完整隔离/多 Worker 验收并未由本环境自动完成。

## 5. 保存代码到仓库

本次助手的改动按你的授权上传到云端开发分支。
你在 Codespaces 中编辑并保存文件**不会自动产生 Git 提交，也不会自动 push**。
推荐每个功能使用独立派生分支：

```sh
git switch -c feat/pi861-runtime-v1-my-feature
# 修改代码，然后运行相应测试和 check
git status --short
git diff
git add extensions/pi861/src/你修改的文件.ts extensions/pi861/test/你添加的测试.test.mjs
git commit -m "feat: describe your change"
git push -u origin HEAD
```

上面的两个文件路径是示例占位，替换成你实际修改的文件。
不要 `git add .`、force push 或直接合并 `main`。
推送授权不等于生产部署授权。长期保留源码以 GitHub 为准，而不是 ChatGPT 临时目录。
根 `AGENTS.md` 的质量/安全约束继续适用；历史 Codex 规划/独立审核门未在本轮伪造完成。

## 6. 基线和未解决问题

接手基线 `978ac51665626b6b49c692e260b77707445bb2c0` 的 7 项运行时 CI 已成功：
[运行 36848907768](https://github.com/wmqfl861/pi861/actions/runs/36848907768)。
本次环境配置的验证绑定本次新提交，不用旧 CI 代替。

仍保留 [CLOUD_HANDOFF_2026-10-01.md](docs/pi861/CLOUD_HANDOFF_2026-10-01.md)
中的 CLOUD-OPEN-1（额外 AI 元数据断言不一致）和 CLOUD-OPEN-2（全套网页超时测试与机器速度相关）。
`verify` 是明确列出的开发环境检查，不是全部 AI 测试、全部 AX1–AX10 或产品发布验收。
出现失败不要删除断言或跳过用例冒充成功。
环境用于二次开发，不等于已完成真实模型/跨服务器/生产级认证和数据安全验收。

首次环境候选 `6e7c1bf` 的实际容器已通过安装、完整检查、28 项定点测试、
4 项真实源码宿主测试和14 项真实 PostgreSQL 测试；演示入口因继承未关闭的 stdin 超时。
本次修订将非交互开发命令的 stdin 关闭，并增加 EOF 回归测试；不改变产品源码。
CI 只使用已提交的数据库驱动锁文件，并固定 Dev Containers CLI 0.89.0。
最终结果请查看当前提交的 **Pi861 development environment** 工作流，而不是旧候选。

首次候选的 npm 安装审计提示根依赖存在 5 项告警（3 moderate、2 high）。
本环境未自动执行 `npm audit fix --force`，也未完成生产依赖安全审核；
不要因开发环境能运行就直接部署生产。实际告警以当前 npm audit 结果为准。

## 7. 在其他云服务器重建

需要已有 Linux、Docker/Compose 和 Node 24；此操作不在你的个人电脑执行：

```sh
git clone --branch feat/pi861-runtime-v1-cloud-20261001 https://github.com/wmqfl861/pi861.git
cd pi861
npm install --prefix /tmp/pi861-devcli --no-save --no-package-lock --ignore-scripts @devcontainers/cli@0.89.0
/tmp/pi861-devcli/node_modules/.bin/devcontainer up --workspace-folder .
/tmp/pi861-devcli/node_modules/.bin/devcontainer exec --workspace-folder . node scripts/pi861-dev.mjs verify
```

首次需要联网下载容器镜像与 npm 依赖；源码 ZIP 是完整源码和环境配方，不是离线虚拟机镜像。
ZIP 不含 Git 历史，部分验证依赖 Git 提交标识，因此实际开发优先 clone/Codespaces。
不要把本仓库目录中的数据库测试命令指向业务库。

## 官方环境资料

- [Codespaces Node.js 环境](https://docs.github.com/en/codespaces/setting-up-your-project-for-codespaces/adding-a-dev-container-configuration/setting-up-your-nodejs-project-for-codespaces)
- [Dev Containers 和 Docker Compose](https://containers.dev/guide/dockerfile)
- [Codespaces 生命周期和工作区保存](https://docs.github.com/en/codespaces/about-codespaces/deep-dive)
- [停止环境和计费边界](https://docs.github.com/en/codespaces/developing-in-a-codespace/stopping-and-starting-a-codespace)
