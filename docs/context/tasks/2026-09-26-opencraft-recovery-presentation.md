## goal
Keep the existing Chat timeline readable during reconnect and show a lightweight local status instead of an opaque restore overlay.

## non_goals
- Change AppServer reconnect, Replica authority, or deployment behavior.
- Commit, push, or replace a running preview.

## requirement_ids / requirement_refs / requirement_excerpt
- User discussion, 2026-09-26: on mobile, preserve old content during reconnect; cold empty load uses a skeleton; definite failure offers retry.

## interface_refs / data_structure_refs
- `ConversationRuntimeSnapshot.authoritative`, `phase`, `timeline.frames`, `error`.
- `Conversation` owns the Timeline viewport; the App owns connection presentation and command gating.

## history_context
- `current_design_refs`: `opencraft/docs/chat-ui-architecture.md`.
- `relevant_evolution`: Replica retains painted entities on disconnect; the prior Web `ConversationHydration` obscured them.
- `superseded_refs`: none.

## acceptance
- Warm reconnect and failure retain visible rows, draft and scroll identity; notice/retry stays local.
- Cold empty load shows delayed skeleton; failure shows inline retry.
- Relevant Web typecheck, focused tests and build pass; browser presentation inspected when available.

## affected_paths
- `opencraft/apps/workbench-web/src/app.tsx`
- `opencraft/apps/workbench-web/src/components/conversation*.tsx`
- `opencraft/apps/workbench-web/src/styles/app.scss`
- `opencraft/apps/workbench-web/src/i18n/locales/zh-CN.json`
- `opencraft/tests/conversation-recovery.test.tsx`
- `opencraft/docs/chat-ui-architecture.md`

## required_context
- `agent-gateway-runtime`, `site-environment-routing`, `upstream-subtrees`, `service-opencraft`.

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md`, `opencraft/AGENTS.md` | 仓库与局部边界 | 授权、验证与 UI 所有权 |
| `docs/context/domains/agent-gateway-runtime.md` | Runtime 路由 | 不改变协议 authority |
| `docs/context/domains/site-environment-routing.md` | Web/locale 邻接 | 只改本地文案 |
| `docs/context/project/upstream-subtrees.md` | mono2 写入源 | 不编辑参考项目 |
| `docs/context/project/services/opencraft.md` | 服务边界 | Web 呈现归属 |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md` and `references/verification.md` | 交互维护 | 保留连续性、检查真实呈现 |
| `opencraft/docs/chat-ui-architecture.md` | 当前设计 | 更新恢复不变量 |
| `opencraft/docs/platform-architecture.md` | 平台生命周期 | 不让 View 控制 Host |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md` | i18n 邻接 | 检查 locale 与测试 |

## evidence
- Focused recovery, reconnect-policy and Replica suite: 35 tests passed.
- Workbench Web TypeScript check and Vite production build passed; i18n check passed.
- Change-impact validation passed for the changed Web source and formal design document.
- Current environment has no Playwright/Chromium installation or active in-app browser tab; no real phone/browser reconnect visual claim.

## risks
- Existing worktree is dirty; preserve unrelated edits and do not publish them.
- Browser may not expose a controllable disconnected Thread fixture; report that boundary explicitly.

## validation
- Focused recovery test, Web typecheck, Web build, change-impact check.

## decisions
- UI state derives from authority, visible Timeline frames and error; no second persistence owner.
- Warm status is absolute and small; cold skeleton occupies only the empty Timeline slot.

## scan_scope
- `opencraft/apps/workbench-web/src`, `opencraft/packages/appserver-replica/src`, relevant OpenCraft tests.

## scan_output
- Bounded `rg` and source inspection in this task.

## handoff
- Source and local Web build are updated; no running server or release was replaced.
- Real mobile reconnect presentation remains to be checked in a browser with a retained Thread.
