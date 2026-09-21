# ctl

用于实例、渠道及实例编排的 Go 控制服务。

## 边界

- 公开 `/v1/instances` 行为依赖网关；直接 `ctl` 测试不能替代公共入口验证。
- Agent/运行时路由任务还要加载 `agent-gateway-runtime`。
- 详细指引延后至 [ctl 服务详情](../docs/context/project/services/ctl.md)。

## 命令

```bash
cd ctl
go test ./...
```

## 硬规则

- 实例归属和地域事实来自权威存储；不得从名称推断。
- 路由或上游变更须同时具备直连上游和公共路径测试。
- 渠道配置与实例归属变更应保持可分别审阅。
