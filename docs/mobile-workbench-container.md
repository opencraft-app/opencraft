# Packaged Web Workbench in Expo

The experimental public mobile container builds the complete existing Web
Workbench bootstrap, application, components and styles into one packaged HTML
document. Sidebar, Composer, settings and tool panels retain their Web owners.
The public RN entry remains the default until device and capability acceptance
is complete. Downstream product entrypoints remain independent.

## Ownership

| Owner | Responsibilities |
| --- | --- |
| Web Application | Connections, authentication, navigation, Scope/View, drafts, caches, extensions and panels |
| Expo container | Packaged document, safe area, native foreground/background, Android back and external navigation |
| Shared mobile contract | Versioned, runtime-scoped capability messages; no conversation-state replication |

Native back invokes Web's memory history, not WebView URL back or a second route
stack. Resize/foreground events do not replace the source or remount the app.
Web visualViewport owns keyboard/Composer geometry; native applies the outer
safe area once, without a second keyboard-avoidance transform.
`@opencraft/client-product/mobile-container` is a trusted-container contract,
independent of private Bot/account bridges. Browser/Electron clients without a
container retain normal startup, navigation and lifecycle behavior.

## Build and use

From the core workspace:

```sh
npm ci --no-audit --no-fund
npm run build:web-workbench --workspace @opencraft/workbench-expo
OPENCRAFT_EXPO_WORKBENCH=web npm run dev:expo
OPENCRAFT_EXPO_WORKBENCH=web npm run build:expo:ios
OPENCRAFT_EXPO_WORKBENCH=web npm run build:expo:web
```

The runner builds before Metro reads the static asset. The standalone build
emits `apps/workbench-expo/assets/mobile-workbench.html` and an identical
`public/mobile-workbench.html` for Expo Web validation; both are ignored.
No selector (or `OPENCRAFT_EXPO_WORKBENCH=native`) retains the RN entry. Mixing
the Web selector with a downstream product entry fails rather than replacing it.

Optional `EXPO_PUBLIC_APPSERVER_WS_URL` and `EXPO_PUBLIC_APPSERVER_HOST_ID` seed a
public Host recipe at build time. The URL must be ws/wss without credentials,
query or fragment. Without a seed, use existing Web connection settings.
Use a reachable TLS endpoint on devices; plain ws/http transport depends on OS
cleartext policy and is not validated by the browser smoke.
Never put secrets in public environment variables or build configuration.

## Packaged code

The compiler reuses canonical Web Vite configuration, aliases, React and browser
compatibility transforms. It packages the module graph, styles, fonts, images
and Workers. Missing resources or a separate module graph fail the build.
Normal Web startup/lazy-download budgets are unchanged; the complete mobile
document's startup and memory cost must be measured before default use.

Native admits only the initial local document at the stable synthetic origin
`https://opencraft.invalid/`. No remote executable-page fallback exists. CSP
blocks network scripts/styles/workers; API, WebSocket and media remain network
operations. Subframes are restricted to local documents. Validated
http/https/mailto/tel links open externally. Unknown, oversized, wrong-version
and retired-runtime messages are rejected before native dispatch.

Packaged WASM resources can be fetched through local data/blob URLs and compiled
with the WASM-specific policy permission. JavaScript string evaluation remains
disabled. The built-document smoke exercises both local fetch paths, WASM
compilation and rejection of JavaScript string evaluation in a normal page script.

## Acceptance and remaining limits

This is an experimental entry, not a device-parity claim:

- Remote browser proxy documents and installed executable extensions are
  restricted by packaged-code policy; they need an approved mobile resource or
  surface adapter. Shared UI alone does not prove these operations work.
- File inputs use WebView's system picker; permissions, cancellation, large
  attachments, recording, clipboard and downloads need device acceptance.
- Native modal/back priority, deep-link/OAuth return, secure credential storage,
  notification delivery and service-worker-dependent operations,
  WebView storage across upgrade/process death and recovery of unsent edits
  require further work. Native SQLite drafts/credentials are not migrated.
- Chinese IME, soft/hardware keyboards, selection, scrolling, panel gestures,
  accessibility and large documents require iOS/Android hardware evidence.

Validate protocol/entry tests, both clients' types, platform boundaries, the
actual packaged-document browser smoke and native bundles. Browser simulation
and Metro output are separate evidence from physical-device behavior. Keep RN
fallback and downstream assembly until the remaining acceptance is resolved.
