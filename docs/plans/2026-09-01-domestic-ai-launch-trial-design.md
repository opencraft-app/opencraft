# 国内 AI 型启航套餐三天免费后端设计

## 目标

国内站 `bundle_launch_ai_01` 改为与启航型相同的点石询价周期策略：询价使用前端请求周期，后续运营将 DB 活动时长改为 `3d` 后，下单仍使用 DB 中的真实时长。

## 范围

- 仅修改 `trade` 后端。
- 不修改国内站前端展示或订阅入口。
- 本次不修改上海正式环境 DB。
- 不修改续费、退款和非点石下单链路。

## 现状

- `bundle_launch_01` 的点石询价周期取请求值。
- `bundle_launch_ai_01` 仅国际站取请求值，国内站取 `trade_bundle_activity.time_span_unit`。
- 点石下单已统一解析 `trade_bundle_activity.time_span_unit`，并将真实周期写入点石请求、`trade_order` 和 `goods_detail`。

## 设计

`dianshiInquiryTimeSpanUnit` 使用精确 bundle 白名单判断：

- `bundle_launch_01`：保持现状，询价周期取请求值。
- `bundle_launch_ai_01`：不再区分站点，询价周期取请求值。
- 其他 bundle：保持现状，询价周期取活动映射的 `time_span_unit`。

不硬编码 `1m`。前端请求 `1m` 时传给点石 `1m`，请求 `3m` 时传给点石 `3m`。因此季付询价不会被错误改写为月付。

下单逻辑不改。运营后续把国内 AI 型启航活动的 `time_span_unit` 从 `1m` 更新为 `3d` 后，点石下单参数和本地订单记录都会使用 `3d`。

## 测试

- 国内 AI 型启航月付：活动映射为 `3d`，询价参数仍为 `1m`。
- 国内 AI 型启航季付：活动映射为 `3d`，询价参数为 `3m`。
- 国际 AI 型启航：现有月付询价行为保持 `1m`。
- 其他套餐：继续使用活动映射时长，证明特殊逻辑未扩散。
- 点石下单：活动映射为 `3d` 时，点石参数、`trade_order` 和 `goods_detail` 均记录 `3d`。

## 发布与数据

代码发布后再由运营修改上海正式库中 `bundle_launch_ai_01` 对应活动行的 `time_span_unit`。本次代码变更不包含 migration 或线上数据操作。
