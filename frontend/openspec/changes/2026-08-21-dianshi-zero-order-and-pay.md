# 点石零元下单并支付链路

## 目标

询价返回 `real_total_cost = 0` 时，前端通过独立入口调用点石
`do_goods_and_pay`，不进入普通计费下单、支付页或自动续费流程。

## 契约

- 前端：`POST /v1/passes/dianshi/order-and-pay`
- CTL：复用新购参数校验，调用 Trade 专用 adapter
- Trade：`POST /internal/trade/dianshi/orders/place-and-pay`
- 点石：请求和响应结构与 `do_goods` 相同，仅 URL 和 `interfaceName` 改为
  `do_goods_and_pay`

## 交互

- 前端仅依据询价原始字段 `bundle.price.real_total_cost === 0` 分流。
- 确认框展示套餐、周期和零元总价，不展示绑卡、支付方式或自动续费。
- 确认后进入发货等待状态，轮询 Pass 生效并继续创建实例。
- 后端不重复校验价格为零，但 Trade 必须校验套餐命中点石活动，不允许回退计费。
