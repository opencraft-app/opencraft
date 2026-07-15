# 自动任务调用 Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:test-driven-development` and `superpowers:verification-before-completion` to execute this plan task-by-task. The approved `/feai-start` orchestration for this M-sized change is `single_agent`, so implementation stays in the current agent lane.

**Goal:** 让用户在 LightVela 自动任务的创建、编辑和详情中安全地绑定零个或一个当前 Agent 已安装的 Hermes Skill。

**Architecture:** 抽取无 React 依赖的 Hermes 已安装 Skill 共享模块，自动任务面板独立维护加载状态，并通过聚焦的选择器组件呈现搜索和异常状态。创建继续使用现有 `CreateCronJobInput.skills`；编辑新增可测试的三态命令构造，明确区分保持、替换与清空。

**Tech Stack:** React 19、TypeScript 5.9、Tailwind CSS、lucide-react、Hermes CLI、Vitest 4、Testing Library、现有中文即 key i18n。

---

## 0. 执行约束

- 需求规模：M。
- 角色：`single_agent`（实现、测试和验证由同一执行者完成）。
- 需求来源：已确认 PRD《自动任务支持调用 Skill》及 `frontend/openspec/proposal.md`。
- 不新增依赖、路由、后端接口、SDK 改动或数据库迁移。
- 严格 TDD：每个行为先写失败测试、确认失败原因，再写最小实现。
- 项目要求 commit/push/MR 前必须展示内容并取得用户确认；因此不在每个小任务后自动提交，最终统一进入显式提交确认门禁。
- 任何实现不得修改 `frontend/openspec/changes/` 中的历史归档。

## 1. 文件职责图

| 文件 | 动作 | 单一职责 |
| --- | --- | --- |
| `frontend/src/lib/hermes-skills-client.ts` | Create | 已安装 Skill 命令、解析、去重、展示名和加载 helper。 |
| `frontend/src/lib/__tests__/hermes-skills-client.test.ts` | Create | 共享 Skill helper 的纯函数与加载行为测试。 |
| `frontend/src/pages/marketing/hermes-agent-experts-panel.tsx` | Modify | 删除页面内重复 helper，改为 import 共享模块。 |
| `frontend/src/pages/marketing/__tests__/hermes-agent-experts-panel.test.tsx` | Modify | 移除已迁移的 helper 单测/import，保留专家包行为覆盖。 |
| `frontend/src/lib/hermes-cron-client.ts` | Modify | 增加 `buildEditCommand` 和 Skill patch 三态语义。 |
| `frontend/src/lib/__tests__/hermes-cron-client.test.ts` | Modify | 覆盖 create/edit 的有 Skill、无 Skill、替换、清空和 shell quoting。 |
| `frontend/src/pages/marketing/automation-skill-picker.tsx` | Create | 自定义单选、搜索、加载/空/失败/不可用状态和详情摘要。 |
| `frontend/src/pages/marketing/__tests__/automation-skill-picker.test.tsx` | Create | 选择器和详情摘要的 Testing Library 测试。 |
| `frontend/src/pages/marketing/hermes-agent-automations-panel.tsx` | Modify | Skill 状态加载、表单接线、提交校验、创建/编辑映射、详情字段。 |
| `frontend/src/pages/marketing/__tests__/hermes-agent-automations-panel.test.ts` | Modify | 表单映射、失效策略和多 Skill 保持的纯逻辑测试。 |
| `frontend/src/i18n/generated/zh-CN.json` | Generate | 新中文文案字典。 |
| `frontend/src/i18n/generated/en-US.json` | Generate/Modify | 新英文翻译。 |
| `frontend/src/i18n/generated/zh-to-key.json` | Generate | 中文 key 到 hash 的映射。 |

## 2. 验收映射

| PRD 验收项 | 对应任务 |
| --- | --- |
| 1、2：可选单选、已安装列表、搜索 | Task 1、Task 3 |
| 3、4：创建时写一个 slug / 未选择保持旧行为 | Task 2、Task 4 |
| 5、6：编辑回显、更换、移除、未改保持 | Task 2、Task 4 |
| 7、8：详情与不可用状态 | Task 3、Task 5 |
| 9：空态和失败不阻断普通任务 | Task 3、Task 4 |
| 10：历史任务兼容 | Task 2、Task 4、Task 7 |
| 11、12：双站与中英文 | Task 6、Task 7 |
| 13：隐私 | Task 4、Task 7 |

### Task 1: 抽取共享的已安装 Skill 客户端

**角色：** single_agent / implementation

**Files:**
- Create: `frontend/src/lib/hermes-skills-client.ts`
- Create: `frontend/src/lib/__tests__/hermes-skills-client.test.ts`
- Modify: `frontend/src/pages/marketing/hermes-agent-experts-panel.tsx`
- Modify: `frontend/src/pages/marketing/__tests__/hermes-agent-experts-panel.test.tsx`

**验收方式：** 新共享测试通过；专家包测试继续通过；自动任务页面无需 import 专家包页面。

- [x] **Step 1: 先写共享 helper 的失败测试**

覆盖以下契约：

```ts
expect(buildInstalledSkillsListCommand()).toContain("hermes_cli.main skills list");
expect(parseInstalledSkillSlugs(jsonOutput)).toEqual(["market-data", "backtest-engine"]);
expect(parseInstalledSkillSlugs(tableOutput)).toEqual(["cody"]);
expect(parseInstalledSkillSlugs(" alpha \nalpha\nbeta\n")).toEqual(["alpha", "beta"]);
expect(formatInstalledSkillDisplayName("finance-news")).toBe("Finance News");
expect(matchesInstalledSkillSearch("finance-news", "Finance News", "news")).toBe(true);
```

- [x] **Step 2: 运行测试并确认因模块不存在而失败**

Run:

```bash
cd frontend && pnpm exec vitest run --config vitest.config.ts src/lib/__tests__/hermes-skills-client.test.ts
```

Expected: FAIL，原因是 `@/lib/hermes-skills-client` 尚不存在，而不是测试环境错误。

- [x] **Step 3: 实现最小共享模块**

模块至少导出：

```ts
export const buildInstalledSkillsListCommand: () => string;
export const getUniqueSkillSlugs: (slugs: string[]) => string[];
export const parseInstalledSkillSlugs: (output: string) => string[];
export const formatInstalledSkillDisplayName: (slug: string) => string;
export const matchesInstalledSkillSearch: (slug: string, displayName: string, query: string) => boolean;
export const listInstalledSkillSlugs: (botId: string) => Promise<string[]>;
```

`listInstalledSkillSlugs` 调用现有 `execCommand`，只返回解析后的 slug；不吞掉错误，由调用方决定 UI 状态。

- [x] **Step 4: 让专家包页面改用共享 helper**

删除页面内的命令常量、去重和 parser 实现；保留专家包专属的安装、重试和 SkillHub 数据逻辑。把 parser 纯单测迁移到新测试文件，专家包组件测试继续从真实共享模块运行。

- [x] **Step 5: 运行共享和专家包测试**

```bash
cd frontend && pnpm exec vitest run --config vitest.config.ts \
  src/lib/__tests__/hermes-skills-client.test.ts \
  src/pages/marketing/__tests__/hermes-agent-experts-panel.test.tsx
```

Expected: 两个测试文件全部 PASS。

### Task 2: 扩展 Hermes Cron 编辑命令的 Skill 三态

**角色：** single_agent / implementation

**Files:**
- Modify: `frontend/src/lib/hermes-cron-client.ts`
- Modify: `frontend/src/lib/__tests__/hermes-cron-client.test.ts`

**验收方式：** 纯命令测试证明 create/edit 在保持、替换、清空时生成正确 CLI，特殊字符被安全 quote。

- [x] **Step 1: 写 `buildEditCommand` 的失败测试**

```ts
expect(buildEditCommand("job-1", { name: "daily" }))
  .toBe("hermes cron edit 'job-1' --name 'daily'");
expect(buildEditCommand("job-1", { skills: ["report's-helper"] }))
  .toBe("hermes cron edit 'job-1' --skill 'report'\\''s-helper'");
expect(buildEditCommand("job-1", { skills: [] }))
  .toBe("hermes cron edit 'job-1' --clear-skills");
expect(buildEditCommand("job-1", {})).not.toContain("skill");
```

同时补充 `buildCreateCommand` 的单 Skill 断言。

- [x] **Step 2: 运行目标测试并确认失败**

```bash
cd frontend && pnpm exec vitest run --config vitest.config.ts src/lib/__tests__/hermes-cron-client.test.ts
```

Expected: FAIL，原因是 `buildEditCommand` / `skills` patch 尚未实现。

- [x] **Step 3: 实现明确的 patch 类型和纯命令构造**

```ts
export interface EditCronJobPatch {
  schedule?: string;
  prompt?: string;
  name?: string;
  deliver?: string;
  script?: string;
  skills?: string[];
}
```

规则：`undefined` 不输出；空数组输出一次 `--clear-skills`；非空数组对每个值输出 `--skill`。UI 虽只传一个值，客户端保持 Hermes 官方 repeated flag 兼容性。

- [x] **Step 4: 让 `editCronJob` 只执行 `buildEditCommand`**

保持 `execCommand` 错误模型不变，不新增网络层和异常包装。

- [x] **Step 5: 运行 Cron 客户端测试**

```bash
cd frontend && pnpm exec vitest run --config vitest.config.ts src/lib/__tests__/hermes-cron-client.test.ts
```

Expected: 全部 PASS，原有解析、测试运行和有效期脚本测试无回归。

### Task 3: 实现可搜索的单 Skill 选择器

**角色：** single_agent / implementation

**Files:**
- Create: `frontend/src/pages/marketing/automation-skill-picker.tsx`
- Create: `frontend/src/pages/marketing/__tests__/automation-skill-picker.test.tsx`

**验收方式：** Testing Library 覆盖默认提示、搜索、选择、loading、空态、失败重试、不可用绑定、不显示清空项与辅助提示，以及 ARIA。

- [x] **Step 1: 先写组件失败测试**

测试 props 契约：

```ts
interface AutomationSkillPickerProps {
  value: string;
  loadState: InstalledSkillLoadState;
  onChange: (slug: string) => void;
  onRetry: () => void;
}
```

至少验证：

- 初始 trigger 显示灰色未选择提示；
- 输入 `news` 只保留 `finance-news`；
- 选择后 `onChange("finance-news")`；
- 下拉只展示已安装 Skill，不提供“不调用 Skill”选项；
- error 显示重试且调用 `onRetry`；
- ready 空数组显示前往 `/agents/skills`；
- value 不在 ready 列表时仍显示 slug 和“不可用”；
- 存在非交互环境提示；
- trigger 有 `aria-expanded`，搜索输入有可访问名称。

- [x] **Step 2: 运行组件测试并确认失败**

```bash
cd frontend && pnpm exec vitest run --config vitest.config.ts src/pages/marketing/__tests__/automation-skill-picker.test.tsx
```

Expected: FAIL，原因是组件不存在。

- [x] **Step 3: 实现最小无依赖自定义下拉**

使用 React state、Tailwind 和现有 lucide 图标；不引入 Command/Popover 新依赖。组件关闭后清空搜索词，使用共享格式化和匹配 helper，保存值始终是传入 options 的真实 slug。

- [x] **Step 4: 增加详情摘要组件或纯展示 helper**

同文件导出 `AutomationSkillBindingSummary`，根据 `value + loadState` 渲染可用、不可用、确认中或暂无法确认状态，供详情弹窗复用并测试。

- [x] **Step 5: 运行组件测试**

```bash
cd frontend && pnpm exec vitest run --config vitest.config.ts src/pages/marketing/__tests__/automation-skill-picker.test.tsx
```

Expected: 全部 PASS。

### Task 4: 接入自动任务加载、创建与编辑

**角色：** single_agent / implementation

**Files:**
- Modify: `frontend/src/pages/marketing/hermes-agent-automations-panel.tsx`
- Modify: `frontend/src/pages/marketing/__tests__/hermes-agent-automations-panel.test.ts`

**验收方式：** 纯 helper 测试证明 create/edit 映射正确，表单中选择器位置正确，加载失败不改变 `canSubmit` 的普通任务路径。

- [x] **Step 1: 写表单映射和提交策略的失败测试**

计划导出并测试小型纯函数，避免通过巨大页面 DOM 间接验证命令：

```ts
expect(toCreateCronSkills("")).toBeUndefined();
expect(toCreateCronSkills("finance-news")).toEqual(["finance-news"]);
expect(toEditCronSkills(["finance-news"], "finance-news")).toBeUndefined();
expect(toEditCronSkills(["finance-news"], "market-data")).toEqual(["market-data"]);
expect(toEditCronSkills(["finance-news"], "")).toEqual([]);
expect(toEditCronSkills(["first", "second"], "first")).toBeUndefined();
```

再覆盖提交验证：新选择被 ready 列表确认缺失时拒绝；原本已不可用且未修改时允许保持；error 状态下无 Skill 的普通任务允许提交。

- [x] **Step 2: 运行现有自动任务测试并确认新增断言失败**

```bash
cd frontend && pnpm exec vitest run --config vitest.config.ts src/pages/marketing/__tests__/hermes-agent-automations-panel.test.ts
```

Expected: FAIL，原因是映射 helper 尚不存在。

- [x] **Step 3: 在 `HermesAgentAutomationsPanel` 增加独立 Skill 加载状态**

- `botId` 变化时调用 `listInstalledSkillSlugs`；
- 状态为 idle/loading/ready/error；
- 提供 `refreshInstalledSkills` 给选择器重试和提交前校验；
- 失败不复用自动任务 `listError`，不阻断 Cron job 列表；
- 所有创建入口（空白、模板）和编辑入口共享同一状态。

- [x] **Step 4: 把选择器接入 `AutomationFormModal`**

- 位置严格在任务说明后、生效时间段前；
- state 初始值为 `initialJob?.skills[0] ?? ""`；
- create 调用增加 `skills: toCreateCronSkills(selectedSkill)`；
- edit 只有 `toEditCronSkills(...) !== undefined` 时写 `patch.skills`；
- 新建/变更选择在提交前验证，确认已卸载时保留表单并显示错误；
- Skill load error 不进入 `canSubmit`，因此未选择 Skill 的任务仍可提交。

- [x] **Step 5: 检查隐私边界**

确认现有 `automation_create_btn` 和 `AUTOMATION_CREATE_SUCCESS` 埋点仍只携带 `bot_id` 等非敏感字段；不新增 prompt、slug、Skill 内容或自定义名称参数。

- [x] **Step 6: 运行自动任务与 Cron 测试**

```bash
cd frontend && pnpm exec vitest run --config vitest.config.ts \
  src/pages/marketing/__tests__/hermes-agent-automations-panel.test.ts \
  src/lib/__tests__/hermes-cron-client.test.ts
```

Expected: 全部 PASS。

### Task 5: 接入任务详情的绑定状态

**角色：** single_agent / implementation

**Files:**
- Modify: `frontend/src/pages/marketing/hermes-agent-automations-panel.tsx`
- Modify: `frontend/src/pages/marketing/__tests__/automation-skill-picker.test.tsx`

**验收方式：** 详情摘要测试覆盖未绑定、可用、不可用、loading 和 error；详情弹窗实际使用同一共享状态。

- [x] **Step 1: 先补充详情摘要失败测试**

```ts
renderSummary({ value: "", status: "ready", slugs: [] });
expect(screen.getByText("不调用 Skill")).toBeInTheDocument();

renderSummary({ value: "finance-news", status: "ready", slugs: [] });
expect(screen.getByText("不可用")).toBeInTheDocument();
```

并分别断言 ready 命中、loading、error 文案。

- [x] **Step 2: 在详情弹窗增加“调用 Skill”字段**

使用 `job.skills[0] ?? ""` 和面板级 `loadState` 渲染 `AutomationSkillBindingSummary`。不得在详情打开/关闭时修改 job 或自动清空绑定。

- [x] **Step 3: 运行组件和自动任务测试**

```bash
cd frontend && pnpm exec vitest run --config vitest.config.ts \
  src/pages/marketing/__tests__/automation-skill-picker.test.tsx \
  src/pages/marketing/__tests__/hermes-agent-automations-panel.test.ts
```

Expected: 全部 PASS。

### Task 6: 完成中英文国际化

**角色：** single_agent / implementation

**Files:**
- Modify: `frontend/src/pages/marketing/automation-skill-picker.tsx`
- Modify: `frontend/src/pages/marketing/hermes-agent-automations-panel.tsx`
- Generate: `frontend/src/i18n/generated/zh-CN.json`
- Generate/Modify: `frontend/src/i18n/generated/en-US.json`
- Generate: `frontend/src/i18n/generated/zh-to-key.json`

**验收方式：** 新文案全部使用 `t()`；英文值人工校对；`pnpm i18n:check` 通过。

- [x] **Step 1: 汇总新增中文 key**

至少包含：调用技能、请选择自动任务需要调用的技能、搜索已安装的技能、暂无已安装 Skill、前往技能管理、加载失败、重试、不可用、状态确认中、暂无法确认、Skill 已不可用的保存错误。

- [x] **Step 2: 运行提取脚本**

```bash
cd frontend && pnpm i18n:extract
```

Expected: 三个 generated 字典按代码 key 更新。

- [x] **Step 3: 补齐并校对英文翻译**

英文使用产品语义，不机械直译；`Skill`、slug、Hermes 等专有名词保持一致。不得手工修改 hash key。

- [x] **Step 4: 运行 i18n 门禁**

```bash
cd frontend && pnpm i18n:check
```

Expected: PASS，无缺失、过期或未翻译 key。

### Task 7: 完整验证、浏览器验收与提交准备

**角色：** single_agent / verification

**Files:**
- Verify all files listed above
- Update progress only: `frontend/openspec/plan.md`

**验收方式：** 目标测试、全量类型检查、i18n、CN/global 可见验证全部通过；diff 无越界；提交前再次取得用户确认。

- [x] **Step 1: 运行目标测试集**

```bash
cd frontend && pnpm exec vitest run --config vitest.config.ts \
  src/lib/__tests__/hermes-skills-client.test.ts \
  src/lib/__tests__/hermes-cron-client.test.ts \
  src/pages/marketing/__tests__/automation-skill-picker.test.tsx \
  src/pages/marketing/__tests__/hermes-agent-automations-panel.test.ts \
  src/pages/marketing/__tests__/hermes-agent-experts-panel.test.tsx
```

Expected: 5 个测试文件全部 PASS。

- [x] **Step 2: 运行静态和国际化门禁**

```bash
cd frontend && pnpm check
cd frontend && pnpm i18n:check
```

Expected: 两条命令 exit 0。

- [x] **Step 3: 国内站浏览器验证**

在 CN 配置下验证：

- 创建默认未选择 Skill；
- 搜索并选择一个已安装 Skill；
- 创建结果详情显示绑定；
- 编辑保持和更换；
- 空列表和加载失败仍可创建普通任务；
- 已卸载绑定显示不可用且不自动清空；
- 页面无控制台错误。

- [x] **Step 4: 国际站浏览器验证**

在 global 配置下重复创建、编辑、详情、移除、空态、错误态和不可用态，确认英文文案与既有国际站通知渠道布局无冲突。

- [x] **Step 5: 回归历史和外部任务**

- 历史 `skills: []` 任务仍可查看、编辑和测试运行；
- 外部多 Skill job 未修改 Skill 字段时不生成任何 Skill flag；
- test run 继续携带 `job.skills`；
- 无 Skill create 命令与改动前一致。

- [x] **Step 6: 检查最终 diff 和计划完成度**

```bash
git diff --check
git status --short
git diff --stat
```

确认没有 `.codebuddy/.cache`、token、任务说明全文、无关格式化或归档历史混入提交范围，并把完成的 plan checkbox 更新为 `[x]`。

- [x] **Step 7: 展示提交内容并等待显式确认**

向用户展示拟提交文件、测试结果、剩余风险和 Lore commit message。只有用户确认后才执行 `git add` / `git commit`；push 和 MR 仍需各自遵守项目确认门禁。

建议 commit intent：

```text
让自动任务能够复用已安装 Skill

Constraint: 复用 Hermes Cron 现有 Skill 协议，不新增后端或 SDK 依赖
Rejected: 直接依赖专家包页面 | 避免页面间耦合
Confidence: high
Scope-risk: moderate
Directive: 保持 undefined=不修改、[]=清空的 Skill 编辑语义
Tested: 待实现后填写
Not-tested: 待实现后填写
```

### Task 8: 修复 Skill 下拉点击外部不收起

**角色：** single_agent / implementation + verification

**Files:**
- Modify: `frontend/src/pages/marketing/automation-skill-picker.tsx`
- Modify: `frontend/src/pages/marketing/__tests__/automation-skill-picker.test.tsx`

- [x] 点击选择器外部区域时关闭下拉并清空搜索词，选择器内部交互保持不变。
- [x] 新增回归测试，并通过自动任务 Skill 目标测试集 179/179 与 `pnpm check`。

### Task 9: 优化 Skill 字段中文文案与默认提示

**角色：** single_agent / implementation + verification

**Files:**
- Modify: `frontend/src/pages/marketing/automation-skill-picker.tsx`
- Modify: `frontend/src/pages/marketing/hermes-agent-automations-panel.tsx`
- Modify: `frontend/src/pages/marketing/__tests__/automation-skill-picker.test.tsx`
- Modify: `frontend/src/i18n/generated/*.json`

- [x] 将字段标题统一为“调用技能”。
- [x] 未选择技能时展示灰色提示“请选择自动任务需要调用的技能”。
- [x] 自动任务 Skill 目标测试集 179/179、`pnpm check` 与 `pnpm i18n:check` 通过。

### Task 10: 精简 Skill 下拉选项与辅助提示

**角色：** single_agent / implementation + verification

**Files:**
- Modify: `frontend/src/pages/marketing/automation-skill-picker.tsx`
- Modify: `frontend/src/pages/marketing/__tests__/automation-skill-picker.test.tsx`
- Modify: `frontend/openspec/proposal.md`
- Modify: `frontend/openspec/spec.md`
- Modify: `frontend/src/i18n/generated/*.json`

- [x] 下拉列表不再展示“不调用 Skill”选项。
- [x] 删除选择器下方的无人值守执行提示文案。
- [x] 自动任务 Skill 目标测试集 178/178、`pnpm check` 与 `pnpm i18n:check` 通过。

### Task 11: 优化 Skill 选择器提示与单行布局

**角色：** single_agent / implementation + verification

**Files:**
- Modify: `frontend/src/pages/marketing/automation-skill-picker.tsx`
- Modify: `frontend/src/pages/marketing/__tests__/automation-skill-picker.test.tsx`
- Modify: `frontend/openspec/proposal.md`
- Modify: `frontend/openspec/spec.md`
- Modify: `frontend/src/i18n/generated/*.json`

- [x] 默认提示改为“请选择自动任务需要调用的技能”。
- [x] 搜索提示改为“搜索已安装的技能”。
- [x] 下拉中的 Skill 展示名称与 slug 改为同一行展示，并在空间不足时截断。
- [x] 自动任务 Skill 目标测试集 178/178、`pnpm check` 与 `pnpm i18n:check` 通过。

## 3. 规划门禁结论

- [x] 已确认需求范围、排除项和 13 条验收标准。
- [x] 已识别规模为 M，执行模式为 single_agent。
- [x] 已读取 P0 上下文、前端规范、设计规范和现有 OpenSpec。
- [x] 已确认现有 Hermes create/list/test-run 能力，缺口集中在共享查询、edit flags 和 UI。
- [x] 已选择主要方案并记录两个备选方案与取舍。
- [x] 已覆盖 loading、空态、错误态、不可用态和历史兼容。
- [x] 已确认不需要额外 capability 或重型依赖。
- [x] plan 含具体角色、文件、测试命令、验收方式和 checkbox。
- [x] 不在范围内的修改已明确排除。
- [x] **规划门禁结论：通过，待用户确认后进入实现。**
