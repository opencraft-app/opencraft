---
name: feai-prd
description: 'TAPD 需求创建。当用户要创建需求单（/feai-prd，或提到"提需求""建需求单""写 PRD""创建 TAPD 需求"）时使用。模板选择 → 复杂度分层 → 影响评估 → 质量门禁 → 创建需求单，可衔接 /feai-start。'
---

# TAPD 需求创建

> 面向产品和研发的需求创建入口：自然语言描述 → TAPD 模板辅助填写 → 质量检查 → 创建需求单 → 可衔接 `/feai-start`。
> 支持任意复杂度需求，检查深度按复杂度自适应。
> 写作标准见 `references/prd-writing-standard.md`；TAPD 平台细则见 `references/tapd-story-format.md`；质量门禁见 `references/gate-prd-quality.md`；用户决策卡片见 `references/decision-cards.md`。

---

## 命令格式

```bash
/feai-prd [需求描述] [--workspace <id>] [--template <id>]
```

| 参数 | 说明 |
|---|---|
| `需求描述` | 可选。直接带上时跳过 Step 3 的描述输入环节。 |
| `--workspace <id>` | 可选。覆盖 `.workflow/project.yaml` 的 `tapd.workspace_id`，本次生效不写回。 |
| `--template <id>` | 可选。跳过模板选择，直接使用指定模板。 |

```bash
/feai-prd
/feai-prd 域名批量导入功能，支持 CSV，校验格式，重复去重
/feai-prd --template <id> 域名列表页改为后端分页
```

---

## 定位

- 产品经理用产品需求模板创建功能需求；研发用技术需求模板创建技术/重构需求。
- 支持任意复杂度需求（含跨系统、异步、高风险场景），检查深度按复杂度自适应，不对需求规模设限。
- `/feai-start` 的前置可选步骤，不侵入研发流程（native 四阶段 shape → build → verify → archive）。
- 不做切分支、不做技术方案设计——切分支在 `/feai-start` 接管后的 build 阶段按团队约定处理，方案由 shape 阶段的 brief 承载。

---

## 前置条件

| 项 | 缺失时处理 |
|---|---|
| `.codebuddy/mcp.json` 配置 `tapd_mcp_http` | 报错并提示补配置（字段结构见 `references/tapd-story-format.md`） |
| `.workflow/project.yaml` 的 `tapd.workspace_id`（空值或仍是 `{{...}}` 占位符均视为缺失） | 交互式让用户输入，确认后写回配置，本次继续 |
| `.workflow/project.yaml` 的 `tapd.business_name`（同上，含占位符判定） | 交互式确认标题中的业务名称段 |
| TAPD 创建权限 | 见 Step 6 权限错误处理，不重试直接结束 |

TAPD MCP 业务工具必须经 `lookup_tool_param_schema` + `proxy_execute_tool` 两步代理调用，详见 `references/tapd-story-format.md`。

---

## 交互规范（重要）

所有需要用户在多个选项间选择的决策点，**必须调用 `ask_followup_question` 工具**弹出图形化多选界面，禁止只输出纯文本卡片让用户在对话框手动打字回复。

- 正文里的文本只承载上下文（草稿预览、检查报告、影响评估结论等）；**真正的选择交互一律走 `ask_followup_question` 工具**。
- 每个决策点对应一次 `ask_followup_question` 调用，`options` 即候选选项；选项的 `label` 要自解释、可独立点选。
- 选项超过 4 个时（如模板列表、迭代列表），只把最相关的 3 个放进 `options`，其余用「其他 / 查看全部」收口，用户选「其他」后再展示完整列表追问。
- 各决策点的 `question` / `header` / `options` 定义见 `references/decision-cards.md`。

---

## 6 步创建流程

以下编号只描述流程结构，不要求运行时逐步输出；阻塞决策一律通过 `ask_followup_question` 工具弹出图形化选择。

### Step 1：选择模板

代理执行 `get_stories_template_list({ workspace_id })`，返回 `id` / `name` / `description` / `sort`。

- `project.yaml` 的 `tapd.templates` 有配置时优先推荐对应模板。
- 模板数量通常较多，展示时优先筛选「轻量」前缀的标准模板，其余折叠。
- 用 `ask_followup_question` 弹出「模板选择」图形化选项（定义见 `references/decision-cards.md`），等待用户点选。

`--template` 已指定时跳过本步。

### Step 2：读取模板字段配置

代理执行 `get_default_story_template({ workspace_id, template_id, use_priority_label: 1 })`。

解析每个字段的 `field` / `value` / `required` / `sort`，区分 `[required]` 与 `[optional]`。模板默认值在 Step 6 传 `templated_id` 时自动套用，不必显式传。

### Step 3：AI 辅助填写

1. **收集描述**：用户未在命令行带描述时，等待用户自由文本输入。
2. **复杂度分层**：按 gate 的复杂度维度判定 S/M/L，决定建模与检查深度。命中任一 L 档触发特征即升为 L。
3. **影响评估（只评级，不设计）**：轻量扫描 `AGENTS.md`、`.workflow/project.yaml` 与需求关键词匹配到的源码目录（只看文件列表），只产出**需求范围评级 S/M/L + 一句话影响范围说明**（如「涉及 XX 模块」），供研发评审判断工时。**禁止输出技术方案、详细设计、具体改动文件清单、可复用组件、实现步骤**——这些留给 `/feai-start` 的 shape 阶段由研发 agent 现场决定。
4. **结构化预填**：按模板字段生成预填值，写作遵循 `references/prd-writing-standard.md`（可测试句式、避开禁用表达、未决项按三分类标记）；标题与 Markdown 结构见 `references/tapd-story-format.md`。
5. **逐字段确认**：正文输出完整草稿预览（文本），再用 `ask_followup_question` 弹出「是否确认草稿」选项；用户选「需要修改」时进一步定位字段。

M/L 档需建模状态与异常路径，L 档需定义高风险控制，检查项见 gate 第五、六块。影响评估只把 S/M/L 评级 + 一句话范围写入需求单，供研发评审判断工时；详细方案由 `/feai-start` 的 shape 阶段产出，不在此处预写。

### Step 4：选择迭代

代理执行 `iterations_get({ workspace_id, status: "open", limit: 30, order: "startdate desc" })`。

按 `references/tapd-story-format.md` 的迭代分类与匹配规则推荐需求池（默认归属，未锁定），用 `ask_followup_question` 弹出「迭代选择」图形化选项。

### Step 5：质量检查

对照 `references/gate-prd-quality.md` 检查：先过 11 项硬门禁，再按档位执行对应检查块，问题按 blocker / major / minor / note 分级，输出三态结论（通过 / 有条件通过 / 打回）。

正文输出检查报告（文本），再用 `ask_followup_question` 弹出「质量检查结果」选项。**不做强阻断**：结论为「打回」时强提示 blocker 项，用户选择直接提交需二次确认。门禁的作用是让用户清楚代价，而非替用户决定。

### Step 6：创建需求并衔接研发

代理执行 `stories_create`，参数映射与常见报错见 `references/tapd-story-format.md`。

**创建成功**：用 `ask_followup_question` 弹出「衔接研发」选项，等待用户选择。

- 选「立即进入开发」→ 调用 `/feai-start {19 位完整 Story ID}`。`/feai-start` 重定向 feai-native skill，在 shape 阶段重新拉取需求详情（含影响评估字段）并写入 `brief.md`；切分支在 build 阶段按团队约定处理。
- 选「结束」→ 输出 Story ID 与 TAPD 链接。

**创建失败**：

| 错误类型 | 处理 |
|---|---|
| 字段校验错误 | 用 `ask_followup_question` 弹出「创建失败重试」选项；用户选「重试」回到 Step 3 定位出错字段，最多重试 2 次 |
| 权限 / 网络 / workspace 不存在 | 输出原始错误详情与排查提示，不重试直接结束 |

---

## 模型路由

| 阶段 | 模型 | 说明 |
|---|---|---|
| Step 1 / 2 / 4 / 6（工具调用） | 默认主模型 | MCP 代理执行，低风险 |
| Step 3（复杂度分层 + 影响评估 + 结构化） | 默认主模型；L 档升高阶模型 | 轻量扫描；L 档涉及跨系统建模与风险判断 |
| Step 5（质量检查） | 低成本模型；L 档升默认主模型 | 模式匹配与分级；L 档需判断高风险控制完整性 |

> 具体 model id 以项目模型路由配置为准；无项目配置时按「低风险扫描优先低成本模型、常规规划与实现用默认主模型、高风险或连续失败时升级」的原则自决。

---

## 与现有命令的关系

```text
/feai-prd（需求创建）                /feai-start → feai-native（研发流程）
  ├─ 选模板 / 读字段配置               ├─ shape：拉取需求详情（复用影响评估）→ brief.md
  ├─ 复杂度分层（S/M/L）               ├─ build：实现 + 切规范分支
  ├─ 影响评估 + 结构化填写              ├─ verify：实际运行验证 → report.md
  ├─ 选迭代（默认需求池）               └─ archive：用户确认后归档
  ├─ 质量门禁（硬门禁 + 分级）
  └─ 创建需求单 → 询问是否进入开发 ──────┘
```

---

## 不包含的能力

设计稿关联（Figma 版本绑定）、评审状态流转、需求变更同步至关联任务、历史需求检索复用——均不在当前范围。
