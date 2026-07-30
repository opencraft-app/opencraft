# MCP 工具接口说明

> **v2 改造**：删除「埋点信息码（`Datong_XXXX`）」路径（`get_dt_tracking_info` 不再使用），删除「埋点方案上传 md」路径（`upload_tracking_plan` 不再使用），导入统一走 `import_tracking_data`。
> B 路径（从零开始）和 A 路径（流程单）共用同一套 MCP 工具。

本项目提供 6 个可用的 MCP 工具接口，分布在两个 MCP 服务上，详细参数和返回说明由各工具接口自身返回。

## 工具列表

| 工具名 | 用途 | Python 脚本兜底 |
|--------|------|:-------------:|
| `import_tracking_data` | 导入埋点方案到 mcp（md → JSON → mcp） | ❌ 不支持 |
| `get_flow` | 拉取大同流程单详情（A 路径核心） | ❌ 不支持 |
| `list_page_structure` | 列出流程单绑定的页面（A 路径校验） | ❌ 不支持 |
| `get_page_structure` | 根据 appId + pageId 获取页面结构信息（支持大同标准版 URL 自动解析） | ❌ 不支持  |
| `list_event_node` | 列出流程单的事件配置信息（A 路径校验） | ❌ 不支持 |
| `start_realtime_debug_mode` | 生成或检查 debugId，开启大同实时联调 | ✅ 支持 |
| `get_by_appkey` | 通过 appkey 获取对应的 appId | ❌ 不支持 |
| `create_app` | 注册大同应用，获取 appkey | ❌ 不支持 |
| `init_app` | 初始化应用（必须在 create_app / get_by_appkey 之后调用） | ❌ 不支持 |
| `query_starrocks_export_status` | 检测应用链路是否 ready（B 路径 Stage 8B） | ❌ 不支持 |
| `finish_appkey_access` | 标记 appkey 业务完成接入（B 路径 Stage 8B 末尾） | ❌ 不支持 |
| `create_dola_conversation` | 创建看板对话（B 路径 Stage 9B） | ❌ 不支持 |

## 重要
mcp调用时，会先检查是否配置了 大同MCP 服务，并调用相应的工具接口。
注意了，仅：`start_realtime_debug_mode` 走 python脚本调用，其他都是走 配置的MCP 调用。


### 调用前检测逻辑

当需要调用 `get_by_appkey` 或 `create_app` 时，先尝试直接调用：

- **调用成功** → 正常使用，无需额外操作
- **调用失败（工具不存在 / 401 未授权）** → 说明用户尚未配置该 MCP 服务，执行以下引导：

### 引导用户配置

向用户发送以下提示：

```
⚠️ 需要配置大同 MCP 服务才能使用此功能。

请在 CodeBuddy 中添加 MCP 服务：
1. 打开 CodeBuddy 设置 → MCP 配置（用户级别）
2. 添加新的 MCP 服务，配置填写：
"大同MCP": { url: "https://datong.mcp.it.woa.com" }

3. 添加后会自动拉起 OAuth 授权页面，完成授权即可
4. 授权完成后，请告诉我"已配置好"，我会重试操作
```

### Fallback 策略

如果用户不想配置 MCP 或配置后仍失败：

| 工具 | Fallback 方式 |
|------|-------------|
| `get_by_appkey` | 提示用户前往 [trackmate.woa.com](https://trackmate.woa.com) 查询 appId，或手动提供 |
| `create_app` | 使用占位符 `YOUR_APPKEY` 继续流程，提示用户前往 [trackmate.woa.com](https://trackmate.woa.com) 手动注册应用 |

### `get_page_structure` 参数说明

| 参数 | 必填 | 类型 | 说明 |
|------|------|------|------|
| `appId` | ✅ | string | 大同应用 ID |
| `pageId` | ✅ | integer | 页面 ID |
| `structureUniqueId` | ❌ | string | 多页面结构 ID。页面有多种情况（多页面结构）时，传入对应情况的 uniqueId |
| `versionId` | ❌ | integer | 需求单 ID（对应大同 URL 中的 `flowId`），默认取最新需求单 |
| `changeOnly` | ❌ | boolean | 仅返回变更内容，不传代表不过滤 |

**从大同平台 URL 中提取参数**：

用户在使用大同标准版时，经常直接粘贴平台 URL 而非手动输入参数。URL 格式示例：

```
https://datong.woa.com/#/d/devtest/develop/detail/view/element-event?appId=RUiWu5Po&menuN=RepDev&flowId=55073&taskId=3Dc2HrSX
```

参数映射：

| URL 参数 | 工具参数 | 说明 |
|---------|---------|------|
| `appId` | `appId` | 大同应用 ID |
| `pageId` | `pageId` | 页面 ID（URL 中可能存在） |
| `flowId` | `versionId` | 需求单号 |
| `strucUniqueId` | `structureUniqueId` | 多页面结构 ID（URL 中可能存在） |

> ⚠️ URL 路径中 `/#/d/{appId}/` 的 appId 与 query 参数中的 `appId` 相同，优先使用 query 参数中的值。
> 如果 URL 中没有 `pageId`，需要询问用户提供。

### `start_realtime_debug_mode` 参数说明

| 参数 | 必填 | 说明 |
|------|------|------|
| `appId` | ✅ | 应用在大同平台的唯一标识 |
| `appkey` | ✅ | SDK 初始化使用的应用密钥 |
| `existingDebugId` | ❌ | 用户项目中已存在的 debugId（如有） |
| `source` | ❌ | 用户埋点信息的来源方式，影响联调链接的选择 |
| `sdkType` | ❌ | 用户项目使用的 SDK 类型，影响生成的配置代码 |

**`source` 取值规则**：
- `datong`：用户通过 `get_flow` / `list_page_structure` / `get_page_structure` 获取的埋点信息（A 路径） → 使用 **datong** 联调链接
- 未提供或无法确认 → 默认使用 **datong** 联调链接

**`sdkType` 取值规则**：
- `beacon`：轻量版 SDK（BeaconAction），debugId 和 appId 直接作为初始化参数传入
- `universal_report`：标准版 SDK（@tencent/universal-report），debugId 和 appId 通过 `beaconOptions` 传入
- 未提供 → 默认使用 `beacon`（轻量版）

### `start_realtime_debug_mode` 独立使用说明

该工具可独立于完整的埋点接入流程使用。当用户直接要求"开启可视化联调"时，无需走完整主流程。

> 📖 详细执行步骤（SDK 检测、参数收集、source 推断）见 `realtime-debug.md`

### `get_by_appkey` 参数说明

| 参数 | 必填 | 类型 | 说明 |
|------|------|------|------|
| `appKey` | ✅ | string | SDK 初始化使用的应用密钥（即 appkey） |

**返回值**：`appId`（应用在大同平台的唯一标识）

> 属于大同测试网关，调用前需确认用户已配置（见上方"MCP 配置检测"章节）。
>
> 典型场景：Step 4 实时联调时，已有 appkey 但缺少 appId，用此工具自动转换，无需用户手动查询。

### `create_app` 参数说明

| 参数 | 必填 | 类型 | 说明 |
|------|------|------|------|
| `appName` | ✅ | string | 应用名称（建议使用项目名，如 package.json 的 name 字段） |
| `platform` | ✅ | string | 平台类型：`web`、`android`、`ios` |
| `description` | ❌ | string | 应用描述 |

> 属于大同测试网关，调用前需确认用户已配置（见上方"MCP 配置检测"章节）。
>
> 📖 完整的 appkey 检测与注册流程见 `app-registration.md`

### `import_tracking_data` 参数说明

> **v2 新增**。统一导入入口。B 路径 Stage 7B / A 路径 Stage 9A 调此工具。

| 参数 | 必填 | 类型 | 说明 |
|------|------|------|------|
| `appId` | ✅ | string | 大同应用 ID |
| `events` | ✅ | array | 事件列表（JSON 数组，每个元素含 event_code / dt_pgid / dt_eid / udf_kv 等字段） |

**events 数组结构**：

```json
[
  {
    "event_code": "dt_pgin",
    "event_name": "页面曝光",
    "dt_pgid": "home",
    "dt_eid": "",
    "trigger": "路由进入页面时",
    "udf_kv": [
      {"key": "page_name", "desc": "页面名称标识"}
    ]
  },
  {
    "event_code": "dt_clck",
    "event_name": "元素点击",
    "dt_pgid": "home",
    "dt_eid": "count_btn",
    "trigger": "点击计数按钮时",
    "udf_kv": [
      {"key": "count", "desc": "当前点击次数"}
    ]
  }
]
```

**使用时机**：
- B 路径 Stage 7B：方案 md 生成后 → 转 events.json → 调 `import_tracking_data` 导入
- A 路径 Stage 9A：方案 md 生成后 → 转 events.json → 调 `import_tracking_data` 导入

> ⚠️ 调用前**先**将 md 解析为 events JSON（落盘到 `dt_tracking_plan/{slug}-events-YYYYMMDDHH.json`），**不直接传 md 字符串**。
> ⚠️ 内容数据过多时可分批导入。
> ⚠️ 报错时根据 `err_details` 调整数据，**重试 3 次**仍失败则阻断流程，提示用户联系大同小秘。

### `get_flow` 参数说明（A 路径核心）

> **v2 新增**。A 路径 Stage 3A 调此工具拉取流程单详情。

| 参数 | 必填 | 类型 | 说明 |
|------|------|------|------|
| `appId` | ✅ | string | 大同应用 ID |
| `flowId` | ✅ | string | 流程单 ID（对应大同 URL 中的 `flowId`） |

**返回值**：包含流程单绑定的页面列表、事件变更、自定义参数变更等。

**使用时机**：A 路径 Stage 3A 解析 URL/flowId 后立即调用。

### `list_page_structure` 参数说明（A 路径校验）

> **v2 新增**。A 路径 Stage 4A 在 URL 中没有 `pageId`（流程单绑定多个 page）时使用。

| 参数 | 必填 | 类型 | 说明 |
|------|------|------|------|
| `appId` | ✅ | string | 大同应用 ID |
| `flowId` | ✅ | string | 流程单 ID |

**返回值**：该流程单绑定的所有 page 列表（含 pageId、pageName 等）。

**使用时机**：A 路径 Stage 4A，逐页面校验存在性。

### `list_event_node` 参数说明（A 路径校验）

> **v2 新增**。A 路径 Stage 4A 校验自定义事件时使用。

| 参数 | 必填 | 类型 | 说明 |
|------|------|------|------|
| `appId` | ✅ | string | 大同应用 ID |
| `flowId` | ✅ | string | 流程单 ID |
| `changeOnly` | ❌ | boolean | 仅返回变更事件，默认 true |

**返回值**：该流程单新增/修改/删除的事件清单。

**使用时机**：A 路径 Stage 4A，自定义事件变更校验。

### `init_app` 参数说明

| 参数 | 必填 | 类型 | 说明 |
|------|------|------|------|
| `appId` | ✅ | string | 大同应用 ID |
| `templateId` | ✅ | integer | **固定传 0** |

**MANDATORY**：无论通过 `create_app` 还是 `get_by_appkey` 获取到 appId，**都必须在最后调用 `init_app(appId, templateId=0)` 初始化应用**，否则后续步骤（埋点方案导入、链路检测、看板创建）将无法正常工作。

### `query_starrocks_export_status` 参数说明（B 路径链路检测）

> **v2 新增**。B 路径 Stage 8B 调此工具检测应用链路是否 ready。

| 参数 | 必填 | 类型 | 说明 |
|------|------|------|------|
| `appId` | ✅ | string | 大同应用 ID |

**判断标准**：返回结果中 `status` 字段为 `running` 才算链路真正 ready，其他状态（`pending` / `failed` / 空字符串 / 无值）均视为未 ready。

### `finish_appkey_access` 参数说明（B 路径接入收尾）

> **v2 新增**。B 路径 Stage 8B 末尾调此工具标记该 appkey 业务完成接入。

| 参数 | 必填 | 类型 | 说明 |
|------|------|------|------|
| `appId` | ✅ | string | 大同应用 ID |
| `appkey` | ✅ | string | SDK 应用密钥 |

**使用时机**：B 路径 Stage 8B 样例数据上报成功后调用。

### `create_dola_conversation` 参数说明（B 路径看板生成）

> **v2 新增**。B 路径 Stage 9B 调此工具创建看板对话。

| 参数 | 必填 | 类型 | 说明 |
|------|------|------|------|
| `prompt` | ✅ | string | 看板 Prompt 完整内容（从 `dt_tracking_plan/{slug}-prompt-YYYYMMDDHH.md` 读取） |

**返回值**：包含 `chatUrl`（看板创建进度链接），**必须完整透出给用户**。

## 调用方式

### 方式一：MCP 工具直接调用（优先）

如果用户项目已配置 MCP，直接使用工具名调用即可。

### 方式二：Python 脚本调用（兜底）

仅限**支持 py 脚本兜底**的工具（见上方工具列表）。如果 MCP 工具调用失败，使用 `scripts/mcp-caller.py` 脚本调用。

```bash
python scripts/mcp-caller.py list
python scripts/mcp-caller.py get_page_structure --appId xxx --pageId 123
python scripts/mcp-caller.py start_realtime_debug_mode --appId xxx --appkey xxx
```

> 脚本使用纯标准库（`urllib`），无需安装额外依赖。

### 判断使用哪种方式

1. 先尝试直接调用 MCP 工具
2. 如果工具不存在或调用失败 → 检查该工具是否支持 py 脚本兜底
   - 支持 → 改用 Python 脚本方式通过终端调用，脚本返回的数据格式与 MCP 工具一致
   - 不支持（如 `get_by_appkey`、`create_app` 等） → 执行上方"MCP 配置检测"章节的引导 / Fallback 策略
