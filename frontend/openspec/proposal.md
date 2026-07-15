# 自动任务支持调用 Skill：需求提案

## 文档状态

- 状态：规划完成，待用户确认后进入实现
- 规模：M（标准开发）
- 执行模式：single_agent
- 开发分支：`frontsandbox/pablozhong-0714-automation-skill-invocation`
- 产品来源：已确认 PRD《自动任务支持调用 Skill》
- 产品父单：[TAPD #136120761](https://tapd.woa.com/tapd_fe/10132091/story/detail/1010132091136120761)
- 发布范围：国内站与国际站同步

## 背景

Hermes Cron 已支持在任务执行前加载 Skill，但 LightVela 的自动任务创建、编辑和详情界面尚未暴露该能力。用户目前只能把工作方法重复写进任务说明，或绕过页面直接使用 Hermes CLI。

本需求在现有自动任务弹窗中增加一个可选的单 Skill 绑定入口，复用当前 Agent 已安装的 Skill 列表，并把绑定关系写入现有 Cron job。历史任务和未选择 Skill 的新任务继续沿用当前行为。

## 用户目标

1. 创建自动任务时，可以从当前 Agent 已安装的 Skill 中选择一个，也可以保持不选择。
2. 编辑任务时，可以回显、保持、更换或移除现有 Skill 绑定。
3. 查看任务详情时，可以确认绑定的 Skill 及其当前可用状态。
4. Skill 列表为空、加载失败或已绑定 Skill 被卸载时，页面提供明确反馈，且不阻断普通任务创建。

## 范围

### 本次包含

- 在“任务说明”之后、“生效时间段”之前增加“调用 Skill（可选）”自定义单选选择器。
- 选择器展示当前 Agent 已安装的 Skill，支持按展示名称或 slug 搜索。
- 创建任务时写入零个或一个 Skill slug。
- 编辑任务时保持、替换或清除 Skill 列表。
- 详情中展示未绑定、可用、不可用或暂无法确认状态。
- 已绑定但被卸载的 Skill 保留原 slug，不自动解绑、不静默降级。
- 加载、空态、失败、重试、失效绑定和非交互运行提示。
- 中英文国际化及国内站、国际站验证。
- 复用并抽取现有已安装 Skill 查询/解析能力，避免页面之间相互依赖。

### 本次不包含

- 一个任务绑定多个 Skill。
- 在自动任务弹窗内安装、创建、学习或编辑 Skill。
- 根据任务说明自动推荐或自动选择 Skill。
- 自动判断 Skill 是否兼容 Cron 非交互环境。
- 修改 Hermes 调度、执行、通知或持久化机制。
- 阻止用户卸载被自动任务引用的 Skill。
- 历史任务迁移。
- 新增第三方依赖、路由或后端接口。

## 方案决策

### 采用方案：共享 Hermes Skill 查询模块 + 独立选择器组件

1. 把“列出已安装 Skill”的命令构造、输出解析、去重和展示名格式化能力从专家包页面抽取到 `src/lib/hermes-skills-client.ts`。
2. 自动任务面板维护独立的 Skill 加载状态，与 Cron 任务列表加载解耦；失败不影响任务列表和普通任务创建。
3. 新建聚焦的 Skill 选择器组件，承载搜索、单选、空态、失败重试和不可用绑定展示。
4. 扩展 `hermes-cron-client.ts` 的可测试编辑命令构造：
   - `skills === undefined`：保持原绑定；
   - `skills.length > 0`：使用 `--skill <slug>` 替换绑定列表；
   - `skills.length === 0`：使用 `--clear-skills` 清空绑定。
5. 表单只保存真实 slug；展示名称仅用于阅读和搜索，不能反向生成 slug。

Hermes 官方行为依据：创建和编辑命令支持 Skill 参数，Cron 会在独立会话中加载绑定 Skill；编辑时可通过 `--skill` 替换、通过 `--clear-skills` 清空。

### 未采用方案

| 方案 | 不采用原因 |
| --- | --- |
| 自动任务页面直接 import 专家包页面的 helper | 会让一个业务页面依赖另一个大型页面模块，增加耦合、测试加载和潜在循环依赖风险。 |
| 修改 `@tencent/tea-sdk-lightclaw` 的 SkillPanel 暴露内部列表 | 需要跨仓 SDK 发布与升级，超出本期“复用现有 Hermes 命令”的范围。 |
| 新建独立 Skill 自动任务向导 | 形成第二套创建流程，超出一期单字段增强目标。 |

## 关键交互与状态

### 创建

1. 默认不选择 Skill，选择器显示灰色提示文案。
2. 选择器加载当前 Agent 已安装 Skill；用户可按展示名称或 slug 搜索。
3. 选择 Skill 后创建时传 `skills: [slug]`；未选择时不传 Skill 参数。
4. 无 Skill 或列表加载失败时，其他表单字段保持可用，仍可创建普通任务。

### 编辑

1. 使用 Cron job 的首个 Skill 作为一期 UI 回显值；未修改该字段时不发送任何 Skill 编辑参数，因此外部创建的多 Skill 绑定也不会被无意覆盖。
2. 更换 Skill 时以一个新 slug 替换原列表；选择器不提供清空绑定选项。
3. 新选 Skill 在保存前若被确认已卸载，则阻止保存并要求重选。
4. 已经不可用的历史绑定可保持原值；更换时按用户操作更新，不自动处理。

### 详情

- 未绑定：显示“不调用 Skill”。
- 已绑定且在已安装列表中：显示展示名称和真实 slug。
- 已绑定但已确认不在已安装列表中：保留 slug并标记“不可用”。
- Skill 列表仍在加载或加载失败：保留 slug，显示“状态确认中”或“暂无法确认”，避免误报为已卸载。

## 验收标准

1. 创建自动任务时，“调用技能”为可选单选项，默认提示“请选择自动任务需要调用的技能”。
2. 选择器只展示当前 Agent 已安装的 Skill，展示名称和 slug 单行排列，并支持按两者搜索。
3. 选择 Skill 后创建任务，Cron job 正确保存一个 Skill slug。
4. 未选择 Skill 时不传入 Skill 参数，任务行为与当前版本一致。
5. 编辑任务时能够回显和更换已绑定的 Skill，选择器不展示“不调用 Skill”选项。
6. 编辑其他字段但未修改 Skill 时，原绑定保持不变。
7. 任务详情能够展示绑定的 Skill；未绑定时展示“不调用 Skill”。
8. Skill 被卸载后不自动解绑、不静默降级，详情显示不可用状态。
9. Skill 列表为空或加载失败时，不影响用户创建普通自动任务。
10. 历史自动任务无需迁移，创建、编辑和执行行为保持正常。
11. 国内站和国际站均完成创建、编辑、详情和异常状态验证。
12. 所有新增文案完成中英文国际化。
13. 埋点和普通日志不记录任务说明全文及用户自定义 Skill 内容。

## 影响面

- `frontend/src/lib/hermes-skills-client.ts`：共享已安装 Skill 命令、解析和展示 helper。
- `frontend/src/lib/hermes-cron-client.ts`：Skill 编辑命令语义。
- `frontend/src/pages/marketing/automation-skill-picker.tsx`：搜索单选与异常状态 UI。
- `frontend/src/pages/marketing/hermes-agent-automations-panel.tsx`：加载状态、创建/编辑/详情接线。
- 对应 Vitest / Testing Library 测试。
- i18n 生成字典。

## 风险与应对

| 风险 | 应对 |
| --- | --- |
| 已安装 Skill 输出格式变化 | 共享 parser 保留 JSON、表格、纯文本三种兼容路径并独立测试。 |
| 编辑时误清除既有绑定 | `undefined` 明确表示不修改，只有用户主动清空时才发送 `--clear-skills`。 |
| Skill 在弹窗打开后被卸载 | 对新建或变更后的选中项在提交前重新确认；明确失败而非静默降级。 |
| 列表加载失败阻断原功能 | Skill 加载状态与 Cron 列表、表单提交解耦；无选择时保持现有路径。 |
| 双站文案不一致 | 所有中文 key 走现有 i18n 提取流程，并分别做 CN/global 浏览器验证。 |
| 敏感内容进入日志或埋点 | 不新增包含 prompt、Skill 内容或自定义名称的日志/埋点；现有创建事件继续只记录非敏感上下文。 |

## 能力与依赖结论

- 不需要新增 capability；本需求不依赖 Figma 高保真或新的 E2E 基础设施。
- 不新增 npm 依赖，继续使用 React、Tailwind、lucide-react、Vitest 和 Testing Library。
- 不需要后端、数据库、SDK 或 Hermes runtime 改造。
- 无阻塞性开放问题。
