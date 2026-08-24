# 韩国国际站签约卡管理前端接入 Implementation Plan

**Goal:** 使用真实 Auth API 替换账号页签约卡演示数据和本地卡号表单。

**Architecture:** 保持 Repository Pattern；Auth Repository 管理四个卡接口，组件只处理展示和交互。绑卡通过腾讯托管页完成，回跳后以列表 API 为最终事实源。

**Tech Stack:** React 19、TypeScript、Vitest、Testing Library、现有 Repository/i18n/navigation 工具。

## Constraints

- 不修改后端。
- 不新增依赖。
- 不采集 PAN、有效期或 CVC。
- 国内站不展示。
- 实现遵循 TDD，每个任务先观察目标测试失败。

## Tasks

- [x] **Developer / Repository contract**：修改 `src/repositories/types.ts`、`http-repositories.ts`、`fake-repositories.ts`；先在独立 Repository 测试中增加四个接口的失败测试，再实现并验证。
- [x] **Developer / Real card component**：重写 `src/pages/marketing/saved-cards-section.tsx`，删除演示卡及本地卡表单；先重写 `src/pages/marketing/__tests__/saved-cards-section.test.tsx` 覆盖真实列表、托管跳转、回跳、mutation 和错误态，再实现。
- [x] **Developer / Account integration and i18n**：由 `SavedCardsSection` 独占消费 `payment-method` 回跳并覆盖完整终态，保持 `AccountPage` 的 `isGlobal` 挂载边界；运行 i18n 抽取并验证生成结果。
- [x] **Reviewer / Verification**：运行定向测试、全量类型检查、i18n 检查和国际站构建；复核无卡敏感信息输入与无未授权改动。

## Acceptance Commands

```bash
pnpm exec vitest run --config vitest.config.ts src/repositories/__tests__/payment-methods.test.ts src/pages/marketing/__tests__/saved-cards-section.test.tsx
pnpm check
pnpm i18n:extract
pnpm i18n:check
pnpm build:global
```
