## stage

CTL 改动和聚焦测试完成；下一步完成变更影响门禁并交接。

## verified

- `origin/master` 基线 `3bc4384e5`。
- 默认、命名、缺失与非法 Profile，以及消息过滤的 Python 脚本测试通过。
- CTL 测试断言每次历史请求只发起一次 TAT，实例归属拒绝不发起 TAT。
- 聚焦 Go test 与 go vet 通过。

## unverified

- 真实 Hermes CVM 的 TAT p95 延迟和并发容量；需要测试环境端到端验证。
- 全量 Go 测试受 CGO SQLite 与 rootless Docker 环境限制。

## discard

- 30–60 秒 Profile 缓存方案；删除 Bot 后短暂保留旧映射。

## restore

- 工作树：`/Users/pablozhong/.codex/worktrees/channel-history-single-exec/lightvela`。
- Task Pack：`docs/context/tasks/2026-10-10-channel-history-single-exec.md`。

## next_action

- 运行 staged change-impact 与文档检查，核对 diff 后交接。
