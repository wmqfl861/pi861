# Pi861 二次开发环境工作包 — 2026-10-01

用户目标：获取可直接打开、运行、修改和提交的云端开发环境及完整源码；
不连接个人电脑，继续按既有授权上传云端分支。

基线：`978ac51665626b6b49c692e260b77707445bb2c0`。
写入分支：`feat/pi861-runtime-v1-cloud-20261001`。
本轮只新增开发环境、开发命令、测试与入口文档，不调整产品接口、真实模型默认值或已有 R1–R8 / AX1–AX10。
同一会话是这些新增文件的唯一写入者；不声称有独立审核或 Codex 规划调用。

1. DEVENV-1：增加 Node 24 + PostgreSQL 17 Compose devcontainer。非特权，不挂 Docker socket，
   不发布数据库端口，共享网络命名空间使数据库保持 loopback-only 测试限制。
2. DEVENV-2：增加 setup/doctor/check/smoke/test/postgres/demo/verify 命令。
   安装仅使用 ignore-scripts；依赖锁和模型数据 pin 入库。测试环境通过白名单清除模型密钥、
   外部验收 opt-in、Node 注入参数和业务数据库覆盖。
3. DEVENV-3：增加配置/安全回归，CI 使用实际 devcontainer 启动和验证。
   初始化数据库驱动 lock 通过 npm 生成、取回审核后提交；最终验证必须使用已提交锁，
   不将候选 CI 中未提交的生成锁冒充最终代码。
4. DEVENV-4：提供中文 DEVELOPMENT.md、源码下载和精确 Git 版本、可打开的仓库入口。
   说明临时会话、可重建配置、用户 Codespace 实例三者区别，说明保存不是自动 push。

退出条件：实际容器 setup、check、定点与宿主 smoke、临时 PG 和无密钥完整 runtime demo 通过，
当前提交与失败日志可追溯；否则分别记录已通过与阻断，不宣称用户专属 Codespace 已创建。
CLOUD-OPEN-1、CLOUD-OPEN-2、完整 AX、跨主机和真实外部模型质量仍保留独立边界。
不自动创建可能计费的用户云主机，不发布软件包、不部署、不修改 main 或其他会话文件。
