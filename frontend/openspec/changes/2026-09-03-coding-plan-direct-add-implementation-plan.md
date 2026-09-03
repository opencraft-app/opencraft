# Coding Plan 直接添加模型 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 点击 Coding Plan 的“添加模型”时直接保存选中模型，不再自动执行模型状态检测，同时保留独立手动检测能力。

**Architecture:** 删除 Provider 层的 `validateBeforeAdd` 能力和面板中的添加前检测分支，让 `handleAdd` 只负责调用 `controller.add`。手动“检测模型状态”继续通过 `handleConnectivityTest` 调用 `controller.testConnection`，两条路径互不复用状态。

**Tech Stack:** React 19、TypeScript、Vitest、Testing Library。

## Global Constraints

- 所有 Coding Plan 继续直接展示七彩石模型目录，默认选择首项并允许切换。
- “检测模型状态”按钮及其 `model_request` 行为保持不变。
- 添加仍使用当前 API Key、模型和用途，并继续传递 `discoverModels: false`。
- 不修改七彩石请求、缓存、Provider 缺失过滤或整体失败兜底。

---

### Task 1: 解耦添加与模型状态检测

**Files:**
- Modify: `frontend/src/pages/marketing/agent-model-config/__tests__/model-config-panel.test.tsx`
- Modify: `frontend/src/pages/marketing/agent-model-config/__tests__/product-provider-adapter.test.ts`
- Modify: `frontend/src/pages/marketing/agent-model-config/agent-model-config-panel.tsx`
- Modify: `frontend/src/pages/marketing/agent-model-config/product-provider-adapter.ts`
- Modify: `frontend/src/pages/marketing/agent-model-config/hermes-model-config-command.ts`
- Modify: `frontend/openspec/plan.md`

**Interfaces:**
- Consumes: `controller.add({ apiKey, model, purpose, discoverModels })` 与独立的 `controller.testConnection(...)`。
- Produces: Coding Plan 添加路径只发出 `HermesModelConfigAction` 的 `add` 动作；`ModelProviderOption` 不再暴露 `validateBeforeAdd`。

- [x] **Step 1: 写失败测试锁定直接添加行为**

将面板测试中的添加前验证场景改为直接添加断言：

```ts
it("adds the selected Coding Plan model without automatic validation", async () => {
  // 渲染带七彩石目录的 Coding Plan，输入 API Key 并选择模型。
  await userEvent.click(screen.getByRole("button", { name: "添加模型" }));

  await waitFor(() => expect(toastMocks.success).toHaveBeenLastCalledWith("模型已添加"));
  expect(remote.actions.some((action) => action.type === "connectivityProbe")).toBe(false);
  expect(remote.actions).toContainEqual(expect.objectContaining({
    type: "add",
    discoverModels: false,
    model: expect.objectContaining({ id: "hy-next" }),
  }));
});
```

同时删除“自动检测失败则不添加”“检测期间目录刷新阻止添加”等只属于旧流程的测试；保留独立手动检测测试。

- [x] **Step 2: 运行聚焦测试并确认 RED**

Run:

```bash
cd frontend
PATH=/Users/pablozhong/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin:$PATH pnpm exec vitest run --config vitest.config.ts src/pages/marketing/agent-model-config/__tests__/model-config-panel.test.tsx src/pages/marketing/agent-model-config/__tests__/product-provider-adapter.test.ts
```

Expected: 新增的直接添加断言失败，因为当前动作序列仍包含 `connectivityProbe`；不是语法、环境或 fixture 错误。

- [x] **Step 3: 删除 Provider 的添加前检测能力**

在 `ModelProviderOption` 删除：

```ts
validateBeforeAdd?: boolean;
```

在产品 Provider 适配层把 Coding Plan 能力收敛为：

```ts
...(isCodingPlan ? { fixedModelSelection: true } : {}),
```

同步移除适配器测试中 `validateBeforeAdd: true` 的期望。

- [x] **Step 4: 最小化添加处理函数**

删除 `validateBeforeAdd`、`validatingBeforeAdd`、`validationRequestRef`、`selectedModelTargetRef` 及其重置逻辑，并让 `handleAdd` 在基础校验后直接执行：

```ts
const nextSnapshot = await controller.add({
  apiKey: normalizedApiKey,
  model: selectedModel,
  purpose,
  discoverModels: category === "custom" || activeProvider?.discoveryStrategy !== "catalog",
});
```

手动检测按钮的 loading 条件恢复为：

```tsx
loading={controller.operation === "connectivity-probe"}
```

添加按钮只在 `controller.operation === "add"` 时显示 loading 图标。

- [x] **Step 5: 运行聚焦回归并确认 GREEN**

Run: Step 2 的同一命令。

Expected: 面板与 Provider 适配测试全部通过，0 failures；独立检测测试仍断言 `connectivityProbe` 使用 `model_request`。

- [x] **Step 6: 运行前端质量门禁**

Run:

```bash
cd frontend
pnpm check
```

Expected: i18n 结构错误为 0，TypeScript 新增诊断为 0，命令退出码为 0。

Run:

```bash
git diff --check
```

Expected: 无输出，退出码为 0。

- [x] **Step 7: 更新执行记录并准备提交**

在 `frontend/openspec/plan.md` 记录 RED、GREEN、`pnpm check` 与差异检查结果；提交前展示最终文件范围和提交信息，由用户确认后再执行 `git commit` / `git push`。
