## goal

将 OpenCraft 会话侧栏从 Host 分组的单行列表升级为 Codex Activity 风格的时间流：任务标题、项目/Host 元数据、状态和选中态由同一个任务项 contract 呈现。

## non_goals

- 不改变 Thread、Host、Project 的运行时所有权。
- 不实现 Codex 的 Priority 筛选、置顶、拖拽排序或 ChatGPT 云任务。
- 不修改用户当前未提交的 Embedded Workbench / Hermes 文件。
- 不提交、推送、打包或发布。

## requirement_ids / requirement_refs / requirement_excerpt

- `USER-2026-09-21-SIDEBAR-ACTIVITY`：侧边栏升级为用户截图中的 Codex “查看活动”风格；若 `ref/codex` 有真实实现则优先按其模型落地。

## interface_refs / data_structure_refs

- `opencraft/packages/workbench-runtime/src/models.ts`：`WorkbenchThread.updatedAt` 是时间分组的规范数据，不从展示字符串反解析。
- `opencraft/apps/workbench-web/src/sidebar-activity.ts`：只负责排序、日期桶和元数据投影，不改变 Host / Thread 身份。
- `opencraft/apps/workbench-web/src/components/sidebar-activity-item.tsx`：Shell 级两行任务项；状态、选中、pending 和菜单保持独立槽位。
- `opencraft/apps/workbench-web/src/components/thread-management.tsx`：既有 Radix 任务菜单承接迁移后的 Host 新建/设置动作。

## history_context

- `current_design_refs`：`opencraft/docs/workbench-design-language.md`、`opencraft/design/invariants.md`。
- `relevant_evolution`：当前实现按 Host 分组并显示单行任务；用户明确要求切换到 Activity 时间流。
- `superseded_refs`：`opencraft/apps/workbench-web/src/sidebar-target-groups.ts` 仅作为旧呈现模型的历史证据。

## acceptance

- 列表按更新时间倒序，并按 Today / Yesterday / weekday / date 分组。
- 每个任务项显示标题和项目元数据；远端任务追加 Host 标签，本机 `Local` 不重复显示。
- running/review/error、unread、pending 和当前任务仍有稳定且不推动正文的视觉槽位。
- 任务上下文菜单、选择和自动滚入视图继续工作。
- 通过聚焦测试、Web typecheck/build，并用真实 Web 或 Electron 预览确认几何与交互。

## affected_paths

- `opencraft/packages/workbench-runtime/src/models.ts`
- `opencraft/packages/workbench-runtime/src/thread-catalog.ts`
- `opencraft/apps/workbench-web/src/components/sidebar.tsx`
- `opencraft/apps/workbench-web/src/components/sidebar-activity-item.tsx`
- `opencraft/apps/workbench-web/src/sidebar-activity.ts`
- `opencraft/apps/workbench-web/src/styles/app.scss`
- `opencraft/packages/design-system/src/tokens.web.scss`
- `opencraft/tests/*sidebar*`
- `opencraft/docs/workbench-design-language.md`
- `opencraft/design/invariants.md`

## required_context

- 根 `AGENTS.md`
- `opencraft/AGENTS.md`
- `opencraft/.agents/skills/opencraft-maintenance/SKILL.md`
- `opencraft/.agents/skills/opencraft-maintenance/references/verification.md`
- `normalize` Skill

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@working-tree` | 仓库边界与 Task Pack 规则 | 限制写入、验证与交付声明 |
| `opencraft/AGENTS.md@working-tree` | OpenCraft UI/设计系统不变量 | 确定 Shell / DS / Feature 所有权 |
| `opencraft/docs/platform-architecture.md@working-tree` | Host / Thread / View 生命周期 | 防止视觉重组改变运行时 owner |
| `opencraft/docs/workbench-design-language.md@working-tree` | 当前侧栏设计契约 | 更新被用户显式推翻的旧 Host 分组规则 |
| `opencraft/design/invariants.md@working-tree` | Shell 长期不变量 | 写入 Activity 列表 contract |
| `ref/codex/lazy/app-initial/is-workspace-root-options-ready.js@reference` | Codex Activity 聚合与调用点 | 对照日期组、secondaryContent、尾部状态 |
| `ref/codex/lazy/app-initial/is-app-update-in-progress.js@reference` | 日期标题与项目/Host metadata | 对照真实 Activity 语义 |
| `ref/codex/lazy/app-initial/environment-type-hover-label.js@reference` | 通用 TaskRow 布局 | 对照两行高度、状态槽位和选中态 |

## evidence

- `npx tsx --test tests/sidebar-activity.test.ts tests/thread-catalog.test.ts tests/thread-catalog-query.test.ts tests/workbench-sidebar-dock.test.ts`：25/25 通过。
- `npm run typecheck --workspace @opencraft/workbench-runtime`：通过。
- `npm run typecheck --workspace @opencraft/workbench-web`：通过。
- `npm run build --workspace @opencraft/workbench-web`：通过。
- `npm run build:electron`：Renderer、Main、Preload 与 Daemon 构建通过。
- `validate_documentation.py --repo . --format json`：0 error / 0 broken first-party links。
- `validate_change_impact.py`（显式传入本轮文件集合）：通过；`agent-gateway-runtime` 仍需 Owner review。
- 实际组件预览 `http://127.0.0.1:5191/`：中文系统 locale 显示“今天/昨天”，两行 metadata、远端 `V8 · 9.134.163.40`、选中态、spinner 与 unread 尾标均已目视确认。
- 隔离 Electron 当前源码启动：AppShell/空 Activity 状态正常；隔离 profile 无存量 Thread，因此有数据行使用真实组件 fixture 验证，不冒充存量会话实机证据。

## risks

- Host 分组标题承载了目标设置/新建入口；Activity 模型不得暗中删除能力。Start + Composer Host 选择器仍负责主要创建路径，既有任务右键菜单保留对应 Host 的新建与设置动作。
- 日期分组受本地时区影响；使用本地日界线，不解析本地化展示文本。
- 工作区已有无关修改；仅编辑 affected_paths，交接时单独列出。

## validation

- `npx tsx --test tests/sidebar-activity.test.ts tests/workbench-sidebar-dock.test.ts tests/lightvela-work-navigation.test.ts`
- `npm run typecheck --workspace @opencraft/workbench-runtime`
- `npm run typecheck --workspace @opencraft/workbench-web`
- `npm run build --workspace @opencraft/workbench-web`
- 真实 Web/Electron 预览截图与 DOM 几何检查。

## decisions

- 借鉴 Codex 的 Activity 聚合、TaskRow contract 和 metadata 投影，不复制其 ChatGPT/Priority 数据层。
- 时间桶由规范时间戳驱动；`time` 仅保留给现有其他客户端展示。
- Host 是任务 provenance 元数据，不再作为侧栏视觉分组 owner。

## scan_scope

- `ref/codex/lazy/app-initial/{is-workspace-root-options-ready,is-app-update-in-progress,environment-type-hover-label}.js`
- `opencraft/apps/workbench-web/src/{components/sidebar.tsx,sidebar-target-groups.ts,styles/app.scss}`
- `opencraft/packages/workbench-runtime/src/{models.ts,thread-catalog.ts}`

## scan_output

- 有界源码阅读；没有生成独立扫描文件。

## handoff

- 当前状态：实现与聚焦验证完成，组件预览保持打开。
- 已知非本轮失败：完整 `lightvela-work-navigation.test.ts` 有两项 Skills/DSH 静态断言受工作区并行修改影响；本轮触及的同文件 Sidebar 断言通过。
- 阻塞项：MR 阶段需 `wisp/mono2-maintainers` 复核 agent-gateway-runtime 责任面；未提交、未推送、未打包发行。
