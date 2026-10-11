---
id: reasoning-preview
type: task
scope: Deliver returned-thinking disclosure into the current self-hosted Web preview without interrupting backend work.
triggers: ["reasoning preview", "思考展开预览", "thinking preview replacement"]
owner: skipzhang
authority: derived
source_of_truth: ["opencraft/docs/build-matrix.md", "opencraft/scripts/serve-workbench-web.mjs"]
status: retired
reviewed_at: 2026-10-08
review_due: 2027-01-06
revision: 1.0.0
precedence: task
derived: true
---

## goal
Apply the completed reasoning disclosure to the actual current preview, preserving its later auto-connect, Bot/draft and reconnect changes.

## non_goals
No desktop-motion dirty source, commit/push/merge, production/GitOps change, credential read/export, paid inference, data copy or backend restart.

## requirement_ids / requirement_refs / requirement_excerpt
Unknown external identifier; direct user authorization: “替换预览。”

## interface_refs / data_structure_refs
Headless Web version/buildId, serving root, hashed static asset inventory, package manifest, runtime digest, listening PID/unit and independent release switch/rollback owner. Hermes reasoning changes enter the browser plugin bundle, not server.mjs.

## history_context
current_design_refs: OpenCraft build-matrix headless delivery, self-hosted preview skill and returned-thinking contract in ChatUI architecture.
relevant_evolution: Current live build is 20261008-codex-auto-connect-chat-drafts, not the previous chat-desktop build. Its Web matches the current preview-source dist exactly; later reconnect/timeout source overlays are preserved. Source task has 555 chat tests and 12 Chromium combinations passing.
superseded_refs: Old recorded chat-desktop PID/unit and all-dirty reasoning-task dist are not current delivery inputs.

## required_context / context_receipt
Router query `opencraft self-hosted preview reasoning disclosure replace running preview` unmatched; bounded search of preview tasks, headless scripts and actual current preview provenance. Read root/OpenCraft AGENTS, maintenance and self-hosted-preview skills in full, maintenance verification, build-matrix headless section, task/checkpoint templates, reasoning source task, previous source integration/delivery tasks, current PROVENANCE/prepare/switch scripts. Adjacency frontend-runtime-openspec-i18n read with frontend/scripts/build-release-artifacts.test.ts neighbor to verify isolation/cleanup discipline. No credential/environment values read.

## decisions
Create an isolated snapshot of the exact current preview source and install dependencies there. Apply only the nine production reasoning files as hunks; preserve current locale, Composer and Hermes additions. Build headless Web only. The runtime does not consume changed Hermes source, so keep PID/unit/runtime/data unchanged and replace static Web with retained rollback. Preserve old hashed assets during the transition so existing clients can still load their chunks.

## acceptance / validation
Candidate Core/Web/Hermes checks, focused reasoning/Hermes and actual Conversation smoke. Headless release metadata and all static resource hashes validated. Package/isolated candidate startup and actual built page checked without real inference. Live post-switch version/assets/health checked; PID/unit/runtime hash unchanged, old Web retained for rollback.

## affected_paths / scan_scope
Nine reasoning production source paths already recorded in reasoning-disclosure task; tests/fixture only in isolated candidate. This receipt is the only new repository change. Candidate scripts and build output remain outside Git.

## scan_output
Private preview staging receipts only; no transcript or payload export.

## evidence
Port 80 PID 3260340 belongs to opencraft-codex-auto-connect-20261008-preview.service, cwd <private preview artifact>. Live Web 491 files exactly match current source dist. Runtime SHA-256 e563d171462a9d39df5e80dee16054b87b104dbe228840d2700ab3fc9d5af11a. Independent read-only review confirms nine source changes are Web-only and nonoverlapping with later preview changes.

Candidate snapshot has 3324 baseline source files and its own locked npm installation; guard confirms only eight existing production files plus the new reasoning.ts changed, with four modified tests/two new test-only smoke files. Core/Web/Hermes types, boundaries/typography/i18n passed; focused tests 241/241 and real Conversation smoke 12/12 passed. Headless Web release built as 20261008-reasoning-current-preview. Isolated real package runtime startup passed health and built-page synthetic reasoning acceptance at widths 1280/390: default folded, first activation, summary-only and separate tool fold. No model request was sent. Fixture failures were resolved by matching the queried WebSocket URL and supplying generated goal/resume contract fields (including approvalsReviewer); no product code/assertion was weakened.

Independent systemd supervisor performed an atomic Linux directory exchange and updated the package manifest. At 2026-10-08T08:23:32.721Z, switch-status is verified/switched: live build 20261008-reasoning-current-preview; all 535 served static file digests match, including 44 retained old hashed assets. Live built-page loads at 1280/390 pass without page errors, missing assets or inference. PID 3260340, unit/cwd/runtime digest/data directory unchanged; backendRestarted=false. Original Web is retained at the incoming swap path, original manifest in the private stage. Rollback script exists; no failure was injected into the running service. Documentation link check passed with zero broken links; task metadata and diff checks passed. Source remains uncommitted; no push/merge.

## risks
Real iPhone/provider acceptance remains pending. Existing full-repository baseline failures remain as recorded by source task. Refuse a switch if live owner/build/runtime changes while preparing; keep prior static files and manifest recoverable.

## handoff / stage
Preview delivery complete. Only static Web and its manifest were replaced; the original backend continues running. Current page requires a refresh to load the new renderer. Prior desktop dirty work and later current-preview changes were preserved.

## verified
Actual live baseline, scoped source preservation, candidate build/component/product acceptance and live post-switch identity/assets/browser checks confirmed. Backup Web and manifest retained. No backend restart, paid inference, data migration, production or Git publication.

## unverified
Real iPhone OS/provider behavior and broad baseline repository failures remain outside this preview delivery. Independent rollback path is implemented, but no live failure-injection drill was performed.

## restore
Do not modify original source worktree or backend. Candidate stage <private preview artifact> contains BASELINE.json, WEB-PREPARED.json, CANDIDATE-VERIFIED.json and switch-status.json. Live Web <private preview artifact>. Original Web <private preview artifact> and original manifest at stage/manifest.before.json remain recoverable. Refuse unrelated ongoing runtime/preview changes rather than overwriting them.

## next_action
User refreshes the existing preview and checks returned thinking content. Source commit/push/merge, future preview replacement or backend restart requires separate authorization.
