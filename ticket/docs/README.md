# 反馈与工单服务

`ticket` 是 LightVela 工单 v1 后端，按 `httpapi → service → store` 分层，并通过 realm 限制受理范围。

## 权威入口

- [服务说明](../README.md)、[Agent 约束](../AGENTS.md)、[目录记录](../catalog-info.yaml)
- API 真源：`../api/openapi.yaml`
- [服务拓扑](../../docs/engineering/architecture/service-topology.md)

## 核心不变量

受理人只能操作本 realm 工单，门禁位于 admin middleware；所有状态变更必须写入 `ticket_audit_log`。不得跨层从 HTTP handler 直连存储。

## 验证

运行 `go test ./...`，覆盖 realm 越权、合法/非法状态流转、审计落库和 API 错误；migration 由独立 GitOps job 管理。
