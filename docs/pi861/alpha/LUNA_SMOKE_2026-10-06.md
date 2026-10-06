# Alpha 全员 Luna/max 冒烟配置与测试

> 后续更新（2026-10-06，用户云端实测回报）：提交 `2f59cc467576c91ea8ac8a49e49732e32e3be2fe` 在HTTPS网关完成14角色同模型Luna/max连通性及工具往返，28次HTTP200、14次本地probe执行。首次另有2次DNS `EAI_AGAIN`，恢复既有平台代理/CA环境后通过，本轮云端共30次尝试。详见[专项验收记录](LUNA_HTTPS_ACCEPTANCE_2026-10-06.md)。以下保留此前助手环境的原始记录，“当前/本轮”按当时环境理解；不删除旧失败，不把不同轮次混算。本助手未读取云端JSON或复测，费用未知，底层模型身份未独立验证；不据此启动持续付费运行。


## 用户授权和范围
用户明确要求先以同一套廉价网关模型配置所有角色并测试是否通畅。本次是对异模要求的有限测试例外，不放宽正式团队的异模准入或把同模结果称为独立审核。
模型ID为 `gpt-6-luna`，思考等级为 `max`，使用 `openai-responses`。不是把 `/max` 拼进标准模型ID，也没有降成 none/high。
官方参考（2026-10-06核查）：https://developers.openai.com/api/docs/models/gpt-6-luna
第三方网关是否支持该协议/名字、是否真的路由到这个底层模型，都需服务端验证，本轮未确认。

## 已创建配置
`.pi/alpha/luna-smoke.json` 定义单独的冒烟模式。`configure` 生成忽略目录 `.pi/alpha/private/luna-smoke/agent/` 中的 Pi `models.json` 和 `settings.json`。
settings 对14个 alpha-*角色逐项覆盖模型与 max 思考等级，同时设置该测试环境的默认模型；原 `.pi/settings.json`、角色占位模型、正式 team.json 不修改。
密钥只从 `PI_ALPHA_TEST_API_KEY` 读取，models.json 写环境变量引用，不写原始密钥。个人地址从 `PI_ALPHA_TEST_BASE_URL` 读取；地址与密钥未提交仓库。
用户本次给的是明文HTTP，客户端不能提供传输加密；已明确提醒测试后轮换，建议服务方提供HTTPS。

## 可重复运行
完成 DEVELOPMENT.md 的源码与 PLUGINS_2026-10-02.md 的插件安装后，用 Node 24：

```sh
# 当前终端需事先安全注入 PI_ALPHA_TEST_BASE_URL 与 PI_ALPHA_TEST_API_KEY。
# 不把 key 放进命令参数、截图、仓库或公开工作流输入。
node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.json scripts/pi861-alpha-smoke.mjs configure
node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.json scripts/pi861-alpha-smoke.mjs live
```

无凭据离线回归：
```sh
node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.json --test scripts/pi861-alpha.test.mjs scripts/pi861-alpha-smoke.test.mjs
node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.json scripts/pi861-alpha-smoke.mjs fixture
```

live通过真正的Pi源码SDK创建会话，读取已固定插件解析的角色和选定Skills，显式覆盖模型；本测试不由自动设计层生成任务，也不是产品的持久调度器。
只允许一个无外部副作用的本地 `alpha_smoke_probe` 工具，验证生成的工具调用、执行、结果回传、第二轮回答。真实网页研究、MCP、文件写入、数据库和业务制作未测。
同组主影先完成准备，再一起进入调用；同时最多2个会话，逐组执行，出现失败即停止后续组。上限32次物理模型请求、每次4096输出token、单次30秒、单会话90秒；关闭重试，不自动更换接口/模型/思考等级。
4096是这次短测预算，不是GPT模型的官方最大输出。网关价格未知，报告billingCost=null，不用默认0费率声称免费。

## 本会话实测
源码以远端03f4113c的完整源码树499d868b恢复并核验。本地建立独立source-snapshot提交，未冒充成功git pull。
- 配置覆盖14角色：通过。
- 52项测试：52通过，0失败，0跳过（原Alpha43项、新增9项）。
- 模拟响应下：14个真实Pi SDK会话、28次截获的Responses请求、每角色一次真实本地工具执行，全部通过；峰值2会话，14个独立sessionId。所有截获请求的reasoning.effort均为max。
- 固定插件角色/Skill发现和网页工具factory注册：通过；未访问真实搜索。
- 完整npm run check：通过；未更改已跟踪产品源码或根依赖。
- 最新一次真实网关尝试：第一组2会话均失败，底层ECONNREFUSED，没有HTTP状态码、没有模型输出、没有工具执行；其余12会话未运行。此前等价的一轮也是两次连接失败；没有自动连续重试。
- 无密钥网络探测：同一网关端口也失败，github.com DNS解析失败。因此不能仅据本环境结果断定网关服务本身宕机，亦不能证明API key或模型兼容性。

首次语法错误日志、并行屏障回归的首次失败，以及依赖归档旧caret清单导致的根检查失败均保留。依赖清单/lock最终从此前精确版本证据归档恢复，未改根锁或重新解析依赖；一次离线锁刷新因缓存缺失失败，没有算通过。

## 云端后续测试入口
`.github/workflows/pi861-alpha-smoke.yml`：push只运行无密钥fixture，绝不自动使用提供方密钥。
手动workflow_dispatch可选择live=true和base_url；密钥必须来自仓库Secret `PI_ALPHA_TEST_API_KEY`，不能作为普通输入。
当前GitHub连接器没有写Actions Secret的功能，本轮未把用户密钥上传到GitHub或利用公开文件/日志转交。未创建Secret、未启动Actions真实模型测试。拥有安全密钥注入的联网云端才能继续实际调用。

## 状态解释
结论是“配置与本地Pi调用链通过，当前容器真实连接被阻断”，不是“全员Luna联网运行通过”。fixture不是模型质量证据；同模型也不是异模独立审核。原项目验收与同步深度研究功能的缺口不因本次短测而关闭。
