# 阿尔法团队建立与后续工作计划 — 2026-10-06

## 当前工作包 A0：bootstrap
由当前会话研究、规划、自我审查、创建配置与开发校验器。唯一写入者为本会话；未调用真实模型子代理。
输入：1381dda4基线、原AGENTS、CONFIGURATION和PLUGINS记录、用户本轮主影与深度研究要求、固定插件文档。
新增范围：.pi/alpha、.pi/agents/alpha、.pi/skills/pi-alpha-*、.pi/prompts/alpha.md、docs/pi861/alpha、新增scripts校验/测试及单独CI。
不修改：产品runtime、原Skill库、原模型默认值、依赖锁、用户电脑、dsh、main。
退出：静态配置、固定插件发现/Skill解析/工具注册、协议负例和完整npm run check有实际结果；结果与SHA绑定。
独立审核门：本轮不宣称完成。SELF_REVIEW是当前作者自我质疑，不能用于替代异模影子验收。
历史Codex/内置子代理规划审核门没有执行记录，不删除或改写旧规则与历史证据；当前用户授权首版当前会话bootstrap，不代表已通过那些门。

## 接续工作包与所有权
A1 需求与证据契约（D1主影，D5参与验收设计）：冻结MissionSpec/ResearchDossier/MethodCard/TeamBlueprint/ExecutionManifest。
A2 研究充分性与实验（D2主影）：接真实搜索结果读取、版本/来源去重、可观察工具记录；无现成方法进入实验，不能靠布尔字段自证。
A3 角色和流程编译（D3主影）：批准词表内生成角色，验证任务输入输出、循环和需求覆盖；支持非代码产物。
A4 模型与工具准入（D4主影）：用户给模型池，校准异模配对、实际参数、工具注册、账户资源；预算/权限统一走Pi服务。
A5 同步主影运行（D1/D4；共享文件D1唯一所有者）：与既有协调者集成，同批准入与prep事件、实时预警、隔离工作区、取消/重启、外部任务ID。
A6 效果试点（D5主影）：真实业务代表任务，对比强单Agent、同模复核、异模事后与异模同步；计总成本，独立盲评。
A7 最终整体验收（D6主影）：交接版本、实际产物、所有关键限制、未验证边界；只用户决定Pi与dsh比较。
没有模型池时这些工作包可以继续做离线规格和确定性检查，但不能标成真实模型执行完成。

## 资源与依赖
共享接口、runtime.ts、compilers、依赖/CI由登记唯一所有者更新；并行写入使用独立工作区。
启动以主影为单位，两槽同时准入。默认4槽是起点，不承诺任何提供方额度。影子有独立研究/验证预算，纳入任务总额。
A1先于A2/A3结构实现；A4和宿主隔离先于A5真实启动；A5通过前不得做A6真实质量声明。
测试/审核阻塞或资源不足需明确说明，不制造空转。不限制研究必须两轮结束，预算不足但未达标记录blocked。

## 验证命令
node scripts/pi861-alpha.mjs check
node scripts/pi861-alpha.mjs status
node scripts/pi861-alpha.mjs simulate
node --test scripts/pi861-alpha.test.mjs
node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.json scripts/check-pi861-alpha-host.mjs
npm run check

simulate只测纯状态协议，prepare只输出不可执行提案。工具加载检查不进行联网或模型请求。
所有首次失败、修正、未运行的真实服务验证记录保留在验证报告；安装只用--ignore-scripts，不跳过根检查。

## 交付与保存
配置和文档推送到feat/pi861-runtime-v1-cloud-20261001。仅显式列出的新增路径提交，非强制更新；发生并发变化先重新核对。
临时目录不是长期服务器；私有配置与运行状态不提交，未完成的模型/宿主绑定作为明确后续输入。
