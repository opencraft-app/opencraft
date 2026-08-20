# 前端国际站计费流程说明

> 对应国内站文档：[`frontend-domestic-billing-flow.md`](./frontend-domestic-billing-flow.md)。两站共用 `subscribe-page.tsx` 同一组件，以编译期常量 `isGlobal` 分流；本文只讲差异部分。
>
> 后端接口契约见 [`codesign/ctl-frontend-billing-api.md`](../../codesign/ctl-frontend-billing-api.md)（§2 新购 / §3 续费 / 「国际站支付模式」章节）。

## 一、一句话概述

国际站走**信用卡订阅制**：前端 `createPassOrder` 下单 → `getPassOrderUrl` 换取米大师 hosted page 支付链接 → 新窗口打开付款 → 本页轮询 `listMyPasses` 等后台发货 → 自动创建实例并跳转。**强制自动续费**（无一次性购买选项），支付回跳场景由 `pay_return` 标记接棒续命轮询。

## 二、前置概念

| 概念 | 说明 | 代码位置 |
|---|---|---|
| **站点分流** | `isGlobal=true` 为国际站。编译期常量（`REGION=global` 构建），构建时折叠 | `src/lib/region.ts` |
| **计费灰度** | 国际站付费默认关闭，需显式开启才展示真实计费；未开启时回到「免费试用」老逻辑 | `runtime-config-context.tsx` → `resolvePaidBillingEnabled` |
| **强制订阅制** | 确认订单弹窗的自动续费为**只读说明**（非开关），`auto_renew_flag` 固定 `auto_renew` | `CreditCardConfirmOrderModal` |
| **价格单位** | 后端返回**分**，币种跟随 `bundle.price?.currency`（USD / KRW 等，缺失兜底 CNY），展示时按币种换算；确认订单弹窗币种符号跟随 `plan.price`（7a6bf73ee 修复，曾硬编码 `$` 导致 KRW 环境错显）；折扣仅后端有真实 `discount` 时展示 | `mapBundleToPlan` / `formatYuan` / `centsToYuan` |
| **支付回跳** | 弹窗拦截兜底走 `location.assign` 替换当前页，付款后 `return_url` 回到全新页面，需 `pay_return` 标记重建轮询 | `subscribe-page.tsx` → `PAY_RETURN_QUERY_KEY` |
| **免费试用** | 灰度未开启时国际站入口走 `POST /v1/passes`（直接发货，不支付） | `createPass` |

### 灰度开关（随 !2979 已合入 master）

```js
// 控制台执行，与国内站灰度期完全同一把钥匙：
localStorage.setItem("lightclaw:features.paidBillingEnabled", "true")
location.reload()
```

判定链（`resolvePaidBillingEnabled`）：

```
config.features.paidBillingEnabled !== true  → 关（后端可一键熔断，本地钥匙打不开）
                ↓ true
国内站 → 开（全量，零影响）
国际站 → hasExplicitPaidBillingOptIn()？
           localStorage "true" 或构建期环境变量显式 "true" → 开
           否则（含未配置/非法值）                        → 关
```

三个关键点：
1. **后端目前对所有站点硬编码下发 `true`**（`ctl/main/api/server.go`），所以后端下发值不能作为国际站放量信号，必须本地显式开启。
2. 构建期判断用「**显式配置过**」而非「解析结果为 true」——兜底默认值是 `true`，若按解析结果判断，未配置环境变量时灰度直接失效。
3. 灰度关闭时 `freeGuideAllowed` 翻转为 `true`：免费试用引导文案与 `createPass` 链路整体复活，是**回到老逻辑**而不只是隐藏价格。

## 三、时序图

```mermaid
sequenceDiagram
    participant U as 用户
    participant FE as 订阅页(前端)
    participant GW as service-gateway
    participant TR as trade(米大师)

    U->>FE: 点「订阅」
    FE->>GW: createPassOrder(bundle_id, period, time_unit, auto_renew_flag="auto_renew")
    GW->>TR: PlaceOrder（新购）
    TR-->>FE: deal_names
    FE->>GW: getPassOrderUrl(deal_names, platform="pc", cancel_url, return_url)
    TR-->>FE: pay_url（hosted page）
    FE->>U: 同步 window.open("about:blank") 占位 → payWindow.location = pay_url
    Note over FE: 占位窗口必须同步开：先 await 再赋值会触发弹窗拦截

    alt 新窗口正常打开
        Note over FE: 原窗口留 paying 态，loop 每 3s 轮询 listMyPasses
        U->>TR: 在新窗口完成付款
        TR-->>FE: 发货（轮询到有效 active pass）
        FE->>FE: finalizeBot（建实例→跳转）
    else 弹窗被拦截（fallback）
        FE->>U: window.location.assign(pay_url) 替换当前页
        U->>TR: 付款
        TR-->>FE: return_url 回跳 /subscribe?pay_return=1&pay_plan=<bundleId>
        Note over FE: 原窗口轮询已随页面销毁
        FE->>FE: 识别标记→清 query→进 paying→重建轮询→发货→finalizeBot
    end

    loop 每 3s（180s 超时后仅切「开通中」文案，不停止）
        FE->>GW: listMyPasses
        GW-->>FE: active pass ? 发货完成 : 继续
    end
```

## 四、阶段细节

### 阶段 1：确认订单（`CreditCardConfirmOrderModal`）

- 自动续费为只读说明行（`RefreshCw` 图标 + 「可随时在账号管理页取消」），**无开关**——商业决策为订阅制后，不给一个点了会被拦的假开关。
- `onPay(true)`：`auto_renew_flag` 固定 `auto_renew`。
- **`auto_renew_flag` 与 `ContractOrder` 完全解耦**（契约文档「国际站支付模式」）：该字段只写入新购订单 `goodsDetail.autoRenewFlag`；是否发起签约由 trade 查用户绑卡状态决定（未绑卡 `ContractOrder=1` 签约并支付，已绑卡直接用现有卡）。前端不需要、也不应该干预签约。

### 阶段 2：下单与支付链接（`startIntlCardPay`）

```ts
// 1. 下单
createPassOrder({ bundle_id, period, time_unit, auto_renew_flag: "auto_renew" })
// 2. 换支付页 URL（PC 端 Bearer 鉴权）
getPassOrderUrl({
  deal_names, platform: "pc",
  cancel_url: payRedirectBase,          // 当前页地址
  return_url: `${payRedirectBase}?pay_return=1&pay_plan=${planId}`,
})
```

回跳地址规则：
- 用 `window.location.href.split("#")[0].split("?")[0]` 去掉 query/hash——**防止把 OAuth code / 一次性 ticket 拼进计费回跳地址**。
- 协议上 `cancel_url`/`return_url` 可选（不传时 trade 用环境兜底 `TRADE_BILLING_PAY_REDIRECT_URL`），但显式传可避免被兜底带到别的页面。
- 账号页续费同理（`renew-pass-modal.tsx` 国际站分支），否则 KR 兜底写死 `/subscribe`，用户付完被从账号页扔到订阅页。

### 阶段 3：两条接棒路径

| 路径 | 触发条件 | 接棒方式 |
|---|---|---|
| ① 新窗口轮询 | 占位窗口成功打开，原窗口留 `paying` 态 | 原窗口轮询命中 pass → `finalizeBot` |
| ② 支付回跳 | 弹窗被拦截，`location.assign` 替换当前页 | 回跳页识别 `pay_return=1` → 清 query → 进 `paying` → 重建轮询 → `finalizeBot` |

路径②的守卫：
- `payReturnHandledRef`：只接管一次，标记用完立即从 URL 清除（`history.replaceState`），防刷新重复触发。
- 前置条件：`authReady && isAuthenticated && planList.length > 0`——`planList` 为空找不到 plan 无法 finalize。
- `pay_plan` 解析失败（链接被改 / 套餐下架）：不进 paying，仅 `refreshPasses()` 刷当前订阅，避免卡在永远等不到结果的弹窗里。

### 阶段 4：轮询与超时

- 间隔 `PAY_POLL_INTERVAL_MS=3s`，超时 `PAY_POLL_TIMEOUT_MS=180s`。
- **超时后不停止轮询**，仅将弹窗切为「开通稍有延迟，本页会自动完成，请勿关闭」——「我已完成支付」手动确认按钮已移除（`onManualConfirm`/`handleManualConfirm` 同步删除），轮询是唯一自动接棒途径，停了发货慢的用户永远等不到自动开通。轮询随弹窗关闭（effect cleanup）终止。
- 回跳等待态无二维码无 `pay_url`：渲染 `Loader2` 转圈 + 「正在开通套餐」；不渲染「重新打开支付页」死按钮。

### 阶段 5：finalizeBot（幂等）

```
闸门① finalizingRef（同步 ref，finally 复位）→ 拦并发
闸门② botsRef.current[0] 已有实例 → 只跳转不创建
addBot → 埋点 → subscribe() → 关弹窗 → navigate(/agents?creating=<botId>)
```

两道闸门防的是路径①原窗口与路径②回跳页**双开导致重复建实例**（用户要为多余实例付费）。

**已知局限**：两 tab 各自独立 React 实例、独立 `finalizingRef`，闸门①拦不住跨 tab 并发；闸门②依赖 `bots` 新鲜度，双 tab 同时通过检查仍可能各建一个。彻底解决需后端按 `pass_id` 幂等——已多次提醒跟进。

## 五、状态机

```
closed ──选套餐下单──▶ paying ──轮询到 pass──▶ finalizeBot ──▶ closed(跳转实例页)
                         │
                         ├──弹窗被拦截──▶ assign(pay_url) ──付款──▶ 回跳(pay_return=1)──▶ paying
                         └──轮询超 180s──▶ 文案切「开通中」（轮询继续）
```

## 六、与国内站的差异速查

| 维度 | 国内站 | 国际站 |
|---|---|---|
| 支付方式 | bridge 中转页 + 微信扫码 | 信用卡 hosted page 新窗口 |
| 自动续费 | 米大师签约模板 | 强制订阅制（只读说明） |
| 实名 | 手机号实名（`realnamePhoneVerificationEnabled`） | 无 |
| 计费开关 | 全量开启 | 灰度默认关闭（localStorage 显式开启） |
| 免费试用 | 走 `createPassOrder` 真实下单 | 灰度未开时走 `createPass` 直接领 |
| 轮询超时 | 同左 | 同左（两站共用同一 effect） |

## 七、已知遗留与坑点

| # | 问题 | 现状 |
|---|---|---|
| 1 | 跨 tab 重复建实例风险（见阶段 5） | 待后端按 `pass_id` 幂等 |
| 2 | `agent-settings-page.tsx` 存在 `isCN &&` 硬守卫 | 国际站灰度开启后该页付费 UI 仍不展示（订阅页/账号页正常） |
| 3 | 灰度关闭态 = 整套老逻辑回归 | 需实测确认免费试用文案与 `createPass` 行为 |
| 4 | `realnamePhoneVerificationEnabled` 的 localStorage override 与付费开关共用一把钥匙体系 | 灰度调试时注意别误开实名 |
| 5 | 国际站曾用 staging 构建期 `PAID_BILLING_ENABLED=true` | 已在 `release-matrix.json` 移除，四环境统一走灰度 |

## 八、文件索引

| 文件 | 职责 |
|---|---|
| `next-site/subscribe-page.tsx` | 主流程：`startIntlCardPay` / 支付回跳 / 轮询 / `finalizeBot` / `CreditCardConfirmOrderModal` |
| `src/pages/marketing/renew-pass-modal.tsx` | 账号页续费（国际站分支：`createRenewOrder` + `getRenewOrderUrl` + 回跳地址） |
| `src/contexts/runtime-config-context.tsx` | 灰度开关 `resolvePaidBillingEnabled` / `hasExplicitPaidBillingOptIn` |
| `release-matrix.json` | 各环境构建期环境变量（付费开关已全部 unset） |
| `src/lib/region.ts` | `isGlobal` 编译期站点常量 |
| `src/repositories/http-repositories.ts` | `createPassOrder` / `getPassOrderUrl` / `createRenewOrder` / `getRenewOrderUrl` / `listMyPasses` / `createPass` |
| `codesign/ctl-frontend-billing-api.md` | 后端契约（支付 URL 接口 / 字段说明 / 国际站支付模式 / 透传关系） |
