# Credit

Credit 是 LightVela 的独立积分服务，当前负责付费积分商品、一次性积分资源包、精确用量和每日计费推量。

服务提供用户询价、下单并支付、退款和积分包查询入口，并通过 Trade 适配外部计费订单与回调。
积分额度来自 LLMGateway plan；Credit 自主管理资源包自然到期，按精确订阅删除后将 live package 和
用量记录原子迁入历史表。

工程边界和验证命令见 [服务文档](docs/README.md)，Agent 实现约束见 [AGENTS.md](AGENTS.md)。
