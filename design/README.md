# OpenCraft 工作区设计

当前产品边界（2026-09-13 用户确认）：工具只在右侧；不提供下方面板、移动到下方或 Show bottom panel。布局能力以本产品明确需求为准。

2026-09-14 补充：云端 Bot 可选。账号零 Bot 不覆盖本机/其他环境的聊天；云端创建是主动环境操作，不是全局遮罩或登录后的必经步骤。

本目录是 OpenCraft 工作区的正式设计与不变量入口。既有 [Platform](../docs/platform-architecture.md)、[Chat](../docs/chat-ui-architecture.md)、[Browser](../docs/browser-workbench-architecture.md) 文档仍拥有各自协议与资源契约；本目录拥有它们之间的工作区呈现契约，不复制第二份 Host、会话或草稿模型。

- [UI 专题索引](ui/README.md)：按需加载字体等设计主题及对应自动检查。
- [工作区模型](workspace-model.md)：身份、所有权和平台适配边界。
- [不变量及证据索引](invariants.md)：编号、实现责任、测试与未验证边界。
- [实施计划](task_plan.md)、[发现](findings.md)、[进度](progress.md)：迁移账本，不能当成已经完成的能力。

修改上述边界时，同一变更必须更新对应不变量及其验证；状态只能用“已实现/已测试/实机已验证/待实现”明确区分。

- [线程编排 Spec](thread-orchestration-spec.md) 与 [架构](thread-orchestration-architecture.md)：Stage 0 只读历史与可重建缓存；后续编排为未来设计。
