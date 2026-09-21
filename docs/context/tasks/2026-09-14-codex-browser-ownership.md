---
id: codex-browser-ownership
type: task
scope: Direct migration of Codex browser manager and presentation state machine
triggers: [opencraft, codex-browser-ownership]
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

## requirement / scope

User: 直接迁移 Codex 的管理器与呈现状态机. Preserve source class bodies; only inject local host ports. Remove the approximate desktop handoff loop. No Owl adoption and no new bottom-panel UI.

## context_receipt

- opencraft/design/README.md and invariants.md
- ref/codex/features/browser/browser-sidebar-webview-manager.ts
- ref/codex/browser/internal/is-different-host-in-conversation.js
- ref/codex/features/browser/get-or-create-browser-sidebar-webview-root.ts
- Current BrowserPresentationCoordinator and Electron surface/metadata ports
- Router: no pack matched; bounded search of above paths

## acceptance

One Page backing owner, mount claim identity + generation fencing, attachment acknowledgement followed by prewarm and next-frame release, fast replacement/cancellation restores the correct outgoing page, close differs from detach, storage identity independent of placement. Source parity check, deterministic transition tests and native multi-tab smoke required.

## checkpoint

Both source classes are now called by the application. The former handoff timers and BrowserMountClaims implementation are removed. Source hashes are locked in codex/source-manifest.json. Storage identity and host generation flow from the source manager into the standard Electron backing; backing metadata is an index, not an independent identity writer.

Focused source-state tests and native multi-tab/form/partition-restart smoke passed before the final cleanup. Gate exposed one obsolete source-shape assertion expecting direct surfaces.commit; updated it to assert delegation to manager.syncElectronWebview while retaining the geometry assertion. Final gate and package are pending.

2026-09-14 continuation: first-backing creation now routes through the source manager, closing the precreation ownership gap. Window/document listeners are scoped by injected event ports. Deferred detach checks the current mount generation before entering the source transition (which expects its caller to fence stale leases). Physical commit no longer owns focus; the presentation host owns focus after interaction release. 66 focused tests pass. Final package and gate logs: /tmp/codex-manager-delivery-{build,package,gate}.log. Packaged synthetic smoke must pass before handoff; no user credentials or model requests.

Final evidence: full gate, Electron build, arm64 package and codesign verification exit 0. The final packaged executable passed the multi-tab/native-navigation/hidden-form/isolation/DOM-bridge/restart-cookie smoke; /tmp/codex-manager-packaged-smoke.log, screenshot /tmp/oc-browser-MGEbk1/browser.png. Opened release/codex-browser-ownership-preview/mac-arm64/OpenCraft Preview.app with an isolated user-data profile. No commit or push; no real inference or credential changes. Source class lock and host port correctness are separate evidence; this is not a claim that all Codex browser features or private host APIs exist locally.
