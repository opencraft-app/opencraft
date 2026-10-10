---
id: opencraft-activity-disclosure-20261006
type: task
scope: Separate chronological segment closure from task disclosure eligibility.
triggers: ["opencraft activity disclosure", "historical message folding", "Steer visibility"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - opencraft/docs/chat-ui-architecture.md
  - opencraft/packages/chat-core/src/agent-activity.ts
status: retired
reviewed_at: 2026-10-06
review_due: 2026-11-05
revision: 1.2.0
precedence: task
derived: false
---

## goal
Separate chronological Activity boundaries from disclosure authority so new inputs cannot hide earlier prose. Keep shared Web/Native semantics, user intent, stable identity and the existing viewport owner.

## non_goals
- No protocol phase fabrication, message reordering, new execution/scroll owner, Bot-chat renderer unification, or blanket removal of useful task disclosures.
- Implementation stage did not authorize Git delivery. Follow-up user request “提交推送 合入master” now authorizes committing/pushing this scoped change and integrating it into remote master; preview replacement/restart, GitOps and public mirroring remain excluded.

## requirement_ids / requirement_refs / requirement_excerpt
- User conversation, 2026-10-06: “历史消息还是会出现折叠的情况？”; “再看看codex 原版细节”; “彻底优雅整改重构”.

## interface_refs / data_structure_refs
- `opencraft/packages/chat-core/src/agent-activity.ts`: ordered presentation plan, Activity segments, disclosure reducer and partition/layout.
- `opencraft/apps/workbench-web/src/components/conversation.tsx`: View-owned explicit choices and restoration; Native consumes the same layout reducer.
- Chronological closure, qualified final-answer, Turn terminal state, collapse eligibility and explicit preference are distinct. Default/effective visibility never writes user intent.
- One Turn clock/Thinking owner; final/async/user messages retain source identity and position.

## history_context
- current_design_refs: `opencraft/docs/chat-ui-architecture.md#history-positions-and-concurrent-observations`, `opencraft/design/invariants.md`.
- relevant_evolution: baseline `3cefebe3e` already preserves ordered multi-response slots but `hasDisclosureBoundary` conflates generic closure and eligibility.
- superseded_refs: machine-local r3562 parity harness does not validate caller policy and is unavailable here.
- Original reference: Codex 26.930.31428/build 12913, original `sites-end-resource` EO/DO/vO, transcript grouping and turn-entry callers. Reference source is read-only; ports/probes do not prove complete Codex UI.

## acceptance
- Commentary/work → Steer → commentary/work → Steer stays visible, including completion with no final answer.
- Async final/questions, approvals, images and unphased text cannot authorize folding.
- A genuine final answer may fold its adjacent task activity, never the final answer itself; post-answer open work stays visible.
- Explicit expanded/collapsed choice is independent of forced/no-toggle presentation; no duplicate/missing partition content.
- History prepend, streaming completion and follow-ups preserve established identities and one live owner.
- Real Conversation smoke in desktop/touch-sized Chromium light/dark, disclosure interaction and scroll reflow; shared types/tests/boundaries and gate.

## affected_paths
- `opencraft/packages/chat-core/src/agent-activity.ts`, focused tests/fixtures/smoke; formal Chat architecture/invariants and mapped engineering domain.

## required_context
- Router returned no matches; bounded exact symbol search used, no broad reference sweep.

## context_receipt
| File | Reason | Use |
|---|---|---|
| `AGENTS.md`, `opencraft/AGENTS.md` @ 3cefebe3e | Ownership and authorization | Shared projector, isolated checkout, no deployment |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md`, `references/verification.md` | Required maintenance workflow | Behavioral/reflow regression and honest evidence |
| `opencraft/docs/platform-architecture.md`, `opencraft/docs/chat-ui-architecture.md` | Current architecture | Projection is disposable; protocol/runtime stay unchanged |
| `docs/context/tasks/TASK-TEMPLATE.md`, `CHECKPOINT-TEMPLATE.md` | Task state | Scoped evidence/checkpoint |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md` | Test neighbor | Chat ordered presentation tests/fixture and existing locale label inspected |
| `opencraft/design/README.md`, `design/invariants.md` | UI contract | Update segment/disclosure invariant |
| `.agents/context/change-impact.json`, `docs/engineering/domains/agent-gateway-runtime.md` (OpenCraft scope) | Formal impact mapping | Update mapped design without unrelated gateway changes |

## evidence
- Clean detached source `3cefebe3e`; separate branch/worktree created, Tencent OA work untouched.
- Router query `opencraft activity disclosure chronological segment folding refactor`: no match.
- Delivery router query `opencraft activity disclosure git commit push merge master delivery`: no match. Bounded delivery-history and local credential-configuration discovery reused the existing private Git credential helper without copying or printing credentials.
- Exact search `hasDisclosureBoundary|resolveAgentActivityDisclosure|resolveAgentActivityLayout|createAssistantTurnPresentationPlan|createTimelineTurnPresentationPlan` in chat-core, consumers and neighboring tests.

## risks
- Existing tests can encode the defect. Change specific bad expectations with independent input-sequence tests, not broad snapshots.
- Hidden reasoning remains hidden; no new phase inference or persistence schema.
- Own dependency install reports existing audit vulnerabilities; do not run unrelated dependency upgrades.

## validation
- Focused shared tests: 131 passed across disclosure, ordered presentation, chat-core and Turn resources, including 96 disclosure-state combinations compared with the reviewed portable Codex oracle.
- Entire chat suite: 504 passed; Workbench unit suite: 332 passed; Web build passed (existing chunk-size warning).
- Full workspace typecheck, i18n checks and boundary checks passed in the gate.
- Full `npm run gate` passed after dependency preparation: 2,232 tests passed, one environment-conditional test skipped, no failures. Web, Expo Web and iOS Metro bundle builds passed; these do not constitute native-device interaction acceptance.
- Real Conversation smoke: desktop/touch-width Chromium × light/dark passed multi-Steer, no-final completion, prepend, per-slice final folding, explicit choice, streaming DOM retention and reload.
- Existing ordered presentation smoke: all four desktop/touch/theme combinations passed, including one live owner and retained streaming rows.
- Existing disclosure reflow smoke: all 48 opening/closing samples passed; measured maximum and final anchor drift were 0 px in this fixture.
- Test-only browser dependencies live under this checkout's ignored `.runtime/activity-disclosure-browser`; Chromium uses existing isolated OS libraries. No preview/profile/database was borrowed.
- Initial gate attempts stopped at checkout dependency preparation (reviewed noVNC patch, native node-pty and separately locked DSH runtime). Ran repository postinstall, rebuilt own node-pty and prepared own DSH via the repository script; the final complete gate exited 0.
- Repository-wide context validation reports 6,273 metadata/link/catalog/credential-pattern errors outside the new Task Pack/checkpoint; both new files have zero reported errors. Explicit actual-change-set design-impact check passed. The repository-wide check is not green, and catalog regeneration/unrelated cleanup is outside this task.
- No real iPhone/Native interaction, original Codex whole-app UI, current screenshot protocol phases or live deployment has been verified.

## decisions
- Replace generic disclosure boundary with an explicit semantic segment ending. Only qualified final semantics grant task fold eligibility.
- Retain separate Bot chat renderer/viewport; do not add an unused presentation-mode service.
- Align no-toggle/forced presentation with original Codex effective-state calculation; intent remains unchanged.

## scan_scope
- Shared Activity projector, Web/Native consumers, neighboring tests and bounded original reference functions only.

## scan_output
- No persistent broad scan artifacts.

## handoff
- Implementation and scoped verification complete in the isolated `refactor/activity-disclosure-20261006` checkout, based on `3cefebe3e`.
- Twelve scoped source/test/design/task files committed as `71e545c6d`; source branch pushed and remote master fast-forwarded from the verified baseline. Independent `ls-remote` confirmed master and `refactor/activity-disclosure-20261006` at that commit; subsequent fetch/ancestry check confirmed source containment. Only this delivery receipt follows as a documentation-only commit.
- Unrelated Tencent OA work and current port-80 preview are unchanged. No preview replacement/restart, public mirror or GitOps operation was performed.
- Long-lived contract is recorded in Chat architecture, UI invariants and mapped engineering design. This pack is bounded history, not a default task route.
- Runtime deployment and real device acceptance remain separate authorization/verification steps. Repository-wide context cleanup is outside this task.
