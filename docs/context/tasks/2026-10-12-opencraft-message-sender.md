---
id: opencraft-message-sender-20261012
type: task
scope: Verified per-user-message employee provenance for Codex Hosts.
triggers: ["message sender", "employee provenance"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth: [opencraft/apps/opencraft-daemon/src/, opencraft/scripts/serve-workbench-web.mjs]
status: active
reviewed_at: 2026-10-12
review_due: 2026-11-12
revision: 1.0.0
precedence: task
derived: false
---

## requirement
User authorized implementation after reviewing the model. Corrections: reuse the
existing SQLite file, no separate sender database; persist the English employee
login name only, no staff ID. Identity is metadata attached to individual user
messages, not a Turn-level author or model prompt.

## context receipt
Root/OpenCraft AGENTS, maintenance skill and verification reference read. Context
router query `opencraft message sender identity apphost tencentoa` returned no match;
bounded searches located AppHost gateway, routing, Codex queues and message
attachments. Formal architecture and Tencent OA documentation establish ownership.

## implementation decisions
WebSocket handshake verification yields an immutable server-side submission context.
AppHost carries it through an optional in-process contextual transport port; no
Renderer field establishes identity. Codex Host stores immutable author snapshots
in a new table of existing codex-host-queue.sqlite, with one shared transaction
owner for queue admission. Stable per-Host directories separate identical Thread
and message IDs on different machines. Historical sender snapshots remain valid
independently of connection expiry. Failed dispatch records are not proof of delivery.

Queue edits preserve original submitter; no editor audit is introduced. Native
legacy inputs without client IDs remain unattributed; employee submissions require
one. Native model input receives no employee sender. Shared history traversal is
reused by attachments and sender metadata; Chat normalization preserves individual
message authors, including steering rather than borrowing the Turn author's name.

## acceptance
Signed WebSocket handshake + separate connection identity even with duplicate
Renderer IDs. First message A, steering B, queued A dispatched by B stays A/B/A.
Spoofed fields ignored; conflicting message identity and expired credentials reject.
Queue admission rollback includes sender; one SQLite file; reopening and fork
mapping; live/paged/resumed/shared Chat projection; ordinary attachments unchanged.
Relevant typechecks, boundaries, i18n and identity/Host/Chat regressions required.

## operational boundary
Real gateway header forwarding is deployment-specific; signed local WebSocket
fixtures establish code behavior, not actual employee gateway coverage. Previous
employee-footer preview is live, but this sender change is not deployed yet. Remote
footer MR !5235 is waiting for protected review; do not bypass the review gate.

## validation evidence
Final focused sender/identity/Host/adapter/attachment tests passed (62 tests).
Shared Chat/attachment regression suite passed (141 tests), including hidden
author preservation without visible-text changes. Headless compatibility passed
(31 tests). Daemon, AppHost, client, protocol, Chat core and Web typechecks passed;
platform boundaries, i18n and formal change-impact validation passed. Headless
runtime bundle built successfully. Own native node-pty rebuilt for runtime tests.
All identity fixtures use synthetic keys and users; no real employee inputs or
model inference are used. Source is on feat/opencraft-message-sender-20261012;
delivery continues through existing employee-identity MR !5235. No sender runtime
cutover has been performed. Web typecheck requires the shared source packages
to resolve the same isolated worktree dependencies; an untracked root node_modules
link points to this checkout's own opencraft/node_modules, without borrowing another
worktree or changing the lockfile.
