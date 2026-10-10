---
id: codex-summary-request
type: task
scope: Trace current Codex summary availability through request settings, model defaults and the local proxy.
triggers: ["codex summary request", "查为什么没有思考摘要", "reasoning summary default"]
owner: skipzhang
authority: derived
source_of_truth: ["opencraft/packages/composer-appserver/src/command-port.ts", "opencraft/packages/account-pool-host/src/codex-proxy.ts"]
status: retired
reviewed_at: 2026-10-08
review_due: 2027-01-06
revision: 1.0.0
precedence: task
derived: true
---

## goal
Find why the current real Codex conversation has no readable returned reasoning summary; distinguish unrequested summary from adapter loss or unsupported model behavior.

## non_goals
No product/configuration change, restart, deployment, credentials inspection/output, opaque decryption, transcript export or paid model call.

## requirement_ids / requirement_refs / requirement_excerpt
Unknown external ID; user explicitly authorizes further diagnosis with “查一查”.

## interface_refs / data_structure_refs
Codex TurnStartParams.summary, selected model default_reasoning_summary/supports_reasoning_summary_parameter, Composer compiled turn options, Account Pool request bytes and upstream response stream, safe active-process/settings metadata.

## history_context
current_design_refs: OpenCraft Returned thinking content design and agent-gateway-runtime authority boundaries.
relevant_evolution: [reasoning-live-availability](2026-10-08-reasoning-live-availability.md) found no readable text in 111 current-thread reasoning Items and differentiated liveness/tools/text disclosure.
superseded_refs: Synthetic UI/adapter acceptance does not establish actual provider summary availability. Older recovered App and Rust checkout defaults must be version-qualified.

## required_context / context_receipt
Root/OpenCraft AGENTS and maintenance/verification retained from the immediately preceding diagnosis; Task/Checkpoint templates, ChatUI returned-thinking/platform ownership and frontend-runtime-openspec-i18n adjacency previously read. Current router matches agent-gateway-runtime; that must_read pack read fully. OpenAI Docs skill read in full and announced; no route reference needed for read-only diagnosis. Official search tool failed with Account Pool route 404; direct official config-reference fetch and official reasoning guide fetch both HTTP 403, so no fetched official documentation claim. Local source/config/version evidence is authority for this machine. Guessed codex-host/headless-server/core compiler/appserver compile-submit-intent paths were absent; bounded known directories and actual imports replace guesses. No blanket ref scan, credential reads or model call.

## decisions
Inspect the actually running binary/version and exact whitelist of summary-related overrides, not installed-shell version alone. Local proxy review tests only synthetic bytes and SSE, using no model. Reference agent distinguishes recovered App, official local Rust checkout and runtime binary versions.

## acceptance / validation
Safe current-thread setting metadata, deployed Composer summary field, actual model/default evidence if obtainable, and proxy request/response preservation. Explain unresolved boundaries when evidence cannot establish them.

## evidence / verified
Actual Codex child PID 3260434 of preview subtree runs codex-cli 0.160.0 from current live package. CODEX_HOME is the original runtime directory. Global whitelist config is model gpt-6.1-sol/effort high; startup whitelist contains only model_provider opencraft-account-pool, no summary override. No model cache file found at runtime depth 2.
Independent proxy reviewer: launch only sets provider/proxy/auth transport settings, proxy forwards original request bytes and response stream without summary modification. Existing launch test 1/1 and synthetic request/SSE/loopback checks 3/3 passed without model calls or file writes.
Local official Rust checkout inspected by reference agent is rust-v0.157.0, not runtime 0.160.0; its model defaults and request gates are corroborative, not exact runtime proof.
Current-thread rollout whitelist inspection found seven turn_context records since 2026-10-08T08:00:00Z, all summary=none, model=gpt-6.1-sol, effort=ultra; agent_reasoning/agent_reasoning_raw_content event counts both zero. Only fields/counts were printed, not reasoning/user/tool content. Global effort high is not the active conversation's inherited ultra setting.
Deployed compiler.ts:275–302 constructs turnOptions with model/effort/permissions/cwd/serviceTier/personality/outputSchema only, no summary; command-port.ts:252–262 sends those options to turn/start. Generated TurnStartParams.ts:99–101 exposes summary override for this and subsequent turns; generated ReasoningSummary permits auto/concise/detailed/none. This proves the effective summary is disabled and our client does not actively request one; it does not prove why every inherited/model default initially selected none.
New reference App 26.930.31428/build12913 with CLI metadata 0.160.0: app-shared-e760024b6716.js Irn:26283–26291 supplies detailed when concurrent_reasoning_summaries is enabled or the Aeon path applies. chunk_Trn.js:162–201 resolves recent/thread/feature/config/explicit request values and writes summary into the request. Reference agent checked original unpacked bundle byte offsets 2941620/2948537; root read restored exact entry and resolver. No inference that this account enables that feature or that every model returns summaries. Rust 0.157 client gate depends on model support and non-none selected setting; its catalog has no gpt-6.1-sol and cannot establish that runtime model's declaration.

## unverified / risks
Actual per-turn effective setting is proven none. Exact runtime-selected model default/support and real upstream acceptance of an enabled summary request remain unverified; no inference call was made. No transient real wire body logged. Current model/provider support cannot be inferred from a different reference version or encrypted payload presence. Official documentation fetch failed, so no official webpage was cited as verified authority.

## affected_paths / scan_scope / scan_output
Diagnostic receipt only. Named local Composer/account-pool source, safe process/config metadata, current-thread settings counts and bounded reference files. No exported text/opaque payload/secret artifact.

## handoff / stage
Read-only diagnosis complete: summary is effectively disabled and the deployed client omits the summary option; the proxy is not stripping it. Live /version.json remains 20261008-reasoning-fold-preview. No product/configuration mutation or backend restart.

## restore / next_action
If the user authorizes implementation, resolve a Codex summary policy at the existing request boundary through supported turn/start.summary, retaining host configuration/model support and sticky-thread semantics; do not rewrite the binary, create an empty UI button or decrypt opaque data. Verify first with synthetic request/stream/native-event acceptance and then separately authorize/accept a real provider response. Existing historical none Items cannot gain text retroactively.
