# 自动任务调用 Skill：技术规格

## 1. 目的

在 LightVela Agent 控制台的自动任务创建、编辑和详情链路中，提供零个或一个 Hermes Skill 的绑定能力。实现必须复用 Hermes Cron 已有协议，保持历史任务与普通任务兼容，并对 Skill 列表失败和已绑定 Skill 失效提供显式状态。

## 2. 术语

- **真实 slug**：Hermes 已安装 Skill 列表返回的目录/标识值，是唯一允许写入 Cron job 的值。
- **展示名称**：由真实 slug 格式化得到的可读文本，仅用于展示与搜索，不参与持久化。
- **可用绑定**：job 保存的 slug 当前存在于该 Agent 的已安装 Skill 列表中。
- **不可用绑定**：已成功加载安装列表，且 job 保存的 slug 不在列表中。
- **未知状态**：安装列表仍在加载或加载失败，无法判断绑定是否仍可用。
- **普通任务**：未绑定任何 Skill 的 Cron job。

## 3. 架构与数据流

```text
Hermes `skills list`
        ↓
hermes-skills-client（命令、解析、去重、展示名）
        ↓
HermesAgentAutomationsPanel（idle/loading/ready/error）
        ├── AutomationSkillPicker（搜索、选择、空态、重试）
        ├── AutomationFormModal（create/edit 映射）
        └── CronJobDetailModal（绑定状态展示）
                         ↓
hermes-cron-client（create/edit 命令）
                         ↓
Hermes Cron job.skills
```

Skill 列表状态必须与 Cron job 列表状态解耦。Skill 查询失败不得清空已有 job 绑定，不得触发 Cron 列表失败，也不得阻止未选择 Skill 的表单提交。

## 4. 共享已安装 Skill 能力

### 4.1 命令

共享模块必须继续使用当前已验证命令：

```sh
cd "$HOME/.hermes/hermes-agent" && COLUMNS=10000 ./venv/bin/python -m hermes_cli.main skills list
```

### 4.2 输出解析

解析器必须支持：

1. `{ success: true, data: { skills: [...] } }` 形式的 JSON；
2. 顶层 Skill 数组 JSON；
3. Hermes 竖线表格输出；
4. 每行一个 slug 的纯文本兜底。

输出必须 trim、去空值、按首次出现顺序去重。保存值必须来自解析后的真实 slug。

### 4.3 展示名称

展示名称由 slug 按 `-` / `_` 分词并格式化，仅用于 UI。搜索必须同时匹配展示名称和原始 slug，大小写不敏感。任何代码都不得根据展示名称反向拼接保存 slug。

### 4.4 复用边界

`hermes-agent-experts-panel.tsx` 与自动任务页面必须共同 import 共享 helper。自动任务页面不得 import 专家包页面模块；共享模块不得依赖 React 页面组件。

## 5. Skill 列表状态模型

```ts
type InstalledSkillLoadState =
  | { status: "idle" | "loading"; slugs: string[]; error: null }
  | { status: "ready"; slugs: string[]; error: null }
  | { status: "error"; slugs: string[]; error: string };
```

要求：

- `botId` 变化时重新加载，不能复用另一个 Agent 的结果。
- 刷新失败时可以保留上次 slugs 供只读展示，但状态必须是 `error`，不能把缓存结果声明为当前可用。
- 选择器必须提供显式重试入口。
- `botId` 为空时进入 `ready + []`，不发命令。
- Skill 加载失败不弹出阻塞整个自动任务面板的全局错误。

## 6. 选择器

### Requirement SKILL-PICKER-1：可选单选

创建和编辑弹窗必须在“任务说明”之后、“生效时间段”之前渲染“调用 Skill（可选）”。默认值为空，且同一时刻最多选中一个真实 slug。

#### Scenario：普通任务

- Given 用户打开创建弹窗
- When 用户不选择 Skill 并提交
- Then 表单不传 `skills`
- And 现有创建行为保持不变

#### Scenario：选择 Skill

- Given 已安装列表包含 `finance-news`
- When 用户选择该项
- Then 选择器显示展示名称与 `finance-news`
- And 表单保存值严格等于 `finance-news`

### Requirement SKILL-PICKER-2：搜索与键盘语义

选择器必须是产品内自定义下拉，不使用原生 `<select>`。触发器应提供 `aria-expanded`，搜索框提供明确 label/placeholder，选项使用可识别的单选语义。搜索空结果与已安装列表为空必须是两个不同状态。

### Requirement SKILL-PICKER-3：加载和错误

- `loading`：显示加载态，不清空表单其他输入。
- `ready + []`：显示“暂无已安装 Skill”、前往技能管理入口和“不调用 Skill”。
- `error`：显示加载失败、重试入口和“不调用 Skill”。
- 已选但不可用：保留 slug，标记“不可用”，允许更换或移除。

### Requirement SKILL-PICKER-4：非交互提示

选择器必须显示“自动任务在非交互环境中运行，请确认该 Skill 支持无人值守执行”或语义一致的中英文提示。不得声称系统已经自动检测兼容性。

## 7. 创建与编辑命令

### 7.1 创建

```ts
skills: selectedSkill ? [selectedSkill] : undefined
```

- 有选择时生成且只生成一个 `--skill '<slug>'`。
- 无选择时不生成 `--skill` 或 `--clear-skills`。

### 7.2 编辑

`EditCronJobPatch.skills` 使用以下三态：

| patch 值 | CLI | 含义 |
| --- | --- | --- |
| `undefined` | 不生成 Skill flag | 保持原绑定，不触碰现有列表 |
| `[slug]` | `--skill '<slug>'` | 用一个 Skill 替换原列表 |
| `[]` | `--clear-skills` | 清空原列表 |

命令构造必须抽为纯函数并独立测试，所有 slug 必须使用现有 `shellQuote`。

### 7.3 外部多 Skill 任务

一期 UI 仅回显首个 Skill，但若用户未修改 Skill 字段，patch 必须保持 `skills === undefined`，从而保留外部 CLI 创建的完整多 Skill 列表。用户主动更换或清空时，才收敛为一期的零/单 Skill模型。

### 7.4 提交前失效检查

- 创建时选择 Skill，或编辑时更换 Skill：保存前必须使用当前列表验证所选 slug。
- 编辑弹窗打开时绑定可用、保存前刷新确认已经卸载：阻止保存，提示重新选择或移除。
- 编辑弹窗打开时绑定已经不可用且用户未修改 Skill：允许保存其他字段，patch 不触碰 Skill，以满足“不自动解绑”。
- 重新验证失败时：未绑定的普通任务仍可提交；新建或变更后的 Skill 绑定不得使用无法确认的陈旧选择提交。

## 8. 详情展示

`CronJobDetailModal` 必须新增“调用 Skill”字段：

| job.skills | 列表状态 | 展示 |
| --- | --- | --- |
| `[]` | 任意 | 不调用 Skill |
| `[slug]` | ready 且包含 slug | 展示名称 + slug |
| `[slug]` | ready 且不包含 slug | 展示名称 + slug + 不可用 |
| `[slug]` | loading | 展示名称 + slug + 状态确认中 |
| `[slug]` | error | 展示名称 + slug + 暂无法确认 |

不可用状态只影响提示，不得修改 job、不触发自动清除，也不得在测试运行时移除 `job.skills`。

## 9. 兼容性、隐私与国际化

### 9.1 兼容性

- `CronJob.skills` 缺失或空数组继续按普通任务处理。
- 现有 create、edit、test run、pause、resume、remove 行为不变。
- 测试运行继续携带 `job.skills`，不新增降级逻辑。
- 不新增路由、后端字段、数据库迁移或特性开关。

### 9.2 隐私

- 不新增记录任务说明全文、Skill 内容或用户自定义 Skill 名称的日志。
- 不把 prompt 或 slug 加入现有大同埋点参数。
- 错误提示可以显示当前用户已经可见的 slug，但不得把 Skill 文件内容发送到埋点或普通日志。

### 9.3 国际化

所有新增中文 key 必须通过现有 `useT()` 接入，并运行 `pnpm i18n:extract` 更新：

- `src/i18n/generated/zh-CN.json`
- `src/i18n/generated/en-US.json`
- `src/i18n/generated/zh-to-key.json`

国内站和国际站必须验证创建、编辑、详情、清空、空态、错误态和不可用态。

## 10. 测试要求

### 单元测试

- 已安装 Skill JSON、表格、纯文本解析与去重。
- 展示名和搜索匹配。
- create 命令有/无 Skill。
- edit 命令保持/替换/清空 Skill。
- 表单 create/edit 三态映射及外部多 Skill 不误覆盖。
- 可用、不可用、loading、error 详情状态判定。

### 组件测试

- 默认“不调用 Skill”。
- 搜索、选择、切换和清空。
- loading、空态、失败重试。
- 已绑定但不可用的保留与标记。
- 非交互提示与基本 ARIA 属性。

### 项目门禁

- 目标 Vitest 测试通过。
- `pnpm i18n:check` 通过。
- `pnpm check` 通过。
- 国内站与国际站本地页面完成可见验证。
