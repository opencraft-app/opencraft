# 模型选择与能力一致性

目标：明确默认选择唯一来源；输入能力从实际目录投影；编译与 Host 校验消费相同模型能力。
非目标：不改用户 models.json、凭据或会话；不重构引擎；不提交推送发布。

1. 核对当前链路与保留现有改动 — 已完成。
2. 默认选择红绿回归与修复 — 已完成。
3. 模型输入能力红绿回归与修复 — 已完成。
4. 编译/Host 校验、聚焦与完整门禁、隔离运行时验收 — 已完成。

检索：root route 无匹配；有界 exact search 后读取相邻测试。
错误：猜测 model-configuration/composer-model-catalog/runtime-models 等文件不存在，已以 rg --files 定位实际入口；不重复猜测。
Context receipt：opencraft/AGENTS.md、maintenance/verification、design/model-configuration、platform-architecture、TASK-TEMPLATE；共享 frontend adjacency 的测试配置已核对，任务不触及 frontend。

checkpoint：77/77 聚焦、完整 gate、真实 DSH 及签名桌面通过；不改变用户模型文件、凭据或默认选择，未提交发布。历史 Root Context 问题不扩散清理。
