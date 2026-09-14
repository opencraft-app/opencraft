---
id: browser-completion
type: task
scope: Complete browser host integration around migrated Codex ownership
triggers: [opencraft, browser-completion]
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

User: 全部搞起来. Complete managed popups, close/storage cleanup, background browser use, per-site permission decisions and revocation, device controls, prewarm/crash recovery.

## non_goals

No Owl adoption, bottom-panel UI, production changes, paid model calls, commits or clearing existing user data. Deny unknown privileged permissions. Do not claim trusted OS input for the semantic PreviewBridge.

## context_receipt

Browser runtime/coordinator/guest code; imported Codex manager and transition; browser-core/dynamic tool schema; desktop-apps, maintenance, baseline-ui, fixing-accessibility. Route returned no pack.

## acceptance

Managed popup keeps original page, owner-bound permissions never leak across origins or guests, explicit clear differs from close, background access retains backing and releases claims, viewport source is shared, crashed backing replaced without new logical page/storage identity. Focused tests, full gate, native synthetic flow.

## checkpoint

Implemented managed popup routing, private per-site permission decisions and explicit revoke/clear, background creation and operation claims, native screenshot/close tools, Codex device presets/drag dimensions, source-manager prewarm registration and crashed guest reload. Desktop Scope bindings now share durable metadata storage; unresolved restored scopes remain dormant instead of being deleted.

Focused tests passed. Native flow /tmp/browser-completion-native4.log passed popup, background DOM read/capture/control release, held viewport drag, forced synthetic guest crash/reload, permission denial/revoke/data clear and restart-cookie checks. Native permission dialog responses were deterministic test substitutes; no real location/camera/microphone access. Evidence /tmp/oc-browser-yUSRC8.

Gate found an old fake Page runtime without setNewWindowHandler; fixture updated. Final gate/build/package pending. No external models/user credentials or existing profiles touched.

Final hardening: retired partitions have a separate metadata inventory and an explicit native-confirmed cleanup entry; close does not silently delete login state. Source handoff interaction lock and automation lock are separate owners. Permission grants and screenshots fence document-generation changes. Native smoke now includes the retired cleanup entry and validates active partition cookies survive restart.

Native packaged smoke passed with the expanded scenario matrix (/tmp/oc-browser-VHyhDX). A final presentation pass groups low-frequency permission/data controls in the existing Radix/themed site-settings menu; menu build/package/gate are running. Plain managed links/popups are supported; native WindowProxy/opener login protocols and Owl adoption are not claimed. Real camera/microphone/location access remains untested, permission dialogs use deterministic test responses.

Final handoff: menu-version full gate, build, arm64 package and codesign all exit 0; /tmp/browser-capabilities-menu-{gate,build,package,smoke}.log. The packaged smoke passed every asserted scenario, including menu entry points, isolated background read/capture/close, held resize, native popup, synthetic guest crash/reload, permission refusal/revoke/current and retired data cleanup, restart of synthetic cookies. Screenshot /tmp/oc-browser-A1AR94/browser.png. Opened release/browser-capabilities-menu-preview/mac-arm64/OpenCraft Preview.app. No commit/push, paid inference or changes to existing user credentials/profiles.
