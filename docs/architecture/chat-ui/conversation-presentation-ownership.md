# ChatUI presentation ownership

Scope: the five remaining categories identified after the scroll/Worked-for
refactors.

## Ownership and invariants

1. **Session projection owns observations.** `turn/plan/updated` materializes
   one new todo item per received update. No renderer mutates the Turn or writes
   persistence. The DSH event fold emits one canonical `todo-list` Item with a
   provider-event identity, shared by live events and history reconstruction.
   Its previous double emission (plan notification + Markdown plan) was removed.
2. **Facts and presentation are separate.** Proposals, todo snapshots and
   implementation records have separate block types. `isCompleted: false`
   cannot become success merely because an implementation record exists.
   An implementation record is retained but not independently rendered. Todo
   observations remain ordered facts, but only the latest snapshot of the
   newest active Turn becomes `activeTodo`; none enter transcript Activity.
3. **Shared core owns semantic placement and eligibility.** Web and Expo use
   the same proposal slot, message actions, detail mode, todo count and compaction
   labels. A failed Turn does not revoke copying a completed answer. Missing
   timestamps remain missing, never invented from mount time.
4. **Renderers own interaction state only.** Completing a plan does not reset
   its manual expansion. Web todo steps use the browser top layer, so the
   virtual row cannot clip them and opening them cannot resize the transcript.
   The compact progress trigger belongs to the sticky Composer footer rather
   than a Turn row; terminal or historical Turns remove it. DSH WebUI independently
   confirms the same ownership boundary by rendering Host `todos` in
   `conversation.input.dock`, never as transcript messages.
   Native uses a touch disclosure. Plan growth still goes through the existing
   viewport/measurement owners; no new scroll-position writer was added.
5. **Host owns capabilities.** Web copies source text plus sanitized rendered
   HTML without changing selection, with the existing plain-text fallback.
   Expo receives a copy port from its host, backed by `expo-clipboard` at the
   version specified by the installed Expo SDK. Decorative unconnected native
   retry/menu icons were removed. No fake fork/report/side-panel buttons were
   added when the host has no such command.
6. **Detail mode is not product identity.** Prose/commands/execution change
   summaries and row visibility, not execution facts. Work-product-specific
   compaction wording is not enabled by choosing prose mode.

## Verification

- `tests/chat/chat-conversation-presentation.test.ts`: distinct todo observations,
  latest active todo selection without transcript rows, canonical step parsing,
  latest proposal identity, implementation false/body,
  compaction defaults/live/history, completed-message actions, detail modes,
  historical todo not retaining active ownership.
- `tests/protocol/appserver-session.test.ts`: real session notification pipeline
  preserves ordered todo observations and does not alter Turn lifecycle.
- `tests/execution/dsh-projection.test.ts`: event identity, no duplicate plan emission,
  repeat fold stability, existing tool/interaction behavior.
- `scripts/smoke/conversation/smoke-conversation-presentation.ts`: headless Chromium running the
  real `Conversation`, built-in renderer registration, Markdown and virtual
  list. Checks writing/completed plans, Planning placeholder, collapse retention,
  download, remount, latest-only fixed todo outside transcript, terminal removal,
  top-layer steps/Escape, compaction without extra Thinking,
  mode changes, copy on failed Turn, HTML/plain MIME payloads and timestamp.
- Existing conversation scroll and Worked-for headless regressions rerun.
  Scroll smoke reports two transient ResizeObserver delivery warnings and no
  idle loop. Worked-for and presentation smoke report no page errors.
- Chat test suite, AppServer test suite, Web/Expo/local-agent-host typechecks,
  and Web production build.

Native behavior was typechecked, not exercised on an iOS/Android device. The
native touch disclosure is not a desktop hover-tooltip pixel comparison.
Provider capabilities, native download/side-panel integration, and full-application
frame-by-frame visual comparison are outside these five fixes.
No deployment is performed by this change.
