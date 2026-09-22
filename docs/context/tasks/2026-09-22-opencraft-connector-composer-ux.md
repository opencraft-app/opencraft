## goal
把 Composer 的连接器入口改为 WorkBuddy 式渐进披露：`+` 菜单负责发现，已选连接器显示图标 Chip，紧凑 Popover 负责会话级连接与选择，完整配置留在管理页。

## non_goals
- 不改变 ConnectorRuntime、ConnectorCapabilityRuntime、凭据、OAuth 或写审批协议。
- 不把完整目录、安装、删除、Token 表单塞进 Composer Popover。
- 不复制 WorkBuddy 的自定义菜单 primitive、硬编码色板或用户账号语义。
- 不提交、推送、安装或发布。

## requirement_ids / requirement_refs / requirement_excerpt
- `user-2026-09-22-connector-composer-ux`：当前只有“连接器”文字且宽 Modal 体验异常；用户认可“未启用进入 + 菜单、启用后图标 Chip、点击紧凑 Popover”的视觉稿并要求实施。

## interface_refs / data_structure_refs
- `ConnectorManager`：连接、授权、保存选择和 View owner 取消的唯一协调者。
- `ManagedConnectorController`：托管连接器实例与 Host notification owner。
- `ConnectorConfiguration`：用户连接与会话选择意图，不含凭据或运行时 handle。
- `CodexComposer`：只增加 Host-owned Add 菜单槽位，不取得 Connector 领域状态。

## history_context
- `current_design_refs`：`opencraft/docs/platform-connectors.md`、`opencraft/design/connector-tool-discovery.md`。
- `relevant_evolution`：当前 `useConnectorPresentation` 用一个临时 Modal owner 同时承载快速选择和连接操作，关闭 Modal 会 `cancelOwner`；WorkBuddy 使用 Add submenu、active Connector chip 和独立管理页。
- `superseded_refs`：Composer 中孤立文字按钮与会话选择宽 Modal。

## acceptance
- 未确认连接器时 Composer 不显示孤立“连接器”文字；`+` 菜单包含“连接器”子菜单。
- 当前会话确认一个或多个连接器后，Composer 显示最多三个图标与溢出数量。
- Add submenu 与 Chip Popover 使用同一 32px 行列表，展示连接、选择、授权、处理中、取消和错误状态。
- Popover 关闭不取消连接；显式取消或会话 Scope 销毁才取消 owner 操作。
- “管理连接器”位于 Popover footer，进入现有连接器管理页。
- OAuth/Token 配置和一次写审批继续使用原有阻断式界面。
- 浅色、深色、窄窗口、键盘、焦点恢复和真实 ConnectorManager 状态转换通过。

## affected_paths
- `opencraft/packages/codex-composer/src/codex-composer.tsx`
- `opencraft/apps/workbench-web/src/app.tsx`
- `opencraft/apps/workbench-web/src/components/new-thread-draft-page.tsx`
- `opencraft/apps/workbench-web/src/components/connectors/connector-panel.tsx`
- `opencraft/apps/workbench-web/src/components/connectors/connector-quick-picker.tsx`
- `opencraft/apps/workbench-web/src/components/connectors/connector-panel.scss`
- `opencraft/apps/workbench-web/src/i18n/locales/zh-CN.json`
- `opencraft/scripts/fixtures/connector-controls.tsx`
- `opencraft/scripts/smoke-connector-controls.ts`
- `opencraft/scripts/smoke-connector-desktop.ts`
- `opencraft/tests/platform-connectors-presentation.test.ts`
- `opencraft/docs/platform-connectors.md`

## required_context
- Context Router 无匹配 Pack，执行了有界精确搜索。
- OpenCraft maintenance、Baseline UI、Accessibility 与 Better Icons。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@working-tree` | 根仓授权和验证边界 | 保留 dirty worktree，不隐含提交发布 |
| `opencraft/AGENTS.md@working-tree` | Radix、主题、状态与真实呈现约束 | 决定 primitive、owner 和验收范围 |
| `opencraft/docs/platform-connectors.md@working-tree` | Connector 正式所有权 | 保持连接/选择/审批真源 |
| `opencraft/design/connector-tool-discovery.md@working-tree` | Capability 与 ConnectorRuntime 分层 | 防止 Composer 持有执行能力 |
| `ref/wb/.../add-menu/connector/index.tsx@recovered` | Add submenu 参考 | 借鉴行密度、状态和管理 footer |
| `ref/wb/.../status-chips/connector-chip.tsx@recovered` | Active chip 参考 | 借鉴图标堆叠和紧凑 Popover |

## evidence
- `smoke:connector-controls` 使用真实 CodexComposer、ConnectorManager、ConnectorRuntime、AppServer WebSocket 和隔离 OAuth 服务通过：Add submenu、Popover 关闭不取消 Scope owner、授权、确认连接、会话选择、Active Chip、写审批一次性语义、刷新后仅恢复意图、缓存授权免二次登录均通过；`writes=1`、`logins=1`。
- 可见证据：`/tmp/opencraft-connector-controls/add-menu-light.png`、`connected-light.png`、`connector-popover-dark-narrow.png`、`write-approval.png`。
- Connector 32 项、Chat 410 项、presentation/root 聚焦 3 项通过；CodexComposer 与 Workbench Web typecheck、i18n 99 条、平台边界、Web 构建和 `git diff --check` 通过。
- Electron 渲染器、Main、Preload、daemon 全量构建通过；`smoke:connector-desktop` 在隔离 profile 中通过，证明新任务 Composer 的 `+ -> 连接器` 子菜单、Main/Preload CAS 持久化和进程重启恢复；默认 `local-codex` Host 不支持托管凭据时显示能力降级说明。
- Smoke 的 Vite 开发客户端在视口/浮层重排时报告既有 `ResizeObserver loop completed with undelivered notifications`，未进入 `pageerror`，产品交互断言与生产构建均通过。

## risks
- 浮层 owner 与连接 owner 若继续绑定，关闭 Popover 会意外取消授权/连接。
- 托管实例、原生 MCP 配置和会话 selection 是不同身份，列表合并必须保留稳定 key。
- Add submenu 与 active Chip 同时挂载时不得启动两份连接操作或重排行。
- Embedded Workbench 禁用 connectorLauncher 时不得泄露 Add 菜单入口。

## validation
- `npm run typecheck --workspace @opencraft/codex-composer`
- `npm run typecheck --workspace @opencraft/workbench-web`
- `npx tsx --test tests/platform-connectors*.test.ts tests/embedded-workbench-presentation-root.test.ts`
- `npm run smoke:connector-controls`
- `npm run test:connectors`
- `npm run test:chat`
- `npm run check:boundaries`
- `npm run build:web`
- `npm run build:electron`
- `npm run smoke:connector-desktop`

## decisions
- 使用项目现有 Radix DropdownMenu + Popover，不复制 WorkBuddy primitive。
- 使用 Lucide `Plug`/`ExternalLink`，不引入新图标库。
- `+` 菜单槽位是 Web Composer 的 Host-owned presentation seam，不成为公开 Extension ABI。
- 连接 owner 绑定 `(hostId, scopeId)`，只在 Scope 退出或显式取消时回收。

## scan_scope
- 当前 Connector Composer presentation、ConnectorManager、CodexComposer footer、聚焦 smoke；`ref/wb` 仅限 add menu、connector chip/provider。

## scan_output
- 当前真实桌面确认孤立文字按钮、宽 Modal、重复标题和空白；WorkBuddy 当前实现确认 Add submenu、最多三图标 Chip、240px Popover、稳定顺序与管理 footer。

## handoff
- 实现与验证完成：旧会话选择宽 Modal 已从运行路径和源码删除；新任务与已有会话共用 Add submenu、Active Chip、Quick Popover 与 Scope-owned operation。
- 未打包、安装、提交、推送或发布；正在运行的旧 OpenCraft 窗口不会热更新。
