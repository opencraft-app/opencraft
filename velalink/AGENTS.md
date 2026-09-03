# VelaLink Agent 入口

本入口适用于 `velalink/`。读取仓库根 `AGENTS.md`、路由任务后，仅加载匹配的 deferred context：

- 桌面预览、ChatUI、工作监控、daemon 故障或本地 telemetry：`docs/context/project/services/velalink-desktop.md`
- 上游同步、导出或 `frontend` consumer pin：`docs/context/project/upstream-subtrees.md` 和 `velalink/MONO2_SUBTREE.md`
- vendored OpenAI Codex Rust 或 app-server 工作：`docs/context/project/services/velalink-codex-vendor.md` 加上最近的嵌套 `AGENTS.md`

硬约束：

- 使用 `make desktop-preview` 作为默认桌面反馈闭环；保持预览数据与打包 Vela 数据隔离。
- 变更桌面运行时行为前，诊断存活进程、端口、近期错误、span 和 SQLite 证据。
- 保留上游谱系，并区分 mono2 集成变更与必须回流上游的变更。
- 更新由 `frontend/` 消费的 VelaLink 行为，需要预期上游 pin 和 consumer 端验证。
- 运行聚焦 package 或 crate 测试，以及所加载服务指引定义的 formatter/type/lint 门禁。

绝不把本地预览、subtree 导入或构建产物视为发布完成。
