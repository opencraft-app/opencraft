---
id: desktop-webview
type: task
scope: Standard Electron webview with application-owned browser lifetime
triggers: [opencraft, desktop-webview]
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

## goal / requirement_excerpt

User: “严格按照Codex复刻，包括细节，只是WebContents无法实现而已。” Codex is the management/interaction reference. Standard Electron webview is the physical backing; Web keeps iframe. Only Owl adoption of pre-existing WebContents is excluded, not WebContents itself.

## context_receipt

OpenCraft maintenance/desktop-apps skills, browser-workbench-architecture, current surface/runtime/coordinator; ref/codex browser manager/root; ref/wb LocalWebview/CloudIFrame. Router has no matching pack. Exact search confirmed bootstrap always selected iframe.

## acceptance

Desktop renders webview; native URL/title/back/forward are authoritative; park/remount preserves page/partition; stale handles cannot hide a newer presentation; guest has no Node/preload/app IPC privileges. Real packaged native check, focused regressions, type/build gates. No user credential changes or real model requests.

## checkpoint

Implemented application-owned guest root, separate persisted storage identity and ephemeral renderer/host/mount generations, late-release fencing, native navigation/title, focus/park handling, guest sandbox authority and existing PreviewBridge semantics.

Native smoke passed against a real Electron process: frame-ancestors/X-Frame-Options DENY page, hide/show retains WebContents ID and unsubmitted form, real-user-gesture navigation/back, no Node/app bridge in guest, typed DOM context read, restart retains partition metadata and synthetic cookie. Evidence: /tmp/oc-browser-7AIak4/browser.png. Full gate and build passed; final preview package pending handoff. No real models, secrets or existing user profile were used by smoke.

Verification issues resolved: default macOS temp path exceeded Unix socket limit; Electron module lookup attempted unnecessary download; test used visible text instead of the actual New browser tab accessible name; synthetic link navigation required userGesture for Chromium back-history behavior. These were harness failures, not claimed as product fixes.

Handoff: final arm64 bundle release/codex-webview-preview/mac-arm64/OpenCraft Preview.app passed codesign and was opened. Packaged-window inspection confirms one webview and zero iframe browser surfaces. No commits or push. This records verified desktop presentation/navigation/lifetime behavior, not certification of all unavailable Codex host internals.
