# 国际站模型表单操作按钮防裁切 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让国际站模型配置表单的长语言操作按钮完整显示，同时保持国内站和模型业务逻辑不变。

**Architecture:** 由已知区域的设置页把 `isGlobal` 显式传入模型面板；模型面板仅根据该布尔值切换复合控件布局类。国际站使用“窄屏两行、桌面 `minmax(0,1fr) + max-content`”网格，国内站保留现有固定宽度 Flex。

**Tech Stack:** React 19、TypeScript 5.9、Tailwind CSS v4、Vitest 4、Testing Library。

## Global Constraints

- 只影响国际站模型配置表单；国内站保持现状。
- 不修改任何翻译资源或西语文案。
- 不修改模型 Provider、API Key、探测、状态检测或添加模型逻辑。
- 不执行 `git commit`、`git push` 或创建 MR。

---

### Task 1: 国际站模型复合控件响应式布局

**Files:**
- Modify: `frontend/src/pages/marketing/agent-model-config/__tests__/model-config-panel.test.tsx`
- Modify: `frontend/src/pages/marketing/agent-model-config/agent-model-config-panel.tsx`
- Modify: `frontend/src/pages/marketing/agent-settings-page.tsx`
- Verify: `frontend/openspec/changes/2026-08-26-international-model-actions-overflow-design.md`

**Interfaces:**
- Consumes: `isGlobal: boolean` from `@/lib/region` in `AgentSettingsPage`.
- Produces: optional `isGlobalRegion?: boolean` prop on `AgentModelConfigPanel`; omitted value preserves domestic layout for existing callers and tests.

- [x] **Step 1: 写国际站布局失败测试**

在现有测试渲染 helper 上增加可选区域参数，并新增国际站断言：

```tsx
function renderPanel(remote: ReturnType<typeof createRemote>, isGlobalRegion = false) {
  return render(
    <AgentModelConfigPanel
      botId="bot-1"
      execDebugCommand={remote.execDebugCommand}
      providers={providers}
      isGlobalRegion={isGlobalRegion}
    />,
  );
}

it("lets international model actions fit long localized labels", async () => {
  const remote = createRemote({ primary: null, fallbacks: [], configuredModels: [] });
  renderPanel(remote, true);
  await screen.findByRole("heading", { name: "已配置模型" });

  const apiKey = screen.getByLabelText("API Key");
  const model = screen.getByRole("combobox", { name: "模型" });
  const fetchButton = screen.getByRole("button", { name: "获取可用模型" });
  const statusButton = screen.getByRole("button", { name: "检测模型状态" });

  expect(apiKey.closest('[data-slot="model-api-key-control"]')).toHaveClass(
    "grid",
    "h-auto",
    "grid-cols-1",
    "sm:h-12",
    "sm:grid-cols-[minmax(0,1fr)_max-content]",
  );
  expect(model.closest('[data-slot="model-option-control"]')).toHaveClass("grid", "grid-cols-1");
  expect(fetchButton).toHaveClass("h-12", "w-full", "border-t", "sm:h-full", "sm:w-auto", "sm:min-w-max");
  expect(statusButton).toHaveClass("h-12", "w-full", "border-t", "sm:h-full", "sm:w-auto", "sm:min-w-max");
  expect(fetchButton).not.toHaveClass("w-28", "sm:w-36");
  expect(statusButton).not.toHaveClass("w-28", "sm:w-36");
});
```

- [x] **Step 2: 运行测试并确认 RED**

Run:

```bash
cd frontend
pnpm exec vitest run --config vitest.config.ts \
  src/pages/marketing/agent-model-config/__tests__/model-config-panel.test.tsx \
  -t "lets international model actions fit long localized labels"
```

Expected: FAIL，因为 `AgentModelConfigPanel` 尚未接受 `isGlobalRegion`，复合控件仍为固定宽度 Flex。

- [x] **Step 3: 实现最小区域化布局**

为 `AgentModelConfigPanel` 增加默认值为 `false` 的 prop；把复合控件布局和操作按钮尺寸分别用 `cn` 切换：

```tsx
const MODEL_COMPOUND_CONTROL_BASE_CLASS =
  "min-w-0 overflow-hidden rounded-md border border-black/10 bg-white shadow-none transition-colors focus-within:border-[#2F6BFF]";

const controlClassName = cn(
  MODEL_COMPOUND_CONTROL_BASE_CLASS,
  isGlobalRegion
    ? "grid h-auto grid-cols-1 sm:h-12 sm:grid-cols-[minmax(0,1fr)_max-content]"
    : "flex h-12",
);

const actionClassName = cn(
  "shrink-0 rounded-none border-0 bg-white px-3 shadow-none hover:translate-y-0 hover:border-black/10 hover:bg-black/[0.025] focus-visible:ring-inset",
  isGlobalRegion
    ? "h-12 w-full border-t border-black/10 sm:h-full sm:w-auto sm:min-w-max sm:border-l sm:border-t-0 sm:px-4"
    : "h-full w-28 border-l border-black/10 sm:w-36",
);
```

在 `TeaSdkSettingsPanel` 调用处传入：

```tsx
<AgentModelConfigPanel
  botId={instance.InstanceId}
  execDebugCommand={execDebugCommand}
  providers={...}
  isGlobalRegion={isGlobal}
/>
```

API Key 包装层和两个字段在国际站使用 `h-12 w-full`，桌面恢复 `sm:h-full`，保证网格两行都有确定高度。

- [x] **Step 4: 重跑组件测试确认 GREEN**

Run:

```bash
cd frontend
pnpm exec vitest run --config vitest.config.ts \
  src/pages/marketing/agent-model-config/__tests__/model-config-panel.test.tsx
```

Expected: 全部 PASS，既有国内站固定宽度断言继续通过。

- [x] **Step 5: 执行静态检查与浏览器验收**

Run:

```bash
cd frontend
pnpm check
git diff --check
```

浏览器在已登录西语 `/agents/models/` 页面验证：两个目标按钮均满足 `scrollWidth <= clientWidth`，并且按钮右边界不超过各自复合控件右边界；窄屏视口下按钮位于字段下一行且页面无横向滚动。

- [x] **Step 6: 展示差异和验证证据**

汇总修改文件、RED/GREEN 证据、类型检查和浏览器尺寸；保持工作区未提交，等待用户后续指令。
