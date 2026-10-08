---
id: task-2026-10-07-desktop-frame-preview
type: task
scope: Same-identity in-memory last-frame preview and live-media crossfade.
triggers: [desktop frame preview]
owner: opencraft-maintainers
authority: primary
source_of_truth:
  - opencraft/plugins/cloud-desktop/src/controller.ts
  - opencraft/plugins/cloud-desktop/src/frame-preview.ts
status: retired
reviewed_at: 2026-10-07
review_due: 2026-11-07
revision: 1.0.0
precedence: task
derived: false
---

## goal
Implement the highest-value remaining reference gap: scoped last-frame recovery preview and live image crossfade.
## non_goals
- No persistent screenshot storage, global cache, periodic capture, compact Shell presentation, assistant avatar, backend protocol change, preview replacement, restart, commit or push.
## requirement_refs
- User `搞起来` following the read-only remaining-gap analysis; explicitly scoped in commentary to last-frame continuity.
## interface_refs / history_context
- Current design `opencraft/docs/cloud-desktop-plugin.md#panel-presentation`.
- Optional connection capture; controller owns memory and binding+resource+incarnation eligibility; shared primitive projects a noninteractive image.
- Original rich reference captures bounded frames and keys identity. Adopt recovery continuity without importing product identity or persistent storage.
## acceptance
- At most 1280px longest edge and bounded JPEG; capture failure does not break media.
- Same-target retry shows cached image only after fresh authorized attachment matches resource/incarnation; new identity/instance/revocation/dispose clears it.
- Cache never grants input or renders ring; pending recovery is visibly connecting; current media replaces preview via 240ms fade and reduced motion skips it.
- Late/reentrant capture cannot restore a successor cache; first load has no fake desktop frame.
## affected_paths
- Generic desktop contract/controller/RFB, capture helper, panel renderer/shared CSS, focused tests/real panel fixture and design documentation.
## context_receipt
- Root/local AGENTS, maintenance skill and complete verification checklist read; router `opencraft desktop last frame preview identity recovery crossfade` unmatched. Bounded contract/controller/RFB/index/style/test inspection and adjacent real panel fixture followed.
## validation
- Desktop tests, plugin/Web typechecks, boundaries/i18n, current Web build, panel browser and real noVNC smoke. Synthetic media/authority is not production or iPhone acceptance.
## risks / decisions
- Sensitive image stays only in controller/retired connection memory; no global view reuse or account persistence. Snapshot cannot substitute authorization or actual first-frame readiness. Fresh preparation intentionally shows plain feedback until physical identity is validated.
## evidence / handoff
- Optional bounded synchronous capture implemented at retirement. Original pinned noVNC `_disconnect` detaches the screen but retains backing pixels; RFB captures before its own teardown/publish and can supply that frame after transport termination. No periodic polling required.
- Controller reuse is fenced by generation, fresh prepared target/resource/incarnation, authority denial and disposal. Tests cover pending preparation, instance/principal replacement, missing control, malformed URLs, bounded capture failure and reentrant retirement.
- Final desktop suite: 139 passed, 0 failed. Plugin/Web typechecks, Web build, boundaries, i18n, diff whitespace and scoped design impact passed. Staged-only docs check had no staged files and is not the scoped proof.
- Browser initial revalidation exposed duplicate hidden clipboard-error text from the retained feedback DOM and a test reading visibility before the delayed fade completed. Removed duplicate ready-state description; wait for actual post-animation visibility, preserving the 240ms presentation.
- Final actual panel/CSS matrix passed `/tmp/opencraft-desktop-ui-dv3hyK`, light/dark/custom at 1024/720/320px and Shell1280/390px; capture uses real browser canvas/JPEG, backend/framebuffer contents synthetic. Recovery image has no pointer events, connecting feedback is visible, confirmed ownership absent, and image/feedback hide after current readiness. Recovery screenshot light720 inspected.
- Managed noVNC input smoke passed `/tmp/opencraft-desktop-input-9rx3I6`; peer and authority synthetic, Chromium IME not iPhone OS keyboard or production authorization acceptance.
- Live remains `20261007-rich-refinement-5b9f70ea2`; no preview replacement, restart, commit or push. Assistant avatar and compact Shell preview remain out of scope.

## checkpoint
### stage
Implementation and scoped verification complete; source only.
### verified
- Bounded JPEG, physical identity-scoped in-memory recovery and noninteractive preview fade; prior input lifecycle regressions remain green.
### unverified
- Production recovery chain, official reference runtime pixel parity and actual iPhone keyboard.
### discard
- Pure solid-only recovery presentation superseded in source; initial preparation without validated identity intentionally remains plain feedback.
### restore
- Preserve dirty source at `/data/opencraft-desktop-master-2s0Onl/repo`; latest isolated delivered baseline and rollback receipts are in rich-refinement task.
### next_action
- On explicit replacement request, transfer the scoped contract/controller/RFB/renderer/helper/style/test changes into the latest running baseline candidate and rebuild the headless profile; do not publish the generic source build.

## preview_delivery
- Delivered with control-presentation refinement on explicit user replacement
  request. Live Web `20261007-desktop-control-frame-5b9f70ea2`, unchanged backend
  PID/runtime/data; receipts `/data/opencraft-desktop-control-frame-preview-h6NLSd`.
  See `2026-10-07-desktop-control-presentation.md#preview_delivery` for verification.
