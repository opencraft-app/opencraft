# 高级设置关闭审批状态提示移除 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从高级设置页面移除“当前高风险操作无需审批”状态提示，并清理所有已支持语言的对应翻译资源。

**Architecture:** 删除 `AgentCommonSettingsPanel` 中仅负责展示该提示的条件 JSX，不改变 `approvalMode` 的读取、选择、保存和确认弹窗。将现有关闭审批与多语言用例改为断言提示不存在，再通过项目 i18n 抽取流程删除废弃 key，确保组件和资源同步收口。

**Tech Stack:** React 19、TypeScript、Vitest、Testing Library、项目内 i18n 抽取与校验脚本。

## Global Constraints

- 只移除“当前高风险操作无需审批”状态提示和对应 `k_c56b6745` 多语言资源。
- 保留“关闭审批”选项、保存流程、风险确认弹窗及其文案。
- 不修改 `approvals.mode`、Hermes 命令、页面其他布局或区域边界。
- 不使用 CSS 隐藏或空翻译；组件 JSX 与七种语言资源必须同时清理。

---

### Task 1: 删除关闭审批状态提示及多语言资源

**Files:**
- Modify: `frontend/src/pages/marketing/__tests__/agent-common-settings-panel.test.tsx:385-425`
- Modify: `frontend/src/pages/marketing/agent-common-settings-panel.tsx:551-556`
- Modify: `frontend/src/i18n/generated/en-US.json`
- Modify: `frontend/src/i18n/generated/es.json`
- Modify: `frontend/src/i18n/generated/id-ID.json`
- Modify: `frontend/src/i18n/generated/ja-JP.json`
- Modify: `frontend/src/i18n/generated/ko-KR.json`
- Modify: `frontend/src/i18n/generated/zh-CN.json`
- Modify: `frontend/src/i18n/generated/zh-Hant.json`
- Modify: `frontend/src/i18n/generated/zh-to-key.json`
- Modify: `frontend/openspec/plan.md`

**Interfaces:**
- Consumes: `snapshot.values.approvalMode`、审批模式 `Select`、现有 locale-aware test render helper。
- Produces: 关闭审批状态下不再渲染提示；不新增函数、组件、状态或配置字段。

- [x] **Step 1: 将关闭审批状态用例改为期望提示不存在**

保留选择器与弹窗断言，仅替换提示断言：

```tsx
it("shows an existing off mode without opening a confirmation dialog", async () => {
  render(
    <AgentCommonSettingsPanel
      botId="bot-a"
      botStatus="running"
      bots={bots}
      getGatewayRestartCommand={async () => "restart"}
      loadSettings={async () => baseSnapshot({
        values: { ...baseSnapshot().values, approvalMode: "off" },
      })}
      saveSetting={vi.fn()}
    />,
  );

  expect(await screen.findByRole("combobox", { name: "审批模式" })).toHaveTextContent("关闭审批");
  expect(screen.queryByText("当前高风险操作无需审批")).toBeNull();
  expect(screen.queryByText("当前不会请求危险命令审批")).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
});
```

- [x] **Step 2: 将六种非简体中文语言用例改为期望提示不存在**

```tsx
it.each([
  ["en-US", "High-risk operations run without approval"],
  ["zh-Hant", "當前高風險操作無需審批"],
  ["id-ID", "Operasi berisiko tinggi tanpa persetujuan"],
  ["es", "Las operaciones de alto riesgo se ejecutan sin aprobación"],
  ["ja-JP", "現在、高リスク操作は承認なしで実行されます"],
  ["ko-KR", "현재 고위험 작업은 승인 없이 실행됩니다"],
] as const)("does not render the approval-off warning for %s", async (locale, removedCopy) => {
  render(
    <AgentCommonSettingsPanel
      botId="bot-a"
      botStatus="running"
      bots={bots}
      getGatewayRestartCommand={async () => "restart"}
      loadSettings={async () => baseSnapshot({
        values: { ...baseSnapshot().values, approvalMode: "off" },
      })}
      saveSetting={vi.fn()}
    />,
    locale,
  );

  await screen.findAllByTestId("common-setting-row");
  expect(screen.queryByText(removedCopy)).toBeNull();
});
```

- [x] **Step 3: 运行测试并确认 RED**

Run:

```bash
cd frontend
pnpm exec vitest run --config vitest.config.ts src/pages/marketing/__tests__/agent-common-settings-panel.test.tsx --api.host 127.0.0.1
```

Expected: 7 个新期望失败，分别对应简体中文状态提示和六种其他语言提示仍被渲染；其余用例继续通过。

- [x] **Step 4: 删除组件中的提示 JSX**

从 `agent-common-settings-panel.tsx` 删除以下完整条件块：

```tsx
{!unsupported && setting.key === "approvalMode" && snapshot.values.approvalMode === "off" && (
  <span className="whitespace-nowrap text-right text-xs text-amber-700">
    {t("当前高风险操作无需审批")}
  </span>
)}
```

不得修改相邻的保存反馈、压缩禁用提示、审批选择器或确认弹窗。

- [x] **Step 5: 运行 i18n 抽取并验证资源清理**

Run:

```bash
cd frontend
pnpm i18n:extract
rg -n 'k_c56b6745|当前高风险操作无需审批|High-risk operations run without approval|當前高風險操作無需審批|Operasi berisiko tinggi tanpa persetujuan|Las operaciones de alto riesgo se ejecutan sin aprobación|現在、高リスク操作は承認なしで実行されます|현재 고위험 작업은 승인 없이 실행됩니다' src/i18n/generated
```

Expected: 抽取命令成功；`rg` 无输出，七份语言字典和 `zh-to-key.json` 均不再包含该 key 或译文。

- [x] **Step 6: 运行定向测试并确认 GREEN**

Run:

```bash
cd frontend
pnpm exec vitest run --config vitest.config.ts src/pages/marketing/__tests__/agent-common-settings-panel.test.tsx --api.host 127.0.0.1
```

Expected: 测试文件全部通过；关闭审批选项与确认流程现有用例继续通过。

- [x] **Step 7: 运行完整前端门禁**

Run:

```bash
cd frontend
pnpm i18n:check
pnpm check
git diff --check
```

Expected: i18n 错误为 0、`pnpm check` 退出码为 0、TypeScript diagnostics 新增数为 0，`git diff --check` 无输出。

- [x] **Step 8: 浏览器验收并更新计划状态**

使用国内站本地环境打开 `/agents/settings/`，将审批模式切换或加载为“关闭审批”，确认：

- 选择器仍显示“关闭审批”。
- 红框位置不再展示状态提示，也没有残留空白元素。
- 从其他模式切换到“关闭审批”时风险确认弹窗仍正常出现。
- 页面控制台无新增错误。

在 `frontend/openspec/plan.md` 勾选任务并记录 RED、GREEN、i18n、`pnpm check`、diff 与浏览器结果。展示最终范围、风险和拟提交信息，取得用户明确确认后再执行 commit/push/MR。

## Execution Results

- RED：目标测试 7 failed / 41 passed；七个失败均由对应语言的旧提示仍被渲染导致。
- GREEN：目标测试 48/48 passed，既有“关闭审批”选项与风险确认流程用例继续通过。
- i18n：`pnpm i18n:extract` 删除 `k_c56b6745`；目标 key、中文和六种译文检索均无结果；`pnpm i18n:check` 通过。
- Frontend gate：`pnpm check` 退出码 0，TypeScript diagnostics 0 new；`git diff --check` 无输出。
- Browser：真实 `/agents/settings/` 因当前本地账号无 Agent 落入空状态；随后使用已删除的临时本地组件预览完成交互验收。选择“关闭审批”时确认弹窗正常出现，确认后选择器显示“关闭审批”、目标提示计数为 0、弹窗关闭，控制台错误为 0。
