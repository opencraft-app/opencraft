# 已配置模型 Provider 分组切换 Implementation Plan

> **执行约束：** 按 TDD 顺序逐步执行；未经用户明确确认，不执行 `git commit`、`git push` 或创建 MR。

**Goal:** 把“已配置模型”从平铺模型列表调整为 Provider 分组列表，并把当前产品目录中的其他模型并入已经配置的 Provider，让用户直接切换模型且无需重新添加 Provider 或提交 API Key。

**Architecture:** 保留 `AgentModelConfigPanel -> useModelConfig -> Hermes debug/exec` 现有数据流。在面板内用 `providerKey + normalized(routeBaseUrl ?? baseUrl)` 派生稳定分组，并将严格匹配的 `providers[].catalogModels` 合并为 UI 候选；Hermes 命令层只在相同 Provider 运行身份下复用已保存配置和 `keyEnv`、补入目标模型 ID。展开态和组内单选态仅保存在 React 本地状态；切换继续复用 `controller.assign(...)`，不增加协议字段。

**Tech Stack:** React 19、TypeScript、Tailwind、shadcn/ui、lucide-react、Vitest、Testing Library、现有 i18n 提取流程。

**Design:** `openspec/changes/2026-09-03-configured-model-provider-switch-design.md`

**Status:** Provider 分组与行内操作布局均已按 TDD 完成，等待用户验收。

## 全局约束

- 不修改 SDK、Hermes 配置格式、后端接口、凭据存储或 `debug/exec` action 协议。
- 不调用 `controller.add`、`controller.probe` 或 `controller.testConnection` 完成已配置模型切换。
- 保留备用模型、取消备用、删除、主模型不可删除、空态和错误态。
- 所有新增可见文案使用 `t(...)`，按钮文案固定为“设为主模型”。
- 不引入新依赖，不为单处逻辑建立跨模块抽象。

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
