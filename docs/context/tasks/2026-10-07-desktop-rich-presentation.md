---
id: task-2026-10-07-desktop-rich-presentation
type: task
scope: Rich cloud desktop media card and confirmed ownership presentation.
triggers:
  - desktop rich presentation
  - desktop ownership visor
  - desktop media card geometry
owner: opencraft-maintainers
authority: primary
source_of_truth:
  - opencraft/plugins/cloud-desktop/src/index.tsx
  - opencraft/packages/design-system/src/desktop-view.web.scss
status: retired
reviewed_at: 2026-10-07
review_due: 2026-11-07
revision: 1.0.1
precedence: task
derived: false
---

## goal
Implement the rich desktop media card, floating ownership island and confirmed-control perimeter/visor, following the original CloudAeonComputerPanel composition.

## non_goals
- No remote OS theme, provisioning, transport change, snapshot persistence, account avatar, deployment, restart, commit or push.
- Do not replace pending cancellation or user-gesture focus with reference behavior that loses existing safeguards.

## requirement_refs / requirement_excerpt
- Current conversation: user approved implementation after source-based reference investigation.

## requirement_ids
- conversation.desktop-rich-presentation.2026-10-07

## interface_refs / data_structure_refs
- Optional `DesktopConnectionSnapshot.mediaAspectRatio`: adapter-owned decoded backing ratio, never shared remote resize.
- `DesktopViewController` projects current connection geometry and remains the input intent/grant authority.
- Design-system `desktop-view.web` owns aspect-fit aperture, shared styling and motion; product plugin supplies status/actions and confirmed active ownership.

## history_context
- Current design: `opencraft/docs/cloud-desktop-plugin.md`.
- Reference evidence: `2026-10-07-cloud-aeon-panel-analysis.md`. The earlier simple panel comparison is not rich-entry parity evidence.
- Preserve all existing uncommitted input, cursor and focus work in this checkout.

## current_design_refs
- `opencraft/docs/cloud-desktop-plugin.md#panel-presentation`

## relevant_evolution
- Rich-entry source investigation corrected the earlier simple-panel visual comparison; preserve earlier input eligibility/focus/cursor fixes.

## superseded_refs
- `2026-10-06-desktop-visual-review.md` remains valid evidence for the simple entry only, not the new rich target.

## acceptance
- Actual framebuffer ratio fits media card; ring follows media, controls remain below card and within viewport on narrow screens.
- Requesting never paints confirmed ownership; cancellation, hidden, blur and late grants cannot revive ring/input.
- Pending feedback does not resize card/action; confirmed control intentionally shifts the control island by 8px to join the card.
- Real component browser coverage for themes, coarse touch, reduced motion and lifecycle; synthetic media/backend explicitly identified.

## affected_paths
- `opencraft/plugins/cloud-desktop/src/{contract,controller,rfb,index,control-action,panel.web}.*`
- `opencraft/packages/design-system/{package.json,src/desktop-view.web.scss}`
- Locale, focused tests/UI fixtures, browser smoke and formal cloud desktop documentation.

## required_context / context_receipt
- Root/OpenCraft AGENTS, maintenance skill and complete verification reference; adjacency card and desktop UI fixture.
- Original reference JS/CSS and actual initializer lazy import read in analysis task.
- Router query `opencraft CloudAeonComputerPanel cloud desktop ownership presentation analysis` had no match; exact bounded plugin/reference search followed, recorded in analysis task.

## evidence
- Initial plugin typecheck passed; existing 132 desktop tests passed before the final direct-surface activation change.
- Current source is dirty and behind origin/master; no merge/pull or preview replacement performed.
- Intermediate browser corrections: replace old invariant forbidding intentional confirmed 8px join; preserve aspect metadata in synthetic fixture reset; wait for acknowledged state rather than the pending Stop label; normalize Chromium multi-layer mask serialization. No input grant or lifecycle safeguard was weakened to pass checks.
- Final actual-component matrix passed: light/dark/custom, 1024/720/320px plus Shell 1280/390px; real framebuffer aspect, wide/small radius and masked ring, direct surface activation/cancel, delayed confirmation, keyboard/null-focusout Stop, touch targets, reduced motion and retained media. Artifacts: `/tmp/opencraft-desktop-ui-GObnJH`. Screenshots use a synthetic framebuffer, not a remote machine or official Mac runtime.
- Real noVNC input smoke passed with synthetic peer/authority: `/tmp/opencraft-desktop-input-oTD7nx`; Chromium IME and touch, not iPhone OS keyboard.
- Final cloud desktop suite and Web build passed. Plugin/Web typechecks, boundaries, i18n and diff whitespace checks passed. Docs impact passed after updating mapped formal ownership documentation.
- Repository context validation remains at historical 6273 errors, zero errors for the two new task records; do not describe the repository-wide context gate as green.

## risks
- noVNC retains coordinate/scaling authority; adapter observes backing canvas dimensions, not CSS bounds.

## preview_delivery_2026_10_07
- User subsequently authorized preview replacement (`替换看看`), extending the earlier implementation-only scope. No commit, push, backend restart or OS theme modification was performed.
- Delivery revalidation found a misplaced DOM assertion and a stale host test adapter; both fixtures were corrected before switching. The earlier combined test/build exit was insufficient proof of the complete test gate. Standalone reruns now prove original source 134/134 and isolated candidate 114/114 plus 20/20 new input tests.
- Candidate uses the actual running baseline `5b9f70ea2dfcdd0fce6aef1165abb5634dafeddd` plus scoped dirty desktop overlay, retaining newer existing preview features instead of publishing the older whole source checkout.
- Candidate plugin/Web typechecks, boundaries, i18n and correctly configured headless Web build passed. Actual-component browser matrix: `/tmp/opencraft-desktop-ui-2uhMm9`; noVNC input smoke: `/tmp/opencraft-desktop-input-JIeUsp`. Synthetic peer/media; iPhone OS keyboard remains unverified.
- Preview frontend atomically exchanged under independent systemd oneshot. Live build `20261007-rich-desktop-5b9f70ea2` verified; backend PID `1907435` and runtime hash unchanged. Health, retained old/new assets, composer and SSH management startup at 1280/390px in light/dark passed without inference.
- Delivery/rollback receipts: `/data/opencraft-rich-desktop-preview-mBLJV3/{DEPLOYMENT.md,prepared.json,deployed.json,live-verified.json}`. Full old Web directory retained at `/data/opencraft-tencentoa-preview-nfiGVw/opencraft-server/web-rich-desktop-20261007`. Frontend overlay is separately recorded; package runtime inventory was not rewritten to imply a new backend release.
- No agent ownership is asserted from observing state. Existing cancel and input eligibility remain authoritative.
- Current live preview will not change from a local build alone.

## validation
- `npm run test:cloud-desktop`, plugin/Web workspace typecheck, `npm run check:boundaries`, `npm run check:i18n`, `npm run build:web`, `npm run smoke:desktop-panel`, `npm run smoke:cloud-desktop` passed.
- Explicit browser executable/module/system-library environment was provided; no system installation or remote authority used.
- Changed-file docs-impact and `git diff --check` passed. Context task-specific checks passed; repository-wide historical errors remain.

## decisions
- Use paired current-theme accent/foreground, not a global hardcoded purple or Vela-specific avatar.
- Stable DOM/media mount; state styling rather than remounting media on takeover.
- Requesting retains cancellable Stop action while delayed dots replace status visually.

## scan_scope / scan_output
- Bounded cloud desktop plugin, shared design-system and existing neighboring desktop tests.

## handoff
- Source and local Web build completed. No preview replacement, restart, commit, push or merge performed. Existing worktree changes preserved; checkout remains behind origin/master.
- Next authorized step is preview replacement followed by actual iPhone/remote desktop visual acceptance. Remote OS theme and persistent last-frame caching remain explicit non-goals, not completed capabilities.
