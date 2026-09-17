## goal

在 OpenCraft Settings 的内部开发者模式中提供应用自有 SQLite 的只读调试查看器。

## non_goals

- 不接受任意数据库路径或任意 SQL。
- 不修改、导入、导出、删除、VACUUM 或迁移数据。
- 不展示模型凭据、账户 session 或 Hermes 外部数据库。

## requirement_refs

- 用户：“设置里面增加一个：对于我们自己sqlite的读取能力，可以查看，不需要修改”；主要用于 Debug；明确禁止使用 graphify。

## interface_refs

- Electron Main 固定枚举当前 profile `dsh/` 下四个 OpenCraft SQLite。
- Preload 仅暴露 list/schema/rows 三种结构化读取；Renderer 不传 SQL 或文件路径。

## history_context

- `current_design_refs`: `opencraft/docs/platform-architecture.md`、`opencraft/docs/chat-ui-architecture.md`。
- `relevant_evolution`: local-agent-host 当前拥有 session routing、history index、thread catalog 与 execution authority 四个 SQLite。

## acceptance

- 入口仅在 Electron + 内部开发者模式显示。
- 固定数据库清单可查看存在性、大小、表；表结构与有限分页行可读。
- 非法数据库 ID、表名、分页输入均拒绝；数据库以 SQLite readonly 模式打开。
- UI 使用现有 Settings 组件和主题；有加载、空、错误状态及键盘可达控件。

## affected_paths

- `opencraft/apps/workbench-electron/src/`
- `opencraft/apps/workbench-web/src/components/` 与 Settings 样式
- 聚焦测试与正式设计文档。

## required_context

- Context router 无 Pack 命中；按 `opencraft/AGENTS.md` 与 OpenCraft maintenance Skill 执行。

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `opencraft/AGENTS.md` | 服务入口 | 平台边界与验证 |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md` | 维护约束 | 状态 owner 与预览纪律 |
| `opencraft/apps/local-agent-host/src/main.ts` | SQLite owner | 固定数据库清单 |
| `opencraft/apps/workbench-electron/src/main.ts`、`preload.ts` | 桌面可信边界 | 受限 IPC |
| `opencraft/apps/workbench-web/src/components/settings-page.tsx` | Settings owner | 内部开发者入口 |

## evidence

- 实施前精确搜索确认四个文件：`opencraft-session-routing.sqlite`、`opencraft-history-index.sqlite`、`opencraft-threads.sqlite`、`opencraft-executions.sqlite`。
- Main 新增固定清单 reader；非法数据库 ID、内部 `sqlite_schema`、SQL 注入式表名均由聚焦测试拒绝，Blob 仅显示字节数、长文本截断。Renderer 只接收结构化 list/tables/rows。
- `workbench-sqlite-debug.test.ts` 2/2、`test:workbench:unit` 233/233、受影响 Electron/Web 类型检查、平台边界与完整 `npm run gate` 通过；docs impact 通过。
- 独立预览构建在 `/tmp/opencraft-sqlite-debug-preview.i9HYoj/package/mac-arm64/OpenCraft SQLite Debug Preview.app`，Bundle ID `ai.lightvela.opencraft.preview.sqlitedebug.i9hyoj`，严格 codesign 通过，未覆盖标准 preview。
- 实际窗口用 5 次 Escape 开启内部开发者模式；Settings 显示四个数据库大小。Session routing 展示两张表；Execution authority 展示六张表及字段/行数；空页显示 0 rows 且 Previous/Next 禁用。没有 SQL、路径、编辑、导出入口。
- 后续按用户要求把同一 5×Escape 手势改为开关。`workbench-internal-developer-mode` 与 SQLite 聚焦用例 5/5、Web 类型检查、`test:workbench:unit` 234/234 通过。
- 新独立预览 `/tmp/opencraft-devmode-toggle-preview.mK9pq0/package/mac-arm64/OpenCraft Dev Toggle Preview.app` 中验证：第一次 5×Escape 显示 enabled 并出现 SQLite inspector；在 inspector 页面再次 5×Escape 显示 disabled，入口立即消失且路由从 `/settings/sqlite-debug` 返回 `/settings/appearance`。
- 用户进一步要求 Plugins 与 Laboratory 也只在开发者模式显示。最终预览 `/tmp/opencraft-dev-settings-preview.REhTcK/package/mac-arm64/OpenCraft Dev Settings Preview.app` 验证：普通模式 Settings 只显示 Appearance 和公开业务贡献页；开启后新增 Plugins、Laboratory、SQLite inspector 与内部 Connectors；在 Laboratory 页面关闭模式后四个内部入口同时消失并回到 `/settings/appearance`。

## risks

- 行内容可能包含用户文本；只在本机内部开发者模式展示，不写日志或遥测。
- 活跃数据库并发变化；每次读取打开短生命周期 readonly connection，不承诺跨页快照一致性。

## validation

- Main reader 聚焦测试、Settings SSR/结构测试、Electron/Web 类型检查、边界检查与完整 gate。
- `validate_documentation.py` 与 `validate_change_impact.py`。

## decisions

- 用户明确禁止 graphify；本任务只使用有界 `rg` 与直接源码检查。

## scan_scope

- Electron Main/Preload、local-agent-host SQLite owner、Settings 页面与相关测试。

## handoff

- 实现和独立预览验收完成；未提交、未发布。预览使用隔离 profile，只读取其新建的本地数据库，没有读取用户正式 profile 内容。

## checkpoint

### stage

实现与验收完成，等待用户决定是否提交。

### verified

- 固定 SQLite 范围、readonly/query_only、表与分页行读取、开发者模式入口、真实 Electron 预览。
- 开发者模式开启/关闭通知、sessionStorage 清理和内部路由回退。

### unverified

- 大数据量表的性能与用户正式 profile 中的真实复杂值；默认不读取该 profile 以保护数据。

### discard

- graphify 路径；用户明确禁止，本任务全程未使用。

### restore

- Task Pack、reader/IPC、Settings component、聚焦测试和独立预览路径。

### next_action

- 用户确认后提交本轮精确文件；提交前需与工作区其他未提交 OpenCraft 改动分离审查。
