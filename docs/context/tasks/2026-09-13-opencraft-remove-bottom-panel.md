# 移除非需求的下方面板

## goal
移除桌面/Web 下方面板及移动、重新显示入口，保留右侧工具和 Overlay 聊天。

## requirement_excerpt
用户：“怎么还增加了下边栏的能力？不需要这个”。此决策覆盖之前从 Codex 扩展出的 bottom 呈现。

## non_goals
- 不改登录、环境、模型和 Side Chat 协议。
- 不关闭已有网页或终端资源，不提交/push。

## context_receipt
- 根/OpenCraft 入口、维护总纲/验证清单、platform 架构、design 工作区不变量；context 路由无匹配，精确检索 Shell/Panel/App。

## affected_paths
- workbench-web Shell/Panel、旧状态迁移、对应 smoke/测试、opencraft/design 与平台/领域文档。

## acceptance
- 没有 bottom slot、移动到下方按钮、Show bottom panel 或底部留白。
- 旧 bottom 标签归回右侧且不关闭资源；右侧/Overlay 正常。
- 类型/聚焦测试/Web smoke；独立 Mac 新预览验证。

## handoff
完成。本轮只收敛下方面板，不把 Codex 全功能作为 OpenCraft 产品需求。

## checkpoint
- verified: 下方 Shell/移动/Show bottom panel 已移除；旧标签归位不关闭资源；Web 类型/6 项聚焦测试/完整 gate/Web smoke/文档检查通过；独立 Mac 预览实际确认 bottom 控件数量为 0，右侧终端最大化/恢复正常。
- unverified: 原 Codex 复刻的其余待办未在本轮扩大实施。
- restore: 新产物为 `opencraft/apps/workbench-electron/release/right-only-preview/mac-arm64/OpenCraft Preview.app`，签名校验通过。旧用户窗口和配置保留，未提交/push。
- next_action: 用户在新预览验收右侧工具与 Overlay。
