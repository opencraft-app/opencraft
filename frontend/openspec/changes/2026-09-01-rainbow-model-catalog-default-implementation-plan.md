# 模型配置默认使用七彩石目录 Implementation Plan

**Goal:** 模型配置面板默认展示当前供应商的七彩石模型目录并选中第一项，腾讯系供应商不再暴露实时获取入口，其他供应商的实时结果完整替换目录。

**Design:** `openspec/changes/2026-09-01-rainbow-model-catalog-default-design.md`

**Architecture:** 在产品供应商适配层新增独立能力字段 `supportsLiveModelRefresh`（按供应商 `value` 判断腾讯系），面板把「当前供应商 `catalogModels` → 默认模型选项」收敛为单一派生值 `catalogModelOptions`，并由已有的供应商指纹 effect 集中承担「恢复目录并选中第一项」的状态重置；实时探测结果不再与目录合并，成功即整体替换。

**Tech Stack:** React 19、TypeScript 5.9、Vitest 4 + Testing Library。

## Global Constraints

- 「腾讯系供应商」判定只看 `IModelProvider.value`：`value === "tokenhub"` 或 `value` 以 `tencent_` 开头，不维护固定枚举。
- 不改变现有 `discoveryStrategy`、连接检测策略（`model_list` / `model_request`）与 Hermes 命令参数（含 `add.discoverModels`）。
- 不合并七彩石目录与实时结果，也不用目录补空实时结果。
- 不新增或修改用户可见文案，因此不触发 i18n 资源变更。
- 现有请求版本控制（`probeUiRevision`）和供应商指纹校验必须继续生效。
- 每个 Task 先 RED、再最小实现、再 GREEN；不自动 commit / push / 建 MR。

## File Structure

- Modify: `src/pages/marketing/agent-model-config/hermes-model-config-command.ts` — `ModelProviderOption` 增加必填 `supportsLiveModelRefresh: boolean`。
- Modify: `src/pages/marketing/agent-model-config/product-provider-adapter.ts` — 适配层产出该能力字段。
- Modify: `src/pages/marketing/agent-model-config/agent-model-config-panel.tsx` — 默认目录、集中重置、按钮可见性、实时结果替换语义。
- Test: `src/pages/marketing/agent-model-config/__tests__/product-provider-adapter.test.ts`
- Test: `src/pages/marketing/agent-model-config/__tests__/model-config-panel.test.tsx`

---

### Task 1: 适配层输出「是否支持实时刷新模型」能力字段

**Files:**
- Modify: `src/pages/marketing/agent-model-config/hermes-model-config-command.ts:53-63`
- Modify: `src/pages/marketing/agent-model-config/product-provider-adapter.ts:49-67`
- Test: `src/pages/marketing/agent-model-config/__tests__/product-provider-adapter.test.ts`

**Interfaces:**
- Produces: `ModelProviderOption.supportsLiveModelRefresh: boolean`（必填），`true` 表示面板可展示实时获取入口。
- Consumes: `IModelProvider.value`。

- [x] **Step 1: 写入失败测试（腾讯系不支持实时刷新，其余支持）**

在 `product-provider-adapter.test.ts` 的第一个用例 `toEqual` 期望对象里，为 `alpha-plan` 补 `supportsLiveModelRefresh: true`，并新增用例：

```ts
it("disables live model refresh for Tencent-managed providers only", () => {
  const adapted = adaptProductModelProviders([
    { ...provider("tokenhub"), provider: "tokenhub" },
    { ...provider("tencent_token_plan") },
    { ...provider("tencent_token_plan_enterprise_pro_intl") },
    { ...provider("minimax_coding"), provider: "minimax" },
    { ...provider("openrouter") },
  ]);

  expect(adapted.map((item) => [item.providerKey, item.supportsLiveModelRefresh])).toEqual([
    ["tokenhub", false],
    ["tencent_token_plan", false],
    ["tencent_token_plan_enterprise_pro_intl", false],
    ["minimax_coding", true],
    ["openrouter", true],
  ]);
});
```

- [x] **Step 2: 运行目标测试确认 RED**

Run:

```bash
cd frontend && pnpm exec vitest run src/pages/marketing/agent-model-config/__tests__/product-provider-adapter.test.ts
```

Expected: FAIL —— 新用例得到 `undefined` 而非 `false` / `true`；首个用例因缺少 `supportsLiveModelRefresh` 键而 `toEqual` 失败。

- [x] **Step 3: 增加类型字段与最小实现**

`hermes-model-config-command.ts`：

```ts
export interface ModelProviderOption {
  providerKey: string;
  providerName: string;
  category: "coding_plan" | "api";
  baseUrl: string;
  apiMode: HermesCanonicalApiMode;
  discoveryStrategy: ModelDiscoveryStrategy;
  supportsLiveModelRefresh: boolean;
  description?: string;
  apiKeyUrl?: string;
  catalogModels?: Array<{ id: string; name: string }>;
}
```

`product-provider-adapter.ts`：

```ts
/** 腾讯系供应商由平台侧统一维护模型目录，不暴露实时探测入口。 */
function providerSupportsLiveModelRefresh(value: string) {
  const normalized = value.trim().toLowerCase();
  return normalized !== "tokenhub" && !normalized.startsWith("tencent_");
}
```

并在 `adaptProductModelProviders` 返回对象中，紧随 `discoveryStrategy` 之后加入：

```ts
      supportsLiveModelRefresh: providerSupportsLiveModelRefresh(provider.value),
```

- [x] **Step 4: 运行目标测试确认 GREEN**

Run:

```bash
cd frontend && pnpm exec vitest run src/pages/marketing/agent-model-config/__tests__/product-provider-adapter.test.ts
```

Expected: PASS（该文件全部用例通过）。此时面板测试仍会因 `ModelProviderOption` 缺少必填字段而类型报错，由 Task 2 修复。

---

### Task 2: 面板默认展示七彩石目录并按供应商能力显示实时入口

**Files:**
- Modify: `src/pages/marketing/agent-model-config/agent-model-config-panel.tsx:189-297`
- Modify: `src/pages/marketing/agent-model-config/agent-model-config-panel.tsx:691-703`
- Test: `src/pages/marketing/agent-model-config/__tests__/model-config-panel.test.tsx`

**Interfaces:**
- Consumes: `ModelProviderOption.supportsLiveModelRefresh`、`ModelProviderOption.catalogModels`。
- Produces（面板内部）：
  - `catalogModelOptions: ModelOption[]` —— 当前分类/供应商对应的默认模型选项，自定义分类恒为 `[]`。
  - `restoreCatalogModelOptions(): void` —— 集中重置入口，替换原 `resetProbeResult`。
  - `canRefreshModels: boolean` —— 是否渲染「获取可用模型」按钮。

- [x] **Step 1: 更新测试夹具并写入失败测试**

先把共享夹具补成合法类型（保持无 `catalogModels`，以免影响既有「默认禁用模型下拉」断言）：

```ts
const providers: [ModelProviderOption, ModelProviderOption] = [
  {
    providerKey: "alpha",
    providerName: "Alpha API",
    category: "api",
    baseUrl: "https://alpha.example.com/v1",
    apiMode: "chat_completions",
    discoveryStrategy: "live",
    supportsLiveModelRefresh: true,
    apiKeyUrl: "https://alpha.example.com/keys",
  },
  {
    providerKey: "beta-plan",
    providerName: "Beta Coding Plan",
    category: "coding_plan",
    baseUrl: "https://beta.example.com/v1",
    apiMode: "chat_completions",
    discoveryStrategy: "live",
    supportsLiveModelRefresh: true,
  },
];

const catalogPlan: ModelProviderOption = {
  ...providers[1],
  providerKey: "catalog-plan",
  providerName: "Catalog Plan",
  catalogModels: [
    { id: "catalog-first", name: "Catalog First" },
    { id: "catalog-second", name: "Catalog Second" },
  ],
};

const tencentPlan: ModelProviderOption = {
  ...catalogPlan,
  providerKey: "tencent-plan",
  providerName: "Tencent Token Plan",
  supportsLiveModelRefresh: false,
};
```

新增用例：

```ts
it("preloads the product catalog and selects the first model before any credential", async () => {
  const remote = createRemote({ primary: null, fallbacks: [], configuredModels: [] });
  render(
    <AgentModelConfigPanel botId="bot-1" execDebugCommand={remote.execDebugCommand} providers={[catalogPlan]} />,
  );
  await screen.findByText("暂未配置模型");

  const modelSelect = screen.getByRole("combobox", { name: "模型" });
  expect(modelSelect).toBeEnabled();
  expect(modelSelect).toHaveTextContent("Catalog First");
  expect(remote.actions.some((action) => action.type === "probe")).toBe(false);
});

it("hides live model discovery for Tencent providers and keeps it elsewhere", async () => {
  const remote = createRemote({ primary: null, fallbacks: [], configuredModels: [] });
  render(
    <AgentModelConfigPanel
      botId="bot-1"
      execDebugCommand={remote.execDebugCommand}
      providers={[tencentPlan, { ...catalogPlan, category: "api" }]}
    />,
  );
  await screen.findByText("暂未配置模型");

  expect(screen.getByRole("combobox", { name: "模型" })).toHaveTextContent("Catalog First");
  expect(screen.queryByRole("button", { name: "获取可用模型" })).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole("tab", { name: "模型 API" }));
  expect(screen.getByRole("button", { name: "获取可用模型" })).toBeInTheDocument();

  await userEvent.click(screen.getByRole("tab", { name: "自定义模型" }));
  expect(screen.getByRole("button", { name: "获取可用模型" })).toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "模型" })).toBeDisabled();
});

it("restores the product catalog when the credential, provider, or category changes", async () => {
  const remote = createRemote({ primary: null, fallbacks: [], configuredModels: [] }, ["live-only-model"]);
  const secondPlan: ModelProviderOption = {
    ...catalogPlan,
    providerKey: "catalog-plan-2",
    providerName: "Catalog Plan 2",
    catalogModels: [{ id: "second-plan-model", name: "Second Plan Model" }],
  };
  render(
    <AgentModelConfigPanel
      botId="bot-1"
      execDebugCommand={remote.execDebugCommand}
      providers={[catalogPlan, secondPlan, { ...catalogPlan, providerKey: "catalog-api", category: "api" }]}
    />,
  );
  await screen.findByText("暂未配置模型");

  await userEvent.type(screen.getByLabelText("API Key"), "secret-value");
  await userEvent.click(screen.getByRole("button", { name: "获取可用模型" }));
  expect(screen.getByRole("combobox", { name: "模型" })).toHaveTextContent("live-only-model");

  await userEvent.type(screen.getByLabelText("API Key"), "-changed");
  expect(screen.getByRole("combobox", { name: "模型" })).toHaveTextContent("Catalog First");

  await userEvent.type(screen.getByLabelText("API Key"), "secret-value");
  await userEvent.click(screen.getByRole("button", { name: "获取可用模型" }));
  await selectOption("Coding Plan 套餐", "Catalog Plan 2");
  expect(screen.getByRole("combobox", { name: "模型" })).toHaveTextContent("Second Plan Model");
  expect(screen.getByLabelText("API Key")).toHaveValue("");

  await userEvent.click(screen.getByRole("tab", { name: "模型 API" }));
  expect(screen.getByRole("combobox", { name: "模型" })).toHaveTextContent("Catalog First");
});

it("returns to the product catalog after a model is added", async () => {
  const remote = createRemote({ primary: null, fallbacks: [], configuredModels: [] }, ["live-only-model"]);
  render(
    <AgentModelConfigPanel botId="bot-1" execDebugCommand={remote.execDebugCommand} providers={[catalogPlan]} />,
  );
  await screen.findByText("暂未配置模型");

  await userEvent.type(screen.getByLabelText("API Key"), "secret-value");
  await userEvent.click(screen.getByRole("button", { name: "获取可用模型" }));
  await userEvent.click(screen.getByRole("button", { name: "添加模型" }));

  await waitFor(() => expect(toastMocks.success).toHaveBeenLastCalledWith("模型已添加"));
  expect(screen.getByRole("combobox", { name: "模型" })).toHaveTextContent("Catalog First");
});
```

- [x] **Step 2: 运行面板测试确认 RED**

Run:

```bash
cd frontend && pnpm exec vitest run src/pages/marketing/agent-model-config/__tests__/model-config-panel.test.tsx
```

Expected: FAIL —— 4 个新用例失败（默认下拉仍为空/禁用、腾讯系仍渲染「获取可用模型」、重置后回到空列表）。既有用例保持通过。

- [x] **Step 3: 面板实现默认目录、集中重置与按钮可见性**

在 `activeProvider` 之后新增派生值：

```ts
  const catalogModelOptions = useMemo<ModelOption[]>(
    () => category === "custom"
      ? []
      : (activeProvider?.catalogModels ?? []).map(({ id, name }) => ({ id, name, source: "catalog" as const })),
    [activeProvider, category],
  );
  const canRefreshModels = category === "custom" || (activeProvider?.supportsLiveModelRefresh ?? true);
```

把 `resetProbeResult` 替换为恢复目录的集中入口：

```ts
  const restoreCatalogModelOptions = () => {
    probeUiRevision.current += 1;
    setModelOptions(catalogModelOptions);
    setSelectedModelId(catalogModelOptions[0]?.id ?? "");
    setConnectionResult(null);
    controller.clearOperationError();
  };
```

供应商指纹 effect 内把清空改为恢复目录，并把 `catalogModelOptions` 加入依赖：

```ts
  useEffect(() => {
    if (previousProviderFingerprintRef.current === providerFingerprint) return;
    previousProviderFingerprintRef.current = providerFingerprint;
    providerFingerprintRef.current = providerFingerprint;
    probeUiRevision.current += 1;
    controller.cancelProbe();
    controller.clearOperationError();
    setApiKey("");
    setApiKeyTarget("");
    setShowApiKey(false);
    setModelOptions(catalogModelOptions);
    setSelectedModelId(catalogModelOptions[0]?.id ?? "");
    setConnectionResult(null);
  }, [catalogModelOptions, controller.cancelProbe, controller.clearOperationError, providerFingerprint]);
```

`handleCategoryChange`、自定义供应商三个输入的 `onChange`、预置供应商 `Select` 的 `onValueChange`、API Key 输入 `onChange` 全部把 `resetProbeResult()` 换成 `restoreCatalogModelOptions()`；`handleAdd` 成功分支把 `setModelOptions([]); setSelectedModelId("");` 换成 `restoreCatalogModelOptions();`。

API Key 复合控件里的按钮按能力渲染：

```tsx
              {canRefreshModels ? (
                <Button
                  type="button"
                  variant="outline"
                  className={compoundActionClassName}
                  disabled={!canProbe || busy}
                  onClick={() => void handleProbe()}
                >
                  <ModelCompoundActionContent
                    idleLabel={t("获取可用模型")}
                    loadingLabel={t("获取中...")}
                    loading={controller.operation === "probe"}
                  />
                </Button>
              ) : null}
```

- [x] **Step 4: 运行面板测试确认 GREEN**

Run:

```bash
cd frontend && pnpm exec vitest run src/pages/marketing/agent-model-config/__tests__/model-config-panel.test.tsx
```

Expected: 除 Task 3 覆盖的实时替换语义外全部通过；若「does not present catalog models when Hermes model discovery fails」失败，由 Task 3 按新契约改写。

---

### Task 3: 实时获取结果完整替换目录

**Files:**
- Modify: `src/pages/marketing/agent-model-config/agent-model-config-panel.tsx:298-339`
- Test: `src/pages/marketing/agent-model-config/__tests__/model-config-panel.test.tsx`

**Interfaces:**
- Consumes: `controller.probe({ apiKey, baseUrl, apiMode })` → `{ models: string[]; succeeded: boolean } | null`。
- Produces: `handleProbe` 的四种收敛结果 —— 成功非空整体替换并选中第一项；成功为空清空列表与选择；命令失败或探测未成功保留请求前列表与选择。

- [x] **Step 1: 写入失败测试并改写被新契约取代的旧用例**

把旧用例 `does not present catalog models when Hermes model discovery fails` 改写为保留语义：

```ts
it("keeps the previous model list and selection when live discovery fails", async () => {
  const remote = createRemote({ primary: null, fallbacks: [], configuredModels: [] }, [], false);
  render(
    <AgentModelConfigPanel botId="bot-1" execDebugCommand={remote.execDebugCommand} providers={[catalogPlan]} />,
  );
  await screen.findByText("暂未配置模型");

  await userEvent.type(screen.getByLabelText("API Key"), "invalid-secret");
  await userEvent.click(screen.getByRole("button", { name: "获取可用模型" }));

  const modelSelect = screen.getByRole("combobox", { name: "模型" });
  expect(modelSelect).toBeEnabled();
  expect(modelSelect).toHaveTextContent("Catalog First");
  expect(toastMocks.error).toHaveBeenCalledWith("未获取到可用模型，请检查API Key是否正确或有效");
});
```

新增用例：

```ts
it("replaces the catalog with live results and re-replaces on the next request", async () => {
  const remote = createRemote({ primary: null, fallbacks: [], configuredModels: [] }, ["live-a", "live-b"]);
  render(
    <AgentModelConfigPanel botId="bot-1" execDebugCommand={remote.execDebugCommand} providers={[catalogPlan]} />,
  );
  await screen.findByText("暂未配置模型");

  await userEvent.type(screen.getByLabelText("API Key"), "secret-value");
  await userEvent.click(screen.getByRole("button", { name: "获取可用模型" }));
  expect(screen.getByRole("combobox", { name: "模型" })).toHaveTextContent("live-a");
  await userEvent.click(screen.getByRole("combobox", { name: "模型" }));
  expect(screen.queryByRole("option", { name: "Catalog First" })).not.toBeInTheDocument();
  await userEvent.keyboard("{Escape}");

  await userEvent.click(screen.getByRole("button", { name: "获取可用模型" }));
  expect(screen.getByRole("combobox", { name: "模型" })).toHaveTextContent("live-a");
  await userEvent.click(screen.getByRole("combobox", { name: "模型" }));
  expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["live-a", "live-b"]);
  await userEvent.keyboard("{Escape}");
});

it("clears the model list when live discovery succeeds with no models", async () => {
  const remote = createRemote({ primary: null, fallbacks: [], configuredModels: [] }, []);
  render(
    <AgentModelConfigPanel botId="bot-1" execDebugCommand={remote.execDebugCommand} providers={[catalogPlan]} />,
  );
  await screen.findByText("暂未配置模型");

  await userEvent.type(screen.getByLabelText("API Key"), "secret-value");
  await userEvent.click(screen.getByRole("button", { name: "获取可用模型" }));

  expect(screen.getByRole("combobox", { name: "模型" })).toBeDisabled();
  expect(screen.queryByText("Catalog First")).not.toBeInTheDocument();
  expect(toastMocks.error).toHaveBeenCalledWith("未获取到可用模型，请检查API Key是否正确或有效");
});

it("keeps the model list while a live request is in flight", async () => {
  const remote = createRemote({ primary: null, fallbacks: [], configuredModels: [] });
  const execute = remote.execDebugCommand.getMockImplementation();
  if (!execute) throw new Error("Missing remote command implementation");
  remote.execDebugCommand.mockImplementation(async (botId, command) => {
    if (decodeAction(command).type === "probe") return await new Promise<never>(() => undefined);
    return execute(botId, command);
  });
  render(
    <AgentModelConfigPanel botId="bot-1" execDebugCommand={remote.execDebugCommand} providers={[catalogPlan]} />,
  );
  await screen.findByText("暂未配置模型");

  await userEvent.type(screen.getByLabelText("API Key"), "secret-value");
  await userEvent.click(screen.getByRole("button", { name: "获取可用模型" }));

  await screen.findByRole("button", { name: "获取中..." });
  expect(screen.getByRole("combobox", { name: "模型" })).toHaveTextContent("Catalog First");
});
```

- [x] **Step 2: 运行面板测试确认 RED**

Run:

```bash
cd frontend && pnpm exec vitest run src/pages/marketing/agent-model-config/__tests__/model-config-panel.test.tsx
```

Expected: FAIL —— 失败保留、请求中保留两个用例因当前实现清空列表而失败；探测未成功仍回落到空列表。

- [x] **Step 3: 让 `handleProbe` 只在成功时替换列表**

```ts
  const handleProbe = async () => {
    if (!providerDraft || !canProbe) return;
    const requestFingerprint = providerFingerprint;
    const revision = probeUiRevision.current;
    setConnectionResult(null);
    controller.clearOperationError();
    const applyModelOptions = (nextOptions: ModelOption[]) => {
      setModelOptions(nextOptions);
      setSelectedModelId(nextOptions[0]?.id ?? "");
      if (nextOptions.length > 0) {
        setPurpose("primary");
        toast.success(t("已获取可用模型"));
      } else {
        toast.error(t("未获取到可用模型，请检查API Key是否正确或有效"));
      }
    };
    if (activeProvider?.discoveryStrategy === "catalog") {
      applyModelOptions(catalogModelOptions);
      return;
    }
    const probeResult = await controller.probe({
      apiKey: apiKey.trim(),
      baseUrl: providerDraft.baseUrl,
      apiMode: providerDraft.apiMode,
    });
    if (revision !== probeUiRevision.current || requestFingerprint !== providerFingerprintRef.current) return;
    if (!probeResult) {
      toast.error(t("模型配置操作失败，请重试。"));
      return;
    }
    if (!probeResult.succeeded) {
      toast.error(t("未获取到可用模型，请检查API Key是否正确或有效"));
      return;
    }
    applyModelOptions(probeResult.models.map((id) => ({ id, name: id, source: "live" as const })));
  };
```

- [x] **Step 4: 运行面板测试确认 GREEN**

Run:

```bash
cd frontend && pnpm exec vitest run src/pages/marketing/agent-model-config/__tests__/model-config-panel.test.tsx
```

Expected: PASS（该文件全部用例通过）。

---

### Task 4: 质量门禁与范围核对

**Files:**
- Verify: 本次改动涉及的 3 个源文件与 2 个测试文件。

- [x] **Step 1: 运行模型配置全量定向测试**

Run:

```bash
cd frontend && pnpm exec vitest run src/pages/marketing/agent-model-config src/pages/marketing/__tests__/agent-settings-sdk-boundary.test.ts
```

Expected: 全部通过，无新增告警。

- [x] **Step 2: 运行静态门禁与差异检查**

Run:

```bash
cd frontend && pnpm check
git diff --check
```

Expected: 两条命令退出码均为 0；TypeScript diagnostics 的 `new` 计数为 0；`git diff --check` 无空白错误。

实际：首轮因本机 `frontend/node_modules` 为部分安装（缺 `opencc-js`、`@wecom/wecom-aibot-sdk`、`@orama/tokenizers` 等），`pnpm check` 在 `scripts/i18n-zh-hant.mjs` 中断、类型基线误报 23 个 new。经用户确认后执行 `CI=true pnpm install --frozen-lockfile`（`package.json` 与 `pnpm-lock.yaml` 未被改动），复跑 `pnpm check` 退出码 0，TypeScript diagnostics 为 206 current / 276 baseline / 0 new / 70 resolved；`git diff --check` 退出码 0。

- [x] **Step 3: 输出验收摘要并等待用户确认**

不自动 commit / push / 创建 MR；把 RED→GREEN 证据、门禁结果和范围核对结论汇报给用户。

## Result

- Task 1 RED：`product-provider-adapter.test.ts` 2 个用例失败（`supportsLiveModelRefresh` 为 `undefined`）；GREEN 后 7/7 通过。
- Task 2 RED：`model-config-panel.test.tsx` 4 个新用例失败（模型下拉仍为「请先获取可用模型」占位、腾讯系仍渲染实时入口）；GREEN 后 29/29 通过。
- Task 3 RED：4 个用例失败（探测失败/命令失败仍清空列表、成功空结果回落目录、请求中被目录覆盖）；GREEN 后 33/33 通过。
- 实现期发现并修复 `model-config-client.test.ts` 中缺少新必填字段的 `ModelProviderOption` 夹具（由类型基线检查暴露）。
- 定向回归：`src/pages/marketing/agent-model-config` 与 `agent-settings-sdk-boundary.test.ts` 共 7 files / 128 tests 通过；唯一 skip 是 `hermes-model-config-real-smoke.test.ts` 的 `describe.skipIf(!hermesSource)`，本机无真实 Hermes 源码时既有跳过。
- 扩大回归：补装依赖后 `src/pages/marketing` 全量 102 files / 1409 tests，1398 通过。剩余 10 个失败均与本次改动无关：
  - 西语 / 印尼语词条断言 5 个（`agent-automations-panel.es`、`agent-automations-panel.id-ID`、`renewal-id-ID`），不引用 `agent-model-config`。
  - 并行满载下的超时 5 个（`account-page-faceid`、`SkillsDemoPanel` ×3、`model-config-client` 的 `reloads lifecycle changes...`）。其中 `model-config-client` 那条会 spawn 真实 Python helper，全量并行时该文件耗时 54s、单条 5s 超时；单独运行该目录 125/126 全通过，且该用例不引用本次修改的 `catalogProvider` 夹具。
- 实现偏差：`handleAdd` 成功分支改用 `restoreCatalogModelOptions()` 后，原先紧随其后的 `setConnectionResult(null)` 已由该函数覆盖，故一并删除，行为不变。

## Self-Review

- 设计文档「供应商范围」→ Task 1；「初始展示」「重置时机」「腾讯系隐藏按钮」→ Task 2；「实时获取」四种结果 → Task 3；「测试与验证」→ Task 1-4 各自的运行步骤与 Task 4。
- 无 TBD / TODO / 「类似 Task N」占位；每个改代码的步骤都给出完整代码。
- 类型一致性：`supportsLiveModelRefresh` 在类型定义、适配层、面板消费处与测试夹具中命名一致；`catalogModelOptions` / `restoreCatalogModelOptions` / `canRefreshModels` 在 Task 2、Task 3 中保持同名。
