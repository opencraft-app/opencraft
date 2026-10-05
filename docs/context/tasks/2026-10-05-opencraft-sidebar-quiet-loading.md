---
id: opencraft-sidebar-quiet-loading-20261005
type: task
scope: Remove sidebar catalog loading chrome while preserving query semantics.
triggers: ["sidebar quiet catalog loading"]
owner: mingyuxiao
authority: primary
source_of_truth: [docs/context/tasks/2026-10-05-opencraft-sidebar-quiet-loading.md]
status: archived
reviewed_at: 2026-10-05
review_due: 2026-11-05
revision: 1.0.0
precedence: task
derived: false
---

## goal
Remove the extra loading spinner/row above sidebar conversation history.

## non_goals
- Do not change catalog fetching, connection ownership, thread-row execution status or conversation-body loading.
- No production/GitOps changes; scoped Git publication and current preview replacement separately authorized after verification.

## requirement_ids / requirement_refs / requirement_excerpt
- User screenshot highlights the sidebar catalog spinner: “是哪来的？去掉吧”.

## interface_refs / data_structure_refs
- Sidebar consumes discovery and per-Host catalog phases; query/controller remain their authority.
- Loading remains distinct from successful emptiness; errors retain scoped retry.

## history_context
- current_design_refs: `opencraft/design/invariants.md`, SSH-07/08.
- relevant_evolution: current master `2760a4422`; spinner introduced with native SSH history work, last Sidebar change `468da9350`.
- superseded_refs: visible catalog-loading row, not the query state.

## acceptance
- No spinner or spacer during discovery/catalog load, including retry.
- Existing row identity/position unchanged when loading completes.
- Errors remain retryable; initial loading does not show “No tasks yet”; successful empty does.

## affected_paths
- Sidebar component, catalog browser smoke, workspace invariant.

## required_context
- Root/OpenCraft AGENTS, maintenance Skill and verification checklist, workspace design entry.

## context_receipt
| File | Reason | Use |
|---|---|---|
| `AGENTS.md`, `opencraft/AGENTS.md` | Scope and ownership | No implicit publication/restart |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md`, `references/verification.md` | UI maintenance | Real Sidebar verification |
| `opencraft/design/README.md`, `invariants.md` SSH-07/08 | Current contract | Preserve loading/error/empty semantics |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md` | Test/config neighbor | Existing catalog smoke and Web package commands |
| `docs/context/domains/release-gitops.md` | Publication router match | Source master and temporary preview do not imply production deployment |
| `opencraft/.agents/skills/opencraft-self-hosted-preview/SKILL.md` | Authorized live switch | Independent supervisor and retained old package |
| `docs/engineering/journeys/agent-request-streaming.md` | Impact-mapped design | Record catalog presentation without changing query ownership |

## evidence
- Router query `OpenCraft sidebar catalog loading spinner remove` had no match; bounded Sidebar/app loading search located the consumer.
- Existing `smoke-sidebar-thread-catalog.ts` and Web package config checked as neighbors.
- Web workspace typecheck and all five catalog query tests passed.
- Real Sidebar browser smoke passed light/dark × desktop/touch: no loading row/spinner, no false empty state, healthy row geometry/identity preserved, errors retryable, hidden remote rows and successful-empty behavior retained.
- Initial browser smoke waited for an empty zero-height section to be visible and timed out; corrected the assertion to wait for attachment/aria-busy instead. The complete rerun passed.
- Documentation validation and diff whitespace checks passed.

## risks
- Hiding feedback must not convert unfinished loading into success/empty; keep `aria-busy` and empty-state guard.

## validation
- Web workspace typecheck, catalog query tests, real Sidebar browser smoke in light/dark desktop/touch, documentation/diff checks.

## decisions
- Remove loading DOM at the owning Sidebar, not shared Spinner or CSS hiding. Only errors produce feedback rows.

## scan_scope
- Sidebar component, catalog query/test/smoke, workspace invariant and Web scripts.

## scan_output
- No secrets, remote writes or inference required.

## handoff
- Source implemented and verified. User now authorized commit, push, master integration and current preview replacement. Preserve the running preview's desktop-control overlay and saved SSH data; switch verification pending.
