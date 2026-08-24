# 韩国国际站签约卡管理前端接入 Spec

## Architecture

签约卡能力归属现有 `AuthRepository`。HTTP 实现复用统一 `request()`，继续携带 Cookie/Bearer、广播 401，并将 API 错误转换为 `RepositoryError`。`SavedCardsSection` 通过 `useRepositories()` 获取 Auth Repository，不直接调用 `fetch`。

## Contracts

- `listPaymentMethods(): Promise<PaymentMethodList>`
- `createPaymentMethodSignOrder(languageCode): Promise<PaymentMethodSignOrder>`
- `setDefaultPaymentMethod(contractCode): Promise<void>`
- `deletePaymentMethod(contractCode): Promise<void>`

`PaymentMethod` 只包含 `contractCode`、`maskedNumber`、`payerName`、`type`、`isDefault`。路径参数必须 `encodeURIComponent`。

## User Flow

### Load

组件挂载后查询第一页、每页 100 条。加载中保持稳定高度；成功后展示真实列表或空态。若后端返回 `503 payment_methods_unavailable`，组件返回 `null`，用于未启用该能力的国际环境。其他错误显示重试入口。

### Add Card

点击“添加卡片”后调用创建签约单接口，语言由当前 locale 映射为 `en | zh | hk`。接口成功后使用 `window.location.assign(redirectUrl)` 在当前页进入腾讯托管签约页。跳转前在 `sessionStorage` 记录接口返回的 `contractCode` 和客户端生成的 `deadlineAt`，不保存卡信息或凭据。

Auth 已固定回跳到 `/account/?payment-method=success|cancelled`。`SavedCardsSection` 是该参数的唯一 owner，挂载时捕获并立即清除 query，随后进入以下状态：

- `success_pending_sync`：若 sessionStorage 中有目标签约单，则在客户端 deadline 内有界刷新，直到列表出现相同 `contractCode`。
- `success_synced`：目标签约单可见；清理 sessionStorage 并展示成功提示。
- `success_timeout`：5 秒后仍不可见；停止自动轮询，保留手动刷新入口，不宣称绑定失败。
- `refresh_failed`：轮询遇到 429、503 以外的请求失败；停止自动轮询并展示手动重试。429 按 `retryAfterSeconds` 提示。
- `cancelled`：清理 sessionStorage，展示取消提示，不改变列表。
- 若回跳时 sessionStorage 已丢失，成功回跳只执行一次列表刷新并展示“结果已刷新”，不凭卡数量推断结果。

### Mutations

- 非默认卡显示“设为默认”；成功后刷新列表。
- 仅非默认卡显示“解绑”；用户二次确认后删除并刷新列表。
- 操作期间只禁用目标卡及相关操作，防止重复提交。
- `default_payment_method_cannot_delete` 显示上游约束文案；`429` 使用 `retryAfterSeconds` 提示稍后重试。

## Presentation

使用通用信用卡图标，展示后端返回的掩码卡号、持卡人名称和默认状态。不展示品牌、有效期或本地推断信息。继续沿用账号页现有 section 视觉，不引入新的卡片嵌套层级。

## Security

- LightVela 不渲染 PAN、有效期、CVC 输入框。
- 重定向 URL 必须是绝对 HTTPS URL，且 host 为国际站生产签约域名 `card.harvestsharp.com`、`centauriglobal.com` 或其子域；不满足时拒绝跳转并展示错误。
- 回跳 query 只驱动提示和刷新，最终状态始终以列表 API 为准。
- 不在 localStorage、sessionStorage 或日志中保存签约卡详情、contractCode 以外的敏感信息。

## Verification

- Repository 测试覆盖 URL、方法、body、路径编码和 204。
- 组件测试覆盖加载、空态、真实列表、创建签约单重定向、成功/取消回跳、同步成功/超时/刷新失败、设置默认、解绑、503 隐藏和业务错误。
- 运行定向 Vitest、`pnpm check`、`pnpm i18n:extract && pnpm i18n:check`、`pnpm build:global`。
