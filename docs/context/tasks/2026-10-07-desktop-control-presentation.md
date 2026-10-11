---
id: task-2026-10-07-desktop-control-presentation
type: task
scope: Readiness-gated control strip and confirmed ownership button crossfade.
triggers: [desktop control presentation]
owner: opencraft-maintainers
authority: primary
source_of_truth:
  - opencraft/plugins/cloud-desktop/src/index.tsx
  - opencraft/packages/design-system/src/desktop-view.web.scss
status: retired
reviewed_at: 2026-10-07
review_due: 2026-11-07
revision: 1.0.0
precedence: task
derived: false
---

## goal
Hide the ownership strip before readiness without layout changes and fade the
solid button layer on confirmed ownership transitions.
## non_goals
- No error-layout redesign, avatar, compact presentation, backend change,
  deployment, restart, commit or push. Preserve prior last-frame source changes.
## requirement_refs
- User approved the two scoped next steps with `好的，搞起来。`.
## interface_refs / history_context
- Current design: `opencraft/docs/cloud-desktop-plugin.md#panel-presentation`.
- Codex 26.930.31428 build 12913 rich panel source hides controls before streaming
  and fades its solid button pseudo-layer over .24s. Our readiness additionally
  requires input availability; presentation never establishes authority.
## acceptance
- Connecting/recovery strip occupies space but is hidden, inert and absent from
  accessible actions; ready shows it without changing reserved control height.
- Confirmed grant/release fades the solid layer, not button geometry. Pending
  retains the cancel action; reduced motion skips transitions; touch hover remains nonsticky.
## affected_paths
- Neutral desktop renderer, shared desktop stylesheet, real browser smoke and design doc.
## context_receipt
- Root/local AGENTS, maintenance skill, complete verification checklist, design
  README and task template read. Router query `opencraft cloud desktop controls
  visibility and button transition` unmatched; bounded exact renderer/style/smoke
  search followed. Frontend adjacency card reviewed; actual OpenCraft adjacent
  fixture/smoke and package scripts checked rather than unrelated frontend code.
## validation
- Plugin/Web typechecks, desktop suite, boundaries/i18n, Web CSS build, real panel
  browser matrix, whitespace and documentation impact.
## risks / decisions
- Feature selects readiness; shared primitive owns visibility and motion.
- Visibility, not display:none, preserves geometry; inert revokes hidden interaction.
- Error retry semantics and input authorization are unchanged.
## evidence / handoff
- Source implementation complete: neutral feature projects current readiness into
  shared visibility + inert/accessibility state; shared action uses a decorative
  solid pseudo-layer with 240ms confirmed ownership crossfade. Control intents,
  cancellation, grants and media mount identity unchanged.
- Desktop suite 139 passed, 0 failed; plugin/Web typechecks, boundaries/i18n,
  Web build, whitespace and scoped formal documentation impact passed. Staged
  impact check had no staged files and is not the scoped evidence.
- Real panel/current compiled CSS browser matrix passed at 1024/720/320px in
  light/dark/custom themes, plus Shell 1280/390px. Receipt/screenshots:
  `/tmp/opencraft-desktop-ui-kNtKNt`. Both ownership directions sampled mid-fade;
  reduced motion immediate; held-press geometry, pending cancel, hidden strip,
  recovery preview and readiness reserved height checked.
- Initial browser attempts exposed obsolete assertions reading the button's now
  transparent base instead of its solid layer and omitting pseudo-element
  animations from sampling; assertions now inspect actual layers/subtree effects.
- Backend/media are synthetic boundaries; official Codex runtime pixel parity,
  production authority/recovery and physical iPhone keyboard not verified.
- Live preview unchanged; no restart, commit, push or replacement.

## checkpoint
### stage
Implementation and scoped verification complete; source and local build only.
### verified
Readiness-gated stable control geometry and confirmed solid-layer crossfade.
### unverified
Current live preview has neither this change nor the prior last-frame source work.
### restore
Preserve the dirty checkout and existing refinement live/rollback receipts.
### next_action
On explicit replacement request, integrate both scoped changes into the running
preview baseline candidate and build the headless profile before atomic switch.

## preview_delivery
- User authorized `替换`. Self-hosted preview skill read in full; route query
  `opencraft self hosted desktop control and frame preview replacement` unmatched.
  Actual listener/cgroup/unit/cwd/Web version/runtime hash checked before switch.
- Eleven desktop source/test files integrated into the existing isolated running
  baseline candidate; bytes verified equal to source. Correct headless build
  `20261007-desktop-control-frame-5b9f70ea2`, 119 desktop + 20 input tests,
  plugin/Web types, boundaries/i18n and real panel browser matrix passed
  (`/tmp/opencraft-desktop-ui-sXRhSI`).
- Independent systemd oneshot atomic exchange succeeded with automatic rollback
  path retained. Receipts `/data/opencraft-desktop-control-frame-preview-h6NLSd`:
  prepared/deployed/live-verified JSON and DEPLOYMENT.md.
- Live `/version.json` confirms the new headless Web build; health OK, port 80
  listener remains PID 1907435; runtime SHA256 unchanged. Four desktop/mobile
  light/dark live startup cases passed for composer/SSH settings and assets.
  Old hashed assets retained; backend/data unchanged, no restart/commit/push.
- Includes prior same-identity last-frame preview plus current visibility/fade.
  Already-open pages need reload; real iPhone desktop/IME acceptance remains manual.
