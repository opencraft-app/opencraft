---
id: opencraft-embedded-chat-2026-09-21
type: task
scope: Additive OpenCraft Embedded Workbench Shell and LightVela AgentChat migration boundary.
triggers:
  - opencraft embedded chat
  - AgentChat replacement
  - Embedded Workbench Shell
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - docs/context/tasks/2026-09-21-opencraft-embedded-chat.md
status: active
reviewed_at: 2026-09-21
review_due: 2026-12-20
revision: 1.0.0
precedence: task
derived: false
---

## goal

Add a first-class OpenCraft `embed-chat` surface that can run inside the existing LightVela Agent page without an iframe, while preserving the current full Workbench entry and keeping legacy AgentChat as the visible/write owner until the embedded surface reports ready and is explicitly shown.

The embedded canvas follows OpenCraft's ordinary Thread/Draft conversation
path. The selected LightVela Bot identifies a fixed instance/Profile Hermes
Host; it must not switch the canvas onto the separate Bot conversation protocol.

## non_goals

- Do not remove legacy AgentChat in this change.
- Do not change the visible layout, routes, or startup contract of the existing OpenCraft Workbench.
- Do not publish, deploy, overwrite `/Applications/OpenCraft.app`, or mutate production/cloud resources.
- Do not assume AgentChat `chatId` equals an OpenCraft/Hermes conversation ID without protocol evidence.

## requirement_ids / requirement_refs / requirement_excerpt

- `user-request-2026-09-21-opencraft-embedded-chat`
- User requirement: run both chat implementations initially; legacy AgentChat remains the default, and the new OpenCraft Chat replaces it only after an explicit successful `show()` boundary.
- User requirement: no iframe; omit the OpenCraft sidebar and reuse the remaining Chat implementation.
- User requirement: existing OpenCraft behavior should remain unaffected; provide a reusable embed mode.

## interface_refs / data_structure_refs

- `opencraft/apps/workbench-web/src/runtime/web-workbench-application.ts`: current full application lifetime.
- `opencraft/apps/workbench-web/src/workbench-root.tsx`: current full Workbench provider/root composition.
- `opencraft/apps/workbench-web/src/runtime/appserver-runtime-context.tsx`: Host, extension, Bot conversation, and application supervisor ownership.
- `opencraft/apps/workbench-web/src/app.tsx`: ordinary Thread/Draft conversation presentation.
- `frontend/src/pages/marketing/agent-chat-panel.tsx`: current legacy AgentChat owner.
- New embed lifecycle invariant: `prepare -> ready -> show`; only the shown surface may write, focus, approve, steer, stop, or consume automatic prompts.
- Existing `createWebWorkbenchApplication()` remains source-compatible and behavior-compatible.

## history_context

- `current_design_refs`: `opencraft/docs/platform-architecture.md`, `opencraft/docs/plugin-architecture.md`, `opencraft/docs/chat-ui-architecture.md`, `opencraft/design/invariants.md`.
- `relevant_evolution`: OpenCraft already exposes Bot conversations through AppServer-backed source/resolver and LightVela Hermes as a Host provider; the current renderer entry still owns a complete document root and Workbench chrome.
- `superseded_refs`: none.

## acceptance

- A separately importable OpenCraft embedded Chat API exists without rendering
  OpenCraft's Sidebar, application navigation, Right Panel or panel toggle.
- The embedded canvas reuses the ordinary Workbench Thread/Draft, Composer,
  and steer owners instead of `BotChatView` or
  `bot/conversation/*`.
- The embedded API binds the requested LightVela instance and Bot Profile
  explicitly and exposes readiness, show/hide, writable ownership, and disposal
  semantics.
- The current full OpenCraft entry continues to typecheck and its focused tests pass unchanged.
- The LightVela Agent page can mount legacy and embedded surfaces in one fixed geometry; legacy stays visible/write-enabled until embedded `show()` succeeds, and failures keep/fall back to legacy.
- The LightVela Sidebar exposes New conversation above Recent conversations.
  It selects an OpenCraft Draft immediately and adds no recent Thread until the
  first submission is accepted.
- Automatic prompt delivery is routed through the current owner instead of document-global DOM discovery.

## affected_paths

- `opencraft/apps/workbench-web/src/**`
- `opencraft/plugins/bot-chat/src/**` only if a narrow reusable surface contract is required.
- `frontend/src/pages/marketing/**`
- Focused OpenCraft/frontend tests.
- `opencraft/docs/platform-architecture.md` and/or `opencraft/docs/chat-ui-architecture.md` for the durable embed contract.

## required_context

- Root `AGENTS.md` and `opencraft/AGENTS.md`.
- `opencraft-maintenance` skill and its verification reference.
- Platform, plugin, Chat UI, and Workbench presentation invariants listed above.

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@working-tree` | mono2 authority, Task Pack, impact and verification rules | Bound scope and evidence requirements |
| `opencraft/AGENTS.md@working-tree` | OpenCraft ownership and platform rules | Preserve runtime/View owners and existing entry behavior |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md@working-tree` | Maintenance and lifecycle invariants | Define single writer, cancellation and presentation boundaries |
| `opencraft/docs/platform-architecture.md@working-tree` | Application/Host/renderer ownership | Separate reusable runtime core from full Workbench chrome |
| `opencraft/docs/plugin-architecture.md@working-tree` | Extension/runtime composition | Reuse Bot Chat contribution without duplicating product rules |
| `opencraft/docs/chat-ui-architecture.md@working-tree` | Chat and Composer authority | Preserve conversation and composer ownership |
| `opencraft/design/README.md@working-tree` | Workbench presentation authority | Keep embedded presentation out of full Shell ownership |
| `opencraft/design/invariants.md@working-tree` | Durable UI/runtime invariants | Additive embed mode must not remount or duplicate writers |
| `opencraft/.agents/skills/opencraft-maintenance/references/verification.md@working-tree` | Relevant checks | Select Bot/Host, Chat and cross-entry verification |

## evidence

- Context router query `opencraft chat replaces frontend AgentChat dual-run show lifecycle evaluation` returned no pack; bounded exact searches were performed in `frontend/src/pages/marketing`, `opencraft/apps/workbench-web`, `opencraft/plugins/bot-chat`, and `opencraft/plugins/lightvela-hermes`.
- Existing dirty worktree recorded before edits; unrelated user changes will be preserved.
- `npm run typecheck --workspace @opencraft/workbench-web`: passed.
- `npm run typecheck --workspace @opencraft/{codex-composer,plugin-bot-chat,workbench-runtime}`: passed.
- `npm run test:bot-management`: 32 passed.
- `npm run test:workbench:unit` and `npm run test:chat`: 404 passed across the selected suites.
- Embedded authority/profile/transient-binding tests: 15 passed.
- Frontend migration plus SDK boundary tests: 6 passed; direct frontend TypeScript check passed.
- `npm run check:boundaries`: passed.
- `npm run build:lightvela-web`: passed; product boundary inspected 181 executable artifacts and found no forbidden HyperNode token.
- Release publish probe copied the stable `__opencraft/embedded-workbench.js` loader and its content-addressed target successfully.
- Documentation validation and explicit changed-file impact validation passed; mapped owner review remains required by the repository policy.
- Local real-page attempt reached the expected login gate in a fresh browser context. No authenticated Host/model/send claim is made from that run.
- A visible preview was restarted from the current checkout on `4173`
  (LightVela) and `10000` (OpenCraft). The initial unauthenticated matrix/report
  is at `/tmp/lightvela-embed-preview/report.html`; later authenticated QA
  supersedes that login-gated observation.
- Authenticated localhost QA confirmed `show()` adopts the embedded surface,
  unmounts legacy AgentChat, preserves the outer `/agents/chat/` route, and
  renders the ordinary New Thread composer. No message was submitted during QA.
- Post-pivot checks: OpenCraft Workbench and frontend TypeScript passed;
  `test:chat`, all 262 Workbench unit tests, platform boundaries, the frontend
  migration test, and `build:lightvela-web` passed. The Composer overlay test
  now requires both menu portals to bind the explicit Presentation Root.
- Shadow-DOM presentation QA found and fixed a root-contract gap: portals were
  initially targeting the outer document and semantic theme tokens were written
  only to `document.documentElement`. Embedded Workbench now owns one
  Presentation Root for theme tokens, menus, dialogs, context menus, drag
  overlays and panel Tabs. Authenticated preview verified the styled Composer
  model menu before the embedded Right Panel projection was removed.
- Session lifecycle is fully bridged: Hermes advertises rename/delete
  capability, AppServer routes native Thread methods to `session.title` and
  `session.close + session.delete`, and the LightVela Sidebar reports pending
  state and failures instead of dropping operation Promises.
- Standard Thread file attachments now use the existing Host staging contract:
  Hermes conditionally advertises `opencraft/attachment-staging`, writes
  bounded client bytes through the authenticated Dashboard filesystem into its
  controlled `opencraft-attachments` tree, persists an idempotency manifest,
  and implements owned recursive removal. Image data URLs remain unchanged.
- Refreshed attachment presentation no longer interprets the Hermes storage
  path. The Host attachment service persists a location-keyed `AttachmentRef`
  metadata index and supplies an `AttachmentMetadataResolver`; history
  hydration resolves the original display name through that port, while
  pre-index staged attachments are lazily backfilled from their storage-owned
  manifest and other unindexed legacy references fall back to a generic
  basename.
- The Connector button is absent from Embedded Core Chat through the shared
  Presentation Policy; the complete Workbench continues to project Connector
  actions unchanged.
- Optional Composer actions use the same policy as Shell surfaces. Embedded
  Core Chat currently supplies an empty action allow-list, hiding the browser
  Voice action whose Chromium speech backend reports offline; the full
  Workbench continues to project all registered actions.
- Authenticated preview verified that New conversation selects the Sidebar
  command, renders the ordinary `What should we work on?` Draft, and leaves
  every existing server conversation unselected without sending a message.
- Attachment-metadata follow-up verification passed: 90 focused Hermes and
  attachment tests, 404 Chat tests, 404 Workbench unit tests, both affected
  package TypeScript checks, platform boundaries, `build:lightvela-web`,
  documentation validation, staged change-impact validation and diff checks.
- Multi-Bot rollout follow-up restores the missing gate: route `active` is only
  presentation state, while the console `show()` reveal state is the explicit
  authorization to prepare/adopt Embedded Chat. The logical Host now includes
  `instanceId + profileId`; CTL `main` maps to Hermes `default`, all ordinary
  Thread operations are adapter-scoped, and Composer queue persistence is
  Profile-separated while the Dashboard token remains physical-instance scoped.
- Follow-up verification: affected frontend and OpenCraft TypeScript checks
  passed; rollout/console-helper component tests passed 7/7; focused embedded
  and Hermes adapter tests passed 87/87; OpenCraft extension tests passed
  182/182 plus Collaboration 56/56; Chat passed 404/404; Workbench unit passed
  262/262; platform boundaries and `build:lightvela-web` passed. Authenticated
  localhost refresh confirmed zero Embedded elements before `show()` and the
  secondary Bot remains Chat-gated before reveal. The optional
  `smoke:hermes-profile-bots` browser fixture could not start because this
  checkout has no `playwright` package; no live secondary-Bot send was made.
- Authenticated secondary-Bot QA caught and removed one stale action guard:
  reveal had enabled the Chat tab but its click handler still returned for any
  non-default Bot. Both presentation and navigation now consume the single
  `isActiveBotChatAvailable` authority.
- Console reveal is now a generic persisted feature state rather than one-way
  page state. One ref-counted `show()` controller toggles the versioned
  origin-local value, synchronizes subscribers and other tabs, survives page
  reload/navigation, and restores any pre-existing global only after its final
  lease. Calling `show()` a second time disables Embedded adoption and hides
  the other reveal-gated product entries.
- Persisted feature-state, console-command, user-menu, Account Referral and
  migration-surface focused tests passed 36/36; frontend TypeScript and diff
  checks passed. Tests cover controller recreation, explicit persisted false,
  storage denial fallback, cross-tab storage events, command lease sharing,
  reload restoration and second-call cancellation.
- Secondary-Bot route correction waits for persisted reveal hydration, so a
  cold reload of an enabled `/agents/chat/?bot=<profile>` cannot redirect to
  Channels from the server-compatible false first frame.

## risks

- Duplicate write/focus ownership if both surfaces are interactive. Mitigation: application-level visible/writable lease and tests for failed/late readiness.
- Global CSS leakage. Mitigation: embedded style entry scoped to the embed root; do not import the full Workbench `app.scss` into frontend.
- Instance/Profile drift through account-wide selection. Mitigation: explicit
  instance/region/account/Profile binding and a Profile-scoped logical Host ID.
- Duplicate runtime subscriptions or incorrect disposal. Mitigation: one embedded application owner with reverse-order disposal and held/late result tests.
- Legacy `chatId` and Hermes conversation identity may differ. Mitigation: no implicit migration in this slice; establish or add a separate mapping contract before history cutover.

## validation

- Focused unit/model tests for embedded lifecycle, readiness, single writer, fallback, explicit instance binding, and disposal.
- `npm run typecheck --workspace @opencraft/workbench-web` from `opencraft/`.
- Relevant Bot/Host and Chat tests from the OpenCraft verification matrix.
- Frontend focused tests/typecheck for the Agent page integration.
- `npm run check:boundaries` if a cross-package contract is added.
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged` before handoff when staged evidence is available; otherwise report that the worktree was not staged.

## decisions

- Use a native React embed mode, not an iframe.
- Keep the existing Workbench entry as a compatibility wrapper and add an independent embedded entry/root.
- Reuse Chat domain/runtime services; do not render or CSS-hide the full Workbench Sidebar.
- Treat `show()` as an ownership commit after readiness, not as DOM mounting.
- LightVela owns the outer Sidebar, Explore/Chat route and session presentation; Embedded Workbench owns the right canvas and supplies session snapshots/actions only.
- Prepare the complete Workbench application graph, but do not project its
  Right Panel or toggle in the embedded Shell. The full Workbench keeps its
  Browser/Terminal panel unchanged.
- Model optional UI as a typed Presentation Policy. Embedded Core Chat disables
  Shell navigation, contextual Sidebar, Right Panel and Connector launcher;
  the full Workbench policy enables them. Do not branch on product names or
  scatter embedded-only visibility checks through components.
- Treat the outer Bot selection as Host configuration only. Embedded sessions
  are ordinary AppServer Threads inside one fixed native Hermes Profile. Rename maps
  `thread/name/set -> session.title`; confirmed deletion maps
  `thread/delete -> session.close + session.delete`.
- Keep the stable embed loader mutable but point it only at a content-addressed Vite entry; use the loader origin as the Shadow DOM asset base.

## scan_scope

- `frontend/src/pages/marketing/agent-{settings-page,chat-panel}.tsx`
- `opencraft/apps/workbench-web/src/{main,workbench-root,runtime/**}`
- `opencraft/plugins/bot-chat/src/**`
- `opencraft/plugins/lightvela-hermes/src/{host,transport,hermes-appserver-bridge}/**`

## scan_output

- Bounded search summaries are recorded in this Task Pack and command history; no separate large scan artifact.

## handoff

- Status: ordinary Thread/Draft embedded presentation and authenticated local
  adoption are implemented and verified; release remains out of scope.
- Next: add production artifact wiring and exercise an actual first submission
  only when external model execution is explicitly in scope.
- Blockers: none for the local presentation. AgentChat conversation identity is
  intentionally not migrated; the embedded session list comes from ordinary
  AppServer Thread authority.
- Required permissions: an authenticated preview session for final runtime QA; release/publish remains outside this task.
