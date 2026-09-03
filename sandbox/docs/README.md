# Sandbox 实例池

Sandbox 管理 Agent 运行机器的库存和状态转换。请求路径只分配/释放，后台 worker 才执行重置、清理和补货。

## 权威入口

- [服务说明](../README.md)、[Agent 约束](../AGENTS.md)、[目录记录](../catalog-info.yaml)
- API 真源：`../openapi.yaml`
- [Sandbox 开发指南](../../docs/agent-guides/sandbox-agent-guide.md)

## 核心不变量

状态机为 `CREATING → CLEAN → ALLOCATED → DRY → RESETTING → CLEAN`，失败/销毁走显式状态。并发分配依赖存储行锁和 `expected_state` 条件更新；不得用直改数据库代替 API 或 rollout 工具。

## 验证

运行 `go test ./...` 与 `scripts/e2e/run.sh`，状态变更覆盖合法/非法转移、并发分配和失败恢复。发布或镜像切换必须使用对应 runbook 并单独取得授权。
