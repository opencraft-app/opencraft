# Agents 加载体验统一 Implementation Plan

> **For agentic workers:** 按任务逐项执行；每个任务都必须先写失败测试，再写最小实现。提交动作需等待用户明确确认。

**Goal:** 在 `/agents/*` 页面统一首次加载、刷新、提交、追加和流式状态的展示契约，并保持既有业务请求与控制器不变。

**Architecture:** 先建立无业务的 `Spinner`、`Skeleton`、加载状态组合，再让 `AgentState` 复用统一视觉和 ARIA。页面迁移按场景进行，首次加载采用结构化占位，已有数据刷新采用局部反馈，按钮操作保留原内容和焦点。

页面首屏规则：具体页面的主数据尚未完成时，使用 `AgentPageLoadingState` 占据内容区域；标题、筛选器、卡片和操作按钮随页面状态一起等待。已有快照进入刷新或提交时，保留现有内容并使用局部 `Spinner`。

**Tech Stack:** React 19、TypeScript、Tailwind CSS、Lucide、Radix/shadcn 现有原语、Vitest + Testing Library。

**Implementation status:** Task 1-3 的本地代码迁移与定向验证已完成；诊断页与会话列表按其非页面首屏语义保留局部 loading；浏览器窄视口回归仍保留在 Verification Gate。未知 `frontend/src/app/sidebar-account-fixture/` 不纳入写集。

## Global Constraints

- 只修改 `/agents/*`、`components/agents`、必要的 `components/ui` 及相邻测试和文档。
- 不修改 Repository、Context、SDK、权限、账务、路由、浏览器、终端、Workbench 工具页和生成副本。
- 不新增依赖；不使用 `any`；所有文案通过调用端 i18n 传入。
- Skeleton 不伪造业务数据；未知进度不渲染伪造百分比。
- 保留现有 Radix 焦点、禁用、Dialog、Sheet 和 Tabs 行为。
- 未经用户另行确认不执行 commit、push、MR、部署或归档。

---

### Task 1: 基础加载原语与 Agents 状态契约

**Files:**
- Create: `frontend/src/components/ui/spinner.tsx`
- Create: `frontend/src/components/ui/skeleton.tsx`
- Create: `frontend/src/components/agents/agent-loading-state.tsx`
- Modify: `frontend/src/components/agents/agent-state.tsx`
- Modify: `frontend/src/components/agents/index.ts`
- Test: `frontend/src/components/ui/__tests__/loading-primitives.test.tsx`
- Test: `frontend/src/components/agents/__tests__/presentation.test.tsx`
- Test: `frontend/src/components/agents/__tests__/loading-state.test.tsx`
- Docs: `frontend/src/components/agents/README.md`

**Interfaces:**
- `SpinnerProps` 继承 `React.SVGProps<SVGSVGElement>`，新增 `size?: "xs" | "sm" | "md" | "lg"`；默认 `md`。
- `SkeletonProps` 继承 `React.HTMLAttributes<HTMLSpanElement>`，渲染 `aria-hidden="true"` 的块级占位。
- `AgentState` 保留当前 props 和四种 `kind`，loading 视觉改由共享 Skeleton/Spinner 组合提供。

- [x] 写失败测试：覆盖 Spinner 装饰性/可标记状态、Skeleton 的 `aria-hidden`/共享 token、AgentState loading 的 `role/status`、`aria-busy` 和错误 alert。
- [x] 运行定向测试确认新增契约先因组件缺失/结构缺失失败，再进入实现。
- [x] 实现 `Spinner`、`Skeleton`，在 `components/agents/index.ts` 导出；不在组件内读取 Context 或发起请求。
- [x] 新增 `AgentPageLoadingState`，首屏页面状态使用 Spinner + 居中标题；保留 `AgentState` 的标题、说明、action 和原有调用端 API。
- [x] 重跑上述测试，组件与 Agents presentation 共 10 项通过。
- [x] 更新 Agents README，记录 loading 原语、ARIA 责任和 `AgentState` 边界。

### Task 2: 首屏、刷新与操作态迁移

**Files:**
- Modify: `frontend/src/pages/marketing/agent-settings-loading-view.tsx`
- Modify: `frontend/src/pages/marketing/agent-automations-panel.tsx`
- Modify: `frontend/src/pages/marketing/agent-memory-views.tsx`
- Modify: `frontend/src/pages/marketing/agent-common-settings-panel.tsx`
- Modify: `frontend/src/pages/marketing/agent-common-settings-views.tsx`
- Modify: `frontend/src/pages/marketing/agent-channel-panel.tsx`
- Modify: `frontend/src/pages/marketing/agent-model-config/agent-model-config-panel.tsx`
- Test: each file's existing adjacent test; add `frontend/src/pages/marketing/__tests__/agents-loading-states.test.tsx` only when no adjacent test exists.
- Docs: `frontend/src/pages/marketing/agents-console/README.md`

**Interfaces:**
- 页面继续消费原有 `loading`、`busy`、`error`、`hasSnapshot` 和 mutation 状态；只改变状态到视觉的映射。
- 首次无数据使用 `AgentState kind="loading"` 或结构化 Skeleton；已有数据刷新保留内容并只显示局部 Spinner。

- [x] 保留自动任务、记忆和通用设置既有数据/错误分支；首次无数据继续使用 AgentState，刷新/保存/恢复默认使用局部 Spinner。
- [x] 将设置骨架和技能详情占位迁移到共享 Skeleton；Buddy、自动化、模型配置首屏改用页面级居中加载状态。
- [x] 将刷新按钮、保存按钮、恢复默认按钮和模型操作改成统一 Spinner，不改变原回调、禁用和错误处理。
- [x] 运行页面相邻模型配置测试；共享 primitive 的 `motion-reduce`、尺寸和 ARIA 契约由组件测试覆盖。
- [x] 通道和 Website 已沿用既有 AgentState loading，不新增请求或状态分支；滚动区域边界保持宿主实现。

### Task 3: 剩余 Agents 页面首屏边界

**Files:**
- Modify: `frontend/src/components/domain/tat-file-manager-panel.tsx`
- Modify: `frontend/src/pages/marketing/agent-skills-panel.tsx`
- Modify: `frontend/src/pages/marketing/agent-experts-panel.tsx`
- Modify: `frontend/src/pages/marketing/agent-deepseek-harness-panel.tsx`
- Modify: `frontend/src/pages/marketing/agent-website-panel.tsx`
- Keep: `frontend/src/pages/marketing/agent-diagnostics-panel.tsx`, `frontend/src/pages/marketing/agents-console/console-session-list.tsx`
- Test: corresponding existing tests under `frontend/src/pages/marketing/**/__tests__` and `frontend/src/pages/marketing/agents-console/__tests__`.
- Docs: `frontend/openspec/changes/2026-09-17-agents-loading-design.md`

**Interfaces:**
- 会话和技能列表继续由调用端提供 `loading`、安装状态和错误；组件不新增请求。
- Chat 状态继续接收 `kind="loading" | "error"`、标题和重试回调；只调整布局内的 loading 视觉。

- [x] 文件、DeepSeek Harness、工作台和 Skills/Experts 首屏在主数据未就绪时使用居中页面状态；已有快照刷新保留内容。
- [x] 诊断页无首屏异步主数据请求，继续直接显示静态操作入口；会话列表属于侧栏导航，继续使用行级 Skeleton，不扩大页面级门禁。
- [x] 保持会话菜单、安装/卸载回调、重试回调和错误文案不变；已有 console/model 聚焦测试通过。
- [ ] 在 390px 和矮窗口浏览器中检查列表追加、Sheet、Chat 状态和滚动区域不发生横向溢出。
- [x] 重跑共享 primitive/Agents 聚焦测试和 `pnpm check`；本批未进入 OpenCraft 生成闭包。

## Verification Gate

- `cd frontend && VITE_REGION=cn NEXT_PUBLIC_REGION=cn pnpm exec vitest run src/components/ui/__tests__/loading-primitives.test.tsx src/components/agents/__tests__/presentation.test.tsx`
- `cd frontend && VITE_REGION=global NEXT_PUBLIC_REGION=global pnpm exec vitest run src/components/ui/__tests__/loading-primitives.test.tsx src/components/agents/__tests__/presentation.test.tsx`
- `cd frontend && pnpm check`
- `git diff --check`
- `python3 .agents/context/scripts/validate_documentation.py --format json`
- `git diff --name-only > /tmp/agents-loading-changed-files.txt && python3 .agents/context/scripts/validate_change_impact.py --changed-files-file /tmp/agents-loading-changed-files.txt`
- 浏览器检查桌面、390px 手机和矮窗口；记录首次加载、刷新、提交、错误、重试和追加列表。
