## stage
嵌入式 Chat 启动选择修复和变更影响门禁已完成，等待最终交接。

## verified
- Firefox 上出错时 `thread/resume` 返回 Hermes 4007 `session not found`；侧栏另一已有会话能加载并在刷新后恢复。
- 配置式嵌入 Host 现在只读取当前 Host 的 Thread 记忆；普通 Workbench 保留全局旧键回退。
- 定向测试 25/25、Workbench Web 类型检查、嵌入版构建和平台边界检查通过。
- 变更影响与文档校验通过。

## unverified
- 新源码尚未部署，不能确认生产页已修复；初始失效 ID 的浏览器存储来源未直接捕获。

## discard
- `config/read`、`connectors/managed/list` 的不支持提示与这次恢复请求无已证实因果关系。

## restore
- 隔离 worktree：`/Users/pablozhong/.codex/worktrees/firefox-chat-restore/lightvela`。
- Task Pack：`docs/context/tasks/2026-10-01-firefox-embedded-chat-restore.md`。

## next_action
- 检查最终 diff 后取消暂存并交接未提交补丁。
