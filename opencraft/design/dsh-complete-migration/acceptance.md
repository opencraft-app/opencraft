# Complete DSH migration acceptance

| Original requirement | Implementation | Executed proof |
| --- | --- | --- |
| bindTurn, epoch, write lease, late native start | Source execution tables/journal and lease table, connection-aware dispatch, request-token gate, durable identities and queues | Authority/native-admission tests; stale epochs, competing owners, overlapping edits, reconnect; real queue and whole-Host restart |
| Host capabilities and Skills | Engine plugin, owner/epoch broker, link, scoped providers, private Skill files, exact Schema validation and native attachments | Real DSH→WebSocket tool→DSH; cancel/timeout/spoof tests; model/history images; native Skill discovery/reload/revocation; real Workbench browser open/list/wait/inspect |
| Checkpoints and surface generations | Source advanceSurface/surfaceToSeed, atomic flush-first store, durable creation intent, staged routing and native history index | Surface/commit-gap/route tests; real generation race and restart; actual SIGKILL between native flush and checkpoint commit recovers exact generation |
| Thread/history/Item/queue/Skill translation | Logical transport, copied page projection and persistent queue, complete scoped metadata | Stable Item IDs across restart; page/cursor/view tests; paused whole-Host queue restore and explicit start; pre-conversation and forced Skill discovery |
| Effective permissions | Runtime service reads, canonical setters, preset composition and custom knob restoration; external event evidence | UI selection matches native log; real switches; restored read-only Agent attempts write and is denied; missing evidence rejects |
| Classifier, pacing, telemetry | Full source classifier and pacer controller, ordered client delivery, payload-free bounded diagnostics | 130 classifier tests; source pacer tests; Unicode/drain/cancel/dispose; telemetry exclusion test and actual host diagnostics |

## Final evidence

Full npm run gate passed. Source parity check matched 84 imported methods;
this proves copied-method fidelity, not inclusion of unrelated cloud services.
Real host smoke passed after runtime installation completed. An earlier
parallel test hit temporary module absence during installation; it was rerun
without weakening assertions.

The real engine checkpoint-crash test passed with
OPENCRAFT_DSH_CRASH_CHECKPOINT=1. Production Workbench UI verified permission
selection, browser actions/page content, subsequent sends, reload, BFCache and
unload. Final Electron build, arm64 package, ad-hoc codesign and native root/
composer startup passed. Diff and documentation checks passed.

## Boundaries

OpenCraft retains product models/credentials, local process transport and UI
identity. HyperNode SSH tenancy and cloud gateways are not local host behavior.
Unsupported audio is explicitly rejected, not discarded. DSH file policy does
not claim a Codex OS sandbox. No arbitrary tool-result URLs are fetched.
All model/fault tests used isolated local endpoints and synthetic keys.
No user logs/config were migrated or erased; no commit/push/release occurred.

Preview: apps/workbench-electron/release/dsh-complete-migration-preview/mac-arm64/OpenCraft Preview.app.
