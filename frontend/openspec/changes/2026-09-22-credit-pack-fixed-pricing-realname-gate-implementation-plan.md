# 积分包固定价格与实名购买门禁实施计划

> **执行说明：** 按任务逐项实施；每项先补失败测试，再写最小实现并运行定向验证。

**目标：** 为积分包提供截图确认的固定价格，展示税费说明，并在已登录但没有完整影子账号绑定时禁用购买、引导实名认证。

**架构：** 前端固定价格表作为卡片展示真源，积分询价接口只保留在线商品和支付链路兼容；购买资格由订阅页传入的用户实名/影子绑定信息决定。下单前端门禁与后端严格影子绑定校验同时保留，fallback 身份不进入订单链路。

**技术栈：** React 19、TypeScript、Next.js 静态页面、Vitest、Testing Library、现有 Repository/Session Context、现有账号页 `realname_required` / `return_to` 跳转约定。

## 全局约束

- 固定价格：国内 `1200/2400/4500/9000/13500` 分；国际 `180/360/650/1300/2000` 美分。
- 页面不计算税费金额，必须显示“最终付款价格包含税费，请以付款页面显示为准。”
- fallback UIN/AppID 只用于询价展示，不能用于下单、支付、资源创建或发货。
- 已登录但影子绑定不完整时价格可见，购买按钮必须 disabled，并提供实名入口。
- 实名完成回到 `/account/billing?section=credits`。
- 不修改套餐购买、续费及其他支付链路。

## 文件职责

- `frontend/src/domain/credit-pack.ts`：固定价格类型、站点价格表与金额选择函数。
- `frontend/next-site/credit-pack-section.tsx`：价格卡片、税费提示、购买资格与实名入口。
- `frontend/next-site/subscribe-page.tsx`：从 Session 用户状态计算完整影子绑定/实名资格并传给积分包区域。
- `frontend/src/repositories/types.ts`、`frontend/src/repositories/http-repositories.ts`、`frontend/src/repositories/fake-repositories.ts`：保持接口兼容；必要时给下单错误提供可识别类型。
- `frontend/next-site/__tests__/credit-pack-section.test.tsx`：固定价格、税费提示、未绑定门禁与实名跳转回归。
- `frontend/next-site/__tests__/credit-pack-section-timeout.test.tsx`：确保支付成功/到账现有行为不受影响。

---

### 任务 1：固定价格领域模型

**文件：**

- 修改：`frontend/src/domain/credit-pack.ts`
- 测试：`frontend/src/domain/__tests__/credit-pack.test.ts`（若无该目录则新建）

**接口：**

- 产出 `CreditPackPrice` 与 `CREDIT_PACK_PRICES`，按 `product_id` 保存 `cnCents`、`globalCents`。
- 产出 `getCreditPackPrice(productId, currency): string | null`，返回最小货币单位字符串，未知商品返回 `null`。

- [ ] 先写失败测试：验证五个商品在 CNY/USD 下分别返回 `1200/2400/4500/9000/13500` 与 `180/360/650/1300/2000`。
- [ ] 运行：`cd frontend && pnpm exec vitest run src/domain/__tests__/credit-pack.test.ts`；预期新断言失败。
- [ ] 添加固定价格表和纯函数；不改 `CREDIT_PACK_DENOMINATIONS` 的积分数量来源。
- [ ] 重跑同一测试；预期全部通过。

### 任务 2：积分包卡片改用固定价格并提示税费

**文件：**

- 修改：`frontend/next-site/credit-pack-section.tsx`
- 测试：`frontend/next-site/__tests__/credit-pack-section.test.tsx`

**接口：**

- 询价成功后仍保存商品状态，但展示金额改从任务 1 的固定价格表计算。
- 卡片保留“积分包价格”，增加税费提示；不渲染可计算的 tax 数值，也不把标价称为最终总价。

- [ ] 先补测试：国内五档卡片显示固定金额；国际站切换后显示美元固定金额；税费提示存在且未出现 `税费：0`。
- [ ] 运行目标测试，预期新增断言失败。
- [ ] 移除卡片金额对 `quote.price` / `quote.real_total_cost` 的展示依赖；当接口询价失败时仍按既有错误态处理支付准备，但固定价格卡片不显示后端临时价格。
- [ ] 增加准确税费提示文案，并通过 `useT()` 接入现有 i18n 机制。
- [ ] 运行 `cd frontend && pnpm exec vitest run next-site/__tests__/credit-pack-section.test.tsx`，预期通过。

### 任务 3：实名/影子绑定购买门禁

**文件：**

- 修改：`frontend/next-site/subscribe-page.tsx`
- 修改：`frontend/next-site/credit-pack-section.tsx`
- 修改：`frontend/src/domain/types.ts`（仅在现有 User 类型缺少所需字段时）
- 测试：`frontend/next-site/__tests__/credit-pack-section.test.tsx`

**接口：**

- `CreditPackSectionProps` 增加 `canPurchaseCreditPack: boolean` 与 `onRequireRealname: () => void`。
- `subscribe-page.tsx` 使用当前 Session 用户状态计算资格：国内站需达到现有实名完成条件；影子同步处于 pending/failed 或绑定字段不完整时均为不可购买。国际站沿用当前站点规则，不新增实名流程。
- 新增 gate `realname-required`，优先级为：未选择 → 未登录 → 无套餐 → 实名/影子绑定不完整 → 询价失败 → 可购买。

- [ ] 先补测试：已登录、有套餐、无完整绑定时卡片仍有固定价格；主按钮有 `disabled`；显示“完成实名后购买”；点击实名入口调用导航回 `/account?realname_required=1&return_to=/account/billing?section=credits`。
- [ ] 运行目标测试，预期新增断言失败。
- [ ] 实现资格计算和 gate；disabled 状态不得通过 click handler 触发下单或询价重试。
- [ ] 实名入口使用现有 `REALNAME_REQUIRED_QUERY_KEY`，对 `return_to` 做 URL 编码，避免拼接错误。
- [ ] 运行目标测试，预期通过，并回归未登录、无套餐、可购买三种既有 gate。

### 任务 4：下单错误转实名引导

**文件：**

- 修改：`frontend/src/repositories/http-repositories.ts`（若需识别错误码）
- 修改：`frontend/src/lib/use-credit-checkout.ts` 或 `frontend/next-site/credit-pack-section.tsx`（按实际错误处理位置）
- 测试：相邻 credit checkout 测试文件

**接口：**

- 后端返回 `BindingNotFound`、`SHADOW_BINDING_REQUIRED` 或等价业务码时，前端不得展示泛化“支付失败”；应切换到实名引导状态。
- 不向下单请求传入 fallback 身份字段。

- [ ] 先补一个下单绑定失效的失败测试，断言不会生成支付 URL，且会调用实名入口。
- [ ] 运行目标测试，预期失败。
- [ ] 实现错误码识别与转换；保留订单已创建但支付未完成时的现有恢复行为。
- [ ] 重跑目标测试，预期通过。

### 任务 5：回归与门禁

**文件：**

- 可能修改：`frontend/src/i18n/generated/*.json`（仅通过生成命令更新）
- 不新增不必要的共享副本或后端改动。

- [ ] 运行聚焦测试：`cd frontend && pnpm exec vitest run next-site/__tests__/credit-pack-section.test.tsx next-site/__tests__/credit-pack-section-timeout.test.tsx src/domain/__tests__/credit-pack.test.ts`。
- [ ] 运行类型检查：`cd frontend && pnpm check`。
- [ ] 如文案新增，运行 `pnpm i18n:extract` 与 `pnpm i18n:check`，确认生成文件只包含本次文案。
- [ ] 运行 `git diff --check`，确认无空白错误。
- [ ] 按国内/国际站各验证固定价格、税费提示、实名禁用和实名回跳；未验证真实支付时不得声称支付链路已通过。

## 计划自检

- 规格覆盖：固定价格、税费提示、未绑定展示与禁用、实名回跳、下单严格校验、测试矩阵均有对应任务。
- 占位符检查：无 `TBD`、`TODO` 或未定义函数名。
- 类型一致性：任务 1 的 `getCreditPackPrice` 被任务 2 使用；任务 3 的 `canPurchaseCreditPack` 与 `onRequireRealname` 由订阅页提供。
