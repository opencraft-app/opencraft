---
id: reasoning-fold-ownership
type: task
scope: Repair response work disclosure fragmented by invisible reasoning observations.
triggers: ["reasoning fold regression", "历史消息分段回归", "empty reasoning work ownership"]
owner: skipzhang
authority: derived
source_of_truth: ["opencraft/packages/chat-core/src/agent-activity.ts", "opencraft/docs/chat-ui-architecture.md"]
status: retired
reviewed_at: 2026-10-08
review_due: 2027-01-06
revision: 1.0.0
precedence: task
derived: true
---

## goal
Fix invisible reasoning observations creating repeated default-collapsed history headings, preserving actual returned reasoning disclosures and chronological work.

## non_goals
No preview replacement, backend restart, commit/push/merge, desktop work, provider inference, fabricated reasoning or copying a Turn total onto every slice.

## requirement_ids / requirement_refs / requirement_excerpt
Unknown external ID; direct report “咋回事” with 13 history rows, followed by authorization “搞起来”.

## interface_refs / data_structure_refs
AssistantTurnPresentationPlan, AgentActivitySegmentEnd, hasFinalAssistantStarted, ReasoningRenderUnit, resolveAgentActivityLayout and the existing View disclosure receipt. Protocol observation, readable Item disclosure, response work-fold owner and Turn clock are distinct.

## history_context
current_design_refs: opencraft/docs/chat-ui-architecture.md#activity-closure-and-disclosure-authority and #returned-thinking-content; opencraft/design/invariants.md.
relevant_evolution: reasoning-disclosure and reasoning-preview tasks delivered returned text, but incorrectly treated each empty reasoning Item as an outer work boundary and propagated a final grant to every slice.
superseded_refs: Those tasks' per-slice-fold/empty-boundary assertions are regression evidence, not the current acceptance contract.

## acceptance
- A 60-tool response with 13 empty reasoning observations has one work surface, zero reasoning disclosures and at most one outer fold; its clock belongs to actual work.
- Returned text stays in chronological independent default-collapsed disclosures; earlier physical tool slices keep semantic summaries rather than receiving extra history-count headings.
- Only the nearest meaningful work slice receives a final answer's fold grant; separate completed responses retain their own grants.
- One Turn clock, one current Thinking owner; hidden-only tail cannot steal a clock or reanimate another response's historical work.
- User input/questions/content retain genuine boundaries; cancelled/no-final work remains visible. Existing View choices remain explicit, not rewritten by data arrival.
- Shared core tests, Web/Native types and actual Conversation browser checks cover long responses and empty-to-text arrival.

## affected_paths
opencraft/packages/chat-core/src/agent-activity.ts; focused core/disclosure tests; reasoning browser fixture/smoke; canonical ChatUI/design/domain documentation. Renderer rules and provider adapters need no duplication.

## required_context / context_receipt
Router query `opencraft chat reasoning empty item creates historical messages disclosure ownership regression` unmatched. Bounded exact search found flushActivity(reasoning), finalAnswerGrants and workStatusOwner in chat-core. No broad log/profile or credential reads.

| File | Reason | Use |
| --- | --- | --- |
| AGENTS.md; opencraft/AGENTS.md | Scope and authorization | Source fix only, preserve dirty tree |
| opencraft/.agents/skills/opencraft-maintenance/SKILL.md; references/verification.md | Required UI maintenance workflow | Correct ownership and real component acceptance |
| docs/context/tasks/TASK-TEMPLATE.md; CHECKPOINT-TEMPLATE.md | Required task/checkpoint format | This receipt |
| .agents/context/change-impact.json; docs/engineering/domains/agent-gateway-runtime.md | Impact mapping | Formal design update |
| docs/context/project/adjacency/frontend-runtime-openspec-i18n.md | Relevant adjacency | Checked chat.previousMessages locale and work-status consumer |
| opencraft/docs/platform-architecture.md (package/context ownership sections); docs/chat-ui-architecture.md (closure/returned-thinking sections) | Current authority | Core owns chronology; renderers consume shared policy |
| reasoning-disclosure / reasoning-preview task receipts | Relevant evolution | Scope and regression evidence |

Browser reviewer independently reread root/OpenCraft AGENTS and maintenance/verification; its router query was also unmatched, then bounded fixture/smoke/core searches and work-status neighbor.
Core test reviewer independently reread the same instructions; router query `opencraft reasoning transparency one fold per response clock regression` unmatched before bounded core/test review.

## decisions
Empty observations stay inside pending work facts, without physical flush/rekey. Actual text may introduce a chronological display slice, but not a new complete-response fold owner. Resolve grants from real final answers to the nearest meaningful slice, independently from the single Turn clock. Keep legitimate earlier response grants after Steer. Do not rename fragmented headings or copy global duration to conceal the regression.

## evidence
Read-only synthetic input reproduces screenshot counts 8/6/4/4/5/5/1/5/4/4/2/5/7 exactly in current model; pre-reasoning HEAD yields one 60-item surface. Real wire payload for that screenshot was not exported. Source establishes empty flush, grant propagation and no-clock label fallback. Existing tests explicitly expected this erroneous fragmentation.

Corrected source: focused core/disclosure 147/147 and complete `npm run test:chat` 559/559 passed. Core, Web and Expo workspace typechecks passed. `check:boundaries` (including typography) and `check:i18n` (220 source messages) passed. No new per-renderer fold rule or provider change was needed.

Actual Chromium Conversation smoke passed 12 engine/theme/mouse-or-touch combinations and 24 long-response checks. The long input uses exactly the screenshot's 13 counts/60 tools, with/without authoritative time metadata. One outer fold, zero empty reasoning disclosures; expansion retains all 60 tools once and in order. With clock the sole heading is Worked for; without metadata the previous single 60-item history fallback remains, without inventing time. Empty-to-text preserves the existing first-source group DOM/identity and explicit choice; actual reasoning and tool folds remain independent. Root visually checked the light touch/clock and dark touch/no-clock screenshots. Evidence: `<private validation evidence>`. Four Vite ResizeObserver notification warnings occurred during large reflow; browser page-error capture remained empty and all assertions passed. They were not filtered or suppressed.

Scoped formal-design impact and staged-impact checks passed (staged set empty; scoped set contains this task's actual paths). Documentation validation returned exit 0, zero errors and zero broken first-party links; diff whitespace check passed. Broader baseline repository governance failures from the original reasoning task were not rerun or asserted fixed by this scoped change.

Read-only live `/version.json` remains `20261008-reasoning-current-preview`, builtAt `2026-10-08T08:08:13.859Z`. No live Web, manifest, backend, profile or data was modified. This is source/component acceptance, not a new delivery package or native-iPhone/provider verification.

## risks
Empty-to-first-text with already restored later tools can introduce a real visible slice; preserve stable source identities/valid existing choices rather than create invisible outer owners to freeze topology. Do not let clock search cross a true response boundary. Native OS/provider acceptance remains separate.

## validation
Focused core/disclosure tests, test:chat, core/Web/Expo types, boundaries, i18n, actual Conversation Chromium smoke and scoped documentation/impact checks. Record baseline unrelated failures without relaxing assertions.

## scan_scope / scan_output
Named core/UI/test/design files only; synthetic fixture output only, no private transcript export.

## handoff / stage
Source correction and scoped verification complete, uncommitted; live preview unchanged.

## verified
Cause reproduced independently; corrected hidden observation, response fold and Turn clock ownership. Long-response browser checks and source tests confirm single fold, actual work clock, chronology and explicit choices.

## unverified
Live preview not replaced; native iPhone OS and real-provider acceptance unverified. Vite reflow notification warnings remain recorded, not claimed resolved.

## discard
Prior test assumptions requiring one outer work fold per invisible reasoning source Item.

## restore
Use the current dirty source checkout; preserve unfinished desktop changes and the existing live preview. No deployment/publication authorization in this turn.

## next_action
If the user requests delivery, create a scoped candidate from the then-current live preview baseline, preserve its other changes, verify the actual built page and atomically replace Web only. Do not restart implicitly or publish the all-dirty build.

## subsequent_delivery
The later explicit “替换预览” authorization was fulfilled separately by [reasoning-fold-preview](2026-10-08-reasoning-fold-preview.md). Build 20261008-reasoning-fold-preview is live after atomic Web-only replacement; backend PID/runtime/data unchanged. This does not replace the source acceptance record above or claim real iPhone/provider acceptance.
