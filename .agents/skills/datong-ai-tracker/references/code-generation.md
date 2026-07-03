# 代码生成详细规则（A 路径专用）

> **v2 定位**：本文档服务于 **A 路径（流程单接入，深度使用场景）** 的 Stage 7A「生成上报代码」。
> A 路径的特点是**变更已确定**（流程单已审批），所以代码生成是"基于已知变更落地"，不是"从零设计"。
>
> **B 路径（从零开始）的代码生成** 见 → `references/tracking-plan.md` 的 Stage 5B。
> **生成前的方案设计** 见 → `references/flow-doc-tracking.md` 的 Stage 5A「方案预生成」。

---

## 1. 前置必读项

进入代码生成前，**必须**已读取：

| 必读项 | 说明 | 路径 |
|--------|------|------|
| `custom-styles/` | 业务方自定义的编码习惯、封装方式、代码示例 | skill 根目录 |
| Stage 5A 方案 md | 本次流程单的方案预生成结果 | `{项目根}/dt_tracking_plan/{slug}-plan-*.md` |
| 上一份产物 | 强制约束：从 `state.json.current_step` 拿路径 | 见 state.json |

**未读完以上 3 项前，不进入代码生成。**

---

## 2. 代码生成优先级

按以下优先级收集参考信息并生成代码：

| 优先级 | 参考来源 | 说明 |
|-------|---------|------|
| 🥇 最高 | `custom-styles/` 目录 | 业务方定义的编码习惯、封装方式、代码示例 |
| 🥈 次高 | 项目已有的上报代码 | 扫描到的现有埋点调用方式和封装 |
| 🥉 兜底 | SDK 官方文档 | `quickstart/` 和 `advanced/` 中的 SDK 使用说明 |

---

## 3. 读取业务自定义上报代码风格文档

**首先检查 `custom-styles/` 目录**

**如果该目录下有业务方编写的文档**：
- 优先读取并遵循其中的编码习惯、封装方式、代码示例
- 生成的代码应与文档中的示例风格一致
- 使用文档中指定的工具类/方法名，不要自行创造

> 📖 详细规范 → 业务方在 `custom-styles/README.md` 中的约定

---

## 4. 拉取流程单变更（A 路径核心）

A 路径的代码生成**基于流程单变更**，不重新设计事件。

### 4.1 已完成的拉取动作（Stage 3A / Stage 4A）

代码生成前，Agent 已完成：
1. **Stage 3A**：解析 URL 提取 `appId` / `flowId` / `pageId` / `strucUniqueId`，调 `get_flow` 拉取流程单详情
2. **Stage 4A**：调用 `list_page_structure` / `get_page_structure` / `list_event_node` 校验页面/事件存在性

### 4.2 方案来源

代码生成**不重新设计事件**，事件名/参数直接从 Stage 5A 的方案 md 中读取：

- 事件名（`event_code`）
- 页面 ID（`dt_pgid`）
- 元素 ID（`dt_eid`）
- 私有参数（`udf_kv`）

> ⚠️ **不再使用 v1 的 `get_dt_tracking_info`（埋点信息码 Datong_XXXX）路径**。
> 流程单 URL 解析规则详见 `references/mcp-tools.md` §「`get_page_structure` 参数说明」。

---

## 5. 扫描项目已有的上报代码

扫描项目源码，查找已有的大同 SDK 调用：

**H5 项目**：
- 搜索 `UniversalReport`、`BeaconAction`、`AutoTrackBeacon` 等关键词

**Android 项目（灯塔上报 SDK）**：
- 搜索 `BeaconReport`、`BeaconEvent`、`BeaconConfig` 等关键词

**Android 项目（采集 SDK）**：
- 搜索 `VideoReport`、`DTReportComponent`、`setPageId`、`setElementId` 等关键词

**通用**：
- 查看是否有用户自己封装的统一上报工具函数/类
- 若业务使用 sdk， 可以参考 sdk 目录下相应 sdk 的文档

---

## 6. 代码生成原则

1. **事件名和参数必须与方案文档中的定义完全匹配**
2. **保持项目代码风格一致**：观察封装方法签名、参数传递方式、文件组织方式
3. **生成的代码应与现有代码融为一体**
4. **重要：已有的埋点代码不要去修改，除非用户明确调整**（原因：原本埋的 pageId/elementId 改了会影响历史数据）
5. **新增代码与已有代码共存**：A 路径只追加本次流程单涉及的事件，不动历史

---

## 7. SDK 选择

根据前面步骤识别的技术栈，选择对应平台的默认 SDK：

| 技术栈 | 默认 SDK | 上报方式 | 文档路径 |
|--------|---------|---------|----------|
| H5 | universal-report | 声明式埋点（标签）+ 手动埋点 | `../sdk/h5/universal-report/quickstart.md` |
| Android | beacon | 手动埋点 | `../sdk/android/beacon/quickstart.md` |
| iOS | beacon | 手动埋点 | `../sdk/ios/beacon/quickstart.md` |

> ⚠️ H5 端默认使用 **universal-report**，优先采用声明式标签埋点（`dt-pgid`、`dt-eid`、`dt-params`），与页面和元素无关联的事件使用手动埋点 API（`reportEvent`）。仅在用户明确指定时才使用其他 SDK（如 `beacon-web-sdk`、`autotrack`）。

---

## 8. 各类 SDK 的代码生成细节

### 8.1 H5 端：universal-report（默认）

加载 `../sdk/h5/universal-report/quickstart.md` 获取 SDK 使用方法。

**声明式标签埋点**（页面和元素事件）：

页面级和元素级事件**默认使用声明式标签埋点**，在 HTML/模板中添加 `dt-` 属性：

- **页面埋点**：在页面根元素添加 `dt-pgid` + `dt-params`
  - SDK 自动上报 `dt_pgin`（页面曝光）和 `dt_pgout`（页面结束曝光）
- **元素埋点**：在元素上添加 `dt-eid` + `dt-params`
  - SDK 自动上报 `dt_imp`（元素曝光）、`dt_clck`（元素点击）、`dt_imp_end`（元素退出）
- **组件埋点**：在组件上添加 `dt-eid` + `dt-params`
  - SDK 自动上报 `dt_imp`（元素曝光）、`dt_clck`（元素点击）、`dt_imp_end`（元素退出）

**手动埋点 API**（独立业务事件）：

当用户明确使用手动上报, 那些与页面和元素**无直接关联的独立业务事件**（如 `open_hongbag`、`watch_author` 等具有实际业务场景自定义事件）时，才使用 `reporter.reportEvent()` 手动上报。
非必要时，不要使用手动上报，走声明式标签埋点。

### 8.2 Android / iOS 端：beacon（默认）

- Android：加载 `../sdk/android/beacon/quickstart.md`
- iOS：加载 `../sdk/ios/beacon/quickstart.md`

使用 beacon SDK 的手动上报 API 完成所有事件的上报。

---

## 9. 代码产出结构

```
src/tracking/
├── reporter.ts / reporter.js   # SDK 初始化封装
├── index.ts / index.js         # 统一导出
```

1. **SDK 初始化封装**：创建 `reporter.ts`（初始化 universal-report / beacon）
2. **统一导出**：创建 `index.ts`
3. **入口初始化**：在 `main.ts` 中添加初始化调用
4. **页面/组件插桩**：为页面和元素添加声明式标签（H5）或手动上报调用（Android/iOS）

> ⚠️ A 路径只追加本次流程单涉及的页面/元素事件，**不修改**已有的页面/元素代码。

---

## 10. A 路径 vs B 路径的代码生成差异

| 维度 | A 路径（流程单） | B 路径（从零开始） |
|------|------------------|---------------------|
| 事件来源 | 流程单已审批的变更（Stage 5A 方案） | Stage 3B 指标 → Stage 4B 反推 |
| 设计空间 | **无**（变更已确定） | **有**（指标驱动，自由设计） |
| 已有代码 | 保留不动，**只追加** | 可能有，引导用户决策 |
| custom-specs 必含项 | 事件命名 / 必选公参 | 指标规范 / 事件命名 / 必选公参 / 必选指标 |
| code_dir 产物 | `{slug}-code-YYYYMMDDHH/` 增量文件 | `{slug}-code-YYYYMMDDHH/` 完整初始化 |
| 后续阶段 | Stage 8A 落盘 → Stage 9A 导入 mcp → Stage 10A 联调 | Stage 6B 落盘 → Stage 7B 导入 → Stage 8B 链路 → Stage 9B 看板 → Stage 10B 联调 |

---

## 11. Checklist 4 维度（强校验）

每步结束，AI 在内心跑一遍：

| 维度 | 内容 |
|------|------|
| **必读项** | 已读 `custom-styles/` + Stage 5A 方案 md + 上一份产物（state.json 指向） |
| **必产物** | `src/tracking/reporter.{ts,js}` + `src/tracking/index.{ts,js}` + 页面/组件插桩（如新增） |
| **必上报** | `code_generated` 事件（含 `path_type=A`） |
| **必校验** | 事件名/参数与方案文档完全匹配；项目代码风格一致；已有代码未修改 |

**自检失败的处理**：

```
Step 自检失败
  ↓
停下汇报："Step 未通过：缺少必产物 {产物路径}"
  ↓
询问用户：补做 / 跳过 / 重做
  ↓
不进入 Step 下一步
```

> 强校验**不是阻塞用户**，而是让 Agent 不能"假装做完"。

---

## 12. 状态文件更新

代码生成完成后，**必须**更新 `state.json`：

```json
{
  "current_stage": "stage7a_codegen",
  "current_step": "code_generated",
  "completed_stages": ["stage0_plan", "stage1_mcp", "stage2_sdk", "stage3a_flow_parse", "stage4a_validate", "stage5a_plan", "stage6a_events_json"],
  "completed_steps": [..., "code_generated"],
  "artifacts": {
    "code_dir": "{项目根}/dt_tracking_plan/{slug}-code-YYYYMMDDHH/"
  }
}
```

> 📖 state.json 完整 schema、断点续跑逻辑 → `SKILL.md` §「状态文件」章节
