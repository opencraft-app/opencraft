# TAPD 需求单格式与平台规则

> 本文件承载 TAPD 平台的硬知识（字段格式、MCP 调用方式、迭代分类）。`/feai-prd` 命令只引用本文件，不内联平台细节。

---

## workspace_id 取值规则

`workspace_id` 是 **8 位纯数字**（如 `10132091`），取自 TAPD 链接 `tapd_fe/` 之后的数字段：

```
https://tapd.woa.com/tapd_fe/{workspace_id}/story/detail/{story_id}
                              ↑ 8 位 workspace_id
```

> ⚠️ 不要把 `10` 前缀拼进 workspace_id。Story ID 是 19 位（`10` + 8 位 workspace_id + 短 ID），但 workspace_id 本身只有 8 位。
> 例：Story ID `1010132091136344769` → workspace_id 是 `10132091`（不是 `1010132091`）。

---

## MCP 调用方式

TAPD MCP 的业务工具（`stories_get` / `stories_create` / `get_stories_template_list` / `get_default_story_template` / `iterations_get` 等）**不能直接作为 toolName 调用**，会返回 `Tool not found`。必须通过元工具两步代理执行：

```
Step A: lookup_tool_param_schema({ tool_name })        → 获取参数 schema
Step B: proxy_execute_tool({ tool_name, tool_args })   → 实际执行
```

可用工具发现：`lookup_tool_param_schema` 的返回描述中包含全部可用工具列表。

MCP 连接配置见项目 `.codebuddy/mcp.json` 的 `mcpServers.tapd_mcp_http` 段（`url` + `headers.X-Tapd-Access-Token`）；文件缺失或仍为占位符时提示用户补配置，不猜测 Token。

---

## 标题命名规范

```
【需求类型】【业务名称】需求概览
```

| 段 | 取值 |
|---|---|
| 需求类型 | 产品需求 / 技术需求 / 运维需求 |
| 业务名称 | 项目简称，取自 `project.yaml` 的 `tapd.business_name` |
| 需求概览 | 一句话描述需求 |

示例：

- `【产品需求】【Lighthouse】LH 开启/关闭优选流量包提示文案修改`
- `【技术需求】【Lighthouse】LightClaw 小程序订阅消息`

---

## description 字段 Markdown 格式

TAPD 的 `description` 字段 `html_type` 为 `rich_edit`（富文本），**MCP 层面不支持切换 Markdown/富文本模式**，但传入的 Markdown 会被 TAPD 正确渲染。因此需求描述统一用 Markdown 产出，换行用 `\n`。

### 支持的 Markdown 元素

| 元素 | 语法 |
|---|---|
| 标题 | `#` ~ `######` |
| 有序/无序列表 | `1.` / `-` / `*` |
| 复选框列表 | `- [ ]` / `- [x]` |
| 表格 | `\| 列 \| 列 \|` |
| 引用块 | `>` |
| 代码标记 / 代码块 | `` `code` `` / ` ```lang ` |
| 流程图 | ` ```mermaid ` |
| 加粗 | `**bold**` |

### 推荐结构（需求阶段，不含技术方案）

```
## 1、需求背景
## 2、需求范围与影响（S/M/L 评级 + 一句话范围）
## 3、验收标准
- [ ] <可测试的验收项>
## 4、流程图（可选，mermaid）
```

约定：

- 验收标准统一用 `- [ ]` 复选框列表，便于评审勾选。
- 流程图优先用 mermaid；TAPD 前端如不支持渲染会显示为代码块，仍可读。
- **需求阶段不写技术方案**：第 2 段只写 S/M/L 评级 + 一句话影响范围（如「涉及 XX 模块」），不写「解决实现方案」、不改动文件清单、不写可复用组件、不写实现步骤。详细设计留给 `/feai-start` 的 shape 阶段。

---

## 迭代分类与选择规则

通过 `iterations_get` 拉取迭代列表（`status: "open"`，`order: "startdate desc"`）。

| 类型 | 命名特征 | 锁定状态 | 用途 |
|---|---|:---:|---|
| 需求池 | `xxx_需求池` | ❌ 未锁定 | **默认归属**，待排期需求暂存 |
| 按周迭代 | `xxx(YYYY/MM/DD-YYYY/MM/DD)` | ✅ 通常已锁定 | 已排期到具体周 |
| 父级分组 | `xxx`（无后缀） | — | 迭代分组，不直接归属需求 |

**默认策略**：需求默认关联对应模块的**需求池迭代**（未锁定），待人工排期时再移到具体周迭代。

**需求池匹配规则**（按顺序尝试）：

1. 读 `project.yaml` 的 `tapd.iteration_pools` 映射，按需求模块取对应需求池 ID。
2. 配置缺失时，用 `iterations_get({ name: "{模块名}_需求池" })` 模糊搜索。
3. 仍找不到则提示用户从列表手动选择或留空。

> ⚠️ 当前进行中的按周迭代通常被锁定（`lock_info` 非空，locker 锁定 `begin`/`due`）。`iteration_id` 字段未锁，仍可关联需求，但优先放需求池。用户选择已锁定迭代时提示 locker，不阻断。

---

## stories_create 参数规则

| 字段 | 是否显式传参 | 说明 |
|---|:---:|---|
| `workspace_id` | ✅ 必传 | 8 位纯数字 |
| `name` | ✅ 必传 | 按标题命名规范 |
| `description` | ✅ 建议传 | Markdown 字符串 |
| `templated_id` | ✅ 建议传 | 传则自动套用模板字段配置与默认值 |
| `priority_label` | ✅ 建议传 | `High` / `Middle` / `Low` |
| `iteration_id` | ✅ 建议传 | 默认需求池 ID；用户选"不关联"则不传 |
| `category_id` | 可省略 | 传 `templated_id` 自动套用 |
| `source` | ❌ **不可传** | schema 不含此字段，传了报错；由模板默认值自动填 |
| `custom_field_119`（产品评审状态） | ✅ 默认传 | 默认 `免评审`；可选值：待评审/评审中/已评审/免评审 |
| `custom_field_120`（合规评审状态） | ✅ 默认传 | 默认 `免评审`；可选值同上 |
| `custom_field_14`（是否需产品体验） | ✅ 默认传 | 技术需求=`否`，产品需求=`是` |
| `owner` | 按需 | 技术需求默认当前用户，产品需求留空 |

自定义字段名（`custom_field_xxx`）随 workspace 配置而变，落地前用 `tapd_fields_summary_get` + `tapd_field_detail_get` 确认当前 workspace 的实际字段名与可选值。

### 常见报错

| 报错 | 原因 | 处理 |
|---|---|---|
| `参数{field}不存在于工具stories_create的参数定义中` | 传了 schema 不支持的字段（如 `source`） | 移除该字段，改由 `templated_id` 套用默认值 |
| `Tool not found` | 直接调用业务工具 | 改用 `proxy_execute_tool` 两步代理 |
| workspace 不存在 | workspace_id 拼了 `10` 前缀 | 改为 8 位纯数字 |
