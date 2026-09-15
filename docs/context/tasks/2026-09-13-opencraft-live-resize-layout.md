---
id: opencraft-live-resize-layout-20260913
type: task
scope: Correct live resize versus visibility clipping ownership
owner: mingyuxiao
authority: primary
source_of_truth: [opencraft/apps/workbench-web/src/components/context-pane-geometry.ts]
status: retired
reviewed_at: 2026-09-13
review_due: 2026-10-13
revision: 1.0.0
precedence: task
derived: false
---
## goal
Make contextual and expanded primary panes reflow with a held drag in both directions; release commits preferences rather than changing layout.
## non_goals
- No model/account changes, alternate sidebar DOM, animation library migration, production or Git operations.
- Do not remove intentional visibility/compact clipping or change stored detent policy during pointer capture.
## requirement_ids / requirement_refs / requirement_excerpt
- Current screenshot and user: “不松手…不会跟手”; approved root-model correction.
## interface_refs / data_structure_refs
- useContextPaneGeometry uses a single MotionValue for layout/frame viewport.
- Primary viewport derives from frame with only a fixed compact-transition floor, never committed width.
- Captured pointer transaction starts from live geometry; lost capture cancels safely.
## history_context
- current_design_refs: opencraft/docs/platform-architecture.md.
- relevant_evolution: previous geometry repair used max(committed, frame), which deliberately clipped shrink and its tests accepted that mistake.
- superseded_refs: 2026-09-12 context geometry contraction invariant.
## acceptance
- Held shrink/grow/reversal: frame/content width agree in normal range, content controls remain inside frame, saved preference unchanged.
- Release has no content catch-up; cancel restores saved geometry; compact/hidden/open/reverse animation remains intact.
- Fixed/floating parity, pointer loss, reduced motion and actual native environment page checks.
- Focused tests, complete gate and isolated Mac preview.
## affected_paths
- opencraft/apps/workbench-web/src/components/*geometry*, *primary*resize*, use-sidecar-primary-motion.ts, sidecar.tsx and app-shell.tsx
- opencraft/tests/context-pane-geometry.test.ts; scripts/smoke-shared-sidebar.ts
## required_context
- Initial router had no matches; exact bounded source search located current geometry owners.
## context_receipt
| File | Reason | Use |
|---|---|---|
| opencraft/AGENTS.md | Workspace constraints | Full gate and source boundaries |
| opencraft/docs/platform-architecture.md | Current model | Replace incorrect contract, preserve visibility lifecycle |
| .agents/skills/fixing-motion-performance/SKILL.md | Motion review | Keep pointer-driven layout separate from timed animation; no library migration |
## evidence
- Pre-fix real component test: shrink frame 275→240 while viewport remains275; release changes viewport240. Old suite marked this passed.
## risks
- Compact and hidden transitions must not force narrow text layout; keep explicit minimum only in that range.
- Gesture takeover from running settle must capture live width, not stale saved target.
## validation
- Unit suite `context-pane-geometry` + `workbench-sidebar-dock`: 26/26 passed. Full `npm run gate` exit 0 (`/tmp/opencraft-live-resize-gate.log`).
- Shared component smoke passed normal and reduced-motion geometry: contextual shrink/grow/reversal, no-jump release, actual Environment button containment, floating, capture loss, primary normal resize and in-flight takeover. Normal run sampled97 held frames; `/tmp/opencraft-live-resize-smoke.log`, `/tmp/opencraft-live-resize-reduced.log`.
- Normal-theme pass separately verifies custom footer spacing token injection. Reduced-motion geometry pass does not inject CSS against moving/reparented footer nodes; all ordinary footer geometry assertions still run.
- Real native Environment → Model services: held widths245/335/240/295/255 matched viewports exactly, all buttons contained, saved width remained275; release only committed255; original275 restored. `/tmp/opencraft-live-resize-native-held.png`.
- Native visibility tests pass open/close/reversal and reduced-motion direct landing, with terminal unmount and fixed footer anchor (`/tmp/opencraft-live-resize-visibility*.log`). Old helper IDs updated to the shared semantic data-surface selector.
- Electron release build, independent `release/live-resize-preview` packaging and strict/deep codesign verification passed. New profile `/tmp/opencraft-live-resize.S13uB1`, CDP19742; existing user previews/profiles untouched by implementation verification.
- Documentation validator errors empty; explicit changed-file impact check passed (owner-review advisory); staged check empty since nothing staged. `git diff --check` passed.
## decisions
- One live width source for ordinary resizing. Saved width belongs to commit/rollback; visibility progress remains separate.
## scan_scope
- Shell geometry, drag transaction, visibility lifecycle and related tests.
## scan_output
- No external scan.
## handoff
- Implemented and independently previewed. No model/account changes, no commits/push, no production operations. Ready for user held-drag acceptance.
## stage
- Core model correction and validation complete.
## verified
- Ordinary resize uses one live layout width; only compact/hidden/visibility transitions clip. Saved width is no longer a viewport floor.
- Stop-before-capture fixes takeover: native-like browser test frame74.484375→76.484375 for a2px pointer step. Reduced mode126→128.
## unverified
- User's already-running older binaries are not hot-updated; use the independent new preview or rebuild before comparing.
## discard
- Earlier tests that accepted viewport=max(committed,frame); a passing old suite is not acceptance.
## restore
- Core files and tests listed above. Vite fixture prebundles dependencies and waits for network idle after an initial cold-start reload failure. Model/account runtime was not mutated.
## next_action
- User visual acceptance in the newly opened preview; Git actions only after explicit authorization.
