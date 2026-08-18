# 自动任务支持获取上游任务的 Context Spec

最后同步：2026-08-13。

## 1. 总体架构

保持现有 `HermesAgentAutomationsPanel → AutomationFormModal → hermes-cron-client` 主链路，在 Cron 客户端增加一个只处理 `context_from` 的结构化适配层。该能力仅在国内站构建启用；国际站通过编译期 `isGlobal` 分支保持原有 Cron 路径。

```text
jobs.json ──补齐 context_from──▶ CronJob[]
                                  │
                                  ├─▶ 上游选择器 / 防环 / 卡片 / 详情
                                  │
现有 CLI CRUD ──普通任务──────────┤
                                  │
官方 cronjob 工具 ──关系变更─────▶ create / update / detach / remove
```

不新增后端接口，不直接写 `jobs.json`，所有命令仍通过实例现有 `debug/exec` 通道执行。

## 2. 数据模型

### 2.1 CronJob

在 `frontend/src/lib/hermes-cron-client.ts` 中扩展：

```ts
interface CronJob {
  // existing fields...
  context_from: string[] | null;
}
```

归一化规则：

- 字符串 → 去空白后转为单元素数组。
- 数组 → 仅保留非空字符串并去重；空数组归一化为 `null`。
- 缺失、`null` 或非法类型 → `null`。
- UI 首期只写 `null` 或单元素数组，但读取层保留 Hermes 原生多上游形态。

### 2.2 外部多上游兼容

Hermes 原生允许多个上游。若任务由其他入口配置了两个及以上上游：

- 表单显示“当前任务配置了多个上游，暂不支持在 LightVela 中编辑”。
- 编辑其他字段时不传 `context_from`，原关系保持不变。
- 关系控件保持只读，不提供解除或替换入口；禁止打开表单后静默截断为第一个。
- 防环计算读取全部现有边。

## 3. Hermes 能力与命令适配

### 3.1 能力检测

新增 `detectCronContextFromCapability(botId)`：在 Hermes 自身虚拟环境中导入 `tools.cronjob_tools.cronjob`，通过 `inspect.signature` 确认 `context_from` 参数存在，并输出带固定前缀的 JSON。

状态分为：

- `supported`：选择器可用。
- `unsupported`：隐藏或禁用选择器，并说明需要升级 Hermes。
- `unknown`：检测失败；选择器禁用且允许重试，普通任务流程不受影响。

能力检测按 Agent 实例缓存；切换 Agent 后重新检测。

### 3.2 结构化调用封装

新增统一命令构造与解析函数，通过：

```py
from tools.cronjob_tools import cronjob
```

调用官方 `cronjob(action=...)`，并以固定 marker 输出 JSON。TypeScript 侧只接受 `success: true`，缺 marker、非法 JSON 或 `success: false` 均抛出 `CronCommandError`。

所有输入先在 TypeScript 中序列化为 JSON，再作为单个 shell 参数传递；不得拼接未转义的任务名、Prompt 或 ID。

### 3.3 创建

- 未选择上游：继续使用现有 `createCronJobWithScriptRollback`，保持普通任务行为。
- 选择一个上游：使用官方 `cronjob(action="create", context_from=[upstreamId], ...)` 一次写入名称、Prompt、schedule、deliver、skills、script 和关系。
- 结构化 create 返回新任务 ID后，沿用现有模型钉住逻辑，但按 ID 处理，不再通过可重复名称反查。
- create 失败时沿用生效窗口脚本回滚；不得留下只写了一半关系的新任务。

### 3.4 编辑

`context_from` 使用三态 patch：

- `undefined`：保持现有关系。
- `[upstreamId]`：替换为一个上游。
- `[]`：解除关系。

关系未变化时继续使用现有 CLI edit。关系发生变化时，把本次表单的全部变更交给一次官方 `cronjob(action="update")`，避免“其他字段已保存但关系保存失败”的半成功状态。

保存前重新拉取任务列表并执行候选合法性与防环校验；表单打开后上游被暂停、删除或过期时阻止保存并要求重新选择。

### 3.5 删除与解绑

删除目标 A 前，用最新任务列表找到 `context_from` 包含 A 的直接下游。

结构化删除命令按以下顺序执行：

1. 逐个把直接下游的 A 引用移除；首期单上游任务变为 `null`，外部多上游任务只移除 A 并保留其他 ID。
2. 任一更新失败时，停止后续操作，并把已成功更新的下游恢复为原始 `context_from`。
3. 全部解绑成功后调用 `cronjob(action="remove", job_id=A)`。
4. remove 失败时同样尝试恢复所有下游原关系。
5. 回滚失败时返回包含受影响任务名称的修复提示，但不输出 Prompt、输出正文或敏感配置。

A → B → C 删除 A 时，只改写 B 的上游；C 仍引用 B。

## 4. 候选与循环检测

新增纯函数构建关系图，边方向定义为“下游任务 → 上游任务”。为任务 J 选择候选 U 时，若从 U 沿上游边可以到达 J，则 J → U 会形成循环，必须排除。

候选还需满足：

- 与当前任务属于同一 `botId`。
- 不是当前任务自身。
- 非暂停、非过期。
- 非测试运行临时任务或场景试跑任务。
- 任务 ID 有效。

创建新任务没有自身 ID，只需排除无效候选；保存后关系由 Hermes 再校验上游是否存在。

循环检测使用 `Set` 记录访问节点，已有异常环或悬空 ID 时不会死循环。悬空关系保留用于异常提示，但不出现在候选中。

## 5. 组件设计

### 5.1 AutomationUpstreamPicker

新增独立组件，避免继续扩大 `agent-automations-panel.tsx`：

- 未选择时，触发器内显示“本任务执行时，将使用上游任务最近的输出作为上下文”。
- 展开层提供名称搜索。
- 每项只展示任务名称，不展示 Cron 表达式、友好执行周期或最近完成时间。
- 当前已选项默认显示勾，悬停或键盘聚焦时切换为叉，点击后解除关联并关闭下拉；不提供单独的“不关联”选项。
- 无候选、加载失败、不支持、既有暂停上游和外部多上游分别有明确状态。
- 支持键盘打开、搜索、选择和关闭；使用 `role="combobox"` / `listbox` / `option`，维持焦点和 `aria-expanded`、`aria-activedescendant`。

### 5.2 AutomationFormModal

新增 props：

- `jobs: CronJob[]`
- `contextCapability`
- `onRefreshJobs()`

表单维护原始关系与用户草稿，使用纯函数判断保持、替换或解除。“调用技能”位于“上游任务”之前，两者均位于“任务说明”之后。

### 5.3 卡片与详情

- `CronJobCard`：存在单上游时显示轻量“来自：A”；上游暂停或缺失时附文字状态，不只使用颜色。
- `CronJobDetailModal`：增加上游名称、当前状态和“本任务执行时，将使用上游任务最近一次的输出作为上下文。”说明。
- 名称通过当前 `jobs` 按 ID 解析；找不到时显示“上游任务已不可用”，不直接展示裸 ID 作为主文案。

### 5.4 最近执行

最近执行详情只展示“当前关联上游”及 Hermes 原生规则：

- 不展示或推断“本次已使用某时刻输出”。
- 最近状态来自当前上游任务的 `last_run_at` / `last_status`，必须标注为当前可观测状态。
- 任务关系已变更或任务已删除、无法可靠解析时省略关系区，不使用当前最新结果反推历史。

## 6. 状态与错误处理

| 场景 | 行为 |
| --- | --- |
| 能力检测中 | 上游选择器骨架或禁用态，普通字段可编辑 |
| 能力不支持 | 禁用入口并提示升级，普通任务可保存 |
| 任务列表失败 | 关系控件可重试，不清空表单其他字段 |
| 上游暂停 | 保留既有关系；新建/替换时不作为候选 |
| 上游无完成输出 | 提示下游会无上下文继续执行 |
| 上游最新状态失败 | 提示 Hermes 仍使用最新完成输出，不回退旧成功结果 |
| 上游被删除或过期 | 保存前校验失败，要求重新选择或解除 |
| 结构化写入失败 | 表单保持打开并保留用户输入 |
| 删除解绑失败 | 不删除上游，恢复已改关系并显示错误 |
| 删除解绑回滚失败 | 不隐藏风险，列出需检查的任务名称 |

## 7. 安全与隐私

- 不把上游输出正文带到浏览器、日志或埋点。
- `context_from` 仅接受当前 Agent 列表中的任务 ID；保存前再次验证。
- Python 命令使用 JSON 载荷和既有 `shellQuote`，不直接插值用户 Prompt。
- 不直接修改 `jobs.json`，不绕过 Hermes 的字段校验和原子保存。
- 循环校验同时在候选阶段和保存阶段执行，前端校验不代替 Hermes 的引用存在性校验。

## 8. 区域隔离、国际化与观测

- 所有新增中文 key 通过现有 `t()` 和生成字典提供英文翻译。
- 国内站读取、展示并写入 `context_from`；国际站不执行能力探测、不水合关系字段、不展示关系 UI，也不调用结构化关系创建、更新或删除接口。
- 国际站普通创建、编辑、删除、列表和最近执行继续使用原有 Cron 路径。
- 区域差异必须使用 `src/lib/region.ts` 的编译期 `isGlobal` 常量，不使用 locale 或运行时域名判断。
- 埋点只记录选择器打开、关系创建/更换/解除、防环阻止、删除解绑成功/失败；不记录 Prompt、任务输出或任务名称。
- 首期不统计“实际注入成功率”，因为 Hermes 没有提供执行级来源元数据。

## 9. 测试策略

### hermes-cron-client

- `context_from` 字符串、数组、空值和非法值归一化。
- 能力检测 marker、unsupported、unknown 和异常输出。
- 结构化 create/update/clear 的 JSON 载荷和 shell 转义。
- `success: false`、缺 marker、非法 JSON 的错误处理。
- 带关系创建失败时的脚本清理。
- 删除多个直接下游、保留外部多上游的其他 ID、失败回滚和 remove 失败回滚。

### agent-automations-panel / picker

- 普通任务、暂停、过期、临时任务、自身和循环候选过滤。
- A → B → C 的合法关系和 A ↔ B、A → B → C → A 的拒绝。
- 创建、编辑保持、更换、解除关系。
- 外部多上游默认只读且不被静默覆盖。
- 卡片、详情、最近执行详情的正常、暂停、缺失和失败状态文案。
- 能力不支持或检测失败时普通任务仍可保存。
- combobox 键盘操作与 ARIA 状态。

### 回归门禁

- 定向 Vitest：Cron 客户端、自动任务面板和新增 picker。
- `pnpm i18n:check`。
- `pnpm check`。
- `git diff --check`。
- 在真实 Hermes 实例完成 A → B → C 两轮验证，覆盖无输出、最新失败输出、暂停和删除解绑。
- 国内站验证创建、编辑、详情和异常提示；国际站验证无上游入口、无能力探测、无关系水合且普通 CRUD 保持原路径。

## 10. 非目标与后续方向

- 不在本期实现完成事件触发、多上游 UI、工作流画布或成功输出筛选。
- 若需要精确回答“某次 B 实际注入了 A 的哪份输出”，应推动 Hermes 在执行 ledger 中写入来源 job ID、文件时间、读取结果和截断状态，再由 LightVela 展示；不得通过当前最新文件反推。
- 若后续所有 Cron 字段都需要结构化能力，可另立需求把普通 CRUD、场景任务和测试运行统一迁移到官方 `cronjob` 工具。
