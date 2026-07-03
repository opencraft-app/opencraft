# 电商与零售场景

## 1. 场景定义

适用于有商品、购物车、订单、支付、履约、退款、会员复购等链路的电商、零售、交易型平台。

## 2. 仓库命中信号

- 实体：`product`、`sku`、`category`、`cart`、`order`、`payment`、`refund`、`inventory`
- 页面：商品详情页、购物车、结算页、订单页、活动页
- 行为：`view_item`、`add_to_cart`、`begin_checkout`、`order_pay_success`、`refund_success`

## 3. North Star 候选

优先候选：**周支付买家数**；备选：GMV / 支付金额、毛利额 / 毛利率（若已具备成本数据）。

## 4. 默认优先推荐指标（含口径与埋点）

### 4.1 核心结果指标

| 指标 | 类型 | 何时推荐 | 建议口径 | 需要的埋点 / 数据 | 关键属性 / 常见切片 |
|---|---|---|---|---|---|
| GMV / 支付金额 | 核心结果 | 有支付成功订单 | 统计周期内 `order_pay_success` 订单的 `order_amount` 求和（毛额） | `order_pay_success` | `order_id`、`user_id`、`order_amount`、`currency`、`category`、`sku_id` |
| 支付订单数 | 核心结果 | 有订单支付状态 | 统计周期内支付成功的去重订单数 | `order_pay_success` | `order_id` 必须唯一 |
| 支付买家数 | 核心结果 | 能关联订单与用户 | 统计周期内发生支付成功的去重用户数 | `order_pay_success` | `user_id`、新老客、会员等级 |
| 支付转化率 | 核心结果 | 可稳定定义分母 | 默认总览：支付买家数 ÷ 到站访客数；同时推荐展示详情→加购→结算→支付分段转化 | `visit` + `order_pay_success` | 总览口径与漏斗口径不要混用 |
| 客单价 AOV | 核心结果 | 有支付金额和订单数 | GMV ÷ 支付订单数 | `order_pay_success` | 多币种需先折算 |
| 销售件数 | 核心结果 | 有订单明细 | 支付成功订单明细中的商品件数总和 | `order_item_paid` / 订单明细表 | `sku_id`、`quantity`、`category` |
| 复购率 | 核心结果 | 有用户历史订单 | 统计周期内支付 >= 2 单的买家数 ÷ 支付买家数 | `order_pay_success` + 历史订单表 | 若做 cohort 复购，需固定观察窗 |
| 毛利率 | 核心结果 | 已有成本数据 | (收入 - 成本) ÷ 收入 | 订单收入表 + 成本表 | 没有成本不要主推 |

### 4.2 诊断 / 护栏指标

| 指标 | 类型 | 何时推荐 | 建议口径 | 需要的埋点 / 数据 | 关键属性 / 常见切片 |
|---|---|---|---|---|---|
| 商品详情到加购转化率 | 诊断 | 有 PDP 与加购链路 | 发生 `add_to_cart` 的去重用户数 ÷ 发生 `view_item` 的去重用户数 | `view_item` + `add_to_cart` | `product_id` / `sku_id` |
| 结算发起率 | 诊断 | 有结算发起事件 | 发生 `begin_checkout` 的去重用户数 ÷ 发生 `add_to_cart` 的去重用户数 | `add_to_cart` + `begin_checkout` | 建议分新老客 |
| 购物车到支付转化率 | 诊断 | 交易漏斗完整 | 支付买家数 ÷ 加购用户数 | `add_to_cart` + `order_pay_success` | 也可拆两段 |
| 搜索到详情 / 加购转化率 | 诊断 | 搜索是核心入口 | 详情或加购用户数 ÷ 搜索用户数 | `search` + `search_result_click` + `view_item` / `add_to_cart` | `query`、`category` |
| 退款率（订单口径） | 护栏 | 有退款流程 | `refund_success` 去重订单数 ÷ 支付订单数 | `refund_success` + `order_pay_success` | 金额口径可单列 |
| 履约时效 | 护栏 | 有发货/签收流程 | `ship_success` 到 `order_pay_success` 的中位数小时数；或 `deliver_success` 到 `ship_success` 的中位数天数 | `order_pay_success` + `ship_success` / `deliver_success` | 按仓、物流商、区域拆分 |
| 缺货率 | 护栏 | 有库存状态 | `inventory_status=out_of_stock` 的商品曝光或下单尝试数 ÷ 商品曝光或下单尝试总数 | `view_item` / `order_create` + 库存状态 | 无库存状态不要硬算 |

## 5. 不要乱推

- 没有订单/支付，不要推荐 GMV、AOV、复购率。
- 没有稳定用户 ID，不要轻易推荐复购与新老客分析。
- 没有成本、库存、退款表时，不要假装经营质量已经可分析。
