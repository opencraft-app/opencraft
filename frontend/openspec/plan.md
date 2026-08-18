# 已安装技能实例展开 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** 实现与验证完成，等待用户验收；不自动提交、推送或创建 MR。

**Goal:** 修复 `/agents/skills` 已安装列表在 SkillHub 返回同名聚合技能时漏展示 `instances[]` 子实例的问题。

**Architecture:** SkillHub installed parser 将 `skills[].instances[]` 展开为独立 `InstalledSkill` 行；实例 `rawId` 保持为命令目标，`slug` 优先使用 `relative_path` 供展示和搜索；已安装列表搜索纳入 `slug` 与 `nativeAliases`。

**Tech Stack:** React 19、TypeScript 5.9、Vitest 4、Testing Library。

## Global Constraints

- 仅调整 `/agents/skills` 已安装清单的数据解析、展示标识和搜索匹配。
- 不修改安装、卸载命令格式；SkillHub 实例卸载仍使用实例 `id/rawId` 作为命令目标。
- 不新增 API、依赖、区域分支、视觉结构或 i18n 资源。

---

### Task 1: 展开 SkillHub installed instances 并验证

**Files:**
- Modify: `frontend/src/pages/marketing/skills-demo/skill-registries.ts`
- Modify: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`
- Test: `frontend/src/pages/marketing/skills-demo/skill-registries.test.ts`
- Test: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.test.tsx`

**Interfaces:**
- Consumes: `acli skills list` JSON 中的 `skills[].instances[]`、`id`、`name`、`display_name`、`relative_path`、`version`。
- Produces: 每个 instance 对应一条 `InstalledSkill`；`rawId` 用于命令，`slug/nativeAliases` 用于展示、搜索和合并匹配。

- [x] **Step 1 — 增加失败回归测试**
  - 解析器测试覆盖 `humanizer.instances[]`，断言 `unclecheng-reduce-ai-perception-v2` 被展开为独立行。
  - UI 测试覆盖已安装搜索可按 instance `relative_path` 命中，列表展示路径但卸载仍携带实例 `rawId`。

- [x] **Step 2 — 运行测试并确认 RED**
  - Run: `cd frontend && pnpm exec vitest run src/pages/marketing/skills-demo/skill-registries.test.ts src/pages/marketing/skills-demo/SkillsDemoPanel.test.tsx`
  - Expected: FAIL，旧实现只展示 top-level `humanizer` 且搜索不到 `unclecheng-reduce-ai-perception-v2`。

- [x] **Step 3 — 实现最小修复**
  - 展开 SkillHub `instances[]`，保留父级分类/展示名兜底。
  - 让已安装列表展示 `skill.slug`，搜索匹配 `slug/nativeAliases`。

- [x] **Step 4 — 运行定向测试与质量门禁**
  - Run: `cd frontend && pnpm exec vitest run src/pages/marketing/skills-demo/skill-registries.test.ts src/pages/marketing/skills-demo/SkillsDemoPanel.test.tsx`
  - Run: `cd frontend && pnpm check && cd .. && git diff --check`

- [x] **Step 5 — 修复已安装搜索框双清除按钮**
  - 在已安装搜索框有值时保留自定义清除按钮，禁用 Chromium/WebKit 原生 search cancel 和 decoration。
  - Run: `cd frontend && pnpm exec vitest run src/pages/marketing/skills-demo/SkillsDemoPanel.test.tsx`

- [x] **Step 6 — 统一三个 Tab 搜索框聚焦样式**
  - 技能、技能包、已安装搜索框统一使用 `lv-agent-search-box`、`lv-agent-search-box-icon`、`lv-agent-search-box-input`。
  - 已安装搜索框保留自定义清除按钮和原生 search cancel 禁用，外层固定宽度不受共享 `width: 100%` 影响。
  - Run: `cd frontend && pnpm exec vitest run src/pages/marketing/skills-demo/SkillsDemoPanel.test.tsx --testNamePattern "uses the skill package search field styling|suppresses the native search clear"`

- [ ] **Step 7 — 验收确认**
  - 汇总 diff、验证结果和剩余风险；等待用户确认后再提交、推送或 MR。

---

# 自动任务支持获取上游任务的 Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development`（推荐）或 `executing-plans` 按任务执行；每批最多 3 个任务，每批结束后运行 quick review。所有步骤使用 `- [ ]` 跟踪。

**Goal:** 在 LightVela 自动任务中安全暴露 Hermes 原生 `context_from`，支持单上游配置、关系展示、防环和删除联动，同时保持普通任务兼容。

**Architecture:** 列表仍通过 `hermes cron list --all` 加载，并从 `jobs.json` 补齐 `context_from`。普通任务继续走现有 CLI；涉及上游关系的创建、更新和删除通过 Hermes 官方 Python `cronjob` 工具执行。UI 使用独立可搜索选择器，关系和循环计算保持为纯函数。

**Tech Stack:** React 19、TypeScript 5.9、Tailwind CSS、Radix UI、Vitest、Testing Library、Hermes `tools.cronjob_tools.cronjob`、现有 `debug/exec`。

## Global Constraints

- 产品输入：`wiki/prd-docs/2026-08-13-自动任务支持获取上游任务的Context.md`。
- 目标站点：仅国内站 `lightvela.com` 启用；国际站 `lightvela.ai` 保持原有自动任务体验，不新增路由。
- 每个 LightVela 任务最多写入一个上游 ID；读取时兼容 Hermes 原生多上游数组。
- Hermes 原生读取最近完成的非空输出，不按成功状态筛选，不回退旧成功输出，不等待同 tick 上游。
- Hermes 原生最多注入 8,000 个字符；LightVela 不读取或展示输出正文。
- 不直接修改 `jobs.json`，不臆造 `--context-from` CLI 参数。
- Hermes 未提供执行级来源 metadata；不得声称某次运行实际使用了某个输出文件。
- 不新增重型依赖；选择器基于 React 和现有 UI 基础组件实现。
- TypeScript 禁止 `any`，外部 JSON 先按 `unknown` 解析。
- 不自动 commit、push 或创建 MR；每个任务只准备可审查 checkpoint，最终由用户单独授权提交。

---

## 文件结构

- Modify: `frontend/src/lib/hermes-cron-client.ts` — `context_from` 读取、能力检测和官方结构化变更适配。
- Modify: `frontend/src/lib/__tests__/hermes-cron-client.test.ts` — Cron 数据与结构化命令单测。
- Create: `frontend/src/pages/marketing/automation-upstream-picker.tsx` — 可搜索、可访问的单上游选择器。
- Create: `frontend/src/pages/marketing/__tests__/automation-upstream-picker.test.tsx` — 选择器交互和无障碍测试。
- Modify: `frontend/src/pages/marketing/agent-automations-panel.tsx` — 候选、防环、表单、卡片、详情、最近执行和删除联动。
- Modify: `frontend/src/pages/marketing/__tests__/agent-automations-panel.test.ts` — 关系纯函数与页面状态测试。
- Modify: `frontend/src/i18n/generated/en-US.json` — 新增英文翻译。
- Modify: `frontend/src/i18n/generated/zh-CN.json` — i18n 提取生成结果。
- Modify: `frontend/src/i18n/generated/zh-Hant.json` — 新文案繁体结果。
- Modify: `frontend/src/i18n/generated/zh-to-key.json` — 中文 key 映射。

---

### Task 1: 读取 `context_from` 并检测 Hermes 能力

**角色：** developer

**Files:**

- Modify: `frontend/src/lib/hermes-cron-client.ts`
- Test: `frontend/src/lib/__tests__/hermes-cron-client.test.ts`

**Interfaces:**

- Produces: `CronJob.context_from: string[] | null`
- Produces: `CronContextCapability = "supported" | "unsupported" | "unknown"`
- Produces: `normalizeCronContextFrom(value: unknown): string[] | null`
- Produces: `buildDetectCronContextFromCapabilityCommand(): string`
- Produces: `parseCronContextCapabilityOutput(output: string): CronContextCapability`
- Produces: `detectCronContextFromCapability(botId: string): Promise<CronContextCapability>`

- [x] **Step 1: 为 `context_from` 归一化和列表补齐编写失败测试**

在 `hermes-cron-client.test.ts` 增加明确用例：

```ts
expect(normalizeCronContextFrom(" job-a ")).toEqual(["job-a"]);
expect(normalizeCronContextFrom(["job-a", "", "job-a", "job-b"])).toEqual(["job-a", "job-b"]);
expect(normalizeCronContextFrom([])).toBeNull();
expect(normalizeCronContextFrom({ job: "job-a" })).toBeNull();
```

扩展现有 `listCronJobs` mock，使 `jobs.json` 中的 `context_from: ["job-a"]` 最终出现在对应 `CronJob` 上；缺失字段返回 `null`。

- [x] **Step 2: 运行定向测试，确认 RED**

Run:

```bash
cd frontend && pnpm exec vitest run src/lib/__tests__/hermes-cron-client.test.ts
```

Expected: FAIL，提示 `normalizeCronContextFrom` 未导出或 `CronJob.context_from` 缺失。

- [x] **Step 3: 实现最小数据模型与 hydration**

在 `CronJob` 增加字段，并在 `parseCronListOutput` 的默认对象中写入 `context_from: null`。在 `listCronJobs` 读取 `jobs.json` 时复用以下归一化函数：

```ts
export function normalizeCronContextFrom(value: unknown): string[] | null {
  const values = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  const normalized = [...new Set(values
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean))];
  return normalized.length > 0 ? normalized : null;
}
```

不得把外部多上游裁剪为一个。

- [x] **Step 4: 为能力检测编写失败测试**

覆盖固定 marker 的三种结果：

```ts
expect(parseCronContextCapabilityOutput('LIGHTVELA_CRON_CONTEXT_CAPABILITY={"supported":true}')).toBe("supported");
expect(parseCronContextCapabilityOutput('LIGHTVELA_CRON_CONTEXT_CAPABILITY={"supported":false}')).toBe("unsupported");
expect(parseCronContextCapabilityOutput("noise")).toBe("unknown");
```

同时断言构造命令包含 `inspect.signature(cronjob)`、`context_from` 和 Hermes venv 路径。

- [x] **Step 5: 实现能力检测并跑 GREEN**

命令核心必须等价于：

```py
import inspect, json
from tools.cronjob_tools import cronjob
supported = "context_from" in inspect.signature(cronjob).parameters
print("LIGHTVELA_CRON_CONTEXT_CAPABILITY=" + json.dumps({"supported": supported}))
```

`detectCronContextFromCapability` 捕获 import、执行和解析异常并返回 `unknown`，不得阻断普通任务列表。

Run:

```bash
cd frontend && pnpm exec vitest run src/lib/__tests__/hermes-cron-client.test.ts
```

Expected: PASS。

- [x] **Step 6: 准备 Task 1 checkpoint**

Run:

```bash
git diff --check
git diff -- frontend/src/lib/hermes-cron-client.ts frontend/src/lib/__tests__/hermes-cron-client.test.ts
```

Expected: 无空白错误；diff 只包含数据读取、能力检测和对应测试。不要执行 commit，等待最终用户授权。

---

### Task 2: 实现官方 `cronjob` 结构化关系变更

**角色：** developer

**Files:**

- Modify: `frontend/src/lib/hermes-cron-client.ts`
- Test: `frontend/src/lib/__tests__/hermes-cron-client.test.ts`

**Interfaces:**

- Consumes: `CronJob.context_from`、`normalizeCronContextFrom`
- Produces: `CronContextPatch = undefined | string[]`
- Produces: `CronjobToolPayload = Record<string, unknown> & { action: "create" | "update" | "remove" }`
- Produces: `CronjobToolResult = { success: true; job?: Record<string, unknown> }`
- Produces: `CronDependentBinding = { id: string; name: string; contextFrom: string[] }`
- Produces: `buildCronjobToolCommand(payload: CronjobToolPayload): string`
- Produces: `parseCronjobToolOutput(output: string): CronjobToolResult`
- Produces: `createCronJobWithContextAndScriptRollback(botId, input, upstreamId, rollbackScript?): Promise<string>`
- Produces: `editCronJobWithContext(botId: string, id: string, patch: EditCronJobPatch, contextFrom: string[]): Promise<void>`
- Produces: `removeCronJobWithDependentRollback(botId: string, targetId: string, dependents: readonly CronDependentBinding[]): Promise<void>`

- [x] **Step 1: 为结构化命令和结果解析编写失败测试**

测试载荷必须保持数组与清空语义：

```ts
const command = buildCronjobToolCommand({
  action: "update",
  job_id: "job-b",
  context_from: ["job-a"],
});
expect(command).toContain("from tools.cronjob_tools import cronjob");
expect(command).toContain("LIGHTVELA_CRON_CONTEXT_RESULT=");
expect(command).toContain("context_from");

expect(parseCronjobToolOutput(
  'LIGHTVELA_CRON_CONTEXT_RESULT={"success":true,"job":{"id":"job-b"}}',
)).toMatchObject({ success: true });
```

补充 `success: false`、缺 marker 和非法 JSON 均抛错的用例。

- [x] **Step 2: 运行定向测试，确认 RED**

Run:

```bash
cd frontend && pnpm exec vitest run src/lib/__tests__/hermes-cron-client.test.ts
```

Expected: FAIL，提示结构化 helper 未定义。

- [x] **Step 3: 实现安全的官方工具封装**

`buildCronjobToolCommand` 把整个 payload 先 `JSON.stringify`，Python 再 `json.loads`，不得逐字段插值：

```py
payload = json.loads(<json string literal>)
result = cronjob(**payload)
parsed = json.loads(result)
print("LIGHTVELA_CRON_CONTEXT_RESULT=" + json.dumps(parsed, ensure_ascii=False))
```

命令从 `"$HOME/.hermes/hermes-agent"` 运行 `./venv/bin/python`。解析器使用输出中最后一个 marker，只有 `success === true` 才返回。

- [x] **Step 4: 为带关系创建和三态编辑编写失败测试**

通过 mock `fetch` 捕获 `debug/exec` command，断言：

```ts
await createCronJobWithContextAndScriptRollback("bot-1", {
  schedule: "0 8 * * *",
  prompt: "write digest",
  name: "daily digest",
  skills: ["news"],
  deliver: "local",
  pinCurrentModel: true,
}, "job-a");
```

create payload 包含 `context_from: ["job-a"]` 并返回新 job ID。编辑分别验证：

- `undefined` 不进入结构化关系路径。
- `["job-a"]` 替换关系。
- `[]` 清空关系。
- 关系变更时，同次 update 包含本次表单其他 patch 字段。

- [x] **Step 5: 实现 create/update 并保持现有模型与脚本语义**

结构化 create 输入只映射 Hermes 支持字段，不传 `pinCurrentModel`。解析新任务 ID 后，将现有模型钉住 helper 改为按 ID 工作：

```ts
async function pinCronJobModelByIdBestEffort(botId: string, jobId: string): Promise<void> {
  const raw = await readRawCronJobRecordById(botId, jobId);
  const model = resolvePinnedModelFromRawCronRecord(raw);
  if (model) await editCronJob(botId, jobId, { model });
}
```

create 失败时删除已写入的 LightVela 生效窗口脚本；普通无上游 create 保持原函数不变。

- [x] **Step 6: 为删除解绑和失败回滚编写失败测试**

测试输入包含单上游和外部多上游：

```ts
const dependents = [
  { id: "job-b", name: "B", contextFrom: ["job-a"] },
  { id: "job-c", name: "C", contextFrom: ["job-x", "job-a"] },
];
```

断言 B 更新为 `[]`、C 更新为 `["job-x"]`，全部成功后才 remove A。第二个 update 失败时必须恢复 B 为 `["job-a"]` 且不 remove A；remove A 失败时恢复 B/C 原关系。

- [x] **Step 7: 实现删除事务补偿并跑 GREEN**

结构化 Python 命令保存每个下游的原数组，失败时反向调用 update 恢复。结果结构至少包含：

```ts
interface CronDependentMutationSummary {
  success: boolean;
  updated: string[];
  rollback_failed: string[];
  error?: string;
}
```

任何 `rollback_failed` 非空都抛出带任务 ID 的错误供上层映射名称，但不包含 Prompt 或输出正文。

Run:

```bash
cd frontend && pnpm exec vitest run src/lib/__tests__/hermes-cron-client.test.ts
```

Expected: PASS。

- [x] **Step 8: 准备 Task 2 checkpoint**

Run:

```bash
git diff --check
git diff -- frontend/src/lib/hermes-cron-client.ts frontend/src/lib/__tests__/hermes-cron-client.test.ts
```

Expected: 无直接 `jobs.json` 写入、无未知 CLI flag、无 `any`。不要执行 commit。

---

### Task 3: 实现关系纯函数和可搜索上游选择器

**角色：** implementer + developer

**Files:**

- Create: `frontend/src/pages/marketing/automation-upstream-picker.tsx`
- Create: `frontend/src/pages/marketing/__tests__/automation-upstream-picker.test.tsx`
- Modify: `frontend/src/pages/marketing/agent-automations-panel.tsx`
- Test: `frontend/src/pages/marketing/__tests__/agent-automations-panel.test.ts`

**Interfaces:**

- Consumes: `CronJob.context_from`
- Produces: `wouldCreateCronContextCycle(jobs, downstreamId, upstreamId): boolean`
- Produces: `getEligibleCronUpstreams(jobs, currentJobId, now): CronJob[]`，其中 `currentJobId` 创建态为 `null`
- Produces: `toCronContextPatch(initial, selected, changed): undefined | string[]`
- Produces: `AutomationUpstreamPicker(props)`

- [x] **Step 1: 为循环、候选和三态 patch 编写失败测试**

在 `agent-automations-panel.test.ts` 添加：

```ts
const jobs = [
  makeCronJob({ id: "a", context_from: null }),
  makeCronJob({ id: "b", context_from: ["a"] }),
  makeCronJob({ id: "c", context_from: ["b"] }),
];
expect(wouldCreateCronContextCycle(jobs, "a", "c")).toBe(true);
expect(wouldCreateCronContextCycle(jobs, "c", "a")).toBe(false);
expect(toCronContextPatch(["a"], "a", false)).toBeUndefined();
expect(toCronContextPatch(["a"], "", true)).toEqual([]);
expect(toCronContextPatch(["a", "x"], "", false)).toBeUndefined();
expect(toCronContextPatch(["a", "x"], "a", true)).toEqual(["a"]);
```

候选测试覆盖自身、暂停、过期、`isTestRunMarkerName`、场景试跑和成环任务。

- [x] **Step 2: 运行面板测试，确认 RED**

Run:

```bash
cd frontend && pnpm exec vitest run src/pages/marketing/__tests__/agent-automations-panel.test.ts
```

Expected: FAIL，提示关系纯函数未定义。

- [x] **Step 3: 实现关系纯函数**

循环算法以“下游 → 上游”为边，使用迭代 DFS 和 visited：

```ts
export function wouldCreateCronContextCycle(
  jobs: readonly CronJob[],
  downstreamId: string,
  upstreamId: string,
): boolean {
  if (downstreamId === upstreamId) return true;
  const upstreamsByJob = new Map(jobs.map((job) => [job.id, job.context_from ?? []]));
  const stack = [upstreamId];
  const visited = new Set<string>();
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (id === downstreamId) return true;
    if (visited.has(id)) continue;
    visited.add(id);
    stack.push(...(upstreamsByJob.get(id) ?? []));
  }
  return false;
}
```

`toCronContextPatch` 在 `changed === false` 时始终返回 `undefined`；只有用户明确选择或清空后才返回 patch，避免外部多上游被打开表单这一动作覆盖。

- [x] **Step 4: 为选择器编写失败组件测试**

测试必须覆盖：

```ts
render(<AutomationUpstreamPicker
  value=""
  options={[makeCronJob({ id: "a", name: "每日新闻收集" })]}
  state="supported"
  onChange={onChange}
/>);
```

- 打开后输入“新闻”只显示匹配项。
- 选择 A 调用 `onChange("a")`。
- 当前已选项悬停或聚焦时勾转叉，点击后调用 `onChange("")`；下拉中不展示“不关联”选项。
- `unsupported`、`unknown`、无候选和外部多上游显示对应文字。
- 键盘 Enter / ArrowDown / Escape 工作，combobox 的 `aria-expanded` 正确变化。

- [x] **Step 5: 实现最小选择器并跑 GREEN**

组件 props 固定为：

```ts
export interface AutomationUpstreamPickerProps {
  value: string;
  options: readonly CronJob[];
  state: "loading" | CronContextCapability;
  existingMultipleUpstreams?: readonly CronJob[];
  onChange: (jobId: string) => void;
  onRetry?: () => void;
}
```

使用按钮 + 搜索 input + `role="listbox"`，点击弹层外或 Escape 关闭。不得新增第三方 combobox 依赖。

Run:

```bash
cd frontend && pnpm exec vitest run src/pages/marketing/__tests__/automation-upstream-picker.test.tsx src/pages/marketing/__tests__/agent-automations-panel.test.ts
```

Expected: PASS。

- [x] **Step 6: 准备 Task 3 checkpoint**

Run:

```bash
git diff --check
git diff -- frontend/src/pages/marketing/automation-upstream-picker.tsx frontend/src/pages/marketing/__tests__/automation-upstream-picker.test.tsx frontend/src/pages/marketing/agent-automations-panel.tsx frontend/src/pages/marketing/__tests__/agent-automations-panel.test.ts
```

Expected: 选择器职责独立、纯函数可单测、无无关样式重构。不要执行 commit。

---

### Task 4: 接入创建编辑、关系展示和运行详情

**角色：** developer

**Files:**

- Modify: `frontend/src/pages/marketing/agent-automations-panel.tsx`
- Modify: `frontend/src/pages/marketing/__tests__/agent-automations-panel.test.ts`
- Modify: `frontend/src/i18n/generated/en-US.json`
- Modify: `frontend/src/i18n/generated/zh-CN.json`
- Modify: `frontend/src/i18n/generated/zh-Hant.json`
- Modify: `frontend/src/i18n/generated/zh-to-key.json`

**Interfaces:**

- Consumes: Task 1 capability与 `CronJob.context_from`
- Consumes: Task 2 structured create/update
- Consumes: Task 3 picker与关系纯函数
- Produces: 创建、编辑、卡片、详情和最近执行的完整用户路径

- [x] **Step 1: 为 Panel 接入编写失败测试**

扩展组件测试，至少断言：

- 能力检测成功时表单显示“上游任务（可选）”。
- 创建选择 A 后调用带 `context_from: [A]` 的结构化 create。
- 编辑不改关系时不传 context patch。
- 编辑替换/解除时调用一次结构化 update。
- 保存前刷新后若上游已暂停或删除，保留表单并显示错误。
- 外部多上游打开后编辑普通字段不会缩减关系。

用语义断言，不绑定 Tailwind class：

```ts
expect(screen.getByText("本任务执行时，将使用上游任务最近的输出作为上下文")).toBeTruthy();
```

- [x] **Step 2: 运行测试，确认 RED**

Run:

```bash
cd frontend && pnpm exec vitest run src/pages/marketing/__tests__/agent-automations-panel.test.ts src/pages/marketing/__tests__/automation-upstream-picker.test.tsx
```

Expected: FAIL，表单尚未接入 picker 或 structured mutation。

- [x] **Step 3: 接入 capability、表单和保存前校验**

Panel 按 `botId` 维护：

```ts
const [contextCapability, setContextCapability] = useState<"loading" | CronContextCapability>("loading");
```

向三个 `AutomationFormModal` 调用点传入 `jobs={jobs}`、`contextCapability` 和 `onRefreshJobs={refreshCreatedJobs}`。表单初始值保留完整 `initialJob.context_from`，只有用户明确修改时才生成 patch。

- [x] **Step 4: 接入卡片、详情和最近执行当前关系展示**

以 `Map<string, CronJob>` 解析上游：

```ts
const jobsById = useMemo(() => new Map(jobs.map((job) => [job.id, job])), [jobs]);
```

- 卡片：`来自：{name}`；暂停或缺失用文字补充。
- 详情：名称、当前状态和“本任务执行时，将使用上游任务最近一次的输出作为上下文。”说明。
- 最近执行详情：字段名固定为“当前关联上游”，不使用“本次已使用”。任务已删除或关系不可可靠解析时省略。

- [x] **Step 5: 生成并补齐 i18n**

Run:

```bash
cd frontend && pnpm i18n:extract
pnpm i18n:zh-hant
```

在 `src/i18n/generated/en-US.json` 为脚本新增的 key 填写以下确定映射：

- `上游任务（可选）` → `Upstream task (optional)`
- `本任务执行时，将使用上游任务最近的输出作为上下文` → `This task uses the upstream task's latest output as context.`
- `本任务执行时，将使用上游任务最近一次的输出作为上下文。` → `When this task runs, it will use the most recent output from the upstream task as context.`
- `当前关联上游` → `Currently linked upstream task`
- `最近完成状态为失败，Hermes 不会回退到更早的成功输出` → `The latest completed run failed. Hermes does not fall back to an earlier successful output.`

不得手写猜测 hash；以脚本生成的 key 为准。检查繁体用词，保持“上游任務”“最近完成輸出”。

- [x] **Step 6: 跑定向测试和 i18n 门禁**

Run:

```bash
cd frontend && pnpm exec vitest run src/pages/marketing/__tests__/automation-upstream-picker.test.tsx src/pages/marketing/__tests__/agent-automations-panel.test.ts
pnpm i18n:check
pnpm i18n:zh-hant:check
```

Expected: 全部 PASS，无缺失英文翻译或繁体漂移。

- [x] **Step 7: 准备 Task 4 checkpoint**

Run:

```bash
git diff --check
git diff -- frontend/src/pages/marketing/agent-automations-panel.tsx frontend/src/pages/marketing/__tests__/agent-automations-panel.test.ts frontend/src/i18n/generated
```

Expected: 当前阶段验证共享实现，不展示上游输出正文；最终发布范围由 Task 8 收敛为仅国内站启用。不要执行 commit。

---

### Task 5: 接入删除联动并完成端到端验证

**角色：** developer + reviewer

**Files:**

- Modify: `frontend/src/pages/marketing/agent-automations-panel.tsx`
- Modify: `frontend/src/pages/marketing/__tests__/agent-automations-panel.test.ts`
- Modify: `frontend/src/lib/hermes-cron-client.ts`（仅修复集成测试暴露的契约问题）
- Modify: `frontend/src/lib/__tests__/hermes-cron-client.test.ts`（对应回归测试）
- Modify: `frontend/src/i18n/generated/en-US.json`（仅删除确认新增文案）
- Modify: `frontend/src/i18n/generated/zh-CN.json`（仅删除确认新增文案）
- Modify: `frontend/src/i18n/generated/zh-Hant.json`（仅删除确认新增文案）
- Modify: `frontend/src/i18n/generated/zh-to-key.json`（仅删除确认新增文案）

**Interfaces:**

- Consumes: `removeCronJobWithDependentRollback`
- Produces: 删除确认中的直接下游预览和安全删除流程
- Produces: 完整质量门禁证据

- [x] **Step 1: 为删除确认与阻断编写失败测试**

覆盖：

- 删除 A 时确认弹窗列出直接下游 B，不列出只通过 B 间接关联的 C。
- 确认后调用 `removeCronJobWithDependentRollback`，而不是直接 `removeCronJob`。
- 解绑失败时 A 仍在列表，错误提示包含需检查的任务名称。
- A → B → C 删除 A 后，B 解除，C 仍引用 B。
- 删除没有下游的普通任务继续走现有直接删除路径。

- [x] **Step 2: 运行面板测试，确认 RED**

Run:

```bash
cd frontend && pnpm exec vitest run src/pages/marketing/__tests__/agent-automations-panel.test.ts
```

Expected: FAIL，当前确认弹窗只接收 `jobName` 且直接删除。

- [x] **Step 3: 实现删除预览和结构化删除接入**

Panel 从最新 `jobsRef.current` 派生直接下游：

```ts
const dependents = jobsRef.current
  .filter((job) => job.context_from?.includes(target.id))
  .map((job) => ({
    id: job.id,
    name: job.name,
    contextFrom: job.context_from ?? [],
  }));
```

确认弹窗显示名称列表和“删除后将解除上游绑定并继续独立执行”。有下游时走补偿式删除，无下游时保留现有路径。

- [x] **Step 4: 运行全部相关测试**

Run:

```bash
cd frontend && pnpm exec vitest run \
  src/lib/__tests__/hermes-cron-client.test.ts \
  src/pages/marketing/__tests__/automation-upstream-picker.test.tsx \
  src/pages/marketing/__tests__/agent-automations-panel.test.ts \
  src/pages/marketing/__tests__/agent-model-switch-automation-sync.test.ts
```

Expected: 全部 PASS；模型切换自动任务同步未回归。

- [x] **Step 5: 运行前端质量门禁**

Run:

```bash
cd frontend && pnpm i18n:check
pnpm i18n:zh-hant:check
pnpm check
cd .. && git diff --check
```

Expected: 所有命令 exit 0。若遇到与本次无关的既有失败，记录完整命令、首个错误和与 `origin/master` 的对比证据，不擅自修改无关模块。

- [ ] **Step 6: 在真实 Hermes 实例验证原生语义**

执行记录（2026-08-14）：已在真实 Hermes 实例完成 A → B → C 正常串联、无上游完成记录时下游继续成功执行、暂停上游保留关系、删除 A 仅解除直接下游 B 且保留 B → C。测试任务均已清理。真实实例暂未稳定制造“最新一次完成状态为失败但仍产生非空输出”的样本，因此第 2 项仅由契约测试覆盖，本步骤保持未完成状态。

使用测试 Agent 创建错峰 A → B → C：

1. A 先产生正常完成输出，确认 B/C 按各自计划运行。
2. 让 A 最新一次输出对应失败状态，确认 B 使用最新完成输出而不回退旧成功输出。
3. 创建尚无输出的上游，确认下游仍执行。
4. 暂停上游，确认关系保留并展示历史输出提示。
5. 删除 A，确认只解除 A → B，B → C 保留。

记录任务 ID、计划时间、状态和页面截图；不得把 Prompt 或输出正文写入仓库。

- [ ] **Step 7: 国内站浏览器回归与国际站未启用验证**

执行记录（2026-08-14）：曾按双站范围验证创建、搜索选择、关系展示、详情/最近执行文案、暂停、无输出、过期候选过滤、成环候选过滤、删除直接下游确认与英文翻译。2026-08-18 发布范围调整为仅国内站；国际站后续只验证该能力未启用。`unsupported/unknown`、外部多上游只读和部分键盘交互由组件/面板测试覆盖，尚未在真实实例构造对应数据，因此本步骤保持未完成状态。

国内站验证功能主路径；国际站验证无上游任务入口且普通自动任务保持原行为：

- 创建、搜索并选择上游。
- 编辑保持、更换和解除。
- 卡片、详情、最近执行的关系文案。
- unsupported/unknown、暂停、缺失、成环和删除确认。
- 键盘完成打开、搜索、选择、关闭。

Expected: 国内站功能主路径成立；国际站无上游任务入口且普通自动任务保持原行为；状态不只靠颜色表达。

- [x] **Step 8: 最终 full review 与用户验收门禁**

执行记录（2026-08-14）：最终整体验收 Review 经两轮问题修复与复审后结论为 `Ready to merge: Yes`，无 Critical / Important 遗留；主 Agent 新鲜门禁为 217/217 测试通过、i18n 2023/2023、繁体一致性、TypeScript/MDX 与 `git diff --check` 全通过。用户已明确验收通过；尚未执行 commit、push、MR 或归档，后续操作仍遵循各自确认门禁。

Run:

```bash
git status --short
git diff --stat
git diff --check
```

输出变更摘要、真实测试结果、浏览器/实例证据、风险和未处理项。等待用户明确验收；验收前禁止 commit、push、MR 和归档。

---

### Task 6: 将上游上下文说明收进选择框

**Files:**

- Modify: `frontend/src/pages/marketing/automation-upstream-picker.tsx`
- Modify: `frontend/src/pages/marketing/__tests__/automation-upstream-picker.test.tsx`
- Modify: `frontend/src/pages/marketing/agent-automations-panel.tsx`
- Modify: `frontend/src/pages/marketing/__tests__/agent-automations-panel.test.ts`
- Modify: `frontend/src/i18n/generated/{en-US,zh-CN,zh-Hant,zh-to-key}.json`

**目标：** 表单不再用独立段落解释上游语义；未选择上游时，选择框内显示“本任务执行时，将使用上游任务最近的输出作为上下文”。选择后显示任务名称；无候选时仍保留选择框，展开后显示空状态。详情页使用完整说明“本任务执行时，将使用上游任务最近一次的输出作为上下文。”。

- [x] **Step 1: 先写失败测试**

断言表单不存在旧独立文案，空选择框显示新提示；无候选时选择框仍存在，展开后显示“暂无可关联的上游任务”；详情页不再展示旧文案。

- [x] **Step 2: 运行定向测试确认 RED**

```bash
cd frontend && pnpm exec vitest run \
  src/pages/marketing/__tests__/automation-upstream-picker.test.tsx \
  src/pages/marketing/__tests__/agent-automations-panel.test.ts
```

Expected: 新断言因旧独立文案、旧空态和旧选择框提示而失败。

- [x] **Step 3: 最小实现并更新 i18n**

删除表单独立说明段落；将新文案作为 Picker 的空值提示；移除“无候选即返回静态状态”的分支，使控件仍可打开并在列表内显示空态；详情页同步新文案。运行 `pnpm i18n:extract` 和 `pnpm i18n:zh-hant` 更新生成资源。

- [x] **Step 4: 运行 GREEN 与质量门禁**

```bash
cd frontend && pnpm exec vitest run \
  src/pages/marketing/__tests__/automation-upstream-picker.test.tsx \
  src/pages/marketing/__tests__/agent-automations-panel.test.ts
pnpm i18n:check
pnpm i18n:zh-hant:check
pnpm check
cd .. && git diff --check
```

Expected: 全部 exit 0；英文和繁体无缺失。

- [x] **Step 5: 本地浏览器回验**

打开“添加自动任务”，确认选择框内显示新提示、上方无独立说明，且无候选时可展开看到空状态；不创建真实任务。

执行记录（2026-08-15）：已将说明收进空 Picker，并将“上游任务”的“（可选）”拆为与“调用技能”“通知方式”一致的浅灰 12px/400 样式。定向测试 119/119、i18n 两项检查、TypeScript/MDX 与 `git diff --check` 通过；独立 Task review 无 Critical / Important。浏览器刷新后确认三处主标题均为 14px/500/80% 黑色，“（可选）”均为 12px/400/40% 黑色且间距 4px；无候选时 Picker 可展开显示“暂无可关联的上游任务”，未创建真实任务，刷新后的新日志无 warning/error。

补充执行记录（2026-08-17）：按验收反馈将“调用技能”移动到“上游任务”之前，仅调整表单渲染顺序。新增 DOM 顺序回归测试并完成 RED → GREEN；相关测试更新为 120/120。浏览器刷新后确认顺序为“调用技能 → 上游任务 → 通知方式”，新日志无 warning/error，未创建真实任务。

补充执行记录（2026-08-17）：选择框提示文案去掉末尾句号，详情页完整说明保留句号；简体、繁体和英文资源已同步，选择框测试覆盖无句号约束。

---

### Task 7: 调用技能下拉支持取消当前选择

**Files:**

- Modify: `frontend/src/pages/marketing/automation-skill-picker.tsx`
- Modify: `frontend/src/pages/marketing/__tests__/automation-skill-picker.test.tsx`

**目标：** 仅国内站的“调用技能”下拉中，当前已选技能默认显示勾；鼠标悬停或键盘聚焦时切换为叉；点击当前已选技能后清除选择并关闭下拉。国际站保持原有已选项交互。

- [x] **Step 1: 先写失败测试并确认 RED**

- [x] **Step 2: 最小实现勾叉切换与点击清除**

- [x] **Step 3: 运行定向测试和前端质量门禁**

执行记录（2026-08-18）：新增国内站当前已选 Skill 下拉项的勾/叉透明度切换，覆盖鼠标悬停和键盘聚焦；点击该项清空选择并关闭下拉。随后按发布范围补充国际站专属回归，国际站继续显示勾并保持原有选择行为。先运行新增用例确认 RED，再完成最小区域隔离。相关测试、类型、i18n 与双构建结果统一记录在 Task 8。

---

## 执行顺序与批次

- Batch 1：Task 1 → Task 2 → quick review。
- Batch 2：Task 3 → quick review。
- Batch 3：Task 4 → quick review。
- Batch 4：Task 5 → full review → 用户验收。
- Batch 5：Task 6 文案与布局微调 → 定向 review → 本地预览回验。
- Batch 6：Task 7 调用技能下拉交互对齐 → 定向测试 → 本地预览回验。
- Batch 7：Task 8 国内站能力隔离 → 国内/国际区域测试 → 双构建质量门禁。

任务存在顺序依赖，不并行修改共享文件 `hermes-cron-client.ts` 和 `agent-automations-panel.tsx`。实现阶段每轮只加载当前 Task 的 active slice。

### Task 8: 仅在国内站启用上游任务 Context

**角色：** Developer → Reviewer

**影响文件：**

- Modify: `frontend/src/lib/hermes-cron-client.ts`
- Modify: `frontend/src/lib/__tests__/hermes-cron-client.test.ts`
- Modify: `frontend/src/pages/marketing/agent-automations-panel.tsx`
- Create: `frontend/src/pages/marketing/__tests__/agent-automations-panel.global.test.ts`
- Modify: `frontend/src/pages/marketing/automation-skill-picker.tsx`
- Create: `frontend/src/pages/marketing/__tests__/automation-skill-picker.global.test.tsx`
- Modify: `frontend/openspec/{proposal,spec,plan}.md`
- Modify: `wiki/prd-docs/2026-08-13-自动任务支持获取上游任务的Context.md`

**验收：** 国内站现有 Context 功能不变；国际站不探测能力、不水合或展示关系、不调用关系 CRUD，普通自动任务仍走原有路径。

- [x] **Step 1: 先写国际站隔离失败测试并确认 RED**

新增国际站专属测试，顶层 mock `isGlobal: true`，断言面板加载不调用 `detectCronContextFromCapability`、列表请求关闭 `context_from` 水合、创建/编辑继续使用原有 CRUD、创建/详情无“上游任务”，删除直接调用原有 `removeCronJob`。在 Cron 客户端测试中断言关闭水合后保留其他 `jobs.json` 元数据但忽略 `context_from`；技能下拉断言国际站保持原交互。

- [x] **Step 2: 使用编译期区域分支完成最小隔离实现**

为 `listCronJobs` 增加默认开启的 `hydrateContextFrom` 选项；面板在国际构建传 `false`。用 `isGlobal` 短路能力探测、候选/删除关系计算、关系 UI 和结构化关系 CRUD，国内站调用方式和行为不变。技能下拉的已选项勾转叉及点击清除同样仅在国内站启用。

- [x] **Step 3: 运行国内/国际定向测试与双构建门禁**

运行 Cron 客户端、国内面板、国际面板、两个 Picker 的 Vitest；运行 `pnpm check`、两项 i18n 检查、`pnpm build:cn`、`pnpm build:global` 与 `git diff --check`。确认国际构建无上游任务入口，国内构建保留现有功能。

执行记录（2026-08-18）：国际站专属用例先检出能力探测、关系水合和展示未隔离，完成编译期区域分支后转绿；随后补充普通 create/edit/delete 旧路径、Skill 已选项原交互及终态任务卡片原行为回归。最终 6 个相关测试文件 238/238、`pnpm check`、2100/2100 i18n、简繁一致性、`build:cn` 112 个静态页面、`build:global` 287 个静态页面及 `git diff --check` 全部通过。全量测试另有仓库既存的文档图片体积、测试 mock、依赖缺失、超时及进程 OOM，不涉及本次改动；相关定向测试均通过。

## 明确排除的文件与改动

- 不修改 `cloudagent/`、网关服务或数据库。
- 不修改 Hermes 上游源码。
- 不重新开放 `scenario-tasks` 用户入口。
- 不修改普通任务的 pause/resume/test-run 行为。
- 不修改帮助文档站、更新日志或 TAPD。
- 不提交 `graphify-out/`、测试 Agent 输出或本地截图中的敏感内容。
