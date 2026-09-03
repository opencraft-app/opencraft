# Hy Token Plan 七彩石覆盖修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 七彩石仍返回 `hy4-preview` 与 `hy3` 时，模型配置页的腾讯云 Hy Token Plan（个人版）仍只展示本地固定的 `hy4-preview`，并使用本地 Hy4 Preview 说明。

**Architecture:** 保留 `useModelProviders` 的七彩石拉取和其他套餐动态配置能力，只在 `product-provider-adapter.ts` 处理固定模型套餐。Hy 个人版继续沿用远端 Provider 名称、API Key 地址、Base URL 与 API 模式，但模型目录和说明从 `model-providers.ts` 的本地固定配置读取，避免远端旧配置重新带回 Hy3。

**Tech Stack:** React 19、TypeScript、Vitest、Next.js 16、现有 `IModelProvider` / `ModelProviderOption` 适配层。

## Global Constraints

- Hy Token Plan（个人版）的可选模型固定为精确 ID `hy4-preview`。
- 不恢复“获取可用模型”功能。
- “检测模型状态”继续使用现有 `model_request` 探测协议。
- “添加模型”继续使用现有 `discoverModels: false` 写入流程。
- 其他 Provider 的七彩石动态目录和说明保持不变。

---

### Task 1: 固定 Provider 目录覆盖与回归测试

**Files:**
- Modify: `src/pages/marketing/agent-config/utils/model-providers.ts`
- Modify: `src/pages/marketing/agent-model-config/product-provider-adapter.ts`
- Test: `src/pages/marketing/agent-model-config/__tests__/product-provider-adapter.test.ts`

**Interfaces:**
- Consumes: 七彩石解析后的 `IModelProvider[]`。
- Produces: `adaptProductModelProviders(source)` 对 `tencent_hy_token_plan` 输出固定 `catalogModels: [{ id: "hy4-preview", name: "hy4-preview" }]` 和本地 Hy4 Preview 说明；其他 Provider 继续映射远端字段。

- [x] **Step 1: 写入能复现现网配置的失败测试**

```ts
it("keeps the Hy Token Plan personal catalog fixed when Rainbow still returns Hy3", () => {
  const [adaptedProvider] = adaptProductModelProviders([{
    value: "tencent_hy_token_plan",
    category: "coding_plan",
    provider: "tencenthytokenplan",
    provider_name: "腾讯云 Hy Token Plan（个人版）",
    description: "远端旧说明：集成 Hy3 模型",
    api_key_url: "https://console.cloud.tencent.com/tokenhub/tokenplan/hy",
    base_url: "https://api.lkeap.cloud.tencent.com/plan/v3",
    api: "openai-completions",
    models: [
      { id: "hy4-preview", name: "Hy4 Preview", isDefault: true },
      { id: "hy3", name: "Hy3" },
    ],
  }]);

  expect(adaptedProvider).toEqual(expect.objectContaining({
    description: expect.stringContaining("Hy4 Preview"),
    catalogModels: [{ id: "hy4-preview", name: "hy4-preview" }],
  }));
});
```

- [x] **Step 2: 运行聚焦测试并确认 RED**

Run: `cd frontend && pnpm test -- src/pages/marketing/agent-model-config/__tests__/product-provider-adapter.test.ts`

Expected: 新用例失败，实际 `catalogModels` 仍包含 `hy3`，说明确实复现现网覆盖路径。

- [x] **Step 3: 导出并复用本地固定配置**

在 `model-providers.ts` 中为 Hy 个人版导出单一事实源，并让 `MODEL_PROVIDER_LIST` 复用：

```ts
export const HY_TOKEN_PLAN_FIXED_CATALOG = {
  description: t("基于腾讯2026年最新推出的混元模型打造：集成 Hy4 Preview 模型，面向 Agent 工作负载设计，适配 Coding Agent、文档自动化、多步工具调用等工作流。"),
  models: [{ id: "hy4-preview", name: "hy4-preview" }],
} satisfies Pick<IModelProvider, "description" | "models">;
```

在 `product-provider-adapter.ts` 中，仅当 `provider.value === "tencent_hy_token_plan"` 时，用该常量替换远端 `description` 与 `models`；Provider 的连接字段继续使用远端值。

- [x] **Step 4: 运行聚焦测试并确认 GREEN**

Run: `cd frontend && pnpm test -- src/pages/marketing/agent-model-config/__tests__/product-provider-adapter.test.ts`

Expected: 文件内全部测试通过；新增用例确认目录只有 `hy4-preview` 且说明包含 `Hy4 Preview`。

- [x] **Step 5: 验证检测与添加模型回归**

Run: `cd frontend && pnpm test -- src/pages/marketing/agent-model-config/__tests__`

Expected: 固定模型、`model_request` 检测及 `discoverModels: false` 添加模型相关用例全部通过。

### Task 2: 前端质量门禁与双区域构建

**Files:**
- Verify: `src/pages/marketing/agent-config/utils/model-providers.ts`
- Verify: `src/pages/marketing/agent-model-config/product-provider-adapter.ts`
- Verify: `src/pages/marketing/agent-model-config/__tests__/product-provider-adapter.test.ts`

**Interfaces:**
- Consumes: Task 1 的固定目录适配结果。
- Produces: 可提交且国内/国际构建均无回归的前端补丁。

- [x] **Step 1: 运行静态检查**

Run: `cd frontend && pnpm check`

Expected: 无新增 TypeScript 或 i18n 错误。

- [x] **Step 2: 运行国内站与国际站构建**

Run: `cd frontend && pnpm build:cn`

Expected: 国内站静态构建成功。

Run: `cd frontend && pnpm build:global`

Expected: 国际站静态构建成功。

- [x] **Step 3: 检查差异质量**

Run: `git diff --check`

Expected: 无输出。

- [x] **Step 4: 提交前展示范围**

展示 `git status --short`、`git diff --stat`、目标测试与构建结果；确认只包含本计划文件、固定 Provider 单一事实源、适配器和回归测试后，再进入 commit / push / MR 流程。
