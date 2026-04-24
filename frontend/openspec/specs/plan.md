# 套餐与订阅模块 (Plan & Subscription)

## 概述

套餐模块负责用户的**套餐选择、订阅状态管理、支付下单、权益（Pass）发放与查询**，
是产品的变现核心链路。与 `auth`、`marketing` 模块强耦合，并对接后端 `subscription/`
与 `payment/` 微服务。

## 页面 / 路由

| 路由 | 组件 | 守卫 | 职责 |
|------|------|------|------|
| `/plans/select` | `PlanSelectPage` | AuthenticatedGuard + PlanGuard | 首次登录时强制选套餐 |
| `/subscribe` | `SubscribePage` | MarketingAuthGuard | 套餐升级/续费（49KB，含支付 UI） |
| `/account` | `AccountPage` | MarketingAuthGuard | 查看当前订阅 + 权益 |
| `/account/orders` | `AccountOrdersPage` | MarketingAuthGuard | 订单列表与凭证 |

## 核心组件

- `pages/app/plan-select-page.tsx` — 首次登录套餐选择页（3.6KB，走 PlanGuard）
- `pages/marketing/subscribe-page.tsx` — **支付主页面**（49KB）：
  - 套餐卡片展示（Bundle 列表）
  - 支付方式选择（微信、支付宝、企业微信"即将支持"豆腐块）
  - 订单生成与轮询
  - 支付成功/失败态
- `components/domain/plan-card.tsx` — 套餐卡片（定价 / 特性 / CTA）
- `components/domain/billing-summary-card.tsx` — 计费摘要
- `domain/plan-catalog.ts` — 套餐目录常量（`free` / `lite` / `pro` 三档配置）
- `router/guards.tsx > PlanGuard` — 强制选套餐的路由守卫

## 数据流

### 领域模型 (`domain/types.ts`)

```
PlanTier       = "free" | "lite" | "pro"
SubscriptionStatus = "active" | "pending_payment" | "cancelled" | "expired"

CurrentSubscription {
  code: PlanTier,
  status: SubscriptionStatus,
  currentPeriodStart?, currentPeriodEnd?,
  updatedAt?, createdAt?
}

Bundle         // 上架套餐：id / name / price / features / tier
Pass           // 用户权益：bundleId / status / expiresAt
```

### API 层 (`PlanRepository`)

| 方法 | HTTP | 说明 |
|------|------|------|
| `getCurrentSubscription()` | GET | 当前订阅，返回 `CurrentSubscription \| null` |
| `getPlanPreview()` | GET | 套餐预览（含 `currentCandidate` / `plans` / `confirmationNeeded`） |
| `updateSubscription(tier)` | POST | 切换套餐（通常用于免费档） |
| `listBundles()` | GET /v1/bundles | 查询上架套餐（付费档） |
| `createPass(bundleId)` | POST /v1/passes | 购买套餐下单，返回 Pass |
| `listMyPasses()` | GET /v1/passes | 当前用户的权益列表 |

### 状态管理

- `SessionProvider.currentSubscription` — 全局订阅缓存
- 每次关键动作（支付成功、切换套餐）后重新拉取 `getCurrentSubscription` 刷新

## 业务规则

1. **首次登录强制选套餐**：`AuthenticatedGuard` + `PlanGuard` 协作，未选套餐的用户
   访问任何控制台页面都会重定向到 `/plans/select`。
2. **套餐分档**：
   - `free` — 免费体验（`updateSubscription("free")` 直接生效，无需支付）
   - `lite` / `pro` — 付费档，走 `listBundles` → `createPass(bundleId)` 下单流程
3. **支付流程**：
   - `createPass(bundleId)` 创建订单返回 Pass（含支付 URL / 二维码）
   - 前端轮询 Pass 状态或 Subscription 状态，支付完成后跳转 `success` 页
4. **企业微信支付**：暂未支持，在支付方式中以"企业微信（即将支持）"豆腐块呈现，
   放在最后一个位置。
5. **订单列表**：`account-orders-page.tsx` 展示历史 Pass 列表，支持筛选/凭证查看。
6. **权益过期**：`Pass.status` 包含过期状态，前端需根据 `expiresAt` 显示剩余天数提醒。

## 测试覆盖

- `plan-select-page.test.tsx` — 套餐选择主流程

## 相关后端服务

- `subscription/` — 订阅状态管理
- `payment/` — 支付网关与订单
- `ctl/` — 套餐规则与资源配额

## 已知待办

- `subscribe-page.tsx` 49KB 过大，未来可拆分「套餐卡片区」「支付方式区」
  「订单轮询区」「结果页」。
