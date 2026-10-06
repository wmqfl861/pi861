# Luna 项目私有配置与复测 — 2026-10-06

用户确认同一网关和 Luna 配置正在其他环境正常使用，要求写入当前项目并测试。本轮没有以本容器的连接失败推断模型不可用，没有更换模型、网关、密钥或降低推理等级。

## 实际配置

基线 `72449727bc9de76c518c9b2ff809bd771f687819`，源码恢复后的树与 `78d2917b884285c0c2ecb88284480433020f0716` 完全一致。当前工作区 `/mnt/data/pi861`，Node 24.21.0。网络 Git pull 未成功；本地 Git HEAD 是用于检查的独立源码快照，不冒充远端提交。

用户给的地址和密钥保存在当前工作区 `.pi/alpha/private/luna-gateway.local.json`，权限 0600，父目录 0700，并由既有 `.pi/alpha/.gitignore` 排除。该文件不提交、不打包、不输出内容。当前会话临时目录不是永久密钥管理服务。

实际 `models.json` 和 `settings.json` 已生成到 `.pi/alpha/private/luna-smoke/agent/`，均为 0600。14 个 Alpha 角色的测试覆盖为 `pi-alpha-smoke/gpt-6-luna`，思考等级 `max`，Responses API。原正式异模团队配置和未绑定占位角色不改写；这是用户授权的同模型连通性测试。

新增入口自动读取这个私有文件，无需重复把密钥放到命令行：

```sh
node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.json scripts/pi861-alpha-local-smoke.mjs configure
node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.json scripts/pi861-alpha-local-smoke.mjs live
```

新环境需要安全注入同名私有配置或沿用原有环境变量测试入口。源码 ZIP 不包含密钥，不构成全员生产启动器。

## 本轮真实测试

两次物理模型请求：`model=gpt-6-luna`、`reasoning.effort=max`、`max_output_tokens=4096`，目标仅用户指定网关的 `/v1/responses`，关闭自动重试和重定向。

| 项目 | 结果 |
| --- | --- |
| 角色配置 | 14/14 已生成测试覆盖 |
| 尝试真实会话 | 第一组主影，共2个 |
| HTTP 响应 | 0 |
| 网络错误 | 2个 ECONNREFUSED |
| 真实模型输出 / 工具调用 | 0 / 0 |
| 未执行会话 | 12（第一组失败后停止） |
| Alpha与Luna本地回归 | 57/57通过，0 skip，包括新增5项私有配置检查 |
| 模拟响应下的工具往返 | 14个Pi SDK会话、28个截获请求、每角色1次探针工具执行，通过 |
| 完整 npm run check | 通过，无自动源码修复 |

浏览器smoke中的 `TERM environment variable not set` 诊断仍保留，完整命令退出0。以上模拟结果不计为Luna联网结果，不证明异模审核质量。

当前结论：配置确实落地并使用了用户的配置重试；此容器访问网关仍在连接阶段失败，因此无法核验真实模型响应。没有HTTP状态就不判断鉴权、模型名称或协议兼容性。

## 云端路径和限制

本轮拟定的临时加密凭据传递方案在提交环节被平台安全检查拦截，没有更新分支、没有启动该CI、没有向GitHub发送用户密钥。相关未提交方案文件已从工作区移除，不尝试绕过拦截。

现有 `.github/workflows/pi861-alpha-smoke.yml` 仍保留受支持的手动测试入口：只有人工选择 `live=true` 且仓库 Secret `PI_ALPHA_TEST_API_KEY` 存在时才运行真实测试；push仅运行无密钥回归。本轮只为新私有配置入口补充CI回归覆盖，没有启用自动付费测试。

当前 GitHub 连接器没有写入Actions Secret或触发workflow_dispatch的工具。未创建Secret，未宣称云端真实测试完成。密钥应通过GitHub原生Secrets设置安全注入，不通过源码、普通输入或日志传递。
