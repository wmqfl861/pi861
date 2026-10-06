# Pi 阿尔法团队 v0.1

## 最新进展：同模型 Luna/max 真实冒烟通过

用户已在自己的云端检出，对 `2f59cc467576c91ea8ac8a49e49732e32e3be2fe` 完成 **14角色、14独立SDK会话、28次HTTP200、14次本地probe工具往返**，参数为 `gpt-6-luna`、`reasoning.effort=max`、OpenAI Responses API。成功运行于2026-10-06 06:56:52—06:59:09 UTC，峰值并发2，回报耗时138秒。

首次环境配置失误导致的2次DNS `EAI_AGAIN`保留；恢复既有平台代理/CA环境后通过，共30次客户端尝试。费用未知，网关底层模型身份未独立验证。本轮复跑57/57及模拟工具往返；此前同提交的其他通过项不算本轮全部重跑。

详见[专项验收记录](LUNA_HTTPS_ACCEPTANCE_2026-10-06.md)和[计划更新](PLAN.md)。这是**用户云端实测回报的录入**，不是本助手复测或原始报告独立审计。

有限冒烟已通过；正式团队仍未获得持续运行准入。异模审核、真实研究、业务MCP、PostgreSQL和持续调度仍需分别验收。本次没有开启付费常驻任务，也没有改变引导配置、模型默认值或凭据。

## 原建队配置说明（历史）

以下“没有已运行的14个模型Agent”“模型池目前为空”等描述属于初版bootstrap及未配置的正式异模池；本次有限同模型测试通过上方独立记录更新，不应把原文当作最新连通性结论。


已创建：7组主影、14份Pi角色配置、11个专用方法Skill、章程、研究记录、工作包、配置校验与协议模拟。
状态：**configured-unarmed**。没有真实模型池，没有已运行的14个模型Agent，没有生产实时调度闭环。
当前助手是首版引导协调者，实际负责本轮研究/规划/自我质疑与落地；不是假装多个模型同时审查自己。

## 查看团队
在仓库根目录、Node 24环境执行：
```sh
node scripts/pi861-alpha.mjs check
node scripts/pi861-alpha.mjs status
node scripts/pi861-alpha.mjs simulate
```
check是配置检查；status列出真实启动阻断；simulate只模拟主影协议，不进行模型或搜索调用。
Pi可以通过/subagents查看alpha-*角色；/alpha是本项目新增的提示模板入口，不是常驻服务启动命令。
role文件模型为有意无效的alpha-unconfigured/awaiting-model-pool，不应直接运行后改成父模型凑数。

## 目录
.pi/alpha/team.json 是团队规范；models.example.json是无密钥模型池模板；work-orders.json是首批任务；work-order.example.json是单任务契约示例。
.pi/agents/alpha是实际岗位，.pi/skills/pi-alpha-*是按岗方法包；docs/pi861/alpha是章程、研究、计划和自我审查。
scripts/pi861-alpha.mjs做本地校验/提案，scripts/check-pi861-alpha-host.mjs使用固定版本真实Pi/插件发现、解析和工具注册。

## 模型绑定
用户提供模型id、provider/model、实际canonicalModelId、能力与岗位资格及调用预算；凭据通过Pi私有宿主配置管理，不发到文档或Git。
模型池目前为空。可在.pi/alpha/models.local.json填写模板（已被该目录.gitignore排除）；禁止提交密钥。
之后可查看某工作包的不可执行配对提案：
```sh
node scripts/pi861-alpha.mjs prepare D2 .pi/alpha/work-order.example.json .pi/alpha/models.local.json
```
prepare即使通过也明确executable=false，因为它没有绑定真实宿主调度/权限/预算。不得把JSON提案当安全授权。
不直接改全局模型配置，不把别名不同当模型不同。上岗前要实际校准模型审核能力。

## 同步与能力边界
影子从同一任务的研究起点准备，不等产物完成。重大风险即时预警，最终审查必须看真实冻结产物。
本轮提供流程约定、提案与可测试协议；真实同步调度和通知接入列为A5，不宣称已经完成。
全部角色默认read-only-research，没有通用终端/写入。未来实验/开发工具须与隔离工作区及可信宿主绑定；不是权限提示词就有安全保证。
web扩展显式加载；工具注册不代表搜索服务已经配置。不会因为存在密钥就自动使用。Hermes与pi861记忆不自动混合。

## 检查
```sh
node --test scripts/pi861-alpha.test.mjs
node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.json scripts/check-pi861-alpha-host.mjs
npm run check
```
host检查在临时home/目录运行并结束，没有真实模型、搜索和MCP请求。恢复环境用原DEVELOPMENT.md及PLUGINS_2026-10-02.md，不再安装另一套调度器。
更多事实依据见RESEARCH.md，缺口及作者自查见SELF_REVIEW.md，接续工作见PLAN.md。
Pi/dsh竞赛按实际产物和全部成本比较，本团队不读取对方私有环境，也不自己裁定获胜。
