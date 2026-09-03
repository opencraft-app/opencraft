# trade

用于商业计费集成、订单创建、支付回调处理和开通调用的 Go 服务。

## 边界

- 订阅、pass、配额和支付任务通过 `subscription-entitlements` 路由。
- 详细实现历史延后至 [trade 服务详情](../docs/context/project/services/trade.md)。
- 外部 jifei 与腾讯云计费规则是外部 authority；不得复制为仓库事实。

## 命令

```bash
cd trade
go test ./...
go vet ./...
```

## 硬规则

- 回调与开通变更需要幂等性测试。
- 在 provider 的成功创建 contract 满足前，不得调用 `ctl` 开通。
- 保留已有外部用户和订单标识；不得引入平行身份映射。
