---
id: checkpoint-2026-10-04-opencraft-loading-performance
type: task
scope: 第一批嵌入启动优化的恢复与交接状态。
triggers: ["opencraft startup checkpoint"]
owner: wisp/mono2-maintainers
authority: derived
source_of_truth:
  - docs/context/tasks/2026-10-04-opencraft-loading-performance.md
status: active
reviewed_at: 2026-10-04
review_due: 2026-11-04
revision: 1.0.0
precedence: task
derived: true
---

## stage
Feature commit ee7ddd3f9 pushed; MR !4961 created (global ID 27556291), target master. First platform readback: opened/can_be_merged, commit_check_state=success, commit_check_block=false. Normal merge is authorized; later readback must establish actual merged state and master ancestry. TAPD is moving to awaiting acceptance, not done; public preview, Fanny/owner CR and production deployment are not completed.
First batch implemented and second-batch optional startup implemented. Same-Application deferred lane, module/factory retirement fencing and bounded loads preserve Supervisor ownership. Earlier source typecheck and embedded release build passed; 26 startup/lifecycle and 132 related regression tests passed. Latest user explicitly authorized commit, push and MR merge to master. Production release/restart remains outside scope. Changes are isolated onto perf/opencraft-embedded-startup-20261004 at master bbd7ffb83 for fresh verification, retaining upstream loader deadlines and browser storage options.
Readiness failure reproduced on unchanged first-batch artifact: TAT/session succeeds, PtyReady and a 7631-byte input occur, but no ensure completion marker and no AppServer initialize. At ~75 seconds Host connect fails at the ensure deadline. Diagnostic-only prompt-gated A/B succeeds, strongly supporting an early long-line PTY input race. Final optional artifact without that diagnostic gate still reproduces cold/warm >40s; do not claim Host stability fixed.

## task_contract_refs
- requirement_ids / requirement_refs / requirement_excerpt：本轮三项要求，精确授权摘录见主 Task Pack。
- interface_refs / data_structure_refs：共享资源 loader、Web Application、Proxy Broker 与 BrowserPageRuntime。
- history_context / current_design_refs / relevant_evolution / superseded_refs：沿用主 Task Pack 的正式架构和线上证据，不把禁用 SW 的实验当设计。
- context_receipt：实际阅读与用途完整列于主 Task Pack；本文件只记录续接状态。

## verified
- Delivery branch fresh checks: 18 startup/ownership + 28 related/real-PTY + 8 frontend tests pass; Web tsc, frontend check (0 new diagnostics), boundaries, Agent Console sync (130 files), cn Next export, embedded release, staged docs-impact and real Chromium narrow-SW smoke all exit 0. The unchanged extension-artifacts test fails its artifactRef assertion and hangs; full extension gate is not green.
- Enabled host Chat route starts the same resource loader before Bot readiness; no speculative Application/Host.
- Proxy start no longer blocks shared Application creation. Specific registration activation replaces document.ready.
- Remote preview navigation is independently gated, with stop/close/replacement/disposal fencing.
- Embedded hashed assets have one-year immutable headers; stable loader/version/bridge/SW have no-cache.
- OpenCraft 25 focused tests and frontend 21 focused tests passed; both relevant typechecks and isolated embedded release build passed.
- Real Chromium Worker + Broker + iframe/HTML/CSS proxy passed outside the document scope, including stopped/closed pending pages.
- Actual embedded build with 8-second artificial register delay became visible before proxy initialization finished; one canvas/editor/TAT connection. Only browser routes changed, auth session revoked204. This is not the full updated frontend performance benchmark.
- Platform boundaries passed. Upstream check has pre-existing i18n drift; changed frontend loader/page are not in that generated closure.
- Formal architecture and mapped engineering domain updated; explicit changed-file docs-impact passed (staged set is empty).
- Full cn production-combo Next export in isolated snapshot passed; default checkout artifacts preserved. Three cold/warm pairs under 100ms added latency / 10Mbps down passed: editor median cold9775ms, warm6176ms; session-list median cold9824ms, warm6228ms. Warm embedded resources32/33 cached, entry no-cache; single element/canvas/TAT connection.
- Second batch runtime: two cold/warm pairs on isolated updated embedded artifact + complete frontend, real authorized API/TAT. Cold editor5937/6049ms, warm5376/5517ms; voice request starts after visible chat and is artificially delayed8003ms on both cold runs. Core extensions active at first paint; optional voice/collaboration/Bot extensions subsequently active, Terminal panel subsequently registered, one canvas/TAT throughout. Final hardening additionally aborts factory scopes when Supervisor's own deadline settles. That final artifact without prompt gate still fails cold/warm at40s; with diagnostic-only prompt gate, cold5942ms + warm succeed and all optional extensions/Terminal register. The latter verifies optional scheduling, not unmodified Host stability.
- Platform/typography boundaries, explicit changed-file docs-impact and documentation links passed (0 broken first-party links). Staged set empty, not an implementation gate.
- Local synthetic real PTY probe: 7631-byte command submitted before delayed interactive shell starts does not execute; after shell's bracketed-paste readiness it executes. This supports but does not alone prove the remote race.
- Diagnostic-only actual prompt wait on unchanged baseline: 4/4 loads succeed, two real ensure inputs wait56/45ms, READY received; Host1286/1111ms on those cold runs. Warm runs adopt the backend. Remote ICANON state not directly read, so truncation mechanism remains inferred rather than directly observed.

## unverified
- Real phone, production CDN/cache and post-release latency are not verified. Failure is located inside Host ensure before initialize, not optional extension loading; prompt-gated A/B supports early-input race but doesn't directly measure remote shell truncation. Optional deferral does not repair this Host failure; do not compute a success-only overall stability matrix.
- First unthrottled diagnostic session could not be revoked after its auth port-forward died; token lost with process. Its 30-minute impersonation TTL is the fallback, not confirmed immediate revocation. Read-only recovery DB path unavailable; no database record modified. Other sessions revoked204, diagnostic processes closed.
- Broad tests/context audits have scope-external failures; frontend full run ended with controlled SIGINT after a busy worker failed to finish. See Task Pack; do not claim full gate passed.

## discard
- Do not interpret synthetic resource-load owner count as a production Application count.
- Do not use diagnostics that disable ServiceWorker as the implementation.

## restore
- Task evidence: 2026-10-04-opencraft-loading-performance.md.
- Final isolated build: /tmp/opencraft-startup-20261004-final.
- Second batch hardened build: /tmp/opencraft-optional-startup-20261004-verified. New source/tests: optional-feature-startup.ts and optional-feature-startup.test.ts.
- Diagnostic-native.json: latest85-second observations, two failed samples at Host~75.54s; diagnostic-optional.json contains final unmodified artifact cold/warm40s failures (earlier successful2-pair values retained in Task Pack/tool evidence). Diagnostic-prompt.json: baseline prompt-gated A/B. Diagnostic-optional-verified.json: completed final optional verification with explicitly diagnostic prompt gate. All current run sessions DELETE204, browsers/loopback static servers/port-forwards closed. All files contain safe metadata, not PTY text/token.
- Complete updated snapshot, artifacts, measurement harness and results: /tmp/mono2-startup-benchmark-bzrXhq; results.json controlled matrix, results-native.json timeout reproduction. Successful native first-series console evidence is recorded in Task Pack (that run exited before result file write).
- Node: /opt/opencraft-server/releases/20260927044131-36119ed931e2/bin/node.
- No production state modified; dirty worktree contains many unrelated changes to preserve.

## next_action
Handoff complete: optional implementation verified; Host failure localized and early-input race strongly supported by bounded A/B, not fixed. Next implementation decision is reliable Host bootstrap delivery/acknowledgment (do not copy diagnostic Bash prompt as POSIX contract). No deploy or CTL/account edits authorized.
