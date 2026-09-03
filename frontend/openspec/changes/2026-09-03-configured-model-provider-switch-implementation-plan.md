# 已配置模型 Provider 分组切换 Implementation Plan

> **执行约束：** 按 TDD 顺序逐步执行；未经用户明确确认，不执行 `git commit`、`git push` 或创建 MR。

**Goal:** 把“已配置模型”从平铺模型列表调整为 Provider 分组列表，并把当前产品目录中的其他模型并入已经配置的 Provider，让用户直接切换模型且无需重新添加 Provider 或提交 API Key。

**Architecture:** 保留 `AgentModelConfigPanel -> useModelConfig -> Hermes debug/exec` 现有数据流。在面板内用 `providerKey + normalized(routeBaseUrl ?? baseUrl)` 派生稳定分组，并将严格匹配的 `providers[].catalogModels` 合并为 UI 候选；Hermes 命令层只在相同 Provider 运行身份下复用已保存配置和 `keyEnv`、补入目标模型 ID。展开态和组内单选态仅保存在 React 本地状态；切换继续复用 `controller.assign(...)`，不增加协议字段。

**Tech Stack:** React 19、TypeScript、Tailwind、shadcn/ui、lucide-react、Vitest、Testing Library、现有 i18n 提取流程。

**Design:** `openspec/changes/2026-09-03-configured-model-provider-switch-design.md`

**Status:** Provider 分组、目录模型切换、行内操作布局、数量移除、带模型名称的 Provider 角色标签及同端点同模型的独立 Provider 展示与备用链写入均已按 TDD 完成，等待提交确认。

## 全局约束

- 不修改 SDK、Hermes 配置格式、后端接口、凭据存储或 `debug/exec` action 协议。
- 不调用 `controller.add`、`controller.probe` 或 `controller.testConnection` 完成已配置模型切换。
- 保留备用模型、取消备用、删除、主模型不可删除、空态和错误态。
- 所有新增可见文案使用 `t(...)`，按钮文案固定为“设为主模型”。
- 不引入新依赖，不为单处逻辑建立跨模块抽象。
- Provider 标题以“主模型：模型名称”“备用模型：模型名称”聚合展示组内角色；同组同时承担主备角色时默认同排、空间不足时自动换行；多个备用模型名称合并到备用模型标签中。

## Task 1：用失败测试锁定 Provider 分组和跨 Provider 切换

**Files:**

- Modify: `src/pages/marketing/agent-model-config/__tests__/model-config-panel.test.tsx`

- [x] 在现有面板测试中增加跨 Provider 场景：Alpha 为当前主模型，Beta 下存在至少一个已配置模型；断言当前 Provider 默认展开并显示“当前生效”，其他 Provider 默认收起。
- [x] 展开 Beta、选择目标模型、点击组内“设为主模型”，断言只提交一次 `assign`，其 `providerKey`、`modelId`、`baseUrl` 和 `routeBaseUrl` 来自 Beta 已保存配置。
- [x] 断言切换动作没有产生 `add`、`probe` 或 `connectivityProbe`，并在响应后把 Beta 标为“当前生效”、目标模型标为“主模型”。
- [x] 增加同一 Provider 多模型场景，断言同一运行身份只出现一个 Provider 分组、组内单选互斥，已是主模型时组按钮禁用。
- [x] 调整既有平铺列表断言，使备用/删除操作在展开的 Provider 分组内继续被覆盖。

关键测试形态：

```tsx
const betaGroup = await screen.findByRole("group", { name: "Beta API 已配置模型" });
await userEvent.click(within(betaGroup).getByRole("radio", { name: "model-beta-2" }));
await userEvent.click(within(betaGroup).getByRole("button", { name: "设为主模型" }));

expect(remote.actions.filter((action) => action.type === "assign")).toEqual([
  expect.objectContaining({
    type: "assign",
    providerKey: "lightvela-beta",
    modelId: "model-beta-2",
    purpose: "primary",
  }),
]);
expect(remote.actions).not.toContainEqual(expect.objectContaining({ type: "add" }));
expect(remote.actions).not.toContainEqual(expect.objectContaining({ type: "probe" }));
expect(remote.actions).not.toContainEqual(expect.objectContaining({ type: "connectivityProbe" }));
```

- [x] 运行面板专项测试，确认新增交互在生产代码修改前按预期 RED，并记录具体失败原因。

```bash
pnpm vitest run src/pages/marketing/agent-model-config/__tests__/model-config-panel.test.tsx
```

## Task 2：最小实现 Provider 分组、展开和组内选择

**Files:**

- Modify: `src/pages/marketing/agent-model-config/agent-model-config-panel.tsx`

- [x] 引入展开图标，并在面板文件内增加仅服务本组件的 Provider 分组类型与纯函数。

```tsx
type ConfiguredProviderGroup = {
  key: string;
  providerName: string;
  models: HermesConfiguredModel[];
};

function getConfiguredProviderGroupKey(model: HermesConfiguredModel) {
  const routeBaseUrl = (model.routeBaseUrl ?? model.baseUrl)
    .trim()
    .replace(/\/+$/, "")
    .toLowerCase();
  return JSON.stringify([model.providerKey.trim().toLowerCase(), routeBaseUrl]);
}

function groupConfiguredModelsByProvider(models: HermesConfiguredModel[]) {
  const groups = new Map<string, ConfiguredProviderGroup>();
  for (const model of models) {
    const key = getConfiguredProviderGroupKey(model);
    const group = groups.get(key);
    if (group) group.models.push(model);
    else groups.set(key, { key, providerName: model.providerName, models: [model] });
  }
  return [...groups.values()];
}
```

- [x] 用 `useMemo` 从已过滤的 `configuredModels` 派生分组，并维护当前展开分组与每组单选模型身份；当 snapshot 更新时保留仍有效的用户选择，否则回退到组内主模型或第一项。

```tsx
const configuredProviderGroups = useMemo(
  () => groupConfiguredModelsByProvider(configuredModels),
  [configuredModels],
);
const [expandedProviderKey, setExpandedProviderKey] = useState<string | null | undefined>(undefined);
const [selectedModelByProvider, setSelectedModelByProvider] = useState<Record<string, string>>({});
```

- [x] 把平铺 `<ul>` 改为 Provider 手风琴：标题按钮暴露 `aria-expanded` / `aria-controls`，当前主模型所在分组显示“当前生效”，展开内容使用带 Provider 名称的 `role="group"`。
- [x] 组内模型改为原生 radio；保留模型角色徽标、备用模型操作和删除操作，不在每一行重复渲染主模型按钮。
- [x] 在分组底部增加唯一“设为主模型”按钮；未选中、忙碌、配置不完整或已经是主模型时禁用；点击时只调用现有 `controller.assign(selectedModel, "primary")`。

关键渲染形态：

```tsx
<input
  type="radio"
  name={`configured-model-${group.key}`}
  checked={selectedIdentity === getHermesModelIdentity(model)}
  onChange={() => selectConfiguredModel(group.key, model)}
/>

<Button
  type="button"
  disabled={busy || !selectedModel || sameModel(snapshot.primary, selectedModel)}
  onClick={() => selectedModel && void controller.assign(selectedModel, "primary")}
>
  <Check className="size-3.5" aria-hidden="true" />
  {t("设为主模型")}
</Button>
```

- [x] 运行面板专项测试直到 GREEN，保持实现只覆盖已确认需求。

```bash
pnpm vitest run src/pages/marketing/agent-model-config/__tests__/model-config-panel.test.tsx
```

## Task 3：回归、国际化和页面验收

**Files:**

- Verify: `src/pages/marketing/agent-model-config/**`
- Verify: `src/i18n/**`

- [x] 运行模型配置目录完整测试，确认添加、检测、连接测试、备用模型和删除行为无回归。

```bash
pnpm vitest run src/pages/marketing/agent-model-config
```

- [x] 运行 i18n 提取/校验；若“当前生效”等文案产生新 key，只通过项目脚本生成并补齐必需 locale，不手改 hash。

```bash
pnpm i18n:extract
pnpm i18n:check
```

- [x] 运行前端综合门禁和差异检查。

```bash
pnpm check
git diff --check
```

- [x] 分别完成 CN/global 生产构建；在 1280px 与 390px 检查静态页面可达、无横向溢出和无新增控制台错误。因本地账号没有 Agent，带模型数据的展开/切换交互由 CN/global 组件用例覆盖。
- [x] 对照设计文档逐项核验验收标准，并检查最终 diff 没有 SDK、后端、凭据或无关页面改动。
- [x] 向用户展示改动文件、关键 diff、测试结果和拟提交信息；仅在用户明确确认后执行 commit/push/MR。

## 验证记录

- RED：新增 2 个 Provider 分组测试按预期失败，既有 29 项通过；失败原因是旧页面没有 Provider 展开按钮和组内 radio。
- GREEN：面板测试 31/31；模型配置目录 127/127，另 1 条按环境跳过。
- `pnpm check`：TypeScript diagnostics 191 current / 276 baseline / 0 new / 85 resolved；i18n 结构错误 0。
- `pnpm build:cn`：94/94 静态页；`pnpm build:global`：592/592 静态页。
- 浏览器：global 静态 `/agents/models/` 可达，1280px 与 390px 均无横向溢出、无新增 console error；本地账号没有 Agent，页面停留在创建入口。
- `git diff --check`：通过。

## Task 17：主备模型标签默认同排并按需换行

**Files:**

- Modify: `src/pages/marketing/agent-model-config/agent-model-config-panel.tsx`
- Test: `src/pages/marketing/agent-model-config/__tests__/model-config-panel.test.tsx`

- [x] 先将现有双角色 Provider 用例改为要求标签容器包含 `flex-row flex-wrap justify-end` 且不包含 `flex-col`，运行专项测试并确认旧实现固定纵向排列而按预期 RED。
- [x] 将标签容器最小改为横向可换行布局；空间充足时主、备用模型标签同排，空间不足时由 `flex-wrap` 自然换行。
- [x] 运行模型配置完整回归、`pnpm check` 和 `git diff --check`，并确认本地 Mock 预览地址可达。
- [ ] 刷新本地 Mock 预览，人工检查桌面下标签同排、窄屏空间不足时自然换行；自动化浏览器受本地 URL 安全策略限制。

增量验证记录：

- RED：双角色专项 2 failed / 50 skipped，实际容器仍为 `flex-col items-end`。
- GREEN：双角色专项 2 passed / 50 skipped。
- 完整回归：模型配置目录 156 项通过，另 1 项按环境跳过；`pnpm check` 通过，TypeScript 0 条新增诊断；`git diff --check` 通过；本地 Mock 预览返回 HTTP 200。

## Task 18：模型行删除按钮仅显示图标

**Files:**

- Modify: `src/pages/marketing/agent-model-config/agent-model-config-panel.tsx`
- Test: `src/pages/marketing/agent-model-config/__tests__/model-config-panel.test.tsx`

- [x] 先增加删除按钮必须具有多语言 `aria-label`、32px 方形尺寸且不包含可见“删除”文字的断言，运行专项测试并确认旧实现按预期 RED。
- [x] 删除按钮中的可见文案，仅保留现有 `Trash2` 图标；使用 `aria-label={t("删除")}` 保持读屏名称，不修改删除确认弹窗及删除逻辑。
- [x] 运行模型配置完整回归、`pnpm check` 和 `git diff --check`，并确认本地 Mock 预览地址可达。
- [ ] 刷新本地 Mock 预览，人工确认删除按钮仅显示图标且操作区排版正常。

增量验证记录：

- RED：删除操作专项 1 failed / 51 skipped，实际按钮没有 `aria-label`。
- GREEN：删除操作专项 1 passed / 51 skipped。
- 完整回归：模型配置目录 156 项通过，另 1 项按环境跳过；`pnpm check` 通过，TypeScript 0 条新增诊断且多语言结构错误 0；`git diff --check` 通过；本地 Mock 预览返回 HTTP 200。

## Task 19：移除目录候选的“可选模型”标签

**Files:**

- Modify: `src/pages/marketing/agent-model-config/agent-model-config-panel.tsx`
- Test: `src/pages/marketing/agent-model-config/__tests__/model-config-panel.test.tsx`
- Test: `src/pages/marketing/agent-model-config/__tests__/agent-model-config.id-ID.test.ts`

- [x] 先将目录候选用例改为要求候选行不出现“可选模型”，运行专项测试并确认旧实现按预期 RED。
- [x] 目录候选行不再渲染状态 Badge；已保存模型的主模型、备用模型和未启用状态保持不变，候选模型操作逻辑保持不变。
- [x] 从模型配置页的印尼语覆盖清单中移除已不再使用的“可选模型”文案，不手工修改生成资源。
- [x] 运行模型配置完整回归、`pnpm check` 和 `git diff --check`，并确认本地 Mock 预览地址可达。
- [ ] 刷新本地 Mock 预览，人工确认目录候选模型行不再显示状态标签且排版正常。

增量验证记录：

- RED：目录候选专项 1 failed / 51 skipped，实际仍渲染“可选模型”Badge。
- GREEN：目录候选专项 1 passed / 51 skipped。
- 完整回归：模型配置目录 155 项通过，另 1 项按环境跳过；`pnpm check` 通过，TypeScript 0 条新增诊断，i18n 源文案减少为 2693 条且结构错误 0；`git diff --check` 通过；本地 Mock 预览返回 HTTP 200。

## Task 20：统一模型名称与文字操作按钮字号

**Files:**

- Modify: `src/pages/marketing/agent-model-config/agent-model-config-panel.tsx`
- Test: `src/pages/marketing/agent-model-config/__tests__/model-config-panel.test.tsx`

- [x] 先将模型行排版用例改为要求模型名称和两个可见文字操作按钮均使用 `text-xs font-normal`，运行专项测试并确认旧实现按预期 RED。
- [x] 将模型名称、“设为主模型”和“设为备用模型 / 取消备用”显式统一为 `text-xs font-normal`；纯图标删除按钮、交互和全局 Button 样式保持不变。
- [x] 运行模型配置目录完整回归、`pnpm check`、`git diff --check`，并确认本地 Mock 预览地址可达。
- [ ] 刷新本地 Mock 预览，人工确认模型名称与文字按钮字号一致。

增量验证记录：

- RED：模型行排版专项 1 failed / 51 skipped，实际模型名称仍为 `text-sm`。
- GREEN：模型行排版专项 1 passed / 51 skipped。
- 完整回归：模型配置目录 155 项通过，另 1 项按环境跳过；`pnpm check` 通过，TypeScript 0 条新增诊断且多语言结构错误 0；`git diff --check` 通过；本地 Mock 预览返回 HTTP 200。

## Task 16：为备用模型 neutral 标签补充灰色边框

**Files:**

- Modify: `src/pages/marketing/agent-model-config/agent-model-config-panel.tsx`
- Test: `src/pages/marketing/agent-model-config/__tests__/model-config-panel.test.tsx`

- [x] 在现有 Provider 标题和模型行备用标签断言中补充 `border border-[var(--border-subtle)]`，运行专项测试并确认旧实现因没有边框按预期 RED。
- [x] 仅为备用模型的两处 neutral Badge 增加主题灰色边框；不修改共享 Badge 的 neutral variant，避免可选模型、未启用等其他状态被统一加框。
- [x] 运行模型配置目录完整回归、`pnpm check` 和 `git diff --check`。
- [ ] 刷新本地 Mock 预览确认标签框视觉效果；本地开发服务已恢复，但自动化浏览器被本地 URL 安全策略拦截，保留给人工确认。

增量验证记录：

- RED：目标测试 1 failed / 33 skipped，实际 class 缺少 `border border-[var(--border-subtle)]`。
- GREEN：目标测试 1 passed / 33 skipped。
- 完整回归：模型配置目录 137 项通过，另 1 项按环境跳过；`pnpm check` 通过，TypeScript 0 条新增诊断；`git diff --check` 通过。

## Task 13：将添加模型按钮移到表单右下角

**Files:**

- Modify: `src/pages/marketing/agent-model-config/agent-model-config-panel.tsx:1041-1054`
- Test: `src/pages/marketing/agent-model-config/__tests__/model-config-panel.test.tsx:677-680`

**Interfaces:**

- Consumes: 现有表单底部 `flex` 操作容器和内容宽度的“添加模型”按钮。
- Produces: 操作容器在所有屏宽使用 `justify-end`；按钮尺寸、禁用条件、加载状态和 `handleAdd()` 调用保持不变。

- [x] **Step 1：先将现有布局断言改为右对齐**

```tsx
expect(addButton.parentElement).toHaveClass("justify-end");
expect(addButton.parentElement).not.toHaveClass("justify-start");
expect(addButton).not.toHaveClass("w-full");
```

- [x] **Step 2：运行目标测试并确认 RED**

Run: `pnpm exec vitest run --api.host=127.0.0.1 src/pages/marketing/agent-model-config/__tests__/model-config-panel.test.tsx -t "uses the production-style lower form"`

Expected: 1 failed，按钮父容器实际仍包含 `justify-start`。

- [x] **Step 3：实现最小布局修改**

```tsx
<div className="flex justify-end border-t border-black/[0.06] pt-5">
```

不修改其内部 `Button` 的 class、disabled 条件或 `onClick`。

- [x] **Step 4：运行目标测试并确认 GREEN**

Run: `pnpm exec vitest run --api.host=127.0.0.1 src/pages/marketing/agent-model-config/__tests__/model-config-panel.test.tsx -t "uses the production-style lower form"`

Expected: 1 passed，其余用例按筛选跳过。

- [x] **Step 5：运行完整回归和前端门禁**

Run:

```bash
pnpm exec vitest run --api.host=127.0.0.1 src/pages/marketing/agent-model-config
pnpm check
pnpm i18n:check
git diff --check
```

Expected: 全部命令 exit 0，TypeScript 无新增诊断，i18n 无新增缺口。

- [x] **Step 6：更新验证记录并进入提交确认点**

把 RED/GREEN 和完整门禁结果写回 `frontend/openspec/plan.md` 与本计划；只展示最终提交范围，得到用户确认后才 commit、push 并更新 MR !3569。

增量验证记录：

- 基线：固定 Vitest API host 为 `127.0.0.1` 后目标测试 1 passed / 33 skipped；未固定 host 的首次启动因本机 `localhost` DNS 解析失败，未进入测试断言。
- RED：目标测试 1 failed / 33 skipped，按钮父容器实际仍为 `justify-start`。
- GREEN：目标测试 1 passed / 33 skipped；模型配置目录 137 项通过，另 1 项按环境跳过。
- `pnpm check`：通过，TypeScript diagnostics 191 current / 276 baseline / 0 new / 85 resolved，i18n 结构错误 0。
- `pnpm i18n:check`：通过，2699 条文案；印尼语既有缺口 174 条。
- `git diff --check`：通过。

## Task 14：降低模型行名称与操作按钮的字体强调

**Files:**

- Modify: `src/pages/marketing/agent-model-config/agent-model-config-panel.tsx:655-712`
- Test: `src/pages/marketing/agent-model-config/__tests__/model-config-panel.test.tsx:475-515`

**Interfaces:**

- Consumes: 现有 `AgentModelConfigPanel` 模型行、共享 `Button` 组件和 `cn` class 合并规则。
- Produces: 仅模型行名称使用 `text-xs font-normal`，仅该行三个操作按钮使用 `font-normal`；交互、文案和全局 Button 样式不变。

- [x] **Step 1：先写失败的排版回归**

在 `renders three role-aware actions with custom disabled-state tooltips` 中增加：

```tsx
const primaryModelName = within(primaryRow).getByText("model-primary");
expect(primaryModelName).toHaveClass("text-xs", "font-normal");
expect(primaryModelName).not.toHaveClass("text-sm", "font-semibold");
for (const action of within(primaryRow).getAllByRole("button")) {
  expect(action).toHaveClass("font-normal");
  expect(action).not.toHaveClass("font-semibold");
}
```

- [x] **Step 2：运行专项测试并确认 RED**

Run: `pnpm exec vitest run src/pages/marketing/agent-model-config/__tests__/model-config-panel.test.tsx -t "renders three role-aware actions"`

Expected: 模型名称仍为 `text-sm font-semibold`，且按钮未包含局部 `font-normal`，断言失败。

- [x] **Step 3：实现最小局部样式覆盖**

将模型名称改为：

```tsx
<span className="break-all text-xs font-normal text-black/85">
```

将三个模型行操作按钮的 class 统一改为：

```tsx
className="rounded-md font-normal"
```

- [x] **Step 4：运行专项测试并确认 GREEN**

Run: `pnpm exec vitest run src/pages/marketing/agent-model-config/__tests__/model-config-panel.test.tsx -t "renders three role-aware actions"`

Expected: 1 passed，其余用例按筛选跳过。

- [x] **Step 5：运行模型配置完整回归和前端门禁**

Run:

```bash
pnpm exec vitest run src/pages/marketing/agent-model-config
pnpm check
pnpm i18n:check
git diff --check
```

Expected: 全部命令 exit 0，TypeScript 无新增诊断，i18n 无新增缺口。

- [x] **Step 6：更新 OpenSpec 验证结果并进入提交确认点**

将本任务的 RED/GREEN、完整测试和门禁结果写回 `frontend/openspec/plan.md` 与本计划；仅展示拟提交范围，不在未获确认时 commit 或 push。

增量验证记录：

- RED：目标测试 1 failed / 33 skipped，模型名称实际仍为 `text-sm font-semibold`。
- RED 复核：仅临时撤回按钮局部覆盖后，目标测试再次 1 failed / 33 skipped，实际渲染仍继承全局 `font-semibold`。
- GREEN：目标测试 1 passed / 33 skipped；模型配置目录 137 项通过，另 1 项按环境跳过。
- `pnpm check`：通过，TypeScript diagnostics 191 current / 276 baseline / 0 new / 85 resolved，i18n 结构错误 0。
- `pnpm i18n:check`：通过，2699 条文案；印尼语既有缺口 174 条。
- `git diff --check`：通过。

## Task 10：移除误导性的模型数量

**Files:**

- Modify: `src/pages/marketing/agent-model-config/__tests__/model-config-panel.test.tsx`
- Modify: `src/pages/marketing/agent-model-config/agent-model-config-panel.tsx`

- [x] 增加失败断言：标题区不存在“共 N 个”，Provider 展开按钮的可访问名称不包含分组模型数量。
- [x] 运行面板专项测试，确认旧实现因顶部总数和 Provider 行数量仍存在而按预期 RED。
- [x] 删除 `configuredModelCount` 派生值、标题右侧总数和 Provider 行右侧数量；保留当前生效徽标、展开状态与列表内容。
- [x] 运行面板专项、模型配置完整测试、`pnpm check` 和 `git diff --check`。
- [x] 刷新本地 Mock 预览，确认标题和 Provider 行均无数量，模型切换与状态徽标保持不变。

## Task 11：将 Provider 的“当前生效”改为主备角色标签

**Files:**

- Modify: `src/pages/marketing/agent-model-config/agent-model-config-panel.tsx`
- Modify: `src/pages/marketing/agent-model-config/__tests__/model-config-panel.test.tsx`
- Verify: `src/i18n/generated/*.json`

- [x] 先调整面板测试：主模型 Provider 显示带模型名称的“主模型”标签，备用模型 Provider 显示带模型名称的“备用模型”标签；同一 Provider 同时承载主、备模型时分两行显示且主模型在上，多个备用模型合并显示；断言 Provider 标题不再出现“当前生效”。
- [x] 运行面板专项测试，确认现有实现因仍渲染“当前生效”而按预期 RED。
- [x] 在 Provider 分组渲染中分别派生主模型、备用模型列表，复用目录展示名并按主上备下渲染 Badge；保持默认展开仍由主模型身份决定。
- [x] 运行 i18n 提取并补齐所有支持语言的带模型名标签，再运行面板专项、模型配置完整测试和 `pnpm i18n:check`。
- [x] 刷新本地 Mock 预览，检查单角色与双角色标签、桌面和窄屏换行，以及“当前生效”已消失。

增量验证记录：

- RED：面板 4 项因旧实现仍显示“当前生效”、未显示带模型名称的主备标签而按预期失败，其余 30 项通过。
- GREEN：面板 34/34；使用隔离的 `cryptography` 测试依赖环境后，模型配置目录 132/132，另 1 条按环境跳过。
- `pnpm i18n:extract` 生成 2 个带模型名称的新词条，en-US、zh-Hant、id-ID、es、ja-JP、ko-KR 均已补齐；`pnpm i18n:check` 通过。
- `pnpm check`：TypeScript diagnostics 191 current / 276 baseline / 0 new / 85 resolved；i18n 结构错误 0。
- 浏览器：同一 Provider 显示“主模型：Hy4 Preview”和“备用模型：Hy3”两行，主模型在上；390px 下页面宽度与视口均为 390px，无横向溢出。

## Task 4：把“设为主模型”收回模型行操作区

**Files:**

- Modify: `src/pages/marketing/agent-model-config/__tests__/model-config-panel.test.tsx`
- Modify: `src/pages/marketing/agent-model-config/agent-model-config-panel.tsx`

- [x] 先修改面板测试：断言每个模型行的操作区都包含“设为主模型”“设为备用模型 / 取消备用”“删除”，并断言 Provider 分组底部不再存在独立操作行。
- [x] 运行面板专项测试，确认新断言因当前“设为主模型”位于分组底部而按预期失败。
- [x] 将“设为主模型”按钮移入每个模型行现有操作容器，点击时直接调用 `controller.assign(model, "primary")`；保留现有 radio、角色徽标、禁用原因和 Tooltip。
- [x] 删除 Provider 分组底部的独立按钮容器以及只为该按钮服务的 `selectedIsPrimary` 派生值，不改变分组和 radio 行为。
- [x] 运行面板专项测试和模型配置目录完整测试，确认新布局及跨 Provider 切换、备用模型、删除行为全部通过。
- [x] 运行 `pnpm check`、`git diff --check`，并刷新本地 Mock 预览完成桌面端 smoke；窄屏由现有 `flex-col` / `flex-wrap` 响应式结构和组件测试覆盖。

关键测试形态：

```tsx
const targetRow = screen.getByText("model-beta-2").closest("li") as HTMLElement;
expect(within(targetRow).getByRole("button", { name: "设为主模型" })).toBeEnabled();
expect(within(targetRow).getByRole("button", { name: "设为备用模型" })).toBeEnabled();
expect(within(targetRow).getByRole("button", { name: "删除" })).toBeEnabled();

await userEvent.click(within(targetRow).getByRole("button", { name: "设为主模型" }));
expect(remote.actions).toContainEqual(expect.objectContaining({
  type: "assign",
  modelId: "model-beta-2",
  purpose: "primary",
}));
```

增量验证记录：

- RED：面板测试 2 项按预期失败，原因分别为目标模型行找不到“设为主模型”和模型行按钮数量仍为 2。
- GREEN：面板专项 31/31；模型配置目录 127/127，另 1 条按环境跳过。
- `pnpm check`：TypeScript diagnostics 191 current / 276 baseline / 0 new / 85 resolved；i18n 结构错误 0。
- 浏览器：Mock 预览中 `hy4-preview` 与 `hy3` 各自在同一模型行内展示“设为主模型”“设为备用模型”“删除”，Provider 分组底部不再出现独立按钮行。
- `git diff --check`：通过。

## Task 12：保留共享接入地址与模型的独立 Provider

**Files:**

- Modify: `src/pages/marketing/agent-model-config/__tests__/model-config-client.test.ts`
- Modify: `src/pages/marketing/agent-model-config/hermes-model-config-command.ts`
- Verify only, do not commit: `src/app/(site)/model-provider-preview/page.next.tsx`

- [x] 先构造 Hy Token Plan 与通用 Token Plan 共用接入地址和 `hy4-preview`、但 Provider key 与 `keyEnv` 不同的真实回归场景；将 Hy4 设为 Hy Provider 备用模型后，断言两个 Provider 仍存在且两份凭据不变。
- [x] 运行客户端专项测试，确认旧投影逻辑会把通用 Token Plan 错误合并掉，按预期 RED。
- [x] 将已配置模型快照的去重边界收紧：只有两个当前配置中的 Provider 具有明确不同凭据身份时才保留为独立项；无独立配置来源的历史 Provider 别名仍按同一运行部署合并。
- [x] 运行新回归与历史别名兼容用例，再运行模型配置目录完整测试、`pnpm check` 和 `git diff --check`。
- [x] 更新不提交的 Mock 预览：Hy3 为主模型、企业版 Auto 为备用模型、通用 Token Plan 独立存在；将 Hy4 Preview 设为 Hy Provider 备用模型后，通用 Token Plan 在桌面和 390px 窄屏均继续显示。

增量验证记录：

- RED：新客户端用例中 `configuredModels` 只剩 Hy Provider 的 Hy3、Hy4，通用 Token Plan 的 Hy4 被错误合并。
- 兼容回归：首次按 Provider key 完全隔离会导致历史 Provider 别名重复；条件收紧后，新场景与历史别名场景 4/4 通过。
- GREEN：模型配置目录 134/134，另 1 条按环境跳过。
- `pnpm check`：TypeScript diagnostics 191 current / 276 baseline / 0 new / 85 resolved；i18n 结构错误 0。
- 浏览器：设置 Hy4 Preview 为备用模型后，Hy Provider 显示主模型 Hy3 与备用模型 Hy4 Preview，通用 Token Plan 仍存在；390px 下页面宽度与视口均为 390px，无横向溢出。
- `git diff --check`：通过。

## Task 5：用失败测试锁定目录模型并入已配置 Provider

**Files:**

- Modify: `src/pages/marketing/agent-model-config/__tests__/model-config-panel.test.tsx`

- [x] 构造 snapshot 仅含 `hy4-preview`、产品目录同时含 `hy4-preview` 与其他模型的场景；断言 Hy Provider 分组显示两个模型，模型总数也按合并去重后的可切换模型计算。
- [x] 断言目录候选显示“设为主模型”和“设为备用模型”，但在尚未写入 Hermes 配置前不显示“删除”。
- [x] 点击目录候选的“设为主模型”，断言只提交一次现有 `assign` action，且携带已保存 Hy Provider 的 `providerKey`、`modelId`、`baseUrl` 和 `routeBaseUrl`；断言不提交 `add`、`probe` 或 `connectivityProbe`，也不包含凭据字段。
- [x] 增加地址与 API 模式分别不匹配的场景，断言不会把目录模型并入同名但不同运行身份的已配置 Provider。
- [x] 运行面板专项测试，确认新增用例因当前页面只渲染 snapshot 模型而按预期 RED。

```bash
pnpm vitest run src/pages/marketing/agent-model-config/__tests__/model-config-panel.test.tsx
```

## Task 6：用失败测试锁定 Hermes 复用 Provider 凭据

**Files:**

- Modify: `src/pages/marketing/agent-model-config/__tests__/model-config-client.test.ts`

- [x] 基于真实 helper 脚本构造仅保存 `hy4-preview` 的 Provider 配置，向现有 `assign` action 传入同一 Provider 运行身份下的其他模型；断言命令成功、Provider 的模型列表补入目标模型、默认模型切换，并保留原 `keyEnv` / key 映射。
- [x] 覆盖备用模型用途，断言目录模型可通过同一逻辑补入并加入 fallback。
- [x] 增加接入地址不匹配和匹配歧义场景，断言命令拒绝复用，且原配置不被修改。
- [x] 运行客户端专项测试，确认新增用例因 `find_configured` 要求模型已保存而按预期 RED。

```bash
PATH=/Users/pablozhong/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin:$PATH pnpm vitest run src/pages/marketing/agent-model-config/__tests__/model-config-client.test.ts
```

## Task 7：最小实现目录模型合并与可分配模型解析

**Files:**

- Modify: `src/pages/marketing/agent-model-config/agent-model-config-panel.tsx`
- Modify: `src/pages/marketing/agent-model-config/hermes-model-config-command.ts`

- [x] 在面板文件内增加 UI-only `catalogOnly` 标记和严格的 Provider 目录匹配 helper；只将当前 `providers[].catalogModels` 中同运行身份的缺失模型合并进分组，不硬编码 Hy 模型，不改变自定义 Provider。
- [x] 目录候选继承现有 Provider 身份字段，继续通过 `controller.assign` 提交；行内保留主/备用操作，并仅对真实已保存模型展示删除操作。
- [x] 在现有 Hermes helper 中为 `assign` 增加最小可分配模型解析：先完全匹配，未命中时仅从相同 `providerKey + normalized(routeBaseUrl ?? baseUrl)` 的唯一配置克隆身份并替换目标模型 ID，再复用 `ensure_provider_model`。
- [x] 保持 `remove` / `removeFallback` 仍要求完全匹配的已保存模型，避免目录候选被误删；不增加 API Key 传输、返回或日志。
- [x] 分别运行 Task 5、Task 6 专项测试直到 GREEN，再运行模型配置目录完整测试。

```bash
pnpm vitest run src/pages/marketing/agent-model-config/__tests__/model-config-panel.test.tsx
PATH=/Users/pablozhong/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin:$PATH pnpm vitest run src/pages/marketing/agent-model-config/__tests__/model-config-client.test.ts
PATH=/Users/pablozhong/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin:$PATH pnpm vitest run src/pages/marketing/agent-model-config
```

## Task 8：回归、门禁与真实交互预览

**Files:**

- Verify: `src/pages/marketing/agent-model-config/**`
- Verify: `src/i18n/**`
- Verify only, do not commit: `src/app/(site)/model-provider-preview/page.next.tsx`

- [x] 运行 `pnpm i18n:check`、`pnpm check` 与 `git diff --check`；本轮没有新增用户可见文案，因此未重新生成 i18n 资源。
- [x] 将不提交的 Mock 预览调整为 snapshot 仅含一个已保存模型、产品目录含多个模型，确认页面仍显示目录候选，且“设为主模型”与备用操作在同一行、目录候选没有删除入口。
- [x] 用当前连接上海生产 API 的本地开发服务完成 1920px 桌面端与 750px 窄窗口浏览器 smoke；两种宽度均无横向溢出，目录模型主模型切换成功且页面未进入错误态。
- [x] 已配置模型优先使用匹配产品目录的模型名称，保证与添加模型选择器的大小写和展示文案一致，同时保留原始模型 ID 参与配置操作。
- [x] 对照设计验收标准检查最终 diff，确认没有 SDK、API Key、Provider 静态目录或无关页面改动。

目录模型增量验证记录：

- RED：面板 1 项按预期失败，实际显示“共 1 个”；Hermes 客户端 1 项按预期失败，返回“model is not saved”对应的统一操作失败。
- GREEN：面板专项 34/34；Hermes 客户端 42/42；模型配置目录 132/132，另 1 条按环境跳过。
- `pnpm check`：TypeScript diagnostics 191 current / 276 baseline / 0 new / 85 resolved；i18n 结构错误 0。
- 浏览器：Mock snapshot 只保存 `hy4-preview`，目录候选 `hy3` 仍直接显示；未启用时无删除入口，点击“设为主模型”后状态切换成功。1920px 与 750px 均无横向溢出。
- `git diff --check`：通过。

## 完成定义

- Provider 分组、默认展开、默认选择、跨 Provider 主模型切换均通过自动化测试和页面 smoke。
- 已配置 Provider 会合并当前产品目录中的其他模型；切换目录模型复用已保存凭据并持久化目标模型，不要求 API Key。
- 切换只出现 `assign`，不出现重新添加、探测、连接检测或 API Key 交互。
- `pnpm check`、`pnpm i18n:check`、模型配置测试和 `git diff --check` 全部通过。
- 最终 diff 严格限定在面板、对应测试、必要 i18n 资源和本次 OpenSpec 文档。

## Task 9：区分目录候选与已保存闲置模型状态

**Files:**

- Modify: `src/pages/marketing/agent-model-config/__tests__/model-config-panel.test.tsx`
- Modify: `src/pages/marketing/agent-model-config/agent-model-config-panel.tsx`
- Modify: `src/i18n/generated/{zh-CN,zh-Hant,en-US,id-ID,es,ja-JP,ko-KR,zh-to-key}.json`

- [x] 将目录候选断言从“未启用”改为“可选模型”，并保留真实已保存闲置模型仍显示“未启用”的既有断言。
- [x] 运行面板专项测试，确认旧实现因目录候选仍显示“未启用”而按预期 RED。
- [x] 在模型角色徽标中仅对 `catalogOnly` 项显示 `t("可选模型")`；主模型、备用模型和已保存闲置模型的既有状态保持不变。
- [x] 运行 `pnpm i18n:extract` 生成新 key，并补齐中文简体、中文繁体、英语、印度尼西亚语、西班牙语、日语和韩语译文。
- [x] 运行面板专项、模型配置完整测试、`pnpm i18n:check`、`pnpm check` 和 `git diff --check`。
- [x] 刷新本地 Mock 预览，确认目录候选显示“可选模型”、已保存闲置模型显示“未启用”，操作按钮和删除规则不变。

关键渲染形态：

```tsx
const roleLabel = role === "primary"
  ? t("主模型")
  : role === "fallback"
    ? t("备用模型")
    : model.catalogOnly
      ? t("可选模型")
      : t("未启用");
```

多语言文案：

- `zh-CN`: `可选模型`
- `zh-Hant`: `可選模型`
- `en-US`: `Available model`
- `id-ID`: `Model tersedia`
- `es`: `Modelo disponible`
- `ja-JP`: `選択可能なモデル`
- `ko-KR`: `선택 가능 모델`

增量验证记录：

- RED：面板 1 项按预期失败，目录候选实际仍显示“未启用”；其余 33 项通过。
- GREEN：面板 34/34；模型配置目录 133/133，另 1 条按环境跳过；字典完整性 18/18。
- `pnpm i18n:check`：英语、繁中、西语、日语、韩语 2694/2694，印尼语 2520/2694，既有缺口保持 174 条、未新增翻译债务。
- `pnpm check`：TypeScript diagnostics 191 current / 276 baseline / 0 new / 85 resolved；i18n 结构错误 0。
- 浏览器：目录候选 `Hy3` 显示“可选模型”且仍无删除按钮，已保存 `Hy4 Preview` 的操作规则未变化。
- `git diff --check`：通过。

## Task 12：允许凭据不同的同端点同模型 Provider 同时进入备用链

**Files:**

- Modify: `src/pages/marketing/agent-model-config/hermes-model-config-command.ts`
- Modify: `src/pages/marketing/agent-model-config/__tests__/model-config-client.test.ts`

- [x] 按用户真实配置构造 Hy Token Plan 与通用 Token Plan 共用接入地址和 `hy4-preview`、但使用不同 `key_env` 的场景；先写入第一条备用路由，再为第二个 Provider 执行 `assign(..., "fallback")`。
- [x] 运行专项用例并确认 RED：第二条路由被 `same_runtime_deployment` 当作别名去重，持久化配置只剩第一条。
- [x] 将已配置 Provider 的凭据身份判定复用于 fallback 读取、追加、取消和角色校验；同 Provider 或无法证明凭据独立的历史别名继续按既有规则去重。
- [x] 断言两条备用路由按顺序保留，快照分别返回两个 Provider；取消通用 Token Plan 路由后，Hy Token Plan 路由仍保留。
- [x] 增加 `assign(..., "primary")` 与 `add(..., "primary")` 回归：设为主模型时仍按运行时部署清理所有冲突的 fallback 别名，不修改 Hermes 配置格式、凭据内容或 action 协议。

增量验证记录：

- RED：新增专项用例失败，预期两条 `fallback_providers`，实际只有 Hy Token Plan 一条。
- RED：两条主模型反向回归均失败，`assign` 与 `add` 都错误保留了同运行时部署的 sibling fallback。
- GREEN：Hermes 客户端 47/47；模型配置目录 137 项通过，另 1 项按环境跳过。
- `pnpm check`：通过，TypeScript diagnostics 191 current / 276 baseline / 0 new / 85 resolved，i18n 结构错误 0。
- `pnpm i18n:check`：通过，2699 条文案；印尼语既有缺口 174 条。
- `git diff --check`：通过。

## Task 15：将备用模型标签改为 neutral 灰色

**Files:**

- Modify: `src/pages/marketing/agent-model-config/agent-model-config-panel.tsx:606-662`
- Test: `src/pages/marketing/agent-model-config/__tests__/model-config-panel.test.tsx:370-390`

**Interfaces:**

- Consumes: 现有 `Badge` 的 `success`、`warning`、`neutral` variant。
- Produces: Provider 标题与展开模型行的备用模型标签都使用既有 `neutral` 灰色；主模型继续使用 `success`，共享 Badge 组件不变。

- [x] **Step 1：先锁定 Provider 标题备用标签为 neutral**

在 `keeps models with the same Provider identity in one radio group` 中增加：

```tsx
expect(fallbackProviderLabel).toHaveClass(
  "bg-[var(--surface-muted)]",
  "text-[var(--text-secondary)]",
);
expect(fallbackProviderLabel).not.toHaveClass(
  "bg-[color-mix(in_oklab,var(--warning)_20%,white)]",
  "text-[var(--warning)]",
);
```

- [x] **Step 2：运行标题专项并确认 RED**

Run: `pnpm exec vitest run --api.host=127.0.0.1 src/pages/marketing/agent-model-config/__tests__/model-config-panel.test.tsx -t "keeps models with the same Provider identity"`

Expected: 1 failed，标题备用标签仍渲染 `warning` 样式。

- [x] **Step 3：将标题备用标签最小改为 neutral 并确认 GREEN**

```tsx
<Badge
  variant="neutral"
  className="justify-end whitespace-normal break-all text-right leading-tight"
>
```

重新运行 Step 2 命令，Expected: 1 passed。

- [x] **Step 4：先锁定模型行备用标签为 neutral**

在同一测试中增加：

```tsx
const fallbackRow = screen.getByText("model-alpha-2").closest("li") as HTMLElement;
const fallbackRowLabel = within(fallbackRow).getByText("备用模型");
expect(fallbackRowLabel).toHaveClass(
  "bg-[var(--surface-muted)]",
  "text-[var(--text-secondary)]",
);
expect(fallbackRowLabel).not.toHaveClass(
  "bg-[color-mix(in_oklab,var(--warning)_20%,white)]",
  "text-[var(--warning)]",
);
```

- [x] **Step 5：运行模型行专项并确认 RED**

Run: `pnpm exec vitest run --api.host=127.0.0.1 src/pages/marketing/agent-model-config/__tests__/model-config-panel.test.tsx -t "keeps models with the same Provider identity"`

Expected: 1 failed，模型行备用标签仍渲染 `warning` 样式。

- [x] **Step 6：将模型行备用标签最小改为 neutral 并确认 GREEN**

```tsx
<Badge variant={primary ? "success" : "neutral"}>
```

重新运行 Step 5 命令，Expected: 1 passed。

- [x] **Step 7：运行完整回归和前端门禁**

Run:

```bash
pnpm exec vitest run --api.host=127.0.0.1 src/pages/marketing/agent-model-config
pnpm check
pnpm i18n:check
git diff --check
```

Expected: 全部命令 exit 0，TypeScript 无新增诊断，i18n 无新增缺口。

- [x] **Step 8：更新验证记录并进入提交确认点**

把两轮 RED/GREEN 与完整门禁结果写回 `frontend/openspec/plan.md` 和本计划；得到用户确认后才 commit、push 并更新 MR !3569。

增量验证记录：

- 基线：目标测试 1 passed / 33 skipped。
- Provider 标题 RED：1 failed / 33 skipped，实际仍为 warning 橙色；改用 neutral 后 GREEN 1 passed / 33 skipped。
- 模型行 RED：1 failed / 33 skipped，实际仍为 warning 橙色；主模型外统一使用 neutral 后 GREEN 1 passed / 33 skipped。
- 模型配置目录：137 项通过，另 1 项按环境跳过。
- `pnpm check`：通过，TypeScript diagnostics 191 current / 276 baseline / 0 new / 85 resolved，i18n 结构错误 0。
- `pnpm i18n:check`：通过，2699 条文案；印尼语既有缺口 174 条。
- `git diff --check`：通过。
