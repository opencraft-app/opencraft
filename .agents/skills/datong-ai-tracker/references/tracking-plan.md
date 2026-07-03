# 路径 B：从零开始的埋点方案设计流程

> **v2 定位**：B 路径是 **默认主流程**（业务初始化场景）。新项目/新业务接入大同埋点时**默认走 B 路径**（指标驱动 → 方案设计 → 落地 → 联调）。
> 用户输入模糊（"做埋点"）时也默认走 B 路径；只有明确出现"流程单/flowId/需求单"关键词时才走 A 路径。
>
> **A 路径（流程单接入，深度使用场景）** 见 → `references/flow-doc-tracking.md`

---

## 入口识别关键词

| 关键词 | 优先级 | 备注 |
|--------|--------|------|
| 从零开始 | 高 | 最直接 |
| 新项目埋点 | 高 | 业务初始化典型场景 |
| 规划埋点 | 高 | 指标驱动 |
| 帮我做埋点 | 中（需追问：有无流程单？） | 默认走 B |
| 接入埋点（模糊） | 低 | 默认走 B |
| 流程单 / flowId / 需求单 / URL | — | **不走 B，走 A** |

> 用户说"做埋点"且没有提供流程单信息 → **默认 B 路径**，Agent 主动确认"是否要从零开始规划指标体系？"

---

## 总体流程（v2）

```
Stage 0：Plan 必须（输出执行计划 + 写 state.json + 获用户"确认"）
Stage 1：MCP 环境检查（必过，否则阻断）
Stage 2：SDK 检测 + appkey 接入
Stage 2b：前置读 custom-specs（业务自定义规范加载）
Stage 3B：场景识别 → 指标推荐 → 用户 ack
Stage 4B：指标 → 事件反推 → 生成 {slug}-plan.md
Stage 5B：用户 ack 方案 → 生成上报代码（前置读 custom-styles）
Stage 6B：代码落盘到项目
Stage 7B：转 events.json + 调 import_tracking_data 导入 mcp
Stage 8B：链路检测（query_starrocks_export_status）+ 样例数据验证
Stage 9B：生成看板 Prompt（create_dola_conversation）
Stage 10B：引导用户开启联调
```

> 📖 Stage 0 计划模板、Stage 1-10 状态机流转、断点续跑 → `SKILL.md` §4 / §5 / §6
> 📖 流程单 A 路径 → `references/flow-doc-tracking.md`

---

## Stage 0：Plan 必须

> 完整 Plan 范本见 `SKILL.md` §4。本节仅列 B 路径特殊项。

**B 路径 Plan 必含项**（§4.4 强制模板）：

| 项 | 内容 |
|------|------|
| 入口识别 | `B 从零开始（默认）` |
| 触发关键词 | 从用户输入提取 |
| 入口上下文 | appId / appKey / 项目路径 / **业务场景识别结果** |
| Checklist 特殊项 | **业务场景识别结果 / 指标推荐清单 / 风险评估** |

**强制约束**：未获用户"确认"前，❌ 不调用任何 MCP、❌ 不修改任何文件、❌ 不生成代码。

---

## Stage 2b：前置读 custom-specs

> **B 路径专属前置步骤**。A 路径复用（参见 `flow-doc-tracking.md` Stage 4A）。

进入 Stage 3B 之前，**必须**先执行 custom-specs 检查（详见 `custom-specs.md`）：

1. 扫描 skill 根目录下 `custom-specs/` 是否存在与**指标规范**相关的 md（文件名含 `metric`/`indicator`/`kpi`/`okr`/`northstar`）
2. 扫描 skill 根目录下 `custom-specs/` 是否存在与**埋点方案规范**相关的 md（文件名含 `tracking`/`event`/`plan`/`param`/`naming`）
3. 若命中：解析 `## 覆盖` / `## 补充` 章节，作为**最高优先级**输入并入 Stage 3B / Stage 4B
4. 命中硬性约束冲突 → 内部记录被拒绝条目（不写入最终文档）
5. 目录不存在/无命中/内容为空 → 回退默认规则，无缝继续

**Checklist 4 维度**（强校验，AI 自检失败时停下汇报）：

| 维度 | 内容 |
|------|------|
| 必读项 | 已读 `custom-specs/README.md` + 命中的指标/埋点方案规范 md |
| 必产物 | `state.json.custom_specs_loaded = true` |
| 必上报 | `custom_specs_loaded` 事件 |
| 必校验 | 命中的 md 数量 ≥ 0；冲突项已记录（内部参考） |

---

## Stage 3B：场景识别 & 指标推荐

在开始设计埋点前，先对齐业务目标：扫描项目 → 识别业务场景 → 推荐核心指标 → 与用户确认。

### 3B.1 项目分析（轻量版）

- 扫描路由、页面组件、API 调用、状态管理、`package.json` 依赖
- 识别关键业务词、核心实体、关键流程、页面/模块类型
- **不产出完整项目摘要**，只记录关键信号供场景打分

### 3B.2 场景匹配

1. 首先读取场景总索引：`../dashboard/references/scenario-library/01-scene-index.md`
2. 按四类证据（业务词 / 核心实体 / 关键流程 / 页面模块）对各场景打分
3. 得分 ≥ 6 → 确定主场景，读取对应的场景文件（`02-*.md` 至 `11-*.md`）
4. 得分 4-5 且与主场景强相关 → 可选再读 1 个副场景
5. 所有场景均 < 4 分 → 跳过场景推荐，降级为通用指标推荐

> 📖 场景库使用规则详见 `../dashboard/references/scenario-library/00-usage-guide.md`

### 3B.3 输出指标推荐清单（精简版）

向用户展示精简格式（不做看板布局设计）：

```markdown
## 📊 业务指标推荐

基于项目代码分析，识别到的业务场景：**{场景名}**（命中证据：{业务词/实体/流程}）

推荐你优先关注以下指标（埋点会围绕这些指标设计）：

| 序号 | 指标名称 | 指标类型 | 业务含义 | 所需核心事件 |
|:----:|---------|:-------:|---------|-------------|
| 1 | {North Star} | 北极星 | {说明} | {事件列表} |
| 2 | {核心结果指标} | 核心 | {说明} | {事件列表} |
| ... | ... | ... | ... | ... |

---
> 👉 这些指标合适吗？你可以：
> - ✅ 确认 → 我将据此设计埋点方案
> - ➕ 增加指标（如"还想看 XX"）
> - ➖ 删除某个指标
> - 🔄 改为通用页面行为指标（PV/UV/点击率等）
```

**指标推荐上限**（避免过度推荐）：
- 1 个 North Star 候选
- 3-5 个核心结果指标
- 2-3 个诊断指标

### 3B.4 用户确认

| 用户选择 | 处理方式 |
|---------|---------|
| ✅ 确认指标 | → 进入 Stage 4B，由指标反推事件 |
| ➕➖🔄 调整指标 | 更新清单后重新展示，直到用户确认 |
| 明确说"不要推荐指标，直接扫代码埋点" | → 跳过 Stage 3B，按 Stage 4B 备选路径穷举页面元素 |
| 场景未命中（降级情况） | → 使用通用指标模板：PV/UV、页面停留时长、关键元素点击率、核心表单提交率 |

### 3B.5 Checklist

| 维度 | 内容 |
|------|------|
| 必读项 | `01-scene-index.md` + 命中的场景文件 |
| 必产物 | 指标推荐清单（对话中展示） |
| 必上报 | `scene_identified` 事件 |
| 必校验 | 得分 ≥ 6 才确定主场景；推荐指标 1+3-5+2-3 上限 |

> ⚠️ Stage 3B 的产出是**指标清单**，不是埋点方案。事件命名细节留给 Stage 4B。

---

## Stage 4B：指标 → 事件反推 + 生成埋点方案

基于 Stage 3B 确认的指标清单，为每个指标反推所需的事件和参数，结合项目代码定位事件的触发位置，产出 **md 格式的埋点方案文档**。

### 4B.1 分析步骤

1. **指标 → 事件映射**：遍历 Stage 3B 指标清单，为每个指标列出所需事件（事件名、dt_pgid、dt_eid、关键参数）
2. **事件 → 代码位置映射**：扫描项目路由/组件，为每个事件定位对应的页面和元素
3. **补齐基础埋点**：除指标直接依赖的事件外，补充必要的基础事件（如页面曝光 `dt_pgin`、页面退出 `dt_pgout`）
4. **按页面组织输出**：按页面维度汇总事件，产出埋点方案文档

### 4B.2 备选路径：用户明确不要指标推荐

如果用户明确拒绝指标推荐，则按原有逻辑穷举：

1. **识别所有页面**（路由级组件/视图）
2. **逐页面分析交互元素**（按钮、卡片、弹窗、标签页、表单、列表项等）
3. **为每个页面和元素确定埋点事件**

### 4B.3 事件设计规则

> 🔀 **自定义规范消费（来自 custom-specs/）**：
> - 若业务自定义规范声明了**事件命名规则**（如 `event_code` 前缀、`dt_pgid`/`dt_eid` 风格约束） → 按自定义规则生成事件名，覆盖下方默认 `snake_case` 约定
> - 若业务自定义规范声明了**必选公参**（如所有事件必须带 `tenant_id`、`user_tier`） → 为每个事件自动补齐这些参数到 `私有参数 udf_kv` 列
> - 若业务自定义规范声明了**自定义事件分类**（在默认 5 类之外新增一类业务类别） → 在分类表和方案中采纳该分类
> - 若业务自定义规范尝试修改**事件三字段主键**（`event_code` + `dt_pgid` + `dt_eid`） → **拒绝采纳**，保留默认硬性约束

1. **⚠️ 事件唯一标识（主键）**：

   `event_code`（事件英文名）+ `dt_pgid`（页面英文名）+ `dt_eid`（元素英文名）三个字段组成数据库主键，用于唯一确定一条事件。

   - **一旦确定，不要轻易修改**，否则会导致数据断裂
   - 如果事件没有关联页面，`dt_pgid` 置空
   - 如果事件没有关联元素，`dt_eid` 置空
   - 同一个 `event_code` 可以在不同页面/元素下复用（因为主键是三字段组合）
   - **⚠️ 每个主键组合必须独立一行，严禁将多个 dt_pgid 或 dt_eid 合并到同一行**（即使事件名称相同）

   | 场景 | event_code | dt_pgid | dt_eid | 说明 |
   |------|-----------|---------|--------|------|
   | 页面事件 | `dt_pgin` | `home` | - | 页面级事件，无元素 |
   | 元素事件 | `dt_clck` | `home` | `post_card` | 某页面下的元素事件 |
   | 独立业务事件 | `search_confirm` | - | - | 与页面和元素均无关联 |
   | 全局元素事件 | `dt_clck` | - | `nav_menu` | 全局元素，不绑定特定页面 |

2. **`element_name`（dt_eid）命名规范**：使用 `snake_case`，描述元素本身而非行为
   - ✅ `like_btn`, `post_card`, `search_modal`
   - ❌ `clickLike`, `PostCard`, `search-modal`

3. **页面命名规范**（dt_pgid）：
   - 页面：`home`, `post_detail`, `profile`, `settings`
   - 弹窗/浮层：`search_modal`, `login_modal`

4. **事件分类**：

| 类别 | event_code | 说明 |
|------|-----------|------|
| 页面曝光 | `dt_pgin` | 进入页面时 |
| 页面结束曝光 | `dt_pgout` | 离开页面时（高优先级上报） |
| 元素曝光 | `dt_imp` | 元素进入可视区域时 |
| 元素点击 | `dt_clck` | 用户点击元素时 |
| 独立业务事件 | 自定义命名 | 与页面/元素无直接关联的业务行为（如 `search_confirm`、`comment_submit`） |

5. **上下文参数**：根据业务场景携带必要的上下文
   - 内容类：`post_id`, `post_title`, `author_id`
   - 操作类：`action`（如 `like`/`unlike`），`tab_name`
   - 度量类：`stay_duration`, `like_count`, `result_count`, `comment_length`
   - 索引类：`image_index`, `current_page`

### 4B.4 产物落盘

> 🔀 **自定义规范消费（来自 custom-specs/）**：
> - 若业务自定义规范声明了**自定义 slug 命名规则或文件名格式** → 采用自定义格式，默认的 `{summary-slug}-YYYYMMDDHH.md` 作为兜底
> - 若业务自定义规范声明了**附加章节**（如"责任人""上线版本""审核人"列或块） → 按自定义格式在文档中加入

**目录**：`{项目根}/dt_tracking_plan/`（不存在则创建；**不污染 skill 目录**）

**文件名格式**：`{summary-slug}-plan-YYYYMMDDHH.md`
- `{summary-slug}`：基于本次埋点需求起的**总结性短标题**，一眼看出这份方案是做什么的
  - 小写英文 + 连字符（kebab-case），如 `content-feed-tracking`、`ecommerce-checkout-tracking`
  - 2-5 个单词，语义具体（不要用 `tracking-plan`、`events` 这种通用词）
  - 优先体现「场景 + 主题」：Stage 3B 命中场景则用场景关键词，否则用项目核心业务词
- `YYYYMMDDHH`：当天日期 + 小时（24h）
- 示例：`content-feed-tracking-plan-202606250030.md`
- 重名处理：末尾追加 `-序号`（从 1 递增）

### 4B.5 Checklist

| 维度 | 内容 |
|------|------|
| 必读项 | 上一份产物（`state.json.current_step` 指向的产物） |
| 必产物 | `dt_tracking_plan/{slug}-plan-YYYYMMDDHH.md`（事件清单） |
| 必上报 | `events_designed` + `plan_generated` 事件 |
| 必校验 | 事件三字段主键无重复；事件名使用 `snake_case` |

---

## Stage 5B：用户 ack + 生成上报代码

### 5B.1 用户确认

向用户展示 `dt_tracking_plan/{slug}-plan-YYYYMMDDHH.md`，询问确认。

| 用户选择 | 处理 |
|---------|------|
| ✅ 确认 | → 进入 5B.2 生成代码 |
| 调整 | 修改方案后重新展示 |
| 取消 | 清理临时文件，结束 |

### 5B.2 生成上报代码

**前置读 `custom-styles/`**（与 `custom-specs/` 对称）：

1. 扫描 skill 根目录下 `custom-styles/` 是否存在
2. 若存在 → 优先读取业务方定义的编码习惯、封装方式、代码示例
3. 不存在 → 回退到项目已有上报代码 + SDK 官方文档（详见 `code-generation.md`）

**代码生成**（详细规则见 `references/code-generation.md`）：

| 技术栈 | 默认 SDK | 上报方式 | 文档路径 |
|--------|---------|---------|----------|
| H5 | universal-report | 声明式埋点（标签）+ 手动埋点 | `../sdk/h5/universal-report/quickstart.md` |
| Android | beacon | 手动埋点 | `../sdk/android/beacon/quickstart.md` |
| iOS | beacon | 手动埋点 | `../sdk/ios/beacon/quickstart.md` |

> ⚠️ H5 端默认使用 **universal-report**，优先采用声明式标签埋点（`dt-pgid`、`dt-eid`、`dt-params`），与页面和元素无关联的事件使用手动埋点 API（`reportEvent`）。

**代码产出**：

```
src/tracking/
├── reporter.ts / reporter.js   # SDK 初始化封装
├── index.ts / index.js         # 统一导出
```

1. SDK 初始化封装：创建 `reporter.ts`（初始化 universal-report / beacon）
2. 统一导出：创建 `index.ts`
3. 入口初始化：在 `main.ts` 中添加初始化调用
4. 页面/组件插桩：为页面和元素添加声明式标签（H5）或手动上报调用（Android/iOS）

### 5B.3 Checklist

| 维度 | 内容 |
|------|------|
| 必读项 | `custom-styles/` + Stage 4B 产物 + 上一份产物 |
| 必产物 | `src/tracking/reporter.{ts,js}` + `src/tracking/index.{ts,js}` + 页面/组件插桩 |
| 必上报 | `plan_confirmed` + `code_generated` 事件 |
| 必校验 | 事件名/参数与方案文档完全匹配；项目代码风格一致 |

---

## Stage 6B：代码落盘到项目

将 5B.2 生成的代码文件写入项目实际路径。

**落盘位置**：
- SDK 初始化封装：`{项目根}/src/tracking/reporter.{ts,js}`
- 统一导出：`{项目根}/src/tracking/index.{ts,js}`
- 入口初始化：追加到 `{项目根}/src/main.{ts,js}`
- 页面/组件插桩：插入到对应文件

**Checklist**：

| 维度 | 内容 |
|------|------|
| 必读项 | Stage 5B 生成的代码 + 项目源码结构 |
| 必产物 | 所有生成文件已写入磁盘 |
| 必上报 | `code_landed` 事件 |
| 必校验 | 文件存在性 + 内容完整性（行数 > 0） |

---

## Stage 7B：转 events.json + 导入 mcp

> **v2 核心改造**：md 产物保留给用户审阅/归档；导入只走 mcp（`import_tracking_data`）。**删除 v1 的 `upload_tracking_plan` 路径**。

### 7B.1 分批转 events.json + 导入

**分批策略**：在 MD 层面分批（不是先转全量 JSON 再切分）。每批 = 从 MD 中取约 50 条事件行 → 转 JSON → 立即调 `import_tracking_data` 导入。

**单批流程**：

1. 从 `dt_tracking_plan/{slug}-plan-YYYYMMDDHH.md` 中取当前批的表格行（约 50 条事件）
2. 按 `import_tracking_data` 工具的 events 数组结构，将该批事件转换为 JSON
3. 将该批 JSON 作为请求参数，调用 `import_tracking_data` 导入
4. 导入完成后，继续下一批

> ⚠️ 事件、元素、参数的中英文名称必须与方案文档保持一致，不能 AI 自由发挥。
> ⚠️ 不是直接上传 json 文件，而是将 JSON 内容作为 mcp 接口的请求参数。
> ⚠️ 每批导入完成后**落盘**本批 JSON 到 `dt_tracking_plan/{slug}-events-YYYYMMDDHH-batch{N}.json`（用于复盘现场）。

### 7B.2 导入错误处理

- 有报错时根据工具返回的 `err_details` 错误信息调整当前批的请求数据
- **重试 3 次仍失败** → 跳过该批，记录失败事件清单，继续下一批
- **整体 3 批以上失败** → 阻断后续流程，提示用户联系大同小秘

### 7B.3 导入结果处理

| 结果 | 处理 |
|------|------|
| ✅ 成功 | 输出导入链接 `https://trackmate.woa.com/#/d/repRegistry/allnode?appId={appId}&trackTerminal=multiFrontend` |
| ❌ 失败 | `⚠️ 导入失败，请联系大同小秘提供协助`（阻断主流程） |
| 无 appId | 跳过导入，提示用户 `⚠️ 找不到应用，无法导入`，中断流程 |

### 7B.4 Checklist

| 维度 | 内容 |
|------|------|
| 必读项 | Stage 4B 方案 md |
| 必产物 | `dt_tracking_plan/{slug}-events-YYYYMMDDHH.json` |
| 必上报 | `mcp_import_done` 事件 |
| 必校验 | `import_tracking_data` 返回 success；events.json 字段完整 |

---

## Stage 8B：链路检测 + 样例数据验证

> 🚨 **本步骤是 Stage 7B 导入成功后、Stage 9B 看板生成前的必经步骤。禁止从 Stage 7B 直接跳到 Stage 9B。**
> 即使链路检测未 ready，也必须执行本步骤的检测动作。

### 8B.1 链路检测

调用 `query_starrocks_export_status` 检测应用链路是否 ready。

- **判断标准**：返回结果中 `status` 字段为 `running` 才算链路真正 ready
- 其他状态（`pending` / `failed` / 空字符串 / 无值）均视为未 ready
- 链路未 ready 时阻断流程，引导用户：`⚠️ 链路未ready，无法生成看板，可以稍后继续，或可以联系大同小秘提供协助`

### 8B.2 样例数据验证

链路 ready 情况下，执行上报样例数据测试链路：

- **严格按照 `references/test-data-link.md` 文档执行**
- 样例数据的 `event_code` / `dt_pgid` / `dt_eid` / `udf_kv` 私有参数**必须从已确认的埋点方案表格中提取**
- 使用 Python 脚本实现（禁止 curl），生成 100 条 mock 数据并上报

### 8B.3 标记完成

执行完样例上报后，调用 `finish_appkey_access`，标记该 appkey 业务完成接入。

### 8B.4 Checklist

| 维度 | 内容 |
|------|------|
| 必读项 | `references/test-data-link.md` + Stage 4B 方案 md |
| 必产物 | 样例数据上报成功日志（内部） |
| 必上报 | `link_checked` + `sample_data_verified` 事件 |
| 必校验 | 链路 status=running；样例数据 100 条全部上报成功 |

---

## Stage 9B：生成看板 Prompt

### 9B.1 读取已确认的埋点方案

读取 `dt_tracking_plan/{slug}-plan-YYYYMMDDHH.md` 中的事件清单和指标信息。

### 9B.2 生成看板 Prompt

严格按照 `dashboard/references/dashboard-prompt.md` 规范生成看板 Prompt：

- Part 1：埋点方案（引导语 + 约定说明 + 事件表格，直接复用已确认的方案内容）
- Part 2：看板方案（基于已确认指标自动生成 ASCII 布局图 + 图卡计算逻辑伪 SQL）
- ⚠️ 生成后必须按 `dashboard-prompt.md` 中的校验规则逐项检查

### 9B.3 保存 + 创建对话

- 看板 Prompt 保存到 `dt_tracking_plan/{slug}-prompt-YYYYMMDDHH.md`
- 读取看板 Prompt md 完整内容，调用 `create_dola_conversation` 工具创建对话
- ⚠️ **必须将 `create_dola_conversation` 返回的链接信息（chatUrl）完整透出给用户**

### 9B.4 看板设计原则

- 基于已确认的指标清单，自动规划 1-2 个看板（如「用户活跃概览」+「功能使用分析」）
- 顶部放核心 KPI 指标卡片（3-6 个），中部放趋势图，底部放分布/明细
- 伪 SQL 中的字段名必须与埋点方案中 `udf_kv` 列定义的具体 key 名完全一致
- 时间条件统一使用 `dt >= TODAY()` 或 `dt >= DATE_SUB(TODAY(), N)`

### 9B.5 Checklist

| 维度 | 内容 |
|------|------|
| 必读项 | Stage 4B 方案 md + `dashboard-prompt.md` + `dashboard-layout.md` |
| 必产物 | `dt_tracking_plan/{slug}-prompt-YYYYMMDDHH.md` |
| 必上报 | `dashboard_created` 事件（含 `entry=post_codegen`） |
| 必校验 | chatUrl 完整透出；Prompt 格式校验全部通过 |

---

## Stage 10B：引导用户开启联调

> 完成所有步骤后，**主动引导用户进行联调验证**，确保埋点数据正常上报。

### 10B.1 引导模板

```markdown
🔍 埋点代码已生成完毕，建议立即开启**可视化联调**验证数据是否正常上报：

1. 我帮你开启联调模式，获取 debugId
2. 将 debugId 配置到 SDK 初始化参数中
3. 在页面上触发埋点操作，实时查看上报数据

👉 回复「开启联调」我来帮你配置
```

### 10B.2 调 start_realtime_debug_mode

用户确认后：

- 调用 `start_realtime_debug_mode` 获取 debugId
- 配置到 SDK 初始化参数中验证数据
- 调用失败/未返回 debugId 时按 `error_occurred` 上报（`phase=step4_debug`）

### 10B.3 Checklist

| 维度 | 内容 |
|------|------|
| 必读项 | 用户回复"开启联调" |
| 必产物 | SDK 初始化代码已插入 `debugId` / `appId` |
| 必上报 | `debug_session_started` 事件（`entry=post_codegen`） |
| 必校验 | debugId 已配置；本地应用已启动 |

---

## 附录：完整 B 路径产物清单

所有产物集中在 `{项目根}/dt_tracking_plan/`：

| 产物 | 命名规则 | 内容 | 给谁看 |
|------|----------|------|--------|
| `state.json` | 固定 | 流程状态机 | Agent |
| `{slug}-plan-YYYYMMDDHH.md` | `{业务名}-plan-{时间}.md` | 埋点方案（表格式） | **用户** |
| `{slug}-events-YYYYMMDDHH.json` | `{业务名}-events-{时间}.json` | 导入用 JSON | Agent → mcp |
| `{slug}-prompt-YYYYMMDDHH.md` | `{业务名}-prompt-{时间}.md` | 看板 Prompt | Agent → dola |
| `{slug}-code-YYYYMMDDHH/` | `{业务名}-code-{时间}/` | 生成的代码文件 | Agent → 项目 |

**命名示例**：
- `dt_tracking_plan/login-tracking-plan-202606250030.md`
- `dt_tracking_plan/login-tracking-events-202606250030.json`
- `dt_tracking_plan/login-tracking-prompt-202606250030.md`

> 📖 state.json 完整 schema、断点续跑逻辑、状态机流转 → `SKILL.md` §6
