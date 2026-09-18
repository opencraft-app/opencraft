## goal

建设 OpenCraft 统一 UI Preferences 基础设施，并将 Applications Pin/导航几何从组件直写 localStorage 迁移到 installation-scoped 异步 Runtime。

## non_goals

- 不伪造 account/workspace 服务端 Preferences API。
- 不持久化 peek、hover、拖动投影或动画状态。
- 不改变 Electron 的随机 loopback 静态服务；Electron installation 使用 Main profile SQLite，Web 使用 IndexedDB。

## requirement_refs

- 用户确认统一 `UiPreferencesRuntime`，按 key definition.scope 路由 installation/account/workspace，并要求先写入 `AGENTS.md` 后建设。

## interface_refs

- `UiPreferenceDefinition`: key、scope、parser、defaultValue。
- `UiPreferenceStore`: load、compareAndSet、subscribe、close。
- `UiPreferencesRuntime`: get、set、reset、subscribe、snapshot。
- `shell.applicationsPinned`: installation scope，默认 false；`shell.contextSidebarWidth` 保存左侧上下文栏宽度。

## history_context

- `ref/bb@62fe3bc` 使用 typed key registry、SQLite `ui_preferences`、revision/CAS、Query/Jotai sync 和 legacy localStorage migration。
- OpenCraft 当前 Shell Navigation 直接写 `opencraft.shell-navigation.v2` 与 width v3；SidebarLayout 已有独立 IndexedDB store。

## acceptance

- UI 组件不再直接读写 Shell Navigation localStorage。
- Web 从 IndexedDB、Electron 从 Main SQLite 通过同一 Runtime 恢复 Pin、account pin、detent、last-visible detent、navigation width 与 context sidebar width。
- Applications 缺省不 Pin；旧 `applications: true` 不迁移为用户选择。
- 快速写入、CAS 冲突、非法值、跨上下文通知和旧偏好迁移有聚焦测试。
- account/workspace scope 缺少 adapter 时显式失败。

## affected_paths

- `opencraft/packages/ui-preferences/`
- `opencraft/apps/workbench-web/src/runtime/`、`opencraft/apps/workbench-electron/src/`
- Shell Navigation、Workbench Runtime、测试与正式设计文档。

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `ref/bb/packages/domain/src/ui-preferences.ts` | typed registry 参考 | key/schema/default |
| `ref/bb/packages/db/src/data/ui-preferences.ts` | CAS 参考 | revision 语义 |
| `ref/bb/apps/app/src/lib/ui-preferences/ui-preferences-sync.ts` | 客户端同步参考 | optimistic/retry/migration |
| `opencraft/packages/workbench-runtime/src/shell-navigation.ts` | 当前状态 owner | 默认值与 reducer |
| `opencraft/apps/workbench-web/src/components/shell-navigation/index.tsx` | 当前 persistence adapter | 移除 direct localStorage |

## evidence

- 新增 `@opencraft/ui-preferences` typed registry、统一 Runtime、revision/CAS store contract 与 Memory test adapter；第一批 key 覆盖 Applications/Account Pin、detent、last-visible detent 和 width。
- Web installation adapter 使用 IndexedDB transaction + BroadcastChannel；Electron 使用 Main-owned `opencraft-ui.sqlite`、严格 key allowlist、64 KiB JSON 上限、CAS transaction 与 preload change event。
- Workbench bootstrap 在挂载真实 Shell 前完成 Runtime open 和旧偏好迁移；Shell Navigation 已移除 direct localStorage 读写。旧 `applications: true` 明确忽略，其余可辨认偏好迁移后删除旧 key。
- 聚焦 Runtime/IndexedDB/Desktop SQLite/Shell 测试 34/34，通过三个相关 workspace typecheck、平台边界和 Electron build。
- 真实 Electron fresh profile：首次 `aria-pressed=false` 且无 legacy localStorage；点击后 SQLite 行为 `shell.applicationsPinned|true|1`；同一 profile 在随机端口变化后重启恢复 `aria-pressed=true`，证明 authority 不依赖 Renderer origin。
- 左侧上下文侧栏端到端：fresh profile 初始 `275px`，写入后布局 token 即时变为 `360px`，SQLite 为 `shell.contextSidebarWidth|360|1`；随机端口变化后重启仍恢复 `360px`，旧 `sidebar-width` localStorage 为空。
- 完整 `test:workbench:unit` 的本任务用例全部通过；套件仍被并行 management-navigation 改动留下的 `workbench-window-chrome.test.ts` 旧源码表达式断言阻断，本任务未覆盖该 owner。

## risks

- 异步恢复可能引发布局跳动；Workbench bootstrap 必须在挂载真实 Shell 前完成 Runtime open/migration。
- Electron Renderer origin 的随机端口会隔离 IndexedDB；不得把单次进程内成功误判为跨重启持久化。
- 旧默认 true 与用户显式 pin 无法区分；按产品决定重置 Applications 为 false，只迁移其他可辨认值。

## validation

- Runtime/IndexedDB/migration 聚焦测试、Shell Navigation 测试、相关 workspace typecheck、边界检查、Electron/Web build 与预览重启。

## decisions

- scope 表示 preference subject，不表示数据库位置。
- installation 是第一期唯一启用的 authority；Web/Electron 使用不同物理 adapter，account/workspace 保留接口扩展点。

## handoff

- installation 基础设施与 Shell 首个消费者完成并通过真实重启验收；account/workspace adapter 尚未实现。未提交、未发布。
