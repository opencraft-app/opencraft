# Hy Token Plan 个人版固定模型 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让腾讯云 Hy Token Plan（个人版）直接固定使用 `hy4-preview`，移除模型发现入口，同时完整保留模型状态检测和添加模型生效流程。

**Architecture:** `model-providers.ts` 继续作为固定模型 ID 和产品文案的唯一来源；`product-provider-adapter.ts` 将 Hy 个人版标记为固定目录模型并选择 catalog 后端策略；`AgentModelConfigPanel` 从目录派生唯一选中模型，只隐藏模型发现动作，连接检测和添加仍走现有 controller。

**Tech Stack:** React 19、TypeScript 5.9、Vitest 4、Testing Library、Radix Select、项目 i18n 生成脚本。

## Global Constraints

- 仅调整 `tencent_hy_token_plan`；其他 Coding Plan、模型 API 与自定义模型继续使用当前模型发现流程。
- 固定模型 ID 和显示名称均为 `hy4-preview`。
- “检测模型状态”必须继续针对 `hy4-preview` 发起真实的直接模型请求检测。
- “添加模型”必须继续保存并按主模型、备用模型或仅添加用途生效，只跳过模型列表发现。
- 不修改 Hermes 配置格式、凭据加密、主备模型规则、保存命令或连接检测结果展示。
- 未经用户查看提交范围并明确确认，不执行 commit、push 或创建 MR。

---

### Task 1: 定义 Hy4 固定目录 Provider 能力

**Files:**
- Modify: `src/pages/marketing/agent-config/utils/model-providers.ts`
- Test: `src/pages/marketing/agent-config/utils/__tests__/model-providers.test.ts`
- Modify: `src/pages/marketing/agent-model-config/hermes-model-config-command.ts`
- Modify: `src/pages/marketing/agent-model-config/product-provider-adapter.ts`
- Test: `src/pages/marketing/agent-model-config/__tests__/product-provider-adapter.test.ts`

**Interfaces:**
- Consumes: `IModelProvider.value`, `IModelProvider.models` 和现有 `ModelDiscoveryStrategy`。
- Produces: `ModelProviderOption.fixedModelSelection?: boolean`；Hy 个人版输出 `fixedModelSelection: true`、`discoveryStrategy: "catalog"` 和唯一目录模型 `hy4-preview`。

- [x] **Step 1: 写 Provider 目录失败测试**

```ts
it("将 Hy Token Plan 个人版固定到 hy4-preview", () => {
  const provider = MODEL_PROVIDER_LIST.find((item) => item.value === "tencent_hy_token_plan");

  expect(provider).toMatchObject({
    description:
      "基于腾讯2026年最新推出的混元模型打造：集成 Hy4 Preview 模型，面向 Agent 工作负载设计，适配 Coding Agent、文档自动化、多步工具调用等工作流。",
    models: [{ id: "hy4-preview", name: "hy4-preview" }],
  });
});
```

- [x] **Step 2: 写 Provider 适配失败测试**

```ts
it("marks the Hy Token Plan personal provider as a fixed catalog model", () => {
  const [adaptedProvider] = adaptProductModelProviders([{
    value: "tencent_hy_token_plan",
    category: "coding_plan",
    provider: "tencenthytokenplan",
    provider_name: "腾讯云 Hy Token Plan（个人版）",
    description: "Hy4 Preview",
    api_key_url: "https://console.cloud.tencent.com/tokenhub/tokenplan/hy",
    base_url: "https://api.lkeap.cloud.tencent.com/plan/v3",
    api: "openai-completions",
    models: [{ id: "hy4-preview", name: "hy4-preview" }],
  }]);

  expect(adaptedProvider).toEqual(expect.objectContaining({
    providerKey: "tencent_hy_token_plan",
    discoveryStrategy: "catalog",
    fixedModelSelection: true,
    catalogModels: [{ id: "hy4-preview", name: "hy4-preview" }],
  }));
});
```

- [x] **Step 3: 运行测试确认 RED**

Run:

```bash
pnpm exec vitest run --config vitest.config.ts --api.host 127.0.0.1 \
  src/pages/marketing/agent-config/utils/__tests__/model-providers.test.ts \
  src/pages/marketing/agent-model-config/__tests__/product-provider-adapter.test.ts
```

Expected: Hy 目录仍返回 `hy3-preview`，且适配结果缺少 `fixedModelSelection`，两条新增断言失败。

- [x] **Step 4: 实现最小 Provider 能力**

```ts
export interface ModelProviderOption {
  // existing fields...
  fixedModelSelection?: boolean;
}

const FIXED_MODEL_SELECTION_PROVIDERS = new Set(["tencent_hy_token_plan"]);

const fixedModelSelection = FIXED_MODEL_SELECTION_PROVIDERS.has(provider.value);
return [{
  // existing mapped fields...
  discoveryStrategy:
    fixedModelSelection || CATALOG_DISCOVERY_PROVIDERS.has(provider.provider.trim().toLowerCase())
      ? "catalog"
      : "live",
  ...(fixedModelSelection ? { fixedModelSelection: true } : {}),
} satisfies ModelProviderOption];
```

并将 Hy 目录改为：

```ts
description: t(
  "基于腾讯2026年最新推出的混元模型打造：集成 Hy4 Preview 模型，面向 Agent 工作负载设计，适配 Coding Agent、文档自动化、多步工具调用等工作流。",
),
models: [{ id: "hy4-preview", name: "hy4-preview" }],
```

- [x] **Step 5: 运行测试确认 GREEN**

Run: 与 Step 3 相同。

Expected: 2 个测试文件全部通过；现有 MiniMax `discoveryStrategy: "catalog"` 断言继续通过，普通 Provider 结果不新增固定模型标记。

---

### Task 2: 固定展示模型并保留检测与添加生效

**Files:**
- Modify: `src/pages/marketing/agent-model-config/agent-model-config-panel.tsx`
- Test: `src/pages/marketing/agent-model-config/__tests__/model-config-panel.test.tsx`

**Interfaces:**
- Consumes: Task 1 的 `ModelProviderOption.fixedModelSelection` 和 `catalogModels`。
- Produces: 固定模型 Provider 的派生模型选项；现有 `controller.testConnection` 与 `controller.add` 调用签名不变。

- [x] **Step 1: 写固定展示且不发现模型的失败测试**

```tsx
it("shows the fixed Hy4 model without model discovery", async () => {
  const fixedProvider: ModelProviderOption = {
    providerKey: "tencent_hy_token_plan",
    providerName: "腾讯云 Hy Token Plan（个人版）",
    category: "coding_plan",
    baseUrl: "https://api.lkeap.cloud.tencent.com/plan/v3",
    apiMode: "chat_completions",
    discoveryStrategy: "catalog",
    fixedModelSelection: true,
    catalogModels: [{ id: "hy4-preview", name: "hy4-preview" }],
  };
  const remote = createRemote({ primary: null, fallbacks: [], configuredModels: [] });

  render(<AgentModelConfigPanel botId="bot-1" execDebugCommand={remote.execDebugCommand} providers={[fixedProvider]} />);
  await screen.findByText("暂未配置模型");

  expect(screen.queryByRole("button", { name: "获取可用模型" })).not.toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "模型" })).toHaveTextContent("hy4-preview");
  expect(remote.actions.some((action) => action.type === "probe")).toBe(false);
});
```

- [x] **Step 2: 写模型状态检测保留测试**

```tsx
await userEvent.type(screen.getByLabelText("API Key"), "hy-secret");
const connectivityButton = screen.getByRole("button", { name: "检测模型状态" });
expect(connectivityButton).toBeEnabled();
await userEvent.click(connectivityButton);
await screen.findByRole("dialog", { name: "模型可用性检测通过" });
expect(remote.actions).toContainEqual(expect.objectContaining({
  type: "connectivityProbe",
  strategy: "model_request",
  model: expect.objectContaining({ id: "hy4-preview" }),
}));
```

- [x] **Step 3: 写添加并生效保留测试**

```tsx
await userEvent.type(screen.getByLabelText("API Key"), "hy-secret");
await userEvent.click(screen.getByRole("radio", { name: "设为主模型" }));
await userEvent.click(screen.getByRole("button", { name: "添加模型" }));

await waitFor(() => expect(toastMocks.success).toHaveBeenLastCalledWith("模型已添加"));
expect(remote.actions).toContainEqual(expect.objectContaining({
  type: "add",
  purpose: "primary",
  discoverModels: false,
  model: expect.objectContaining({ id: "hy4-preview" }),
}));
expect(remote.actions.some((action) => action.type === "probe")).toBe(false);
```

- [x] **Step 4: 运行三条新增测试确认 RED**

Run:

```bash
pnpm exec vitest run --config vitest.config.ts --api.host 127.0.0.1 \
  src/pages/marketing/agent-model-config/__tests__/model-config-panel.test.tsx
```

Expected: 固定 Provider 仍显示“获取可用模型”，模型下拉为空，检测和添加按钮不可用，新增断言失败。

- [x] **Step 5: 从目录派生固定模型并隐藏发现动作**

```ts
const fixedModelOptions = activeProvider?.fixedModelSelection
  ? (activeProvider.catalogModels ?? []).map(({ id, name }) => ({ id, name, source: "catalog" as const }))
  : [];
const availableModelOptions = activeProvider?.fixedModelSelection ? fixedModelOptions : modelOptions;
const effectiveSelectedModelId = activeProvider?.fixedModelSelection
  ? fixedModelOptions[0]?.id ?? ""
  : selectedModelId;

const selectedModel = providerDraft && effectiveSelectedModelId
  ? { ...providerDraft, id: effectiveSelectedModelId, keyEnv: "" }
  : null;
```

API Key 复合控件只对非固定 Provider 渲染发现按钮：

```tsx
{!activeProvider?.fixedModelSelection ? (
  <Button type="button" variant="outline" className={compoundActionClassName} disabled={!canProbe || busy} onClick={() => void handleProbe()}>
    <ModelCompoundActionContent idleLabel={t("获取可用模型")} loadingLabel={t("获取中...")} loading={controller.operation === "probe"} />
  </Button>
) : null}
```

模型 Select 的 `value`、`disabled`、placeholder 和选项遍历全部改用 `effectiveSelectedModelId` / `availableModelOptions`。保持以下现有策略不变：

```ts
discoverModels: category === "custom" || activeProvider?.discoveryStrategy !== "catalog",
strategy: activeProvider?.discoveryStrategy === "catalog" ? "model_request" : "model_list",
```

- [x] **Step 6: 运行模型面板测试确认 GREEN**

Run: 与 Step 4 相同。

Expected: 新增固定模型、连接检测、添加生效测试通过；现有实时发现、MiniMax 目录发现、自定义 Provider、主备模型和错误恢复测试全部保持通过。

---

### Task 3: i18n 与完整质量门禁

**Files:**
- Modify: `src/i18n/generated/*.json`（仅由仓库脚本生成/同步 Hy4 介绍键）
- Modify: `openspec/plan.md`
- Verify: `openspec/changes/2026-09-01-hy-token-plan-fixed-model-design.md`
- Verify: `openspec/changes/2026-09-01-hy-token-plan-fixed-model-implementation-plan.md`

**Interfaces:**
- Consumes: Task 1 的新中文源文案。
- Produces: 所有已开放 locale 可解析的新 i18n key，以及可审查的最终 diff 和验证记录。

- [x] **Step 1: 生成并检查 i18n 资源**

Run:

```bash
pnpm i18n:extract
pnpm i18n:check
pnpm i18n:zh-hant:check
```

Expected: 新 Hy4 介绍键被生成；旧 Hy3 介绍键无源码引用；已开放 locale 均有非空值。对非中文 locale 仅把既有介绍中的模型名从 Hy3 替换为 Hy4 Preview，不改变其余语义。

- [x] **Step 2: 运行专项回归与类型检查**

Run:

```bash
pnpm exec vitest run --config vitest.config.ts --api.host 127.0.0.1 \
  src/pages/marketing/agent-config/utils/__tests__/model-providers.test.ts \
  src/pages/marketing/agent-model-config/__tests__/product-provider-adapter.test.ts \
  src/pages/marketing/agent-model-config/__tests__/model-config-panel.test.tsx
pnpm check
git diff --check
```

Expected: 专项测试全部通过，`pnpm check` 无新增诊断，`git diff --check` 无输出。

- [x] **Step 3: 国内站浏览器 smoke（可达性完成，表单交互受账号无智能体限制）**

在真实后端或可用预览中检查：选择 Hy 个人版后立即显示 `hy4-preview`；API Key 行没有“获取可用模型”；填写 API Key 后“检测模型状态”可点击；检测成功/失败反馈正常；“添加模型”按所选用途生效。

执行结果：本地 `/agents/models/` 返回 200、正常渲染且无控制台错误；当前浏览器账号没有智能体，只显示“立即创建”。为避免创建真实云端资源，未执行表单交互；固定模型、检测和添加动作由 3 条组件回归测试覆盖。

- [x] **Step 4: 更新执行记录并等待提交授权**

将 `openspec/plan.md` 中本需求任务更新为 `[x]`，记录 RED/GREEN、专项测试、i18n、类型和浏览器证据。随后展示变更文件、diff、验证结果、建议 commit message 与 MR 信息；仅在用户明确确认后执行 commit、push 或创建 MR。
