---
id: reasoning-live-availability
type: task
scope: Diagnose why the current Codex Thinking label does not expose returned reasoning text.
triggers: ["thinking unavailable", "思考中没有箭头", "live returned summary missing"]
owner: skipzhang
authority: derived
source_of_truth: ["opencraft/packages/chat-core/src/reasoning.ts", "opencraft/apps/workbench-web/src/components/conversation.tsx"]
status: retired
reviewed_at: 2026-10-08
review_due: 2027-01-06
revision: 1.0.0
precedence: task
derived: true
---

## goal
Explain the user's live observation that one Thinking label is not interactive and another expands tools, without claiming synthetic summary acceptance proves actual provider availability.

## non_goals
No product implementation, deployment, restart, configuration mutation, paid inference, credential reads, reasoning/transcript export or decryption of opaque content.

## requirement_ids / requirement_refs / requirement_excerpt
Unknown external ID; user asks whether Thinking can expand and reports both no-arrow/no-response and tool-only expansion.

## interface_refs / data_structure_refs
ReasoningBlock, presentReasoning, thread-thinking-placeholder, AgentActivityGroupDisclosure, returned reasoning summary/content presence, current-thread read-only rollout structure.

## history_context
current_design_refs: opencraft/docs/chat-ui-architecture.md#returned-thinking-content and design/invariants.md timeline ownership.
relevant_evolution: [reasoning-fold-preview](2026-10-08-reasoning-fold-preview.md) delivered build 20261008-reasoning-fold-preview and synthetic acceptance, explicitly excluding real-provider acceptance.
superseded_refs: Do not infer provider-returned text from synthetic fixtures or equate the tool work-fold with a reasoning disclosure.

## acceptance / validation
Verify actual live version, independently inspect the three render paths and active-state test coverage, inspect only current-thread reasoning structure/counts without returning text.

## required_context / context_receipt
Read root/OpenCraft AGENTS, maintenance SKILL and verification completely; Task/Checkpoint templates, ChatUI returned-thinking section, platform ownership sections, frontend-runtime-openspec-i18n adjacency and ThinkingLabel locale consumer. Router query `opencraft running Thinking reasoning summary disclosure unavailable Codex live` unmatched. Bounded named renderer/runtime searches located active disclosure and placeholder. Guessed reasoning.tsx/types.ts/submission.ts paths were absent; corrected through renderer imports and bounded composer file listing. No broad source, log or credential scan. Snapshot source is the scoped stage used by the current verified preview.

## decisions
Separate noninteractive liveness, tool activity and actual returned reasoning. Diagnose availability at the source before changing gestures or rendering empty buttons. Read only the current thread located by explicit CODEX_THREAD_ID; SQLite readOnly/query_only resolves its rollout path. Streaming JSON inspection emits only reasoning-item structure counts, never text or opaque values.

## evidence / verified
Live /version.json remains 20261008-reasoning-fold-preview. conversation.tsx:494–506 renders an ordinary div placeholder; command-and-review-renderers.tsx:50–80 renders an independent actual-text disclosure; agent-activity-renderers.tsx:83–96 renders a work group that expands only visible tools. User explicitly confirms the first and third paths.
Source smoke-reasoning-disclosure.ts:38–59 tests streaming summary first activation, while delivery verify-built.mjs uses completed/idle native history. Independent reviewer ran four relevant core tests successfully and confirmed this acceptance boundary.
Current-thread read-only metadata since 2026-10-08T08:00:00Z found 111 persisted response_item/reasoning records through 2026-10-08T10:19:24.523Z: zero with nonempty summary text, zero with nonempty detail text, 111 with opaque payload presence; JSON invalid-line count zero. No actual reasoning text, opaque payload, user text, model credentials or unrelated threads were output. Exact model_reasoning_summary/model_supports_reasoning_summaries keys were not present in the inspected runtime config; this does not establish the upstream default or model's summary capability.

## unverified / risks
No real-provider inference was made. Whether request/configuration, current model support or upstream behavior suppresses summaries remains unverified. Persisted Item structure is not a claim that every transient wire event was inspected. Real iPhone gesture acceptance remains separate; no renderer click fix is inferred from missing content.

## affected_paths / scan_scope / scan_output
This diagnostic receipt and an acceptance note in the preceding delivery receipt only. Named source/fixture inspection and current-thread metadata counts; no exported transcript artifact.

## handoff / stage
Diagnosis complete: the reported two labels are liveness and tool activity, not returned-text controls; current persisted Codex Items contain no readable summary/detail. Product and live preview unchanged.

## discard
Unqualified claim that current real Codex Thinking expands merely because synthetic returned-text tests passed; premature cache/click blame.

## restore / next_action
If authorized to continue capability work, inspect the current provider's summary request/model capability using safe metadata, then validate actual streaming availability before changing UI or declaring completion. Never expose/decrypt opaque content or fabricate a summary.

## subsequent_request_diagnosis
User later authorized “查一查”. [codex-summary-request](2026-10-08-codex-summary-request.md) confirms seven effective current-thread summary settings are none and the deployed Composer emits no summary option. The local proxy preserves request/response bytes. No enablement or provider inference was performed.
