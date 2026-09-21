# Subscription

Subscription 是 LightVela 的订阅与权益服务，管理套餐、当前订阅、续费和支付结果应用。

- 工程入口：[docs/README.md](docs/README.md)
- Agent 入口：[AGENTS.md](AGENTS.md)
- API 真源：[api/openapi.yaml](api/openapi.yaml)

本地变更运行 `go test ./...`。数据库 migration 通过仓库级 GitOps DB job 执行，正式发布只认 Argo CD。
