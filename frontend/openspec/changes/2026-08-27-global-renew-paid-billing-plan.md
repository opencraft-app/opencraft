# 国际站续费付费开关 Implementation Plan

**Goal:** 用 `paidBillingEnabled` 统一控制国际站账号页、Agent 到期提醒和续费弹窗，关闭时保持 Coming Soon，开启时复用现有续费链路。

**Architecture:** 将站点与运行时开关收敛到 `isRenewalAvailableForRegion(globalRegion, paidBillingEnabled)`，三个调用方只消费统一判定。账号页单独保留“国际站关闭时仍展示 Coming Soon”的可见性规则，国内站现有付费开关行为保持不变。

**Tech Stack:** React 19、TypeScript 5.9、Vitest 4、Testing Library。

## Task 1: 用失败测试锁定统一门控

**Files:**
- Modify: `src/pages/marketing/__tests__/renew-coming-soon.test.ts`
- Modify: `src/pages/marketing/__tests__/account-page-renewal.global.test.tsx`
- Modify: `src/pages/marketing/__tests__/agent-settings-renewal-reminder.global.test.tsx`
- Modify: `src/pages/marketing/__tests__/renew-pass-modal.test.tsx`

- [x] 增加策略函数四象限测试，锁定国际站依赖开关、国内站行为不变。
- [x] 增加国际站账号页开关关闭显示 Coming Soon、开启可打开弹窗的测试。
- [x] 增加 Agent 到期提醒关闭静态、开启可点击的测试。
- [x] 增加续费弹窗国际站关闭不询价、开启正常询价的测试。
- [x] 运行定向测试并确认因缺少新门控而失败。

## Task 2: 最小实现统一门控

**Files:**
- Modify: `src/pages/marketing/renew-coming-soon.tsx`
- Modify: `src/pages/marketing/account-page.tsx`
- Modify: `src/pages/marketing/agent-settings-page.tsx`
- Modify: `src/pages/marketing/renew-pass-modal.tsx`

- [x] 扩展统一策略函数签名并更新三个调用方。
- [x] 保持账号页国际站关闭时的 Coming Soon 可见性，开启后展示真实续费按钮和正常状态文案。
- [x] 保持 Agent 国际站关闭时的静态提醒，开启后展示可点击提醒。
- [x] 续费弹窗关闭时阻止询价和下单。
- [x] 运行定向测试并确认通过。

## Task 3: 质量门禁

- [x] 运行相关 Vitest。
- [x] 运行 `pnpm check`、`pnpm i18n:check` 和 `git diff --check`。
- [x] 检查最终差异仅包含本需求代码、测试和 OpenSpec 记录。

## Verification

- 续费相关聚焦回归：6 个测试文件、47 passed。
- `pnpm check` 通过：TypeScript diagnostics 232 current / 276 baseline / 0 new / 44 resolved。
- `pnpm i18n:check` 与 `git diff --check` 通过。
- 扩展运行 `renewal-id-ID.test.ts` 时有 2 条 `origin/master` 既有失败：缺少 `套餐{{time}}，敬请期待` 的印尼语字典映射；本变更未修改该测试或生成字典。
