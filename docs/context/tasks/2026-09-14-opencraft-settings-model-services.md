---
id: opencraft-settings-model-services-2026-09-14
type: task
scope: Move local Model Services to Settings and remove the Environment application surface.
status: retired
owner: skipzhang
---

## goal
Settings 成为本机模型服务的唯一用户入口，Environment 应用界面及路由被移除。

## non_goals
- 不删除 Host/environment runtime、目录发现、模型配置仓库、凭据或 DSH 适配能力。
- 不改生产、发布、提交或推送。
- 不重做模型服务内部交互。

## requirement_ids / requirement_refs / requirement_excerpt
- 当前用户请求：“本机模型服务，放到设置吧。环境这个界面，整体删除。”

## interface_refs / data_structure_refs
- `ApplicationRoute`、`WorkbenchNavigation`、Settings extension contribution。
- 本机模型服务继续绑定不可变 local Host ID；不存在本机时不得回退到当前远端 Host。
- 页面移除不等于 Host/会话 runtime 销毁。

## history_context
- `current_design_refs`: `opencraft/docs/platform-architecture.md`, `opencraft/docs/local-agent-custom-providers.md`。
- `relevant_evolution`: 当前实现把 environment-owned Settings page 重定向到 Environment 父容器；本需求明确废弃该呈现。
- `superseded_refs`: Environment first-class application route 与父导航呈现。

## acceptance
- 应用栏不再显示“环境”。
- `/environments` 不再解析为 Environment 应用，历史 URL 安全落到 Settings 或中立页面。
- Settings 显示并打开“模型服务”，复用当前模型服务视图且绑定本机。
- connected 与 hostless Shell 行为一致；不存在本机时不显示模型服务。
- 聚焦测试、模型服务 smoke、跨 package gate 及独立桌面预览通过。

## affected_paths
- `opencraft/apps/workbench-web/src/app.tsx`
- `opencraft/apps/workbench-web/src/components/hostless-workbench.tsx`
- `opencraft/apps/workbench-web/src/components/settings-page.tsx`
- `opencraft/apps/workbench-web/src/runtime/workbench-navigation*.ts`
- Environment page/style imports and relevant tests/docs.

## required_context
- Route query had no matching pack; bounded exact search used.

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md`, `opencraft/AGENTS.md` | boundaries | Task Pack, gates, dirty-worktree care |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md` | OpenCraft maintenance | preserve runtime owner while removing View |
| `opencraft/.agents/skills/opencraft-maintenance/references/verification.md` | verification | model/settings/UI preview gates |
| `opencraft/docs/platform-architecture.md` | Shell/navigation authority | update superseded Environment presentation |
| `opencraft/docs/local-agent-custom-providers.md` | model authority | preserve Host-scoped service and storage |
| planning/graphify/baseline-ui/accessibility/React skills | execution discipline | bounded navigation implementation |

## evidence
- Focused package typechecks passed for Workbench Web, Extension Contract and Built-in Agents.
- Focused navigation/Settings/model/Shell tests passed 27/27; production residual scan and `git diff --check` passed.
- `smoke:model-services` passed against isolated AppServer/DSH and a local synthetic model endpoint; no external model request.
- Shared Sidebar browser smoke passed with Chat/Settings/account only across docked, floating, narrow and resize scenarios.
- Full `npm run gate` passed after correcting worktree-only dependency mappings; no failure markers, iOS bundle completed.
- Superseding local-worktree gate evidence: AppServer suite passed 150/151; the lone process-RPC replacement test consistently fails with the known macOS-only `posix_spawnp failed` before changed code. This is recorded, not counted as a pass.
- Final superseding evidence: after restoring the lockfile-installed `node-pty` helper's executable mode, the isolated process test and the complete current-worktree `npm run gate` pass. Model Services and Sidecar browser smokes pass again against local workspace links.
- Final Electron renderer/host build, isolated `mac-arm64` package and `codesign --verify --deep --strict` passed. CDP live result: Environment action `0`, Settings group `本机`, selected model entry `模型服务`, URL `/settings/vela.builtin-agents.model-services`, provider navigation visible.

## risks
- Dirty shared worktree; only exact affected hunks will be changed.
- Removing the View must not remove environment-directory service registrations used by Chat/account discovery.
- Old URLs and target-settings fallbacks must not reopen a deleted route.

## validation
- Focused navigation/settings/model tests, model-services smoke, `npm run gate`, documentation/change-impact checks, packaged Electron live UI.

## decisions
- Remove product surface, not domain runtime.
- Settings chooses only the real local profile for Model Services.

## scan_scope / scan_output
- Bounded exact search in workbench-web navigation, Settings container, builtin model contribution and relevant tests.
- `graphify-out/graph.json` absent; full mono2 graph generation skipped as disproportionate.

## handoff
- Complete. Final preview is open from `release/settings-model-services-b7de-final/mac-arm64/OpenCraft Preview.app`; no commit, push or production change performed.
