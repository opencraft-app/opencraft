---
id: codex-summary-default
type: task
scope: Enable returned Codex summaries by default at the native request boundary while preserving explicit choices and Hermes behavior.
triggers: ["codex default summary", "默认请求思考摘要", "enable returned thinking"]
owner: skipzhang
authority: derived
source_of_truth: ["opencraft/apps/opencraft-daemon/src/codex-engine-adapter.ts", "opencraft/docs/chat-ui-architecture.md"]
status: retired
reviewed_at: 2026-10-08
review_due: 2027-01-06
revision: 1.0.0
precedence: task
derived: true
---

## goal
Codex requests a readable summary by default when an OpenCraft native turn/start omits its summary option, including existing conversations and Host-owned queued starts. Actual returned text remains independently collapsed by default.

## non_goals
No preview replacement/restart, commit/push/merge, provider inference, credential/profile copy, model binary modification, opaque decoding, fabricated reasoning or desktop changes. No new UI switch and no provider-independent summary field injected into Hermes/DSH.

## requirement_ids / requirement_refs / requirement_excerpt
Unknown external ID; explicit user request “那你加一下吧，然后hermes默认就有的是吧”.

## interface_refs / data_structure_refs
Native turn/start.summary generated ReasoningSummary, CodexEngineAdapter physical writer shared by client requests and Host queue; explicit null native inheritance and explicit mode choices. Hermes reasoning.delta/history projection and provider-dependent returned text.

## history_context
current_design_refs: ChatUI Returned thinking content and platform Codex routing/package ownership.
relevant_evolution: [codex-summary-request](2026-10-08-codex-summary-request.md) proved actual seven current-thread rounds summary=none, client omits summary, proxy preserves bytes. Reference App requests summary via native protocol, not by exposing opaque content.
superseded_refs: Synthetic disclosure acceptance and older Rust model defaults do not prove real-provider availability.

## required_context / context_receipt
Root/OpenCraft AGENTS retained current investigation; maintenance SKILL and verification reread completely, templates/history/ChatUI/platform ownership and relevant adjacency retained from preceding diagnostic. Router `opencraft returned thinking summary request default Codex Hermes composer appserver` unmatched; bounded compiler/command-port/runtime searches located direct and queue paths. Guessed queue-enqueue/server/native-surface paths absent; actual test import locates Codex daemon adapter. change-impact mapping read; formal agent-gateway runtime design will be updated. Existing dirty worktree and exact live version recorded and preserved. No external provider call or broad reference scan.

## decisions
Keep default policy Codex-specific at the single physical native request boundary, not in generic Composer selections/renderer or Hermes/DSH. Add auto only to turn/start requests without a summary field; preserve explicit null/none/concise/detailed/auto and malformed values for native validation. Do not add unsupported fields to turn/steer, thread/start/fork/resume or queue protocol. All client and Host queue starts already use this writer; existing conversations switch at their next ordinary start. Native model capability controls whether an actual upstream summary parameter/text is supported.

## acceptance / validation
Adapter integration tests capture actual physical outbound requests for normal/new/fork/resume/empty continuation, queue starts, explicit choices, steer/non-start invariance and local/remote transport paths. The new suite is included in test:appserver. Relevant adapter/queue/SSH tests, daemon types and boundaries. Actual native summary event conversion and both physical stream paths use synthetic input, no real-model call; retain separate real-provider and iPhone acceptance boundary.

## affected_paths
Codex daemon adapter; scoped new adapter tests and test:appserver registry; ChatUI/formal domain documentation and this receipt. Preserve earlier reasoning/desktop edits.

## evidence / verified
Current branch integrate/opencraft-desktop-master-20261006 remains dirty/behind origin; no pull/reset. Existing dispatchQueuedStart uses requestPhysical(turn/start), direct clients and internal requests share writePhysical. Native generated summary enum permits auto and explicit null inheritance. Hermes reviewer confirms default reasoning.delta/history projection and ordinary Responses summary auto, but provider/model/config can yield no readable text; reasoning.available is only a body preview and is ignored.

The implemented writer only adds summary=auto to turn/start with a valid request ID and without an own summary field, cloning both message and params. Each missing-field start reapplies the product default, even after an earlier none; explicit null retains native inheritance. Independent owner/routing review found no second summary cache and no Hermes/DSH injection.

Verification on 2026-10-08: daemon tsc --noEmit passed; dedicated codex-reasoning-summary suite 10/10; complete test:appserver 268/268 plus SSH 75/76 (one isolated real-sshd case skipped because sshd is unavailable); earlier adapter/queue/command subset 49/49. Typography/platform boundaries, scoped formal docs impact and diff --check passed. All regression requests are synthetic/loopback; no real-model inference.

Hermes projection/plugin and Native returned-reasoning disclosure suites additionally passed 114/114, including genuine reasoning, durable alternatives, body-preview rejection and default folding. These unchanged-surface tests emit pre-existing i18n/Node warnings but no failures; they do not establish a live Hermes provider's current configuration or guarantee text generation. Task metadata/local links and the final scoped docs-impact check passed.

Current native codex-cli 0.160.0 was separately accepted with fresh private CODEX_HOME/workspace and user/network namespace containing only loopback with no routes. No credentials, account profile or model catalog was copied. Its own gpt-6.1-sol catalog accepted turn/start.summary=auto; exactly one local synthetic Responses POST contained reasoning.summary=auto. Synthetic delta/done yielded one native summaryTextDelta and one completed reasoning Item with one summary part, matching synthetic text, zero raw content parts; turn completed, unexpected HTTP count zero. Safe receipt and isolated script are in <private validation evidence>. This verifies native request/event support, not real-provider summary generation.

Live read-back still reports buildId 20261008-reasoning-fold-preview and MainPID=3260340, ActiveState=active. No preview files, service or runtime configuration changed.

## unverified / risks
Explicit null continues native inheritance and may still be none, intentionally not rewritten. Already-running turns and old encrypted Items are not modified. Deployment requires a fresh scoped runtime package because this is Host code, not another Web-only swap. Real-provider summary generation and iPhone interaction remain unverified until separately accepted. No deploy, restart, commit, push or merge was performed.

## scan_scope / scan_output
Named native adapter/compiler/runtime/test files and synthetic output only. No transcript, secret, opaque payload or profile copy.

## handoff / stage
Source implementation and scoped validation complete; not deployed. Existing returned-text disclosure stays initially folded and independent of tool activity.

## restore / next_action
At an explicitly authorized preview replacement, package this Host change against the exact current runtime baseline; do not deploy the entire dirty checkout or perform a Web-only swap. Then verify a new ordinary turn's summary request and actual returned text. Until then keep current live preview unchanged.
