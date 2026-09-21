---
id: shell-pane-ownership
type: task
scope: Codex Viewport Frame ownership and panel transition reconstruction
triggers: [opencraft, shell-pane-ownership]
owner: mingyuxiao
authority: primary
source_of_truth:
  - opencraft/design/invariants.md
status: retired
reviewed_at: 2026-09-14
review_due: 2026-10-14
revision: 1.0.0
precedence: task
derived: false
---

## requirement

User: 不变量和所有权重构. Fix chat reflow into a narrow sliver during browser panel full/collapse transitions using verified same-version Codex geometry and lifecycle, not Composer-specific min-width patches.

## context_receipt

- Current AppShell, AppShellRightPanel, use-panel-animation
- /tmp/codex-layout-evidence/current-appshell.js and current-appshell.css from installed Codex 26.908.40834
- Source Wba, Xba, Vba, nSi, WH, r_a; exact width equation tested
- opencraft/design/invariants.md; maintenance and motion verification boundaries
- Router no match; bounded Shell exact search

## acceptance

F=max(0,W-min(R,visibility*panelWidth)); Viewport flex aperture, Frame independent width and query container. Distinct progress values, one transaction writer; entering/exiting mode changes and scope snaps fence stale callbacks. No draft/browser remount. Sample in-flight DOM geometry for maximize/restore/hide/reverse plus reduced motion.

## checkpoint

Pure geometry and 63 focused tests pass. Native frame sampler /tmp/shell-pane-native8.log passed maximize/restore/rapid reverse/hide/reopen and reduced-motion endpoint checks: initial Frame480, minimum Frame480 while aperture reaches0. Draft and WebContents ID retained.

Ordinary held resize initially failed even after render settling: pointer move crossed into native guest. A transaction-owned capture overlay restores main-document event delivery; held resize now changes Frame before release. Added cancel/blur/lostcapture cleanup, preserving the initial width on cancellation. Final gate/build/packaged trace pending. No real inference or user-profile mutation.

Final evidence: full gate /tmp/shell-pane-final-gate.log, build/package/codesign exit0. Final packaged frame trace /tmp/shell-pane-packaged.log passed 556 samples across maximize, restore, rapid reverse, hide-from-full, reopen and reduced-motion: minimum Frame480 while viewport reaches0. Ordinary held resize updates before release; simulated pointer cancellation restores its starting width and removes capture layer. Draft and WebContents identity remain intact. JSON traces and settled screenshot: /tmp/oc-pane-4aFgS4. Product preview: release/shell-pane-ownership-preview/mac-arm64/OpenCraft Preview.app. No commits, push, real inference or old-profile mutation.
