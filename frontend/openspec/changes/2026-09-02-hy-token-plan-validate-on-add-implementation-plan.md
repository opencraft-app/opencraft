# Hy Token Plan 添加前自动验证 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Subagent execution requires explicit user authorization.

**Goal:** 移除 Hy Token Plan 独立的模型状态检测入口，并在添加模型前自动执行真实模型请求；只有验证成功才保存。

**Architecture:** 产品 Provider 适配层通过 `validateBeforeAdd` 显式声明 Hy 的保存前验证能力；模型配置面板根据该能力隐藏独立按钮，并在现有 `controller.add` 前串行调用 `controller.testConnection`。底层 `connectivityProbe`、Hermes 添加协议和其他 Provider 流程保持不变。

**Tech Stack:** React 19、TypeScript 5.9、Vitest 4、Testing Library、LightVela Hermes 模型配置客户端。

## Global Constraints

- 仅调整 `tencent_hy_token_plan`；其他 Provider 的模型发现、独立状态检测和添加流程保持不变。
- Hy Token Plan 不再展示独立的“检测模型状态”按钮。
- 点击“添加模型”时先使用当前 API Key、当前模型和 `strategy: "model_request"` 执行真实请求。
- 验证成功后直接添加，不展示“模型可用性检测通过”弹窗。
- 验证失败或异常时不得调用 `add`，不得写入配置；必须保留 API Key、模型和用途选择。
- Hy 添加继续传 `discoverModels: false`；主模型、备用模型和仅添加用途保持原行为。
- 不删除底层 `connectivityProbe` / `testConnection`，不修改七彩石目录、缓存、兜底、接口或依赖。
- 未经用户查看提交范围并明确确认，不创建分支、commit、push 或 MR。

---

### Task 1: 声明 Hy 添加前验证能力

**Files:**
- Modify: `src/pages/marketing/agent-model-config/hermes-model-config-command.ts:53-64`
- Modify: `src/pages/marketing/agent-model-config/product-provider-adapter.ts:7-75`
- Test: `src/pages/marketing/agent-model-config/__tests__/product-provider-adapter.test.ts:84-128`

**Interfaces:**
- Consumes: `IModelProvider.value`。
- Produces: `ModelProviderOption.validateBeforeAdd?: boolean`；仅 `tencent_hy_token_plan` 输出 `true`。
- Preserves: `fixedModelSelection`、`discoveryStrategy`、远端目录与空目录过滤。

- [x] **Step 1: 写 Provider 能力失败测试**

在现有远端 Hy 目录测试中增加断言：

```ts
expect(adaptedProvider).toEqual(expect.objectContaining({
  providerKey: "tencent_hy_token_plan",
  discoveryStrategy: "catalog",
  fixedModelSelection: true,
  validateBeforeAdd: true,
  description: "七彩石最新模型说明",
  catalogModels: [
    { id: "hy4-preview", name: "Hy4 Preview" },
    { id: "hy-next", name: "Hy Next" },
  ],
}));
```

现有非 Hy Provider 使用完整对象断言，不应出现 `validateBeforeAdd`。

- [x] **Step 2: 运行测试并确认 RED**

Run:

```bash
pnpm exec vitest run --config vitest.config.ts --api.host 127.0.0.1 \
  src/pages/marketing/agent-model-config/__tests__/product-provider-adapter.test.ts
```

Expected: Hy 适配结果缺少 `validateBeforeAdd: true`，新增断言失败；其他现有用例通过。

- [x] **Step 3: 实现最小 Provider 能力**

在 `ModelProviderOption` 增加独立能力字段：

```ts
export interface ModelProviderOption {
  providerKey: string;
  providerName: string;
  category: "coding_plan" | "api";
  baseUrl: string;
  apiMode: HermesCanonicalApiMode;
  discoveryStrategy: ModelDiscoveryStrategy;
  description?: string;
  apiKeyUrl?: string;
  catalogModels?: Array<{ id: string; name: string }>;
  fixedModelSelection?: boolean;
  validateBeforeAdd?: boolean;
}
```

在适配层使用独立集合，避免把固定目录与添加前验证错误绑定：

```ts
const VALIDATE_BEFORE_ADD_PROVIDERS = new Set(["tencent_hy_token_plan"]);

const validateBeforeAdd = VALIDATE_BEFORE_ADD_PROVIDERS.has(provider.value);

return [{
  providerKey: provider.value,
  providerName: toPlainText(provider.provider_name) || provider.provider || provider.value,
  category: provider.category,
  baseUrl,
  apiMode,
  discoveryStrategy:
    fixedModelSelection || CATALOG_DISCOVERY_PROVIDERS.has(provider.provider.trim().toLowerCase())
      ? "catalog"
      : "live",
  ...(fixedModelSelection ? { fixedModelSelection: true } : {}),
  ...(validateBeforeAdd ? { validateBeforeAdd: true } : {}),
  description: toPlainText(provider.description) || undefined,
  apiKeyUrl: provider.api_key_url.trim() || undefined,
  catalogModels,
} satisfies ModelProviderOption];
```

- [x] **Step 4: 运行测试并确认 GREEN**

Run: 与 Step 2 相同。

Expected: Provider 适配测试全部通过；只有 Hy 带 `validateBeforeAdd`。

### Task 2: 添加时自动验证并处理失败

**Files:**
- Modify: `src/pages/marketing/agent-model-config/agent-model-config-panel.tsx:194-223,351-382,730-845`
- Test: `src/pages/marketing/agent-model-config/__tests__/model-config-panel.test.tsx:98-107,150-255,686-750`
- Modify: `openspec/plan.md`
- Modify: `.workflow/runtime/current-task.summary.md`（本地运行时状态）
- Modify: `.workflow/runtime/verification-ledger.md`（本地验证记录）

**Interfaces:**
- Consumes: Task 1 的 `ModelProviderOption.validateBeforeAdd`。
- Produces: Hy 添加动作顺序 `connectivityProbe(model_request) -> add(discoverModels=false)`；失败路径只产生 `connectivityProbe`。
- Preserves: 其他 Provider 的独立检测按钮和直接添加路径。

- [x] **Step 1: 扩展测试夹具并写失败用例**

为 Hy fixture 增加能力：

```ts
const fixedHyProvider: ModelProviderOption = {
  providerKey: "tencent_hy_token_plan",
  providerName: "腾讯云 Hy Token Plan（个人版）",
  category: "coding_plan",
  baseUrl: "https://api.lkeap.cloud.tencent.com/plan/v3",
  apiMode: "chat_completions",
  discoveryStrategy: "catalog",
  fixedModelSelection: true,
  validateBeforeAdd: true,
  catalogModels: [{ id: "hy4-preview", name: "hy4-preview" }],
};
```

为 `createRemote` 增加一次性业务失败响应，不把失败伪装成命令异常：

```ts
let nextConnectionSucceeded = true;

if ((action.type as string) === "connectivityProbe") {
  const succeeded = nextConnectionSucceeded;
  nextConnectionSucceeded = true;
  return {
    status: "SUCCESS",
    exitCode: 0,
    output: connectionOutput(snapshot, succeeded),
  };
}

return {
  actions,
  execDebugCommand,
  failNextRead: () => {
    readFailure = true;
  },
  failNext: (type: HermesModelConfigAction["type"]) => {
    nextFailure = type;
  },
  failNextConnection: () => {
    nextConnectionSucceeded = false;
  },
};
```

将原“保留独立检测”用例替换为成功链路：

```tsx
it("validates the fixed Hy model before adding it", async () => {
  const remote = createRemote({ primary: null, fallbacks: [], configuredModels: [] });
  render(
    <AgentModelConfigPanel
      botId="bot-1"
      execDebugCommand={remote.execDebugCommand}
      providers={[fixedHyProvider]}
    />,
  );
  await screen.findByText("暂未配置模型");

  expect(screen.queryByRole("button", { name: "检测模型状态" })).not.toBeInTheDocument();
  await userEvent.type(screen.getByLabelText("API Key"), "hy-secret");
  await userEvent.click(screen.getByRole("button", { name: "添加模型" }));

  await waitFor(() => expect(toastMocks.success).toHaveBeenLastCalledWith("模型已添加"));
  expect(screen.queryByRole("dialog", { name: "模型可用性检测通过" })).not.toBeInTheDocument();
  expect(remote.actions
    .filter((action) => action.type === "connectivityProbe" || action.type === "add")
    .map((action) => action.type)).toEqual(["connectivityProbe", "add"]);
  expect(remote.actions).toContainEqual(expect.objectContaining({
    type: "connectivityProbe",
    strategy: "model_request",
    model: expect.objectContaining({ id: "hy4-preview" }),
  }));
  expect(remote.actions).toContainEqual(expect.objectContaining({
    type: "add",
    purpose: "primary",
    discoverModels: false,
  }));
});
```

增加失败不保存用例：

```tsx
it("keeps the Hy form unchanged when validation fails", async () => {
  const remote = createRemote({ primary: null, fallbacks: [], configuredModels: [] });
  remote.failNextConnection();
  render(
    <AgentModelConfigPanel
      botId="bot-1"
      execDebugCommand={remote.execDebugCommand}
      providers={[fixedHyProvider]}
    />,
  );
  await screen.findByText("暂未配置模型");

  await userEvent.type(screen.getByLabelText("API Key"), "hy-secret");
  await userEvent.click(screen.getByRole("radio", { name: "仅添加" }));
  await userEvent.click(screen.getByRole("button", { name: "添加模型" }));

  expect(await screen.findByRole("dialog", { name: "模型可用性检测未通过" })).toBeInTheDocument();
  expect(remote.actions.some((action) => action.type === "add")).toBe(false);
  await userEvent.click(screen.getByRole("button", { name: "确定" }));
  expect(screen.getByLabelText("API Key")).toHaveValue("hy-secret");
  expect(screen.getByRole("combobox", { name: "模型" })).toHaveTextContent("hy4-preview");
  expect(screen.getByRole("radio", { name: "仅添加" })).toBeChecked();
});
```

保留现有普通 Provider 用例对“检测模型状态”按钮和直接添加行为的断言。

- [x] **Step 2: 运行模型面板测试并确认 RED**

Run:

```bash
pnpm exec vitest run --config vitest.config.ts --api.host 127.0.0.1 \
  src/pages/marketing/agent-model-config/__tests__/model-config-panel.test.tsx
```

Expected: Hy 仍展示独立检测按钮；点击添加只产生 `add`，没有前置 `connectivityProbe`；失败用例错误地保存模型。

- [x] **Step 3: 最小实现自动验证与按钮隐藏**

在面板中派生能力：

```ts
const validateBeforeAdd = activeProvider?.validateBeforeAdd === true;
```

将 `handleAdd` 改为先验证、后保存：

```ts
const handleAdd = async () => {
  const normalizedApiKey = apiKey.trim();
  if (!selectedModel || !normalizedApiKey || !credentialMatchesProvider) return;
  if (validateBeforeAdd) {
    const requestFingerprint = providerFingerprint;
    const revision = probeUiRevision.current;
    setConnectionResult(null);
    const result = await controller.testConnection({
      apiKey: normalizedApiKey,
      model: selectedModel,
      strategy: "model_request",
    });
    if (revision !== probeUiRevision.current || requestFingerprint !== providerFingerprintRef.current) return;
    if (!result) return;
    if (!result.success) {
      setConnectionResult(result);
      return;
    }
  }
  const nextSnapshot = await controller.add({
    apiKey: normalizedApiKey,
    model: selectedModel,
    purpose,
    discoverModels: category === "custom" || activeProvider?.discoveryStrategy !== "catalog",
  });
  if (!nextSnapshot) return;
  setApiKey("");
  setApiKeyTarget("");
  setShowApiKey(false);
  setModelOptions([]);
  setSelectedModelId("");
  toast.success(t("模型已添加"));
  setConnectionResult(null);
};
```

只对未启用自动验证的 Provider 渲染独立按钮：

```tsx
{!validateBeforeAdd ? (
  <Button
    type="button"
    variant="outline"
    className={compoundActionClassName}
    disabled={!selectedModel || !apiKey.trim() || !credentialMatchesProvider || busy}
    onClick={() => void handleConnectivityTest()}
  >
    <ModelCompoundActionContent
      idleLabel={t("检测模型状态")}
      loadingLabel={t("检测中...")}
      loading={controller.operation === "connectivity-probe"}
    />
  </Button>
) : null}
```

添加按钮在 Hy 自动验证和保存两个阶段都显示 loading 图标：

```tsx
{controller.operation === "add" || (validateBeforeAdd && controller.operation === "connectivity-probe")
  ? <Loader2 className="size-4 animate-spin" aria-hidden="true" />
  : <Plus className="size-4" aria-hidden="true" />}
```

- [x] **Step 4: 运行聚焦回归确认 GREEN**

Run:

```bash
pnpm exec vitest run --config vitest.config.ts --api.host 127.0.0.1 \
  src/pages/marketing/agent-model-config/__tests__/product-provider-adapter.test.ts \
  src/pages/marketing/agent-model-config/__tests__/model-config-panel.test.tsx \
  src/pages/marketing/agent-model-config/__tests__/use-model-config.test.tsx \
  src/pages/marketing/agent-model-config/__tests__/model-config-client.test.ts
```

Expected: 新增成功/失败链路通过；其他 Provider 的独立检测、模型发现、添加失败恢复以及客户端协议测试全部通过。

- [x] **Step 5: 运行质量与差异门禁**

Run:

```bash
pnpm check
cd ..
git diff --check
git status --short
```

Expected: TypeScript 无新增诊断、i18n 结构错误 0、`git diff --check` 无输出；没有修改七彩石 Hook、Hermes Python 执行协议、依赖或生成字典。

- [x] **Step 6: 更新执行记录并停在用户验收点**

将 `openspec/plan.md` 当前任务标为完成，记录 RED/GREEN、聚焦测试、`pnpm check` 与差异检查结果；更新本地 runtime summary 和 verification ledger。展示变更范围与剩余风险，不创建分支、不 commit、不 push、不创建 MR。

## 执行结果

- RED：Provider 适配测试出现 1 个预期失败，证明 Hy 尚未声明添加前验证能力；模型面板测试出现 2 个预期失败，证明独立检测按钮仍存在且失败探测仍会进入保存。
- GREEN：单面板回归 29/29 通过，覆盖成功、业务失败和探测命令异常；使用包含 `cryptography` 的 Codex 工作区 Python 运行项目标准 `test:model-config`，7 个文件 126/126 通过；本地 Hy4 整体失败兜底测试 1/1 通过。
- 质量门禁：`pnpm check` 通过，TypeScript diagnostics 为 191 current / 276 baseline / 0 new / 85 resolved；i18n 结构错误 0。
- 差异门禁：`git diff --check` 无输出；未修改七彩石 Hook、Hermes Python 执行协议、依赖或生成字典。
- 环境说明：标准套件首次使用系统 Python 时因缺少 `cryptography` 导致辅助脚本无协议标记和 36 个级联失败；切换到 Codex 工作区自带 Python 后原命令全量通过，不涉及代码修复或依赖变更。
