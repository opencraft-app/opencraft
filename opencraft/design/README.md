# OpenCraft 工作区设计

当前产品边界（2026-09-13 用户确认）：工具只在右侧；不提供下方面板、移动到下方或 Show bottom panel。学习 Codex 的所有权模型，不自动引入其全部布局能力。

2026-09-14 补充：云端 Bot 可选。账号零 Bot 不覆盖本机/其他环境的聊天；云端创建是主动环境操作，不是全局遮罩或登录后的必经步骤。

本目录是本次 Codex 工作区复刻的正式设计与不变量入口。既有 [Platform](../docs/platform-architecture.md)、[Chat](../docs/chat-ui-architecture.md)、[Browser](../docs/browser-workbench-architecture.md) 文档仍拥有各自协议与资源契约；本目录拥有它们之间的工作区呈现契约，不复制第二份 Host、会话或草稿模型。

- [工作区模型与来源](workspace-model.md)：身份、所有权、参考实现映射和适配边界。
- [不变量及证据](invariants.md)：编号、实现责任、测试与未验证边界。
- [实施计划](task_plan.md)、[发现](findings.md)、[进度](progress.md)：迁移账本，不能当成已经完成的能力。

修改上述边界时，同一变更必须更新对应不变量及其验证；状态只能用“已实现/已测试/实机已验证/待实现”明确区分。
