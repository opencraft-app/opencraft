---
id: task-memory-tabs-style-20260920
type: task
scope: 记忆与用户画像 Tab 的局部视觉对齐及通道重新连接按钮文字样式修复。
triggers: ["记忆 Tab", "用户画像 Tab", "重新连接按钮"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - frontend/src/pages/marketing/agent-memory-views.tsx
  - frontend/src/pages/marketing/agent-channel-views.tsx
  - frontend/src/pages/marketing/agent-config/standard-panel.css
status: active
reviewed_at: 2026-09-20
review_due: 2026-10-20
revision: 1.0.0
precedence: task
derived: false
---

# 记忆页 Tab 样式对齐

## goal
按用户指定，将「记忆 / 用户画像」Tab 对齐现有「探索 / 对话」视觉。

## non_goals
- 不改其他 Tab、controller、加载、数据请求、限额保存、依赖或共享接口。
- 不提交、推送、重新部署；保留原有 DevCloud 规划。

## requirement_refs / requirement_excerpt
- 当前对话：“这个组件的样式可以和【探索/对话】保持一致”。

## interface_refs / data_structure_refs
- MemoryPanelView 继续接收受控 activeTab 与 onTabChange，Radix 拥有键盘行为。
- 保留 MemoryPanelViewProps 与 MemoryEntryTab，加载条件不变。

## history_context
- current_design_refs: frontend/DESIGN.md、frontend/src/pages/marketing/agent-memory-README.md。
- relevant_evolution: 当前分支 204a3338d 的 ConsoleSidebarTabs 已采用 36px/12px 及无描边白色选中块。

## acceptance / validation
- Tab 高 36px、字体 12px、4px 内边距和项间距、轻灰底，选中项白底轻阴影；宽度仍由内容决定。
- 保留方向键与面板关联、刷新/加载/保存行为；聚焦测试、pnpm check、diff 检查。

## affected_paths
- frontend/src/pages/marketing/agent-memory-views.tsx 与相邻 panel 测试、README。
- frontend/openspec/plan.md 与本任务记录。

## context_receipt
| 文件 | 原因 | 用途 |
|---|---|---|
| AGENTS.md、frontend/AGENTS.md | 仓库与服务规则 | 复用原语和验证边界 |
| frontend/DESIGN.md | 组件规范 | 保留 Tabs 原语和局部 className 组合 |
| docs/context/project/adjacency/frontend-runtime-openspec-i18n.md | 邻接定位 | 检查 vitest 配置及面板测试 |
| frontend/src/pages/marketing/agents-console/console-sidebar-tabs.tsx | 用户指定参考 | 样式尺寸、选中与焦点 token |

## evidence
- 路由查询 frontend memory tabs style console-sidebar-tabs 无匹配；在 agent-memory* 与 console-sidebar-tabs.tsx 有界搜索定位。
- 当前工作树无 graphify-out；本次直接核对已知两个组件，不生成全仓图谱。
- UPSTREAM.json 没有 agent-memory-views 或 agent-memory-panel，页面不在生成闭包。
- `pnpm exec vitest run --api.host=127.0.0.1 src/pages/marketing/__tests__/agent-memory-panel.test.tsx src/pages/marketing/__tests__/agent-channel-action-layout.test.ts src/pages/marketing/__tests__/agent-channel-interactions.test.tsx`：3 个文件、17 个用例通过；覆盖 Tab 尺寸/选中态、方向键切换、刷新 Portal、限额保存，以及已连接通道重新连接按钮白字。
- `pnpm check`：i18n 提取/校验、繁中校验、文档同步、MDX 生成通过；TypeScript 诊断 168 current / 276 baseline / 0 new；既有 i18n warning 49 条。
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`：通过；`git diff --check`：通过。
- 通道问题证据：`Button variant="outline"` 的内联 `style.color` 覆盖旧 reconnect CSS；现改为 default + reconnect modifier，局部 CSS 明确深色背景与 `#fff` 前景，测试锁定 DOM 类、渲染前景和 CSS 规则。
- `pnpm build`：生产构建与静态页面生成通过（Next.js 编译、TypeScript、103 个静态页面、SEO/EdgeOne 检查）；构建脚本自动改写了生成的 `frontend/next-env.d.ts` 路由引用，已恢复该生成文件的原工作树内容。
- `pnpm test`：全量测试未通过，失败集中在当前分支其他文档/国际化/支付/模型配置/工作台契约与资源压力（302 passed、17 failed、1 skipped；50 failed tests，3 worker errors，期间有 worker OOM）；失败文件未命中本轮改动文件。本轮聚焦 17 用例和 `pnpm check` 已通过。

## handoff
- 实现与聚焦验证完成。本轮源码与验证记录按用户授权提交并推送预览分支，不部署。DevCloud 相关未提交文件保持原样：`docs/context/tasks/2026-09-19-personal-devcloud-environment.md`、`frontend/openspec/changes/2026-09-19-personal-devcloud-environment-plan.md` 及其 `frontend/openspec/plan.md` 记录；本轮未执行 DevCloud 远端操作。
