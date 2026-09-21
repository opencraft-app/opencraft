# VelaLink 桌面与 Chat UI

`velalink` 包含桌面壳、Chat UI、daemon、观测客户端和 vendored OpenAI Codex；不同边界需要加载不同的延后 Context，而不是一次读完整 subtree。

## 权威入口

- [项目说明](../README.md)、[Agent 入口](../AGENTS.md)、[目录记录](../catalog-info.yaml)
- [Subtree 契约](../MONO2_SUBTREE.md)
- [上游与平台治理](../../docs/engineering/platform/README.md)

## 关键边界

默认桌面反馈闭环使用 `make desktop-preview`，预览数据与打包 Vela 数据隔离。运行时问题先检查进程、端口、近期错误、span 和 SQLite。vendored Codex 正文由上游拥有，只记录本地集成与 pin。

## 验证

运行受影响 package/crate 的 formatter、type、lint 和 test；frontend consumer 行为变化还需验证上游 pin 与消费端，不把预览成功视为正式发布。
