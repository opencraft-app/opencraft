# 积分包询价展示与实名购买门禁实施计划

> 执行说明：每项先补失败测试，再写最小实现并运行定向验证；所有前端源码修改完成后再同步 vendored 生成物。

**目标：** 使用积分询价返回值展示积分包价格、税费和总价；在已登录但没有完整影子账号绑定时禁用购买并引导实名认证；保持询价和下单的身份边界。

## 全局约束

- 价格真源是 `POST /v1/credit/inquiry`。
- `quote.price` 展示积分包价格，`quote.real_total_cost - quote.price` 展示税费，`quote.real_total_cost` 展示总价。
- 询价响应不完整或总价小于积分包价格时，商品状态为失败，卡片和购买入口不可用。
- 询价加载中保留业务引导：未登录显示“登录后购买”，无套餐显示“先开通套餐”，已具备购买资格的用户保持按钮 disabled 并显示“加载中…”。
- 不维护 `CreditPackPrice`、`CREDIT_PACK_PRICES` 或 `getCreditPackPrice`。
- 默认账号或 fallback UIN/AppID 只允许用于询价展示，不能进入下单、支付、资源创建或发货。
- 实名完成回到 `/account/billing?section=credits`。

## 文件职责

- `frontend/next-site/credit-pack-section.tsx`：询价状态、价格拆分、购买资格和实名入口。
- `frontend/next-site/subscribe-page.tsx`：从 Session 用户状态计算影子绑定/实名资格并传给积分包区域。
- `frontend/src/domain/credit-pack.ts`：商品、询价和订单契约；不包含固定价格表。
- `frontend/next-site/__tests__/credit-pack-section.test.tsx`：询价价格、税费拆分、门禁优先级和询价失败回归。
- `frontend/next-site/__tests__/credit-pack-section-timeout.test.tsx`：支付到账状态不受影响。
- `frontend/src/i18n/__tests__/dictionaries.test.ts`：只断言当前生成物中存在的词条。

## 任务 1：询价金额展示

- [x] 读取 `quote.price`、`quote.real_total_cost` 并转换为元。
- [x] 计算并展示税费差额和含税总价。
- [x] 对缺失金额、非法金额和总价小于价格的响应转为询价失败。
- [x] 展示“最终付款价格包含税费，请以付款页面显示为准。”

## 任务 2：实名/影子绑定购买门禁

- [x] 保留 `canPurchaseCreditPack` 与 `onRequireRealname` 属性。
- [x] gate 优先级为：未选择 → 未登录 → 无套餐 → 实名/影子绑定不完整 → 询价失败 → 询价加载中 → 可购买。
- [x] 询价加载中不抢占登录、套餐和实名引导。
- [x] 只有询价成功且通过实名门禁后才打开订单确认弹窗。
- [x] 下单返回绑定错误时显示实名引导，后端校验仍是最终权威。

## 任务 3：支付前置条件记录

- [x] 国内支付票据缺失时保留失败态，不生成无效二维码。
- [x] 国际支付链接缺失时保留失败态，不执行空链接跳转。
- [x] 下单请求只传商品标识，不传询价使用的默认账号身份。
- [x] 实名回跳使用 `/account/billing?section=credits`。

## 任务 4：验证与生成物

- [ ] 运行积分包聚焦测试：
  `pnpm exec vitest run next-site/__tests__/credit-pack-section.test.tsx next-site/__tests__/credit-pack-section-timeout.test.tsx`。
- [ ] 运行 i18n 字典测试、`pnpm i18n:check` 和 `pnpm i18n:validate`。
- [ ] 运行 `pnpm exec tsc --noEmit -p tsconfig.app.json` 或仓库规定的 `pnpm check`。
- [ ] 所有 `frontend/src` 修改完成后执行 `node opencraft/scripts/sync-mono2-agent-console.mjs`，再执行 `--check`。
- [ ] 运行 `git diff --check`，确认无空白错误。

## 验收结论

实现以询价接口为价格真源，按接口差值展示税费；固定价格方案已废弃。询价失败和支付票据缺失均保持不可购买或失败态，默认账号只服务价格展示，真实下单继续依赖用户自己的影子绑定。
