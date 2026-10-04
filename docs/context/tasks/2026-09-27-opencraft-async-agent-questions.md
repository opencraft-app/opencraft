## goal
Show and answer Codex `request_user_input_async` questions in OpenCraft Web/Electron, including touch clients and reconnect/history replay.

## non_goals
- No phone-only protocol fork, AppServer binary modification, unrelated dirty HEIC/activity changes, commit or push.

## requirement_ids / requirement_refs / requirement_excerpt
- User, 2026-09-27: Agent questions never appeared in OpenCraft; desktop and ordinary Web previously showed question UI. Clarified that mobile itself does not choose async mode. User authorized implementation with “搞” and running Web replacement with “替换吧”.
- User, 2026-09-30: Async question card displayed an MR Markdown link literally. Authorized adopting the existing Markdown rendering invariant and implementing it; no live preview replacement requested.

## interface_refs / data_structure_refs
- Codex `rust-v0.157.0` (`00c972e`): `ThreadItem::AgentMessage { delivery: Async, questions }`; question ID is JSON of `["request_user_input_async", messageId, index]`.
- Codex `AnsweredQuestion` encodes a normal UserInput text envelope with `questionItemId`, `question`, `answer`; a response is a new user submission, not a server-request response.
- OpenCraft `TextTimelineBlock`, `projectTimeline`, `Conversation` and `SubmitIntent` are the model, renderer and submission boundaries.

## history_context
- `current_design_refs`: `opencraft/docs/chat-ui-architecture.md`, `opencraft/docs/platform-architecture.md`.
- `relevant_evolution`: generated AppServer `AsyncUserInputQuestion` arrived with `791224baf`; current text projector predates it and drops `delivery`/`questions`.
- `superseded_refs`: none.

## acceptance
- A Codex async AgentMessage yields a visible, touch-operable choice/free-text form while the ordinary Composer remains available.
- Answer uses Codex's stable question identity and normal user submission; duplicate taps and uncertain delivery do not silently create duplicate answers.
- History/reconnect and another client's answer update question state; two same-title questions retain distinct identities.
- Existing blocking `item/tool/requestUserInput` remains unchanged.
- Model-authored question titles use the shared safe Markdown resource pipeline; links open by Host intent, while option values and reply envelopes remain unchanged. The form retains an accessible name without nesting block Markdown in a legend.

## affected_paths
- `opencraft/packages/chat-core`, `opencraft/apps/workbench-web`, focused tests and chat architecture docs.

## required_context
- Router packs: `agent-gateway-runtime`, `site-environment-routing`, `upstream-subtrees`, `service-opencraft`; only OpenCraft and Agent runtime facts apply.

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md`, `opencraft/AGENTS.md` | Repository/Service authority | Task Pack, ownership, release boundary |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md` and `references/verification.md` | Maintenance method | Preserve Composer and lifecycle ownership |
| `docs/context/domains/agent-gateway-runtime.md`, `docs/context/domains/site-environment-routing.md`, `docs/context/project/upstream-subtrees.md`, `docs/context/project/services/opencraft.md` | Router must-read | Keep implementation in OpenCraft |
| `opencraft/docs/platform-architecture.md`, `opencraft/docs/chat-ui-architecture.md` | Formal design | Shared protocol semantics, renderer adaptation |
| `docs/context/domains/release-gitops.md`, `opencraft/docs/build-matrix.md` | Delivery boundary | Isolated headless archive and live cutover |
| `/data/codex-native-review-EpSNWz/repo/codex-rs/...` at `00c972e` | Exact bundled Codex revision | Async message and answer envelope behavior |
| `ref/codex/conversations/app-server-manager-class-04231.ts`, `ref/codex/lazy/app-initial/resolve-account-provider.js`, `ref/codex/modules/ui-islands-v10/card-header.js` | Recovered reference request-panel path | Confirm native blocking questions use a plain title and differ from async AgentMessage cards |

## evidence
- Generated `ThreadItem` has `delivery` and `questions`; current `agentMessage` projector maps only text/phase.
- Existing blocking question UI is sourced from pending `item/tool/requestUserInput` and replaces Composer; it is not the async message contract.
- Bundled Codex source emits `AgentMessageDelivery::Async` with questions and renders `AnsweredQuestion` as a structured new user message.

## risks
- A reply can be queued or have unknown delivery; only authoritative/optimistic submission state can close its question, never a click alone.
- Unrelated dirty source and documentation edits are present. Do not stage or overwrite them.
- No live browser tab is currently available for real-device acceptance.

## validation
- Focused chat-core projection/answer and static Web card tests: 5/5 passed.
- `npm run test:chat`: 436/436 passed; affected workspace typechecks and Web build passed.
- Formal docs-impact and repository documentation checks passed. Full `npm run gate` passed, including Web, Expo Web and Expo iOS builds. No physical mobile/browser acceptance has been performed.
- Isolated release worktree focused test and Web typecheck passed; its headless archive passed package smoke with DSH and Codex Host.
- 2026-09-30 Markdown-title follow-up: 439/439 current Chat tests, Web and Web-renderer typechecks, platform-boundary check, Web build, and isolated fixture bundle passed. The dedicated Playwright smoke could not run on this machine because the Playwright package is absent; installed Chromium also cannot start due to missing `libgbm.so.1`. No live/phone visual acceptance yet.

## decisions
- Preserve async question identity on the AgentMessage text block; derive answered/dismissed state from user-message history and keep the ordinary Composer mounted.
- Submit answers via the existing Host submission path with a Codex-compatible reply envelope; do not send an interaction RPC.
- Codex's blocking request panel uses a plain-text `CardHeader`, so it is not a precedent for Markdown in async question titles. Reuse OpenCraft's existing assistant Chat Document pipeline and resource policy at the card presentation boundary; the form remains owner of answer state.

## scan_scope
- Bounded OpenCraft chat-core/runtime/Web renderer and exact bundled Codex `00c972e` sources.

## scan_output
- No separate artifact; source anchors recorded above.

## handoff
- Local implementation and automated validation complete. User authorized running Web replacement; assets were hot-switched without restarting the active Host. No commit or push authorized. Physical mobile acceptance remains.
- The Markdown-title follow-up is source-only in the current checkout. It has not replaced the running preview and has not been committed or pushed.

## checkpoint
### stage
- Protocol, shared projection, Web card and Host submission path implemented; cross-platform gate passed.
### verified
- Device type is not a protocol selector. The async tool emitted by Codex is a replayable AgentMessage item, distinct from blocking server requests.
- Stable per-index question IDs, structured reply, ordinary follow-up dismissal, uncertain/failed delivery, and card markup have focused tests.
- Isolated archive SHA-256: `afaf0cde73a242745d241e0c008ca4183be3abce5544fd240d64ea0a16302537`; new buildId `20260927044131-36119ed931e2`.
- Live `/version.json` and HTML meta report the new buildId, referenced JS returns HTTP 200, and `/__opencraft_health` reports healthy. Host MainPID remained `454692`.
- A real `request_user_input_async` test question was accepted after cutover; phone-side card visibility/answer is awaiting user observation.
### unverified
- Physical mobile interaction with a newly generated async question; already-open pages must reload to load new JS.
### discard
- The earlier HEIC diagnostic is unrelated to this task.
### restore
- Preserve dirty activity renderer, gateway doc and HEIC files. Old Web directory is recoverable at `/opt/opencraft-server/releases/20260927025646-33abd12d5ad6/web.before-20260927044131`; `current` points at `/opt/opencraft-server/releases/20260927044131-36119ed931e2`.
### next_action
- User refreshes the phone page and exercises a new async question. If live UI fails, restore the old Web directory and `current` pointer through a checked rollback; do not touch the persistent data directory.
- For the 2026-09-30 title follow-up, run `smoke:async-question-markdown` in an environment with Playwright/Chromium, then publish a separately authorized Web preview before claiming phone acceptance.

### 2026-09-30 Markdown-title checkpoint
- Stage: shared Web Chat Document is wired into async question title presentation; card still owns only answer controls and state.
- Verified: 439 Chat tests, Web/Web-renderer typechecks, platform boundaries, fixture bundle, Web build, `git diff --check`, and repository documentation validation passed.
- Unverified: real browser/phone link and form interaction; no running preview replacement. Playwright is absent and local Chromium lacks `libgbm.so.1`.
- Restore: preserve the current dirty worktree and live build `20260930-bubble-handoff`; do not restart the conversation-bearing service for this source-only change.
- Next: run the dedicated browser smoke where dependencies are available, then obtain explicit preview-replacement authorization if the user wants to test on phone.
