# 韩国国际站签约卡管理前端接入 Proposal

## Goal

将国际站账号页现有的演示卡片组件接入 Auth 已发布的签约卡管理 API，使用户可以查看真实签约卡、跳转腾讯托管页绑卡、设置默认卡和解绑非默认卡。

## Acceptance Criteria

- 国际站账号页不再展示三张演示卡，也不再收集卡号、有效期或 CVC。
- 已登录且能力可用时，页面展示 `GET /auth/payment-methods` 返回的真实卡片。
- “添加卡片”调用 `POST /auth/payment-methods/sign-orders` 并跳转返回的 HTTPS 托管页。
- 托管页回到 `/account/?payment-method=success|cancelled` 后，页面消费并清理回跳参数；成功时刷新卡列表。
- 非默认卡可设为默认或解绑；默认卡不可解绑。
- 加载显示稳定占位，空列表显示空态；一般失败与限流显示重试入口，`503 payment_methods_unavailable` 隐藏整个区域，mutation 失败保留当前列表并显示行内错误。
- 国内站构建不展示签约卡区域。

## Scope

- 前端领域类型、Repository 接口及 HTTP/Fake 实现。
- `SavedCardsSection` 的真实数据与托管绑卡交互。
- Repository 与组件级回归测试。

## Non-goals

- 不修改 Auth、Shadow、Service Gateway 或腾讯计费接口。
- 不在 LightVela 页面采集或保存 PAN、有效期、CVC。
- 不推断后端未提供的卡品牌和有效期。
- 不自动化第三方托管绑卡页面。
