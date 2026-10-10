## goal

Keep code-only user messages readable in the Web conversation timeline.

## non_goals

- No message storage, Markdown parser, assistant code-block, or preview-service changes.

## requirement_ids / requirement_refs / requirement_excerpt

- User report in this conversation: code-only user messages appear as empty narrow bubbles. The user requested applying the shared sizing invariant observed in the local Codex and BB references.

## interface_refs / data_structure_refs

- `UserMessageBlock` projects the existing `UserMessageTimelineBlock.message` through `WebUserMessageDocument`.
- The user bubble owns intrinsic/max width; shared `chat-code-block` containment must not suppress its intrinsic width contribution there. The code scroller owns horizontal overflow.

## history_context

- `current_design_refs`: `opencraft/docs/chat-ui-architecture.md`.
- `relevant_evolution`: `ref/codex` recovered Renderer snapshot uses a user-bubble-scoped containment reset; `ref/bb` commit `62fe3bc` uses intrinsic user-message width without code-block inline-size containment. Neither reference is authority over the current OpenCraft runtime.
- `superseded_refs`: none.

## acceptance

- A fenced-code-only user message has a visible, content-sized bubble within the user-message width cap.
- Long code remains inside that cap and scrolls within the code block.
- Truly empty and attachment-only messages keep their existing presentation.

## affected_paths

- `opencraft/apps/workbench-web/src/styles/app.scss`
- `opencraft/tests/workbench-user-message-layout.test.ts`
- `opencraft/docs/chat-ui-architecture.md`

## required_context

- Context router returned no matching Pack. OpenCraft maintenance skill and chat architecture apply.

## context_receipt

| File | Reading reason | Use |
|---|---|---|
| `AGENTS.md`, `opencraft/AGENTS.md` | Repository and service boundaries | Scope and verification |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md`, `references/verification.md` | UI maintenance method | Preserve presentation ownership and distinguish source from visual proof |
| `opencraft/docs/chat-ui-architecture.md` | Current design | Record sizing invariant |
| `ref/codex/lazy/app-initial/subagent-activity-chip-group-CC185tmV.js`, `ref/bb/apps/app/src/components/thread/timeline/ConversationMessageContent.tsx` | Fixed-version reference layouts | Compare containment and width ownership |

## evidence

- The reported messages were persisted as non-empty fenced code and parsed as code-fence nodes; the current bubble had no containment reset while the shared code block used `contain: inline-size`.
- `node --import tsx --test tests/workbench-user-message-layout.test.ts tests/chat-document.test.ts`: 28/28 passed.
- Web TypeScript `tsc --noEmit -p apps/workbench-web/tsconfig.json`: passed.
- Web Vite build into an isolated `/tmp` output directory: passed; emitted CSS contains `.thread-user-message__bubble .chat-code-block{contain:none}`.
- `git diff --check` on affected tracked paths: passed.
- Repository documentation validation: passed with no errors, broken first-party links, or warnings.
- A narrow-screen browser fixture was attempted, but the available in-app browser rejected inspection without Preview Bridge and cannot screenshot this mobile tab; no real-layout pass is claimed.

## risks

- CSS intrinsic sizing can vary on narrow viewports. Keep the change scoped to user bubbles; verify the compiled CSS and a mobile browser before claiming visual completion. Reverting the bubble-scoped rule restores previous layout.

## validation

- Focused user-message layout and chat-document tests; Web typecheck/build; mobile visual check when a usable browser is available.

## decisions

- Preserve shared renderer containment. Lift it only at the user-bubble boundary, as in the Codex reference, while retaining BB's content-sized bubble/max-width/inner-scroll invariant.

## scan_scope

- `opencraft/apps/workbench-web/src/components/conversation/user-message.tsx`, `opencraft/apps/workbench-web/src/styles/app.scss`, `opencraft/packages/chat-render-web/src/renderers/code/`, relevant tests and fixed references.

## scan_output

- Bounded source inspection; no bulk scan artifact.

## handoff

- Source, focused tests, typecheck and isolated build are complete. Mobile visual geometry remains unverified in this environment. The running preview was not replaced; no deployment or commit was performed.
