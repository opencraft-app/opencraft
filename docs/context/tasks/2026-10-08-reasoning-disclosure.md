---
id: reasoning-disclosure
type: task
scope: Engine-returned reasoning disclosure in the shared conversation presentation.
status: retired
triggers: ["opencraft reasoning", "思考内容", "returned thinking content"]
owner: skipzhang
authority: derived
source_of_truth: ["opencraft/packages/chat-core/src/reasoning.ts", "opencraft/packages/chat-core/src/agent-activity.ts"]
reviewed_at: 2026-10-08
review_due: 2027-01-06
revision: 1.0.0
precedence: task
derived: true
---

## goal
Show actual returned reasoning/summary for all engines, including Codex, Hermes and DSH, as a separate default-collapsed disclosure during and after work.
## non_goals
No fabricated/decoded hidden reasoning, model configuration, extra inference, desktop work, preview replacement, restart, commit or push.
## requirement_ids / requirement_refs / requirement_excerpt
requirement_ids: unknown (direct conversation request, no external issue identifier).
User: “Codex，hermes 都应接入它实际返回的思考摘要或者说默认都接入”; default collapsed confirmed; current Thinking tool header must not be confused with reasoning content.
## interface_refs / data_structure_refs
ThreadItem.reasoning summary/content; reasoning text/summary delta projections; ReasoningTimelineBlock; AssistantTurnPresentationPlan; existing ActivityDisclosure and Conversation View restore receipt.
## history_context
Current design: opencraft/docs/chat-ui-architecture.md#history-positions-and-concurrent-observations and #activity-closure-and-disclosure-authority. Earlier recovered Codex classifier hides reasoning; this user request intentionally changes that product policy, not its protocol.
Reference: locally installed @deepseek-ai/dsh-client-ui-conversation 0.1.1-rc.2 ReasoningRow (default collapsed, last live line/first completed line, actual text body). Reference is read-only, not a claim of the running product's behavior.
current_design_refs: opencraft/docs/chat-ui-architecture.md#returned-thinking-content; opencraft/design/invariants.md Conversation invariants.
relevant_evolution: user explicitly superseded the previously hidden returned-text policy; final review distinguished transparent reasoning separators from real response/interaction boundaries.
superseded_refs: recovered Codex hidden-Item classifier and Hermes prefix-based reasoning erasure, retained only as bounded historical evidence.
## context_receipt
Router query `opencraft chat reasoning summary disclosure Codex Hermes DSH` unmatched; bounded searches restricted to chat-core, conversation renderers, Hermes adapter and reasoning tests. Checked neighboring locale and i18n extraction/check script.

| File | Read reason | Use |
| --- | --- | --- |
| AGENTS.md; opencraft/AGENTS.md; opencraft/apps/workbench-expo/AGENTS.md | Scope, authority and platform rules | No publication, preserve worktree, shared/native boundaries |
| opencraft/.agents/skills/opencraft-maintenance/SKILL.md; references/verification.md | Required maintenance workflow | Actual components, evidence layers, View intent |
| opencraft/docs/chat-ui-architecture.md; opencraft/docs/platform-architecture.md | Current reasoning/order/scroll and package design | Core chronology/authority; reuse disclosure and viewport owners |
| opencraft/design/README.md; opencraft/design/invariants.md | Workbench invariant entry | Independent disclosure and single clock |
| docs/context/tasks/TASK-TEMPLATE.md; CHECKPOINT-TEMPLATE.md | Required task state | Scope and honest checkpoint |
| .agents/context/change-impact.json; docs/engineering/domains/agent-gateway-runtime.md | Formal impact mapping | Sync canonical documentation |
| docs/context/project/adjacency/frontend-runtime-openspec-i18n.md | Required relevant adjacency | Check locale/source-message contract |
| opencraft/packages/appserver-protocol/src/generated/v2/ThreadItem.ts | Generated wire authority | Only returned summary/content are readable |
## decisions
Shared core selects explicit nonempty summary before returned detail and emits stable reasoning slots, independent of tool groups and work totals. One current-response live owner, no empty disclosure. View owns explicit collapse choice; streaming/completion never writes it. Reuse existing native/DOM disclosure and viewport reflow owner.
## acceptance
Default folded, accessible mouse/touch/keyboard expansion, retained choice through stream/completion/restoration, separate tools, no duplicate Thinking, no content fabrication, chronological identity and copy boundaries retained. Types on core/Web/Native, focused core/Hermes tests, real Chromium Conversation smoke, boundary/i18n/doc-impact checks.
## affected_paths
opencraft/packages/chat-core/src/{reasoning,agent-activity,index}.ts; Web Conversation/Reasoning consumer/styles/zh-CN locale; Native Conversation; Hermes adapter/state-machine; related tests and reasoning browser fixture/script; canonical ChatUI/invariant/domain docs. No desktop implementation changes in this task.
## required_context
The router supplied no matching Pack. Required local context is the receipt above, loaded before task actions; reference code is source evidence, not instructions.
## validation
Core/Web/Expo/Hermes workspace types; test:chat; Hermes/DSH/Thinking focused tests; reasoning/activity/conversation Chromium smokes; boundary/typography/i18n; documentation and scoped change-impact checks. Root context checks are recorded separately from task-specific tests, not reported all-green.
## scan_scope
Bounded source/test paths above; additional exact searches of locally installed DSH UI and local pinned Hermes producer for event authority. No production credentials or remote model calls.
## scan_output
No transcript/payload export; only synthetic fixture screenshots and test summaries. Temporary diagnostics use read-only Node load overlays, not source replacement.
## evidence
Shared model, Web and Native consumers implemented; Hermes actual-reasoning vs body-preview projection corrected. Final `test:chat`: 555/555 passed, including 3 production Native component tests with RN platform seams. Focused core/disclosure tests: 143/143 passed. Focused Hermes/DSH/Thinking tests: 132/132 passed. Core/Web/Expo/Hermes workspace types, boundary/typography and i18n checks passed. Web/Expo types and Web production build rechecked after the final eligibility fix. The Web build includes the whole dirty tree and is not a scoped delivery package or deployed preview.

Final real Chromium reasoning smoke passed all 12 combinations (Codex/Hermes/DSH synthetic returned text, mouse/touch, light/dark), including empty-to-first-text stable identity, explicit choice retention, two independent tool disclosures through reasoning-only separators, and one Thinking/work-clock owner. Evidence: `<private validation evidence>`. Existing activity disclosure smoke passed all 4 combinations and conversation presentation smoke passed. No paid-provider calls. Final independent review confirmed the original tool-fold regression is resolved and real user-input/question/content boundaries stop final-answer eligibility propagation.

Read-only producer authority: local Hermes agent pinned `3c3ab69abb9b08683b5eb15b4e2b8be1198c875f`, `agent/turn_response_intake.py` and `tui_gateway/tool_progress.py`; also confirmed matching behavior at `f42f579cf8bac4918ac9599bece71618afadd846`. Actual assistant-message body becomes `reasoning.available`; it is not a reasoning delta. Formal ChatUI contract records this distinction.
## risks
Available content depends on what the engine actually returns. No paid/live provider calls or native iPhone verification. iOS bundle blocked by missing generated `mobile-bot-runtime.html`; its existing builder is blocked by missing frontend `@tailwindcss/postcss` in this checkout. No other worktree dependencies or generated output were borrowed.

Additional unrelated validation failures retained: Hermes history integration/reconstruction tests fail with the same `1 != 2` at integration line 86/reconstruction line 52 under both HEAD `ff3cc8aeb` and current source. Codex legacy activity oracle defaults to a missing machine path; a read-only path overlay to the available matching reference files still has one no-toggle user-message partition mismatch. Loading HEAD model source reproduces that same mismatch. Neither baseline issue was repaired or tests relaxed for this task.

Root governance is not all-green: context catalog validation reports existing schema/contract and secret-literal findings; context unit tests report 4 failures out of 27. Context-audit unit tests passed 33/33; its discovery audit completed with `needs_agent_review`/`not_assessed`, not an audit-grade pass. Documentation link validation passed and scoped change-impact mapping passed. Only this task's generated catalog additions were reverted; no unrelated catalog changes were retained.
## handoff
Source changes uncommitted. Desktop edits from the prior task remain untouched. Current live preview remains unchanged; replacing it requires a separate scoped build/switch, not copying the all-dirty Web build.

Subsequent user-authorized preview delivery: see [reasoning-preview](2026-10-08-reasoning-preview.md). It applies this source change to the newer live preview baseline, with a Web-only cutover and no backend restart; the original source-only verification receipt above is unchanged.

Subsequent user screenshot exposed a long-response regression that the original
per-slice expectations incorrectly accepted. Empty reasoning created outer work
slices and the final grant collapsed all of them into history headings. The
ownership policy and those test assumptions are superseded by
[reasoning-fold-ownership](2026-10-08-reasoning-fold-ownership.md); its corrected
source/browser receipt does not imply another preview replacement.

## stage
Source implementation and scoped verification complete. Final review caught and resolved an eligibility regression: reasoning is now a display separator that preserves tool folding when a real final answer follows, not a response/interaction boundary. Genuine content, user input and interaction boundaries still stop the grant; no renderer workaround or extra work clock was introduced.
## verified
One stable returned-text disclosure, default collapsed, summary preferred, detail fallback; tools remain separate. Actual Hermes reasoning survives completion/history even when final answer repeats its text; body previews never create reasoning. User choice is not rewritten by streaming/completion; no opaque content decoding.
## unverified
Native OS/real provider execution and running preview. Existing baseline history/oracle failures are outside scope; do not call the entire repository gate green.
## discard
Old classifier policy hiding all returned reasoning; treating Hermes `reasoning.available` event name as reasoning authority; desktop continuation for the present request.
## restore
Use current task source paths and focused tests; preserve dirty desktop files. No commit/push/deploy authorization. Do not touch production or model configuration.
## next_action
Hand off source-only completion. If separately requested, prepare a scoped preview package that preserves the existing preview changes, then verify its build identity and UI; do not publish the all-dirty Web build or restart implicitly. Native OS/provider acceptance and unrelated baseline gates remain explicitly unverified or failing above.
