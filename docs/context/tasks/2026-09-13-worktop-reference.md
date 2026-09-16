---
id: worktop-reference-20260913
type: task
scope: Clone Worktop and assess reusable interaction/ownership patterns for OpenCraft
owner: mingyuxiao
authority: primary
source_of_truth: [ref/worktop/README.md]
status: retired
reviewed_at: 2026-09-13
review_due: 2026-10-13
revision: 1.0.0
precedence: task
derived: false
---
## goal
Clone user-specified Worktop into ref/worktop and identify source-backed strengths, fit and limitations without modifying OpenCraft runtime.
## non_goals
- No dependency installation, app launch, source edits in reference, user-data import, paid inference or adoption into OpenCraft.
- No claim that repository screenshots are a locally verified running app.
## requirement_ids / requirement_refs / requirement_excerpt
- User requested https://github.com/yanglongyun/Worktop.git cloned to ref/worktop and an assessment of useful/good implementations.
## interface_refs / data_structure_refs
- WorkspaceTab / WorkspaceGroupState / PersistentPanelLayer; split resize transaction; ModelConnectionFields; runAgent / createLedger.
## history_context
- current_design_refs: opencraft/.agents/skills/opencraft-maintenance/SKILL.md and current OpenCraft architecture.
- relevant_evolution: previous WorkBuddy and LobeHub assessments; current user priority is visible workflows and stable lifecycle/geometry ownership.
- superseded_refs: README claims alone are not runtime proof.
## acceptance
- Exact target cloned, revision identified, clean reference worktree and local ignore confirmed.
- Findings cite actual code paths; compare fit to OpenCraft and distinguish verified defects from architectural tradeoffs.
## affected_paths
- ref/worktop (independent reference checkout, locally excluded)
- .git/info/exclude (local safety rule only)
- this Task Pack
## required_context
- Router returned no pack; bounded direct source inspection used.
## context_receipt
| File | Reason | Use |
|---|---|---|
| opencraft/AGENTS.md | Project boundary | No runtime or release mutations |
| opencraft/.agents/skills/opencraft-maintenance/SKILL.md | Review method | Separate interaction, ownership and verified evidence |
| opencraft/.agents/skills/opencraft-maintenance/references/verification.md | Acceptance boundary | Audit pure tests before executing; do not install or launch reference |
## evidence
- Clone revision6ab528423b361c28b3e06a6f15d2d0ba4279cd8e, repository package version1.7.2, MIT license. Added /ref/worktop/ to local exclude.
- Read repository screenshots as design references; inspected unified tab types, launcher modes, persistent browser/terminal layer, split drag guard, shared model connection form and contextual setup, injected agent loop and chat ledger.
- `node --test tests/agent-compaction.test.mjs tests/browser-cursor.test.mjs`:9/9 pass. Imports inspected; network mocked; no server/database/desktop boot.
- Empty-key behavior reproduced through request() with a stubbed fetch: rejected before network, networkCalls0, contradicting model form optional-key hint.
## risks
- Personal single-host product patterns do not supply OpenCraft multi-Host/epoch/persistent-run guarantees.
- Split Escape/pointercancel/blur all persist final position; differs from OpenCraft cancellation rollback.
- Application/extension capability declarations are not proof of OS sandboxing. README explicitly states local tools are unsandboxed.
## validation
- Clone and local ignore checked; reference worktree clean; two safe test suites run. Application itself not installed/built/launched.
## decisions
- Prioritize contextual model setup, persistent surface lifecycle and embedded-frame drag protection as ideas, not a wholesale migration.
- Retain current OpenCraft DSH/runtime and multi-environment identities; no implementation change authorized by this review.
## scan_scope
- Worktop workspace UI, model setup, drag, agent/chat boundary, app/widget capability seams and focused tests.
## scan_output
- Source-backed assessment in conversation; no generated knowledge graph or external scan.
## handoff
- Complete; reference available at ref/worktop, no OpenCraft behavior changes or Git push.
## stage
- Source review and bounded test evidence complete.
## verified
- Exact clone revision, source implementations and9 pure test outcomes.
## unverified
- Desktop performance, real credentials/model compatibility, full security isolation and crash recovery.
## discard
- Do not treat screenshots, comments or minimal local tests as proof of production reliability.
## restore
- Inspect ref/worktop at recorded revision; it is intentionally outside parent Git changes.
## next_action
- User chooses a concrete interaction or boundary to adapt; do not automatically port code.
