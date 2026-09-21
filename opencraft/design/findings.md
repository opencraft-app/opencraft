# Codex 参考与当前差异

参考基线：本地 `ref/codex` 恢复源码，非当前线上完整行为证明。

- `RightPanelComposerOverlay` 是主会话的呈现，不创建第二个主会话。普通 Composer 与展开工具 Composer 在页面分支互斥；Side Chat/后台 Agent 标签不叠加主输入框。
- 主身份、草稿 key、标签身份、资源身份分别建模；DOM 不承担持久化或资源所有权。
- 标签移动不执行关闭回调；显式关闭按类型策略释放资源。
- Codex tab state 写入验证渲染实例和版本；浏览器挂载使用实例/代际检查。
- OpenCraft 已有 composer-core、HostRuntime、BrowserRuntime、TerminalRuntime 和 Cordis WorkbenchPanelService；优先接通，不另建平行 owner。
- 现有面板 reducer 支持 right/bottom 状态，但目前只看到同区域 reorder；待检查跨区域 UI 和主 Composer 路径。

架构事实以专题设计和当前源码/测试为准；本文件仅为本轮发现账本。
