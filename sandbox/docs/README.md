# Sandbox 实例池

Sandbox 管理 Agent 运行机器的库存和状态转换。请求路径只分配/释放，后台 worker 才执行重置、清理和补货。

## 权威入口

- [服务说明](../README.md)、[Agent 约束](../AGENTS.md)、[目录记录](../catalog-info.yaml)
- API 真源：`../openapi.yaml`
- [Sandbox 开发指南](../../docs/agent-guides/sandbox-agent-guide.md)

## 核心不变量

常规库存状态机为 `CREATING → CLEAN → ALLOCATED → DRY → RESETTING → CLEAN`，失败/销毁走显式状态。在线升配单独使用 `ALLOCATED → MODIFYING → ALLOCATED`，由持久化 operation 记录停机、改计算规格、扩盘、开机、校验和 Pool 重绑进度。并发分配依赖存储行锁和 `expected_state` 条件更新；不得用直改数据库代替 API 或 rollout 工具。

## 验证

运行 `GOWORK=off go test ./...` 与 `scripts/e2e/run.sh`，状态变更覆盖合法/非法转移、并发分配、升配幂等续跑和失败恢复。发布或镜像切换必须使用对应 runbook 并单独取得授权。
