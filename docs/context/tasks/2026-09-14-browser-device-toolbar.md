---
id: browser-device-toolbar
type: task
scope: Replace improvised device form with Codex compact toolbar and edge handles
triggers: [opencraft, browser-device-toolbar]
owner: mingyuxiao
authority: primary
source_of_truth:
  - opencraft/docs/browser-workbench-architecture.md
status: retired
reviewed_at: 2026-09-14
review_due: 2026-10-14
revision: 1.0.0
precedence: task
derived: false
---

## requirement / scope

User screenshot rejects thick bordered width/height row and drag text button. Use Codex DeviceToolbar layout, input edit/blur semantics and boundary handles; keep product theme/icon entry. No unrelated model/DSH changes.

## context_receipt

Route has no pack. Read current browser-panel-plugin and shared viewport layout; ref/codex/lazy/app-initial/render-browser-sidebar-comment-overlay.js toolbar/input/resize helpers. Existing Codex viewport helpers are source-derived.

## acceptance

34px toolbar, compact width × height inputs, device preset, rotate, zoom and close; labels collapse at source breakpoints. No drag text button. Five edge/corner handles, live held resize, cancellation, keyboard access and narrow/dark native screenshots. Full service gate plus packaged smoke.

## checkpoint

Compact source-layout toolbar and source input editing semantics implemented; rejected form/drag text removed. Edge handles consume the same viewport layout as backing; source resize math retained. Native smoke passed held resize, zoomFactor 125%, mode close, and 760/980px window geometry (toolbar 34px, no clipped controls). Actual dark theme command validation is being added; OS preference alone does not override the app's light preference.

First native run hit existing right-panel-tab-drag-cursor interception after clicking a tab; fixture navigation now uses the tab's supported keyboard activation to isolate device-toolbar validation. This does not claim the unrelated tab-drag issue is fixed.

Dark-mode QA uses the app's actual Settings → Appearance radio controls, then returns to the same browser. Screenshot review caught missing edge measurement on a fresh panel remount: child layout effect ran before parent slot ref attachment. Subscription now starts after ref attachment; handles remain absent until measured. Added native equality checks for guest/handle width, height and vertical position after settings navigation and resize. Final remount regression and package pending.

Final: full npm gate, Electron build, arm64 package and codesign verification passed. Packaged smoke /tmp/device-toolbar-packaged-smoke.log passed, including held handle resize, width/height rotation, native 125% zoom, 34px/no-overflow toolbar geometry, settings navigation/remount equality and actual dark theme. Screenshot evidence /tmp/oc-browser-5QeKVt/device-toolbar.png and device-toolbar-narrow-dark.png. Opened release/codex-device-toolbar-final-preview/mac-arm64/OpenCraft Preview.app. No commit/push, paid inference or existing user-profile changes.
