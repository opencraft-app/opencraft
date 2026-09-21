# Cloud Ladder Gateway

本服务把受认证的请求代理到 IDC/计费上游，并以 Proto 定义客户端可依赖的协议。

## 权威入口

- [服务说明](../README.md)、[Agent 约束](../AGENTS.md)、[目录记录](../catalog-info.yaml)
- 协议真源：`../proto/cloudladdergateway/v1/gateway.proto`
- [订阅与权益领域](../../docs/engineering/domains/subscription-entitlements.md)

## 关键边界

公网入口不得绕过 HMAC/mTLS；Starlark 条件不能引入外部副作用。异步 webhook 目前是进程内 goroutine，不是可靠队列。外部计费规则属于登记的外部 authority，不复制进本服务文档。

## 验证

修改 Proto 后运行 `make generate` 并检查 `gen/`；常规变更运行 `go test ./...`，代理路径还需覆盖认证失败、上游错误、审计字段与超时。
