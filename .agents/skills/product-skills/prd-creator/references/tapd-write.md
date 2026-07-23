# TAPD Write Rules

读取时机：PRD 定稿后需要创建、更新、复用 TAPD 产品父单时读取本文件。

## 自动准备 TAPD 环境

PRD 定稿后立即进入这一步。原则：TAPD 环境准备全部由 AI 自动静默完成；在本阶段，唯一需要打扰用户的动作是索要 TAPD 个人 Token（仅当本地没有有效 Token 时才问）。后续工蜂鉴权与不可逆操作确认按 `mr-flow.md` 处理。

### 自动环境自检

- 检查 `mcporter-internal` 是否已安装（`mcporter-internal list` 能正常返回即视为已装）。未安装则静默执行下面的全局安装（`mcporter-internal` 是需要全局可执行的 CLI，此处使用 `-g` 是必要的例外）：

```bash
npm install -g @tencent/mcporter-internal --registry=https://mirrors.tencent.com/npm
```

- 检查 `.codebuddy/mcp.json` 是否存在且包含 `tapd_mcp_http` 配置。不存在则基于 `.codebuddy/mcp.json.example` 自动生成/合并，保留文件中已有的其他 MCP 配置（例如 `gongfeng_mcp_http`），不覆盖。
- 用一次只读接口探测当前 Token 是否可用（例如 `mcporter-internal call tapd.<只读接口>`）：
- 探测成功：本地已有有效 Token，直接进入固定字段步骤，不问用户。
- 探测失败（401 / unauthorized / token missing / token expired / permission denied）：进入 Token 索要步骤。

### 唯一需要打扰用户的动作：索要 TAPD 个人 Token

只有探测不到有效 Token 时才触发，话术示例：

> PRD 已经准备好了，我需要你的 TAPD 个人访问令牌才能直接建单。
> 获取地址：https://tapd.woa.com/platform/myhome?not_direct=1&from=mcp#tab=tab-mytoken
> 拿到后发给我，我会自动完成剩下所有配置和建单，不会再打扰你其他内容。

拿到 Token 后自动写入 `.codebuddy/mcp.json` 的 `mcpServers.tapd_mcp_http.headers["X-Tapd-Access-Token"]`，随后重新探测一次确认生效；仍失败则如实告知报错内容，不要假装成功。Token 只写入本地 `.codebuddy/mcp.json`（已在 `.gitignore` 中），不写入仓库文档、提交信息或除当前会话外的持久化位置。

## 固定字段

- `workspace_id` 固定为 `10132091`（LightVela / mono2 对应的 TAPD 项目），不再现场发现或询问。
- 分类固定使用名称为 `LightVela` 的分类：现场调用一次分类列表接口，按名称精确匹配得到 `category_id`（分类 ID 可能变化，只能硬编码名称去匹配，不能硬编码 ID）。找不到同名分类时不阻塞创建，省略 `category_id`，并在完成总结里注明"未找到 LightVela 分类"。
- 标题固定格式：`【产品需求】【LightVela】<产品需求标题>`。如果发布范围明确，标题可在 `LightVela` 后追加站点标识：`【国内站】`、`【国际站】`、`【双站】` 或 `【分阶段】`，例如 `【产品需求】【LightVela】【国际站】<产品需求标题>`。
- 状态仍需现场发现 backlog（待办）等价状态值，映射规则按概念状态执行，但不需要用户确认这次映射结果。

## 创建前最小展示

不再展示完整的"TAPD 写入计划"表格，只展示一行信息：

```markdown
即将创建 TAPD 单：【产品需求】【LightVela】<标题> ｜ 分类：LightVela ｜ 状态：<backlog 等价状态>
```

展示后直接创建，不等待用户回复确认。

## 描述字段必须写 HTML

TAPD 需求描述框是富文本编辑器，底层存储是 HTML，不是 Markdown 渲染引擎。即使工具参数提示"建议使用 Markdown 格式"，实际写入 `**加粗**`、`## 标题`、`- 列表` 这类 Markdown 语法都不会被解析，会原样把符号显示给用户。

因此，写入或更新 `description` 字段前，必须把产品输入稿从 Markdown 转成 HTML 标签后再提交，例如：

- 标题：`## 二、背景` -> `<h3>二、背景</h3>`
- 加粗：`**本次包含**` -> `<p><b>本次包含</b></p>`
- 列表：`- 要点` -> `<ul><li>要点</li></ul>`

禁止直接把带 `**`、`##`、`- ` 等 Markdown 符号的原始文本塞进 `description` 字段。仓库本地保存的 PRD 文件（`.md`）仍然可以是标准 Markdown，只有写入 TAPD 时才需要转成 HTML。

推荐创建产品父单 payload 模板：

```yaml
workspace_id: "10132091"
name: 【产品需求】【LightVela】<产品需求标题>
description: <产品输入稿 + 原型说明 + 待确认问题，转成 HTML 标签后写入，不要留 Markdown 符号>
with_v_status: "1"
v_status: <backlog 等价状态>
owner: <产品负责人或当前处理人>
creator: <当前处理人>
priority_label: <High|Middle|Low，按项目约定>
category_id: <按名称"LightVela"现场匹配得到的分类 ID，未匹配到则省略>
```

推荐更新父单 payload 模板：

```yaml
workspace_id: "10132091"
id: <产品父单 ID>
description: <更新后的产品输入稿、评审结论、产物交接建议、跳过原因，转成 HTML 标签后写入，不要留 Markdown 符号>
with_v_status: "1"
v_status: <目标状态：评审中 / 已通过 / 产品完成的等价状态>
```

## 创建或更新成功后主动发链接

调用创建/更新工具成功后，返回结果里通常带 `detail_link`（形如 `https://tapd.woa.com/tapd_fe/<workspace_id>/story/detail/<id>`）。这个链接必须在本轮回复中直接、主动地发给用户，不能只说"已创建成功"而不给链接，也不要等用户追问才给。至少包含一次可点击的完整 URL。

## 创建或复用产品父单

- 如果已有父单，先读取它的实际字段和状态，再从当前状态继续。
- 如果没有父单，PRD 定稿且 Token 可用后直接以 backlog（待办）等价状态创建，不需要用户对写入内容做二次确认（一行展示已经足够）。
- 父单描述保持为产品事实源：PRD、评审记录、产物交接建议和未解决问题都放在这里。
- PRD 和验收标准要写进需求描述里，不只留在聊天记录。
- 产品父单必须写明发布站点与同步策略；如果站点范围待确认，必须把“是否国际站同步发布”写入待确认问题。
- 描述字段必须是 HTML，不要把 Markdown 符号原样写进 `description`。
- 避免使用 `<value>` 这类占位包裹，它可能被 TAPD 富文本处理吞掉。
- 创建或更新调用成功后，从返回结果里取出 `detail_link`（或按 `https://tapd.woa.com/tapd_fe/<workspace_id>/story/detail/<id>` 拼出链接），在当前回复中直接发给用户，不要等用户问才给。
