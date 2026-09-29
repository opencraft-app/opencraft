# OpenCraft changed-file Review

## goal
Make the running changed-file summary and completed resource card open a working, read-only Review surface, including per-file selection on touch.

## non_goals
- No new TurnDiff protocol or patch-batch model.
- No Undo/Reapply or Host mutation capability.
- No preview-service replacement or production deployment.

## requirement_refs / acceptance
User: “接通review和完成态卡片。不需要turn diff吧？太细节了”. The in-progress summary opens Review, the completed card presents file counts/list and opens Review, and unsupported Undo/Reapply is absent. A selected file displays only its existing diff; the active Thread owns the dialog lifetime.

## interface_refs / history_context
- Existing `TurnDiffTimelineBlock` has `unifiedDiff`, file summaries and status.
- `ConversationDocumentContext.onReviewTurnDiff` was declared but the Workbench did not provide it.
- Codex recovered reference distinguishes in-progress inline summary from completed resource card; it is comparison evidence, not the OpenCraft runtime authority.

## affected_paths
- `opencraft/apps/workbench-web/src/app.tsx`
- `opencraft/apps/workbench-web/src/components/conversation.tsx`
- `opencraft/apps/workbench-web/src/components/conversation/turn-diff-review*`
- `opencraft/apps/workbench-web/src/styles/app.scss`
- `opencraft/package.json`
- `opencraft/docs/chat-ui-architecture.md`
- `opencraft/tests/workbench-turn-diff-review.test.ts`

## context_receipt
| File | Why | Use |
|---|---|---|
| `AGENTS.md`, `opencraft/AGENTS.md` | Root and service ownership | Scope and validation |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md` and `references/verification.md` | Maintenance and UI evidence | Do not equate build with visible acceptance |
| `opencraft/docs/platform-architecture.md`, `opencraft/docs/chat-ui-architecture.md`, `opencraft/design/README.md` | Renderer/Workbench ownership | Workbench owns Review surface |
| `ref/codex/shared/normalize-turn-to-display-items-04332.ts`, recovered UI bundle | Reference model and presentation | Compare live/completed behavior only |

## decision / risk
Reuse the existing aggregate unified diff. A Workbench-owned Radix modal displays it; selecting a file filters view-only chunks via the existing path summarizer. The Card does not show an unavailable mutation. Risk: real mobile scrolling, focus and visual density need browser verification.

## validation / handoff
Focused TurnDiff and chat-core tests 93/93, Web typecheck, platform boundary check, and Vite Web build passed. The browser inspection channel did not return, so real mobile interaction and visual density remain unverified. No running preview was replaced.
