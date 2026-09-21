# Trade

Trade 是 LightVela 的交易与商业计费集成服务，处理订单创建、支付回调、provider 调用与成功后的 CTL 开通。

- 工程入口：[docs/README.md](docs/README.md)
- Agent 入口：[AGENTS.md](AGENTS.md)
- 跨服务流程：[../docs/engineering/journeys/subscription-purchase-renewal.md](../docs/engineering/journeys/subscription-purchase-renewal.md)

本地修改运行 `go test ./...` 与 `go vet ./...`。外部计费实时规则必须回到登记 authority 校验。
