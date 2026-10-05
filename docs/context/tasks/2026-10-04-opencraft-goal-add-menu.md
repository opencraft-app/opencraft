# Composer goal creation menu

## goal
将“设定持续目标”从独立胶囊入口移入输入框的“＋”菜单。

用户追加：删除会话菜单的“在 Codex 上新建任务”和“Codex 设置”入口，不删除能力；
授权替换当前预览，优先仅替换 Web，不重启执行宿主。

## non_goals
- 不更改目标协议、执行、预算或进度显示。
- 不提交或生产发布；新授权允许替换预览，但不扩展为重启执行宿主。
- 上一轮折叠滚动修复不属于本轮目标。

## requirement_refs / requirement_excerpt
- 本会话用户截图与“设定目标放到菜单里吧”，随后明确指“设定持续目标”按钮。

## interface_refs / data_structure_refs
- `ThreadGoalSurface` 提供创建菜单项与编辑弹窗；Goal resource 保持权威状态。
- `CodexComposer.addMenuContent` 使用既有菜单扩展槽，不新增菜单 owner。

## history_context
- current_design_refs: `opencraft/docs/chat-ui-architecture.md#thread-goals`
- relevant_evolution: 已有目标功能及独立按钮；此次仅迁移创建入口。
- superseded_refs: 无。

## acceptance
- 无目标可写会话通过“＋ → 设定持续目标”打开同一编辑弹窗。
- 外部胶囊和空白占位消失；附件/连接器入口不受影响。
- 创建、取消、已有目标、只读能力与会话切换通过真实组件浏览器测试。
- Web 类型检查、聚焦测试、影响文档检查通过。

## affected_paths
- `opencraft/apps/workbench-web/src/components/thread-goal-surface.tsx`
- `opencraft/apps/workbench-web/src/components/thread-management.tsx`
- `opencraft/apps/workbench-web/src/components/sidebar.tsx`
- `opencraft/tests/sidebar-activity.test.ts`
- `opencraft/scripts/smoke-thread-management.ts`
- `opencraft/apps/workbench-web/src/app.tsx`
- `opencraft/apps/workbench-web/src/styles/app.scss`
- `opencraft/scripts/smoke-thread-goal-ui.ts`
- `opencraft/docs/chat-ui-architecture.md`
- `opencraft/design/invariants.md`
- `opencraft/packages/codex-composer/src/codex-composer.tsx`
- `docs/engineering/domains/agent-gateway-runtime.md`

## required_context / context_receipt
- `AGENTS.md`, `opencraft/AGENTS.md`: 授权、组件所有权与验证边界。
- maintenance Skill 及 verification.md：复用标准菜单，验证实际呈现。
- `docs/context/tasks/TASK-TEMPLATE.md`: 任务记录。
- `opencraft/docs/chat-ui-architecture.md`: Goal 与 Composer 边界。
- `opencraft/design/invariants.md`: 布局与草稿连续性。
- `docs/engineering/domains/agent-gateway-runtime.md`: 映射设计的目标呈现/执行所有权。
- adjacency/frontend-runtime-openspec-i18n 卡已读；此任务不触及 frontend 真源，邻居检查选已有 `smoke-thread-goal-ui.ts` 与 Goal resource。
- Router 无匹配；初始 composer.tsx/composer/locales 路径查询失败，扩大到 Web src 与 codex-composer，定位真实入口。

## evidence / validation
- Web 与 Codex Composer 类型检查通过；Web Vite 构建通过，保留已有 chunk 大小和静态/动态导入警告。
- `node --import tsx --test tests/thread-goal-resource.test.ts tests/codex-composer-attachment-focus.test.ts tests/platform-connectors-presentation.test.ts tests/composer-core.test.ts`: 28/28 通过。
- `npm run check:boundaries`: 通过（含 typography）。
- `scripts/smoke-thread-goal-ui.ts`: 390px 触控 Chromium，浅/深主题通过；同一真实 Composer 与 Goal surface 验证菜单入口、取消不写入/保留输入草稿、键盘 End/Enter 创建一次、已有目标隐藏创建、只读/无 Thread 隐藏创建、换 Thread 关闭旧编辑并保持原编辑器 DOM。
- 最新浏览器隔离截图位于 `/data/opencraft-goal-ui-VL2dOw`，已查看 light-add-menu.png，中文标签正常且无外部胶囊占位。
- 菜单到弹窗原本存在退场 FocusScope 争用；改为 Radix close autofocus 生命周期完成后打开弹窗，移除固定延时/同帧争抢。早期失败包含 fixture 的 React/i18n 依赖预打包、隐藏辅助标题严格选择器、键盘未等菜单焦点就发送 End；修正后全部真实输入序列通过。
- `validate_change_impact.py` 对本轮显式变更集通过；`git diff --check` 通过。未 staged，无提交。

## decisions
- 功能状态和弹窗仍由 Goal surface 持有，Composer 只呈现已有扩展菜单项。
- 创建能力尚未确认时禁用菜单项；不显示技术状态文案。
- 菜单可携带关闭后的呈现 continuation；Goal view 的 scope 防止换 Thread/卸载后晚到 callback 打开旧弹窗或关闭新草稿。

## risks
- 菜单关闭与弹窗焦点交接，需验证触控/键盘；取消不应丢失输入草稿。

## scan_scope / scan_output
- 本轮只修改上述路径，不扫描凭据。

## handoff
- Goal 菜单迁移与两项 Host 快捷入口删除均已完成并替换当前 Web 预览。
- 当前 port80 版本为 `20261004-thread-menu-b5f8180b6dc9`，基于已运行的 `20261004-goal-menu-2a0b1e518cee`；仍属 `opencraft-neutral-focus-20261004-preview.service`，PID `1554252`，运行时哈希 `775d26c525045d584a6f3685535aaff3d86d840e14989ab36e37af1d8a62258a`，执行服务未重启。
- 尚无实机 iOS/登录 Host 验证，不以合成 Goal client 证明后台实际执行。已打开页面需刷新。

## Thread 菜单预览替换回执（2026-10-04 01:09 CST）

- 用户明确只删除“在 Codex 上新建任务”和“Codex 设置”入口；源码移除 Thread 菜单及 Sidebar 的专用回调，正常新任务与设置导航保留。
- 源码真实 Radix 浏览器 smoke 通过，触控及右键菜单均为“重命名、新建分支、归档”，对应操作仍可用。
- 基于运行中的 Goal 菜单版本，仅对 Web 的对应菜单项作 AST 定位替换；源码清除了回调接线，发布包保留的旧接线已无入口。未打包其他 dirty worktree 改动。
- 独立 `opencraft-thread-menu-20261004-cutover` 原子交换 Web，回滚目录与 manifest 位于 `/data/opencraft-thread-shortcuts-preview-F25Ahx`。MainPID、runtime hash、数据目录均不变，health 正常。
- 候选及实际 port80 浏览器验证均通过：manifest 全哈希核对、菜单精确三项、Goal 菜单焦点交接/取消保留草稿/合成保存、零资源与页面错误。浏览器 WebSocket 被阻断，无真实 Host 写入。
- Sidebar 原静态测试仍断言已删除的 Host 入口；更新为禁止这些入口接线的回归约束，其余断言保持。
- `tests/sidebar-activity.test.ts` 与 `tests/thread-lifecycle.test.ts` 最终 19/19 通过，`git diff --check` 通过。

## Goal 菜单预览替换回执（2026-10-04 01:01 CST）

- 用户“替换吧”授权当前前端预览。遵循 self-hosted-preview Skill，核对 PID/unit/cwd、版本、runtime hash 与数据目录；只改 Web，不停止当前 Host。
- 当前 port80 版本为 `20261004-goal-menu-2a0b1e518cee`，基础版本 `20261004-neutral-focus-b77cdda508d1`；只编译当时 Goal surface 源码并按 AST 替换 Composer/menu 接线，未打包整个 dirty worktree。
- 独立 `opencraft-goal-menu-web-cutover-20261004.service` 使用 Linux renameat2 原子交换目录；保留旧 Web 与 manifest 于 `/data/opencraft-goal-menu-preview-DcRg5g`。新资源 namespace 避免复用缓存，旧 URL 字节仍保留。
- MainPID 始终 `1554252`、unit `opencraft-neutral-focus-20261004-preview.service`；runtime SHA-256 始终 `775d26c525045d584a6f3685535aaff3d86d840e14989ab36e37af1d8a62258a`。数据目录未改，健康响应 ok。
- 候选及实际 port80 的浏览器验证：Web manifest 哈希全通过、零资源/页面错误、触控菜单→弹窗焦点→取消保留输入→合成 Goal 保存。测试阻断 WebSocket，无真实目标或模型执行写入。
- HTML build meta 与 version.json 对齐，manifest 一并更新；本回执独立于同时存在的其他临时脚本修改，以 status.json 和实际 HTTP 响应为证据。
- 已打开页面需刷新加载新入口；尚无真实手机设备或真实 Host 执行验收。
