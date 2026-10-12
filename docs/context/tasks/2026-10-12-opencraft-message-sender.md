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
fixtures establish code behavior, not actual employee gateway coverage. The sender change is deployed in the running preview using an additive overlay
on its actual runtime; the current Web assets and data directory are preserved. Footer MR !5235 has merged as 52897784a; sender MR !5252 is waiting for
protected review. Do not bypass the review gate.

## validation evidence
Final focused sender/identity/Host/adapter/attachment tests passed (62 tests).
Shared Chat/attachment regression suite passed (141 tests), including hidden
author preservation without visible-text changes. Headless compatibility passed
(31 tests). Daemon, AppHost, client, protocol, Chat core and Web typechecks passed;
platform boundaries, i18n and formal change-impact validation passed. Headless
runtime bundle built successfully. Own native node-pty rebuilt for runtime tests.
All identity fixtures use synthetic keys and users; no real employee inputs or
model inference are used. Source is on feat/opencraft-message-sender-20261012;
source commit a7321adf5 is pushed in feat/opencraft-message-sender-20261012 and
reviewed separately in https://git.woa.com/wisp/mono2/-/merge_requests/5252.
Normal merge API returned `Review check not passed. 409 conflict`. The sender runtime cutover completed and was verified on 2026-10-12. Web typecheck requires the shared source packages
to resolve the same isolated worktree dependencies; an untracked root node_modules
link points to this checkout's own opencraft/node_modules, without borrowing another
worktree or changing the lockfile.

## running preview delivery
User authorized deploying into the running preview. Independent systemd unit
`opencraft-message-sender-cutover-20261012` completed with CUTOVER_VERIFIED and
exit status 0; rollback to the previous runtime was prepared before switching.
Running unit: opencraft-migrated.service, verified PID 2857330. Runtime entry:
`/data/tmp/opencraft-message-sender-preview-20261012/opencraft-server/runtime/server-message-sender.mjs`.
SHA256: 88bc493cb73c0631e20ad85ac24a3b85021756f109222a8deee919fc169e090a.
Preserved Web build: 20261012-tasks-header-preview-r2 (2e3958578).
Preserved data directory: /data/opencraft-migration-20261009/data.
Package-level fixtures verified first A / steer B / queued A dispatched by B,
spoof and collision rejection, clean native model inputs, signed WebSocket
connection isolation, anonymous unknown, native SSH and Desktop wire compatibility.
Live post-reconnect checks verified PID, unit, working directory, runtime hash,
health, unchanged Web version, signed identity isolation with synthetic accounts,
missing/invalid signatures rejected, and native SSH banner on public port 80.
No synthetic user messages were submitted into the live data directory.
Deployment receipt, guarded overlay builder, cutover/rollback script and probes:
`/data/tmp/opencraft-message-sender-preview-20261012/`. Master merge remains
subject to MR !5252 protected review; preview deployment does not bypass it.
