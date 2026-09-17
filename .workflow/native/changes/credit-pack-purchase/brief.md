# 积分包购买 — 前端 UI（支付降级）

**change**: credit-pack-purchase
**日期**: 2026-09-10
**基线**: `origin/master@fd60fa3f1`
**范围决策**: 仅前端 UI + 询价；支付与逐包明细留接口位，等后端补齐再联调

---

## 1. 需求

在国内站/国际站 `/subscribe` 增加「补充模型积分」区域，在 `/account` 把积分展示从单套餐升级为多来源汇总。产品方案见用户输入（15 章完整版）。

本 change **只做前端可独立交付的部分**，不改 Go 后端。

---

## 2. 现场调查结论（独立核实，非照抄产品方案）

### 2.1 后端现有能力

Credit 服务路由真源 `credit/internal/httpapi/server.go:35-53`，全 HTTP+JSON，鉴权走 `X-User-Id` 请求头（网关注入）：

| 接口 | 可用性 |
|---|---|
| `GET /v1/credit/products` | 可用，但**无 credit_total / price** |
| `POST /v1/credit/inquiry` | **可用**（本 change 主要依赖） |
| `POST /v1/credit/packages/order` | 可用，但**不返回支付地址** |
| `POST /v1/credit/packages/order-and-pay` | 可用（仅联调语义） |
| `GET /v1/credit/packages` | 可用，但**不返回 package_id** |

### 2.2 三处硬阻塞（前端无法绕过）

**A. 支付地址恒空** — `trade/internal/logic/creditorder/service.go:178,229`

```go
return s.writeOrder(ctx, normalized, def, resp.BigDealID, resp.DealNames[0], status, "", "")
//                                                                    payURL ↑ 恒为空字符串
```

order 响应只有 `{dealName, bigOrderId}`。对比套餐链路 `CreatePassOrderResult { deal_names, auth_code }`（`frontend/src/domain/types.ts:381-403`）——积分包拿不到微信二维码，也拿不到信用卡托管页地址。**支付流程无法闭环。**

**B. 查询结果无 package_id** — `credit/AGENTS.md:79` 明文契约

> 查询结果只返回 `credit_type/credit_total/credit_available/expired_time`。

`CreditItem` 定义在 `credit/internal/service/service.go:265-270`，确无 ID 字段。后果：无法稳定标识单个积分包，无法关联 `order_id` 判定「本次订单已到账」。

**C. 套餐积分不在 credit 服务** — `credit/AGENTS.md:3`

> 当前实现付费积分包；免费积分和套餐积分的入口迁移后续再补。

`credit_type` 仅 `paid`/`free`。账号页现有积分来自套餐 pass：

```
frontend/src/pages/marketing/account-page.tsx:872-876
const creditsTotal = operablePass ? operablePass.credit_total : 0;
```

要做统一明细，前端须合并 **pass + credit 两套数据源**。

### 2.3 前端现状

- 前端**零接入**：`grep 'v1/credit|credit/packages|credit/inquiry'` 在 `frontend/` 下无命中
- `frontend/next-site/subscribe-page.tsx` 3938 行（Next.js App Router 公开站）
  - 已有 `ConfirmOrderModal:2048`、`PaymentPendingModal:2446` 可作交互范式参考
- `frontend/src/pages/marketing/account-page.tsx` 1995 行（Vite SPA 控制台）
- **两页分属不同渲染体系**，i18n 机制不同（见 3.3）

---

## 3. 方案

### 3.1 `/subscribe` 积分包区域

位置：现有套餐卡片区下方，独立分区。5 张面额卡片（1000/2000/4000/8000/12000）。

数据来源：
- 积分数量 —— **本期硬编码在前端常量表**。理由：`products` 接口无 `credit_total`，且 `credit/AGENTS.md:22` 禁止在 `credit_product` 表新增该字段；产品方案 10.1 要求「接口层按 LLM Gateway plan 派生」属后端改造，不在本次范围。常量表须与后端 `product_id` 一一对应，并留注释指向后端待补字段。
- 价格 —— 走真实 `POST /v1/credit/inquiry`（国内 CNY / 国际 USD）
- 单卡询价失败只禁用该卡，不影响其他卡（产品方案 9）

主按钮五态按产品方案 6.3 实现（未选/可购/未登录/无套餐/询价失败）。

### 3.2 支付降级：feature flag 默认关闭（已确认）

订单确认弹窗 UI 完整实现（商品、有效期、1 份、金额、支付方式、虚拟商品条款勾选），但**整个积分包购买入口由 feature flag 控制，默认关闭**。

- flag 关闭（默认）：`/subscribe` 不渲染积分包区域，`/account` 不显示「购买积分包」入口
- flag 开启：区域可见，可询价、可选卡、可打开确认弹窗

**零真实订单**：本期不调用 `POST /v1/credit/packages/order`，不产生任何待支付订单。确认弹窗的支付按钮在 flag 开启时点击后提示「支付通道接入中」，不发起下单请求。

理由：`payURL` 恒空导致支付无法闭环，若真实落单会在后端积累无法支付的孤儿订单。

flag 实现方式在 build 阶段按仓库现有惯例选型（优先复用已有开关机制，无则用构建期常量），需可在不发版的前提下评估开启成本。

### 3.3 i18n 约束（两套体系）

- `/subscribe` 属 Next.js 公开站，被 `PublicSiteLocaleBridge` → `LocaleOverrideProvider` 覆盖语言
- `/account` 属 SPA，走全局 i18n 单例读 localStorage
- 新增中文文案必须走 `t("中文原文")` + `frontend/src/i18n/generated/zh-to-key.json` 反查表闭环，7 个 locale 同步（zh-CN/zh-Hant/en/es/id/ja/ko）

### 3.4 `/account` 多来源汇总

汇总区：当前可用 / 当前额度 / 已使用 / 来源数量 + 「购买积分包」入口。
数据 = 套餐 pass（现有 `operablePass`）+ `GET /v1/credit/packages`（新接入）合并。

**逐包明细降级**：因无 `package_id`，用 `${credit_type}-${credit_total}-${expired_time}` 组合作为 React key 与去重依据。已知限制：同额度且到期时间完全相同的两个包会冲突（同一秒下单两笔同额度包，概率极低但存在）。此为**临时方案**，后端补 `package_id` 后必须替换，代码中留 TODO 标记。

排序按产品方案 8.2：到期时间早的在前 → 购买时间早的在前 → 稳定 ID。因缺购买时间与稳定 ID，本期仅按 `expired_time` 排序，同时间保持接口返回顺序。

---

## 4. 不做（明确排除）

- 任何 Go 后端改动（payURL、package_id、products 派生字段、退款落闸、资格校验）
- 真实下单与支付（不调 `order` 接口，不产生任何订单）
- 到账确认与 `delivered` 状态判定（依赖 order_id ↔ package 关联）
- 3 个月包、数量选择器、自动续费、优惠券、退款入口
- `/subscribe` 裸路由语言 bug（用户已决定暂缓，见 5.1 风险）

---

## 5. 已知风险（用户已知悉并确认）

### 5.1 与暂缓的语言 bug 直接冲突（本期接受）

产品方案 5 要求 `/account` 的「购买积分包」跳转 `/subscribe?section=credits`——这正是**裸路由** `/subscribe`。而已确诊的 bug（`next-site/subscribe-page-client.tsx:12` 默认 `locale = DEFAULT_PUBLIC_ROUTE_LOCALE.locale`，国际站为 `en-US`，经 `LocaleOverrideProvider` 硬覆盖）会导致：

> 国际站中文用户从账号页点「购买积分包」→ 跳到裸 `/subscribe` → **新增的积分包区域全部显示英文**

即本 change 的核心入口链路必然踩中该 bug。

**用户已确认本期不修**。缓解因素：feature flag 默认关闭，积分包区域不对外可见，因此该缺陷在 flag 开启前不会暴露给真实用户。**但 flag 开启前必须先修复此 bug**，否则国际站中文用户一开启就会看到整块英文——此项列为上线前置条件，写入 report.md 遗留事项。

---

## 6. 验证口径

- `npx tsc --noEmit` exit 0
- 新增组件单测：卡片渲染、五态按钮、询价失败降级、账号页多来源汇总计算（可用/额度/已使用）
- i18n 闭环校验：新增中文 → zh-to-key 命中 → 7 locale 均有值，无残留硬编码中文
- 现有测试不回归（`subscribe-page.test.tsx` 等）
- 手工验证需用户在真实环境确认（询价接口连通性、双站币种）
