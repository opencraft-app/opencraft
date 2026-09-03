# Hy Token Plan 七彩石模型目录 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `tencent_hy_token_plan` 在七彩石成功时使用远端模型与说明，在远端缺失或模型为空时不展示，并保留整体失败的本地 Hy4 兜底和固定选择交互。

**Architecture:** `useModelProviders` 继续负责远端优先和整体失败兜底；`model-providers.ts` 仅保存本地兜底内容；`product-provider-adapter.ts` 将 Hy 的固定目录从“数据覆盖”改为“行为标记”，并过滤空目录。

**Tech Stack:** React 19、TypeScript 5.9、Vitest 4、LightVela 本地 Provider Hook 与 Hermes 模型配置适配层。

## Global Constraints

- 七彩石成功时不得用本地 Hy4 覆盖远端 `description` 或 `models`。
- 七彩石成功但缺少 `tencent_hy_token_plan` 时不得本地补回。
- `tencent_hy_token_plan.models` 为空或清洗后无有效 ID 时不得展示。
- 七彩石整体请求或解析失败时继续回退 `MODEL_PROVIDER_LIST`，其 Hy 兜底模型仍为 `hy4-preview`。
- Hy 保持 `fixedModelSelection: true`、`discoveryStrategy: "catalog"`，不恢复“获取可用模型”或 `/models` 发现。
- 不新增轮询、TTL、依赖、接口或已保存配置迁移。
- 未经用户查看提交范围并明确确认，不创建分支、commit、push 或 MR。

---

### Task 1: 将 Hy 固定目录改为七彩石数据驱动

**Files:**
- Modify: `src/pages/marketing/agent-model-config/__tests__/product-provider-adapter.test.ts`
- Modify: `src/pages/marketing/agent-model-config/product-provider-adapter.ts`
- Modify: `src/pages/marketing/agent-config/utils/model-providers.ts`
- Verify: `src/pages/marketing/agent-config/utils/__tests__/model-providers.test.ts`

**Interfaces:**
- Consumes: `IModelProvider.description` 与 `IModelProvider.models`。
- Produces: Hy Provider 继续输出 `fixedModelSelection: true` 和 `discoveryStrategy: "catalog"`，目录内容来自输入 Provider；空目录输出 `[]`。
- Preserves: `MODEL_PROVIDER_LIST` 中 Hy4 本地兜底内容。

- [x] **Step 1: 写远端权威和空目录失败测试**

将旧的“远端 Hy3 仍强制 Hy4”测试改成：

```ts
it("uses the Rainbow Hy Token Plan catalog while keeping fixed selection", () => {
  const [adaptedProvider] = adaptProductModelProviders([{
    value: "tencent_hy_token_plan",
    category: "coding_plan",
    provider: "tencenthytokenplan",
    provider_name: "腾讯云 Hy Token Plan（个人版）",
    description: "七彩石最新模型说明",
    api_key_url: "https://console.cloud.tencent.com/tokenhub/tokenplan/hy",
    base_url: "https://api.lkeap.cloud.tencent.com/plan/v3",
    api: "openai-completions",
    models: [
      { id: "hy4-preview", name: "Hy4 Preview", isDefault: true },
      { id: "hy-next", name: "Hy Next" },
    ],
  }]);

  expect(adaptedProvider).toEqual(expect.objectContaining({
    providerKey: "tencent_hy_token_plan",
    discoveryStrategy: "catalog",
    fixedModelSelection: true,
    description: "七彩石最新模型说明",
    catalogModels: [
      { id: "hy4-preview", name: "Hy4 Preview" },
      { id: "hy-next", name: "Hy Next" },
    ],
  }));
});

it("hides the Rainbow Hy Token Plan provider when it has no valid models", () => {
  expect(adaptProductModelProviders([{
    value: "tencent_hy_token_plan",
    category: "coding_plan",
    provider: "tencenthytokenplan",
    provider_name: "腾讯云 Hy Token Plan（个人版）",
    description: "暂无模型",
    api_key_url: "",
    base_url: "https://api.lkeap.cloud.tencent.com/plan/v3",
    api: "openai-completions",
    models: [{ id: "  ", name: "无效模型" }],
  }])).toEqual([]);
});
```

同时增加缺失 Provider 的回归断言：

```ts
expect(adaptProductModelProviders([])).toEqual([]);
```

- [x] **Step 2: 运行测试并确认 RED**

Run:

```bash
pnpm exec vitest run --config vitest.config.ts --api.host 127.0.0.1 \
  src/pages/marketing/agent-model-config/__tests__/product-provider-adapter.test.ts
```

Expected: 远端目录测试实际只得到本地 `hy4-preview` 且说明被覆盖；空目录测试实际仍得到本地 Hy Provider。

- [x] **Step 3: 最小实现行为标记和空目录过滤**

将固定目录 Map 改为行为 Set，并只标准化输入目录：

```ts
const FIXED_MODEL_SELECTION_PROVIDERS = new Set(["tencent_hy_token_plan"]);

const fixedModelSelection = FIXED_MODEL_SELECTION_PROVIDERS.has(provider.value);
const catalogModels = provider.models
  .map((model) => ({ id: model.id.trim(), name: model.name.trim() || model.id.trim() }))
  .filter((model) => model.id);
if (fixedModelSelection && catalogModels.length === 0) return [];

return [{
  // existing mapped fields...
  discoveryStrategy:
    fixedModelSelection || CATALOG_DISCOVERY_PROVIDERS.has(provider.provider.trim().toLowerCase())
      ? "catalog"
      : "live",
  ...(fixedModelSelection ? { fixedModelSelection: true } : {}),
  description: toPlainText(provider.description) || undefined,
  catalogModels,
} satisfies ModelProviderOption];
```

删除 `HY_TOKEN_PLAN_FIXED_CATALOG` 导出，并在 `MODEL_PROVIDER_LIST` 的 Hy 条目内保留同一份本地兜底：

```ts
description: t(
  "基于腾讯2026年最新推出的混元模型打造：集成 Hy4 Preview 模型，面向 Agent 工作负载设计，适配 Coding Agent、文档自动化、多步工具调用等工作流。",
),
models: [{ id: "hy4-preview", name: "hy4-preview" }],
```

- [x] **Step 4: 运行聚焦测试确认 GREEN**

Run:

```bash
pnpm exec vitest run --config vitest.config.ts --api.host 127.0.0.1 \
  src/pages/marketing/agent-config/utils/__tests__/model-providers.test.ts \
  src/pages/marketing/agent-model-config/__tests__/product-provider-adapter.test.ts \
  src/pages/marketing/agent-model-config/__tests__/model-config-panel.test.tsx
```

Expected: 3 个测试文件全部通过；模型面板仍覆盖固定选择、`model_request` 检测和 `discoverModels: false` 添加。

### Task 2: 完成回归与交付前验证

**Files:**
- Modify: `openspec/plan.md`
- Modify: `.workflow/runtime/current-task.summary.md`（本地运行时状态）
- Modify: `.workflow/runtime/verification-ledger.md`（本地验证记录）
- Verify: `openspec/changes/2026-09-02-hy-token-plan-rainbow-catalog-design.md`
- Verify: `openspec/changes/2026-09-02-hy-token-plan-rainbow-catalog-implementation-plan.md`

**Interfaces:**
- Consumes: Task 1 的实现与测试证据。
- Produces: 可审查的范围、类型检查结果和用户验收摘要。

- [x] **Step 1: 运行前端类型门禁**

Run:

```bash
pnpm check
```

Expected: TypeScript 无新增诊断，i18n 结构检查通过。

- [x] **Step 2: 运行差异检查并审查范围**

Run:

```bash
git diff --check
git status --short
git diff -- \
  frontend/src/pages/marketing/agent-config/utils/model-providers.ts \
  frontend/src/pages/marketing/agent-model-config/product-provider-adapter.ts \
  frontend/src/pages/marketing/agent-model-config/__tests__/product-provider-adapter.test.ts
```

Expected: `git diff --check` 无输出；业务代码仅包含删除成功态本地覆盖、保留固定行为和过滤空 Hy 目录。

- [x] **Step 3: 更新 OpenSpec 与验证记录，停在用户验收点**

将 `openspec/plan.md` 当前任务标为完成，记录 RED/GREEN、聚焦测试、`pnpm check` 与差异检查结果。展示变更范围和风险；不创建分支、不提交、不推送、不创建 MR。

## 执行结果

- RED：Provider 适配测试出现 2 个预期失败；远端双模型与说明被本地 Hy4 覆盖，空模型 Provider 被本地 Hy4 补回。
- GREEN：3 个聚焦测试文件共 38 个用例通过；远端目录与说明生效，空 Hy 目录隐藏，固定选择、`model_request` 检测和 `discoverModels: false` 添加回归保持通过。
- 质量门禁：`pnpm check` 通过，TypeScript diagnostics 为 191 current / 276 baseline / 0 new / 85 resolved；i18n 结构错误 0。
- 差异门禁：`git diff --check` 无输出；没有修改 Hook、面板、接口、依赖或 i18n 生成资源。
