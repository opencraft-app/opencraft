# Packaged Web Workbench in Expo

The public mobile container builds the complete existing Web
Workbench bootstrap, application, components and styles into one packaged HTML
document. Sidebar, Composer, settings and tool panels retain their Web owners.
The independent RN workbench has been retired. Downstream product entrypoints remain independent; device acceptance is reported separately.

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
npm run build:web-workbench --workspace @opencraft/mobile
npm run dev:expo
npm run build:expo:ios
npm run build:expo:web
```

The runner builds before Metro reads the static asset. The standalone build
emits `apps/mobile/assets/mobile-workbench.html` and an identical
`public/mobile-workbench.html` for Expo Web validation; both are ignored.
`apps/mobile` always selects the bundled Web Workbench for public builds. There
is no RN fallback or native workbench selector. Trusted product entry selection
remains a separate build-time contract.

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

In bundled mode, native admits only the initial local document at the stable synthetic origin
`https://opencraft.invalid/`. No automatic remote executable-page fallback exists. CSP
blocks network scripts/styles/workers; API, WebSocket and media remain network
operations. Subframes are restricted to local documents. Validated
http/https/mailto/tel links open externally. Unknown, oversized, wrong-version
and retired-runtime messages are rejected before native dispatch.

Packaged WASM resources can be fetched through local data/blob URLs and compiled
with the WASM-specific policy permission. JavaScript string evaluation remains
disabled. The built-document smoke exercises both local fetch paths, WASM
compilation and rejection of JavaScript string evaluation in a normal page script.

## Acceptance and remaining limits

The unified entry is not a device-parity or store-review claim:

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
and Metro output are separate evidence from physical-device behavior. Keep downstream assembly separate and record remaining physical-device acceptance honestly.

## Explicit self-hosted website source

Native settings outside the WebView own the source choice and remain reachable
on network error or content-process termination. The default document is bundled;
the user can explicitly select their own HTTPS OpenCraft website. URL credentials,
query parameters, fragments and non-HTTPS schemes are rejected. This new explicit
choice replaces the previous blanket prohibition on remote main documents only
within self-hosted mode, not the packaged-code policy of the built-in workspace.

Selection is versioned in native SecureStore. Save must succeed before retiring
the current view. Failure preserves the current source; corrupt/unavailable stored
selection offers retry and explicit restoration rather than silently switching.
Each selected remote view uses private ephemeral storage and disables shared and
third-party cookies. No credentials or application state are copied between
sources. Switching back to bundled code restores its own Web storage origin;
remote sign-in must be repeated after a view is retired. The Web validation adapter
uses normal browser iframe storage and cannot prove native cookie isolation.

Self-hosted content has no injected mobile identity and no onMessage native bridge.
Only same-origin HTTPS navigation remains in the view; validated external links
open through the system. Android back uses remote WebView history only for this
mode. Built-in content continues to use the original Web memory navigation.
Retries create a fresh document/runtime, rejecting late messages from retired
views. Failed documents never automatically select another source.

Native toolbar surfaces use Expo GlassEffect when available and fall back to
shared semantic surfaces. This container material never creates a second
Workbench navigation state or duplicates Web controls. External website mode
is a technical capability for user-operated services, not an App Store acceptance
guarantee or a mechanism for unreviewed native-code updates.
