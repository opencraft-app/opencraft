---
id: task-2026-10-07-desktop-rich-refinement
type: task
scope: Intrinsic desktop controls, exact shoulder geometry and layered shadow transitions.
triggers: [desktop rich refinement]
owner: opencraft-maintainers
authority: primary
source_of_truth:
  - opencraft/packages/design-system/src/desktop-view.web.scss
  - opencraft/plugins/cloud-desktop/src/index.tsx
status: retired
reviewed_at: 2026-10-07
review_due: 2026-11-07
revision: 1.0.0
precedence: task
derived: false
---

## goal
Implement the three source-proven remaining presentation differences approved by the user (`该起来`).

## non_goals
- No preview replacement, restart, commit, push, backend/control authority changes, invented agent avatar or OS appearance changes.

## requirement_refs / requirement_excerpt
- Current conversation: refine intrinsic control layout, exact asymmetric shoulders and shadow crossfade after reference investigation.

## interface_refs / history_context
- Current design: `opencraft/docs/cloud-desktop-plugin.md#panel-presentation`.
- Prior evidence: `2026-10-07-cloud-aeon-panel-analysis.md#post_delivery_gap_review`.
- Original version 26.930.31428/build 12913: rich panel JS and matched CSS, not official runtime execution.

## acceptance
- No fixed 140px text slot; ordinary localized labels reserve intrinsic geometry to preserve pending cancellation position.
- Only confirmed visor applies 241px minimum; controls stay centered and media geometry unchanged.
- Reference narrow/wide shoulder dimensions and curves; fixed shadows crossfade opacity, including reduced motion.
- Preserve input capabilities, same media DOM, immediate revocation and late grant fencing.

## affected_paths
- Shared desktop SCSS, plugin status markup, panel browser smoke and formal cloud-desktop documentation.

## context_receipt
- Root/local AGENTS read in investigation; maintenance skill and complete verification reference re-read for implementation.
- Router `opencraft rich desktop control island shoulder shadow refinement`: no match. Bounded shared CSS/plugin/test search; adjacency frontend-runtime-openspec-i18n and neighboring real panel fixture read during investigation.

## validation
- Desktop unit suite, plugin/Web type checks, boundaries, i18n, current Web CSS build, real panel browser matrix and scoped documentation impact.

## risks / decisions
- Hidden intrinsic measurement labels must be accessibility-hidden. Confirmed minimum width may intentionally change island width, but pending must not move actions.
- Preserve unrelated dirty changes and current live preview; no automatic publication.

## evidence / handoff
- Implemented shared intrinsic status sizing with accessibility-hidden localized reservations, confirmed-only minimum width, exact reference breakpoint shoulders and fixed pseudo-shadow crossfade. Plugin contributes text only; control/media authority unchanged.
- Standalone cloud desktop suite: 134 passed, 0 failed. Plugin/Web typechecks, boundaries, i18n, Web build and whitespace checks passed.
- Real panel matrix passed: light/dark/custom, 1024/720/320px, Shell 1280/390px, localized controls, held pending cancellation, retained media, centered confirmed visor, shoulder computed geometry, reduced motion. Final artifacts `/tmp/opencraft-desktop-ui-9G3FGm`; actual shadow transitions paused at 120ms prove complementary partial opacity on both fixed layers.
- Screenshot inspected at `/tmp/opencraft-desktop-ui-0Au2kh/light-720-zh-control.png`; synthetic framebuffer, not remote OS or official Codex runtime. Original screenshot does not establish exact runtime pixel parity.
- Existing live build remains `20261007-rich-desktop-5b9f70ea2`. No preview replacement/restart/commit/push performed. Local generic Web build is verification output, not a headless deployment candidate.

## checkpoint
### stage
Implementation and targeted validation complete, awaiting separately authorized preview delivery.
### verified
- Shared primitive changes and real browser acceptance above; existing lifecycle suite passes.
### unverified
- Official Codex runtime pixel parity, actual iPhone OS keyboard and current live rendering of these refinements.
### discard
- Fixed 140px status slot and symmetric approximate shoulders are superseded.
### restore
- Worktree `/data/opencraft-desktop-master-2s0Onl/repo` contains prior dirty work; retain all unrelated changes. Latest delivery baseline and receipts remain in prior rich-presentation task.
### next_action
- If user requests replacement, use current running baseline plus scoped overlay and self-hosted-preview skill; do not deploy the older generic whole worktree build.

## authorized_preview_delivery
- User now authorized replacement (`替换呗`). Fully read self-hosted preview skill and checked actual port 80 listener PID 1907435, systemd cgroup/unit, cwd, Web version and runtime hash. Router delivery query had no match; bounded prior-delivery/source inspection followed.
- Existing isolated candidate retains current 5b9f70ea2 baseline and earlier desktop overlay. Only three refinement files transferred; SHA256 values match original source. Rebuilt using the correct headless host configuration as `20261007-rich-refinement-5b9f70ea2`.
- Candidate 114/114 desktop tests and plugin typecheck passed; actual component/current candidate CSS browser matrix including 120ms shadow sampling passed at `/tmp/opencraft-desktop-ui-hKCSxH`.
- Independent frontend atomic-exchange supervisor completed successfully. Delivery receipts `/data/opencraft-rich-refinement-preview-90ll9g/{prepared.json,deployed.json,live-verified.json}` confirm live build `20261007-rich-refinement-5b9f70ea2`, health success, desktop/mobile light/dark composer and SSH management startup without asset/page errors, retained old entry assets and no inference. Backend PID 1907435 and runtime SHA256 cba7fa89d21f40a9ca775a03d39ca05f1da34365c9ca5565c752b7e9aa81ac26 unchanged; no restart. Full previous Web retained at `/data/opencraft-tencentoa-preview-nfiGVw/opencraft-server/web-rich-refinement-20261007`; earlier rollback also untouched.
