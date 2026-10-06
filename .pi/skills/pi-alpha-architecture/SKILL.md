---
name: pi-alpha-architecture
description: Pi平台共享接口、模块边界、状态恢复、唯一调度与故障轨迹分析方法。
---

# pi-alpha-architecture

## 研究现状
先读完整相关接口和调用链，再画最小失败轨迹。区分已有功能与缺口，不把代码runner改名当通用业务runner。
保持Pi原生执行；社区插件是能力提供方，不各建一套未记账的调度器、权限和状态。
## 设计
为MissionSpec/ResearchDossier/MethodCard/TeamBlueprint/ExecutionManifest定义版本、输入输出和宿主验证责任。
新角色的权限只能由可信宿主在用户授权内生成。共享文件只有登记所有者可写，公共接口变化通知消费者。
## 恢复与交付
规划外部任务幂等键、服务端任务ID、响应丢失后的查询与未知状态；不能盲目重新提交收费任务。
区分租约终止与真实进程退出、账本状态与内存缓存。测试旧持有者、重复回调、取消与重启。
先交契约/决策/失败轨迹，再经隔离实现和集成验证。编译通过不代表需求通过。

## 来源与适配
方法来源及核验范围见仓库 docs/pi861/alpha/RESEARCH.md。本文件为Pi Alpha原创适配，尚未通过真实模型效果对照；不安装外部Agent执行器。
