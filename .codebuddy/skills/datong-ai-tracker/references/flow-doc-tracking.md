# 路径 A：流程单接入（独立命令）

> **v2 定位**：A 路径是 **深度使用场景**。用户已通过 B 路径完成"从零开始"埋点体系后，做"按流程单补埋点"时直接触发 A 路径。
> A 路径作为**独立命令**存在，**不内嵌在 B 路径中**。
>
> **B 路径（从零开始，默认主流程，业务初始化场景）** 见 → `references/tracking-plan.md`

---

## 入口识别关键词

| 关键词 | 优先级 | 备注 |
|--------|--------|------|
| 流程单 | 高 | 最直接 |
| flowId | 高 | 字段名 |
| 需求单 | 中 | 产品/PM 习惯用语 |
| URL（带 `flowId=` 参数） | 高 | 解析 URL 参数 |
| 需求 ID | 中 | 业务方用语 |
| 接入埋点（模糊） | 低 | **需追问：是流程单还是从零？默认走 B** |

> ⚠️ A 路径状态机短（分钟级，流程单做完就结束），与 B 路径的长状态周期（跨天/跨周）**完全独立**，不互相污染 `state.json`。

---

## 总体流程（v2）

```
Stage 0：Plan 必须（输出执行计划 + 写 state.json + 获用户"确认"）
Stage 1：MCP 环境检查（必过，否则阻断）
Stage 2：SDK 检测 + appkey 接入
Stage 3A：解析流程单（URL / flowId / 需求单号）→ 拉 get_flow
Stage 4A：拉 list_page_structure / list_event_node 校验页面/事件存在性
Stage 5A：方案预生成 → 生成 {slug}-plan.md
Stage 6A：转 events.json + 用户 ack 方案
Stage 7A：生成上报代码（前置读 custom-styles）
Stage 8A：代码落盘到项目
Stage 9A：调 import_tracking_data 导入 mcp
Stage 10A：引导用户开启联调
```

> 📖 Stage 0 计划模板 → `SKILL.md` §4
> 📖 MCP 工具参数 → `references/mcp-tools.md`
> 📖 自定义规范消费 → `references/custom-specs.md`

---

## Stage 0：Plan 必须

> 完整 Plan 范本见 `SKILL.md` §4。本节仅列 A 路径特殊项。

**A 路径 Plan 必含项**（§4.4 强制模板）：

| 项 | 内容 |
|------|------|
| 入口识别 | `A 流程单` |
| 触发关键词 | 流程单 / flowId / 需求单 / URL |
| 入口上下文 | appId / appKey / **flowId / appId 解析结果 / 流程单拉取次数** |
| Checklist 特殊项 | **flowId / appId 解析结果 / 流程单拉取次数** |

**强制约束**：未获用户"确认"前，❌ 不调用任何 MCP、❌ 不修改任何文件、❌ 不生成代码。

---

## Stage 2：SDK 检测 + appkey 接入

> 与 B 路径 Stage 2 相同。详见 `SKILL.md` 全局 Step 1 + Step 3。

**核心要点**：
- 流程单 URL 通常带 `appId`，但 `appkey` 仍要从 SDK 初始化代码里取或注册
- A 路径**复用** B 路径的 appkey（如已有）；无则询问用户是否注册
- **复用 Stage 2b（custom-specs 前置）**（与 B 路径保持一致）

**Checklist**：

| 维度 | 内容 |
|------|------|
| 必读项 | `references/sdk-detection.md` + `references/app-registration.md` + `custom-specs/` |
| 必产物 | `state.json.app_key` 已写入 |
| 必上报 | `sdk_detected` + `appkey_ready` + `custom_specs_loaded` 事件 |
| 必校验 | appkey 非空；custom-specs 已读 |

---

## Stage 3A：解析流程单 + 拉 get_flow

### 3A.1 参数解析

| 用户提供 | 处理方式 |
|---------|---------|
| 大同平台 URL（带 `flowId=`） | 解析 URL 提取 `appId` / `flowId` / `pageId` / `strucUniqueId` |
| `flowId` + `appId` | 直接使用 |
| `flowId` 单值 | 追问 `appId`（除非有上下文） |

**URL 解析规则**（参考 `mcp-tools.md`）：

| URL 参数 | 工具参数 | 说明 |
|---------|---------|------|
| `appId` | `appId` | 大同应用 ID |
| `pageId` | `pageId` | 页面 ID（URL 中可能存在） |
| `flowId` | `versionId` | 需求单号 |
| `strucUniqueId` | `structureUniqueId` | 多页面结构 ID（URL 中可能存在） |

> ⚠️ URL 路径中 `/#/d/{appId}/` 的 appId 与 query 参数中的 `appId` 相同，**优先使用 query 参数中的值**。
> 如果 URL 中没有 `pageId`，需要询问用户提供。

### 3A.2 调 get_flow 拉取流程单详情

参数准备完成后，调用 `get_flow(appId, flowId, ...)` 拉取流程单的变更详情。

- 包含：本流程单涉及的所有页面、事件、参数变更
- 返回数据用于 Stage 4A 的存在性校验

### 3A.3 Checklist

| 维度 | 内容 |
|------|------|
| 必读项 | 用户输入的 URL / flowId |
| 必产物 | `state.json.flow_id` + `state.json.app_id` 已写入 |
| 必上报 | `flow_parsed` + `flow_fetched` 事件 |
| 必校验 | flowId / appId 非空；get_flow 返回 success |

---

## Stage 4A：校验页面/事件存在性

基于 Stage 3A 拉到的流程单详情，逐个校验页面和事件的存在性。

### 4A.1 校验页面

**情况 1：URL 中提供了 `pageId`**
- 直接调用 `get_page_structure(appId, pageId, structureUniqueId, versionId=flowId, changeOnly=true)`
- `changeOnly=true` → 只取变更内容，**不返回未变更部分**
- 拿到页面结构的最新变更

**情况 2：URL 中没有 `pageId`**（流程单绑定多个 page）
- 流程单绑定多个页面 → 需要先通过 `list_page_structure` 接口获取该流程单绑定的页面 list
- 一个一个调用 `list_page_structure` 接口获取页面有什么页面结构
- 再逐个调用 `get_page_structure` 获取具体页面结构的变更内容
- 完成全部页面的埋点

### 4A.2 校验自定义事件

流程单也有关于**自定义事件**的变更，调用 `list_event_node` 获取该流程单事件配置信息：

- `changeOnly=true` → 只取变更事件
- 列出新增/修改/删除的事件清单

### 4A.3 Checklist

| 维度 | 内容 |
|------|------|
| 必读项 | Stage 3A get_flow 返回数据 |
| 必产物 | `state.json.completed_steps` 包含 `flow_page_checked` + `flow_event_checked` |
| 必上报 | `page_structure_checked` 事件 |
| 必校验 | 所有 page / event 都有对应变更内容；无缺失项 |

---

## Stage 5A：方案预生成

> v1 的 Step 4"获取埋点信息"和 Step 5"生成代码"在 v2 合并为 Stage 5A + Stage 7A。
> A 路径的特点是**变更已确定**（流程单已审批），所以方案是"预生成"而非"设计"。

### 5A.1 整理变更清单

基于 Stage 4A 校验后的页面/事件变更，整理为方案文档：

1. 遍历流程单涉及的每个页面
2. 列出该页面的页面级事件（`dt_pgin` / `dt_pgout`）
3. 列出该页面下的元素级事件（`dt_clck` / `dt_imp` / `dt_imp_end`）
4. 列出该流程单的新增/修改自定义事件

### 5A.2 转表格式

按 `references/tracking-table-format.md` 的固定 **7 列**表头格式输出：

| 触发时机 trigger | 示意图 ui | 事件 event_code | 页面 dt_pgid | 元素 dt_eid | 私有参数 udf_kv | 说明 remark |
|----------|:----:|---------|---------|:------------:|-------|-------|

### 5A.3 产物落盘

**目录**：`{项目根}/dt_tracking_plan/`

**文件名格式**：`{summary-slug}-plan-YYYYMMDDHH.md`

- `{summary-slug}`：基于流程单变更内容起短标题
  - 优先用流程单主题（如 `login-flow-55073`、`order-detail-tracking`）
  - 小写英文 + 连字符（kebab-case），2-5 个单词
- 示例：`login-flow-55073-plan-202606250030.md`
- 重名处理：末尾追加 `-序号`

### 5A.4 Checklist

| 维度 | 内容 |
|------|------|
| 必读项 | Stage 4A 页面/事件变更数据 + `tracking-table-format.md` |
| 必产物 | `dt_tracking_plan/{slug}-plan-YYYYMMDDHH.md` |
| 必上报 | `plan_generated` 事件 |
| 必校验 | 事件三字段主键无重复；7 列表头完整；流程单所有变更已覆盖 |

---

## Stage 6A：转 events.json + 用户 ack

### 6A.1 转 events.json

读取 Stage 5A 方案 md 的**完整文本内容**，按 `import_tracking_data` 工具的接口要求，将内容生成 JSON 数据文件 `dt_tracking_plan/{slug}-events-YYYYMMDDHH.json`。

> ⚠️ 事件、元素、参数的中英文名称必须与方案文档保持一致。
> 产物 JSON 文件**保留**（用于复盘现场）。

### 6A.2 用户确认

向用户展示 `dt_tracking_plan/{slug}-plan-YYYYMMDDHH.md`，询问确认。

| 用户选择 | 处理 |
|---------|------|
| ✅ 确认 | → 进入 Stage 7A 生成代码 |
| 调整 | 修改方案后重新展示 |
| 取消 | 清理临时文件，结束 |

### 6A.3 Checklist

| 维度 | 内容 |
|------|------|
| 必读项 | Stage 5A 方案 md |
| 必产物 | `dt_tracking_plan/{slug}-events-YYYYMMDDHH.json` |
| 必上报 | `events_json_ready` + `plan_confirmed` 事件 |
| 必校验 | events.json 字段完整；用户已 ack |

---

## Stage 7A：生成上报代码

> **前置读 `custom-styles/`**（与 B 路径保持一致）

### 7A.1 代码生成优先级

| 优先级 | 参考来源 | 说明 |
|-------|---------|------|
| 🥇 最高 | `custom-styles/` 目录 | 业务方定义的编码习惯、封装方式、代码示例 |
| 🥈 次高 | 项目已有的上报代码 | 扫描到的现有埋点调用方式和封装 |
| 🥉 兜底 | SDK 官方文档 | `quickstart/` 和 `advanced/` 中的 SDK 使用说明 |

### 7A.2 H5 端：universal-report（默认）

加载 `../sdk/h5/universal-report/quickstart.md` 获取 SDK 使用方法。

**声明式标签埋点**（页面和元素事件）：
- 在 HTML/模板中添加 `dt-pgid` + `dt-params`（页面级）/ `dt-eid` + `dt-params`（元素级）
- SDK 自动上报 `dt_pgin` / `dt_pgout` / `dt_imp` / `dt_clck` / `dt_imp_end`

**手动埋点 API**（独立业务事件）：
- 当事件与页面和元素**无直接关联**时才使用 `reporter.reportEvent()`
- 非必要时，不要使用手动上报，走声明式标签埋点

### 7A.3 Android / iOS 端：beacon（默认）

- Android：加载 `../sdk/android/beacon/quickstart.md`
- iOS：加载 `../sdk/ios/beacon/quickstart.md`
- 使用 beacon SDK 的手动上报 API 完成所有事件的上报

### 7A.4 代码产出

```
src/tracking/
├── reporter.ts / reporter.js   # SDK 初始化封装
├── index.ts / index.js         # 统一导出
```

1. SDK 初始化封装：创建 `reporter.ts`（初始化 universal-report / beacon）
2. 统一导出：创建 `index.ts`
3. 入口初始化：在 `main.ts` 中添加初始化调用
4. 页面/组件插桩：为页面和元素添加声明式标签（H5）或手动上报调用（Android/iOS）

### 7A.5 代码生成原则

1. **事件名和参数必须与方案文档中的定义完全匹配**
2. **保持项目代码风格一致**：观察封装方法签名、参数传递方式、文件组织方式
3. **生成的代码应与现有代码融为一体**
4. **重要**：已有的埋点代码不要去修改，除非用户明确调整

### 7A.6 Checklist

| 维度 | 内容 |
|------|------|
| 必读项 | `custom-styles/` + Stage 5A 方案 md + 上一份产物 |
| 必产物 | `src/tracking/reporter.{ts,js}` + `src/tracking/index.{ts,js}` + 页面/组件插桩 |
| 必上报 | `code_generated` 事件 |
| 必校验 | 事件名/参数与方案文档完全匹配；项目代码风格一致 |

---

## Stage 8A：代码落盘到项目

将 7A 生成的代码文件写入项目实际路径。

**落盘位置**：
- SDK 初始化封装：`{项目根}/src/tracking/reporter.{ts,js}`
- 统一导出：`{项目根}/src/tracking/index.{ts,js}`
- 入口初始化：追加到 `{项目根}/src/main.{ts,js}`
- 页面/组件插桩：插入到对应文件

**Checklist**：

| 维度 | 内容 |
|------|------|
| 必读项 | Stage 7A 生成的代码 + 项目源码结构 |
| 必产物 | 所有生成文件已写入磁盘 |
| 必上报 | `code_landed` 事件 |
| 必校验 | 文件存在性 + 内容完整性（行数 > 0） |

---

## Stage 9A：调 import_tracking_data 导入 mcp

### 9A.1 分批导入

**分批策略**：从 Stage 6A 生成的 `events.json` 中，按约 50 条事件为一批，逐批调用 `import_tracking_data` 导入（不是等量拆分 JSON 文件，而是按 events 数组元素分批）。

**单批流程**：

1. 从 `dt_tracking_plan/{slug}-events-YYYYMMDDHH.json` 中取当前批的 events 数组片段（约 50 条）
2. 将该批 events 数组作为请求参数，调用 `import_tracking_data` 导入
3. 导入完成后，继续下一批

> ⚠️ 每批导入完成后**落盘**本批 JSON 到 `dt_tracking_plan/{slug}-events-YYYYMMDDHH-batch{N}.json`（用于复盘现场）。

### 9A.2 导入错误处理

- 有报错时根据工具返回的 `err_details` 错误信息调整当前批的请求数据
- **重试 3 次仍失败** → 跳过该批，记录失败事件清单，继续下一批
- **整体 3 批以上失败** → 阻断后续流程，提示用户联系大同小秘

### 9A.3 导入结果处理

| 结果 | 处理 |
|------|------|
| ✅ 成功 | 输出导入链接 `https://trackmate.woa.com/#/d/repRegistry/allnode?appId={appId}&trackTerminal=multiFrontend` |
| ❌ 失败 | `⚠️ 导入失败，请联系大同小秘提供协助`（阻断主流程） |
| 无 appId | 跳过导入，提示用户 `⚠️ 找不到应用，无法导入`，中断流程 |

### 9A.4 Checklist

| 维度 | 内容 |
|------|------|
| 必读项 | Stage 6A events.json |
| 必产物 | mcp 导入完成日志（内部） |
| 必上报 | `mcp_import_done` 事件 |
| 必校验 | `import_tracking_data` 返回 success；错误 ≤ 0 |

---

## Stage 10A：引导用户开启联调

> ⚠️ A 路径**不进入 Stage 9B 看板生成**（流程单做完就结束）。
> 完成后只引导用户开启联调，确认数据上报正常即可。

### 10A.1 引导模板

```markdown
🔍 流程单 55073 的埋点代码已生成完毕，建议立即开启**可视化联调**验证数据是否正常上报：

1. 我帮你开启联调模式，获取 debugId
2. 将 debugId 配置到 SDK 初始化参数中
3. 在页面上触发埋点操作，实时查看上报数据

👉 回复「开启联调」我来帮你配置
```

### 10A.2 调 start_realtime_debug_mode

用户确认后：

- 调用 `start_realtime_debug_mode` 获取 debugId
- 配置到 SDK 初始化参数中验证数据
- 调用失败/未返回 debugId 时按 `error_occurred` 上报（`phase=step4_debug`）

### 10A.3 Checklist

| 维度 | 内容 |
|------|------|
| 必读项 | 用户回复"开启联调" |
| 必产物 | SDK 初始化代码已插入 `debugId` / `appId` |
| 必上报 | `debug_session_started` 事件（`entry=post_codegen`） |
| 必校验 | debugId 已配置；本地应用已启动 |

---

## 与 B 路径的衔接

用户在 B 路径完成"从零开始"后，做"按流程单补埋点"时直接触发 A 路径：

```
B 路径完成 → state.json 标记 completed
用户：「按流程单 55073 接入埋点」
Agent：识别为 A 路径入口 → 新建 state.json（A 入口，flowId=55073）
       复用 B 路径的 appkey（state.json artifacts.app_key）
       走 A1-A12
```

**state.json 多入口支持**：
- `entry` 字段区分 B / A / C / D
- 用户可能 A 路径跑一半切去 B 路径 → 询问用户「检测到未完成任务，是否继续？」

---

## 附录：完整 A 路径产物清单

所有产物集中在 `{项目根}/dt_tracking_plan/`：

| 产物 | 命名规则 | 内容 | 给谁看 |
|------|----------|------|--------|
| `state.json` | 固定 | 流程状态机 | Agent |
| `{slug}-plan-YYYYMMDDHH.md` | `{业务名}-plan-{时间}.md` | 埋点方案（表格式） | **用户** |
| `{slug}-events-YYYYMMDDHH.json` | `{业务名}-events-{时间}.json` | 导入用 JSON | Agent → mcp |
| `{slug}-code-YYYYMMDDHH/` | `{业务名}-code-{时间}/` | 生成的代码文件 | Agent → 项目 |

**A 路径 vs B 路径产物差异**：
- A 路径**不生成** `{slug}-prompt-YYYYMMDDHH.md`（流程单不做新看板）
- A 路径**不进入** Stage 8B 链路检测（流程单级别数据已在 B 路径接入时验证过）
- A 路径**不进入** Stage 9B 看板生成（流程单做完就结束）

> 📖 state.json 完整 schema、断点续跑逻辑、状态机流转 → `SKILL.md` §6
