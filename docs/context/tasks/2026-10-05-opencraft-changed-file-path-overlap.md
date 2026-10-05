---
id: opencraft-changed-file-path-overlap-20261005
type: task
scope: Bound changed-file basenames within the remaining path slot and deliver the fix to master.
triggers: ["changed file path overlap"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - opencraft/apps/workbench-web/src/styles/app.scss
  - opencraft/docs/chat-ui-architecture.md
status: active
reviewed_at: 2026-10-05
review_due: 2026-11-05
revision: 1.1.0
precedence: task
derived: false
---

# Changed-file basename boundary

## goal / requirement_excerpt
User: "改 然后提交推送合入maater". Fix long filenames painting over line counts; commit, push and integrate into master.

## non_goals
- No preview replacement, service restart, deployment or unrelated SSH/devops changes.
- No path shortening in the data model, count repositioning or card widening.

## current_design_refs / interface_refs / data_structure_refs
- ChatUI architecture, Changed-file review: renderer owns geometry, Turn diff owns data, Workbench owns Review.
- `TurnDiffBlock`, `turnDiffDisplayPath`, `TurnDiffStats` and `.thread-turn-diff__path`.
- Invariant: counts retain intrinsic width; directory yields first; even the basename cannot paint outside the remaining path slot; full path remains the accessible label and Review target.

## relevant_evolution / superseded_refs
- Diagnosis reproduced checkpoint basename overlap (95.14px) using current preview CSS at viewport width 390; two shorter filenames did not overlap.
- Read-only Codex 26.930.31428-12913 reference: `sites-end-resource-b8a510733e15.js`, ME path label uses `max-w-full shrink-0 truncate` for basename. This is presentation evidence, not runtime authority.
- Isolated clean integration checkout starts at master `2c19eaaf6`; original development checkout has concurrent SSH/devops changes and is not modified.

## affected_paths
- OpenCraft card styles, ChatUI design, review tests and browser fixture; root task receipt.

## context_receipt
- Root/OpenCraft AGENTS; maintenance Skill and verification checklist.
- Router must-read frontend service detail; frontend adjacency and existing changed-file Review test.
- ChatUI Changed-file review, platform package/typography ownership and change-impact mapping.

## acceptance / validation
- Focused Review tests and Web typecheck/build.
- Real Conversation browser matrix at 320/390/768/1200px, light/dark; long basename without directory, deep paths, both counts, expanded/collapsed list, unchanged Review target and accessible label.
- Negative control must reproduce the old overlap. Fresh remote refs and ancestry verify source delivery; no running preview claims.

## stage / handoff
Implemented four basename boundary properties; no runtime state, data model or interaction changes. Four Review unit tests and Web typecheck passed. Web/preview-bridge build passed (5728 modules), retaining existing dynamic-import/chunk warnings. Browser regression passed all eight width/theme combinations, each with five real Conversation rows, full-path Review intent, accessible labels and expansion/collapse; a 390px negative control reproduces the original overlap with the old rules. No iPhone Safari or packaged Electron acceptance is claimed.

Source delivery uses `fix/changed-file-path-boundary-20261005`; commit/push and fresh master ref verification are pending. Running preview is not replaced. No separate lint script exists in the touched Web workspace.
