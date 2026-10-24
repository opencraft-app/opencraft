# ClientRuntime: Web, PWA and Electron

ClientRuntime owns one renderer document's presentation resources. It is separate
from AppServerWorkbenchRuntime, Thread/Actor execution, the server Host, and the
Browser tool's WebBrowserRuntime. It does not own accounts, drafts, routes, theme
preferences or native execution.

| Implementation | Owned presentation capabilities |
| --- | --- |
| WebRuntime | Shared DOM pointer/focus modality and window-appearance projection |
| PwaRuntime | Web capabilities plus the installed-app edge-navigation policy |
| ElectronRuntime | Web capabilities plus the preload fullscreen subscription/snapshot and existing native appearance port |

The bootstrap factory checks the actual Electron bridge before PWA display mode.
Only a top-level browser document with Apple's standalone flag or standalone media
mode selects PwaRuntime. Embedded/native-container documents keep Web mechanics
and their existing host-owned system appearance capability. Runtime identity is
not an authorization boundary; DOM projection attributes never grant host access.

Construction is passive. Bootstrap starts one runtime, binds its narrow appearance
projector to the existing appearance owner, then mounts the application. Appearance
still resolves preference, requested/applied ID, catalog and mode. Runtime only
projects that intent through the existing window adapter, preserving Electron's
window background separately from the Shell edge surface. The synchronous HTML
head uses the same pure codec/catalog before a runtime exists; no second palette
cache or preference writer is introduced.

Page retirement and HMR unbind the projector and dispose input/native listeners
before unmounting React. Start/dispose are idempotent, a retired instance cannot
restart, and partial startup releases its acquired resources. Persisted pagehide
retains the runtime with its document. Moving between conversations preserves the
same runtime and application state.

## PWA edge policy

PwaRuntime reserves native history contacts only when the Apple Home Screen
capability is present. Its capture/non-passive listener cancels a single initial
touch in either outermost 20 CSS pixels, using the current viewport width after
rotation. Center contacts, multi-touch and noncancelable events keep their normal
handling. Cancellation does not stop propagation, invent history entries, rewrite
URLs or trap popstate. Both reserved strips also consume edge-origin taps/scrolls;
the Shell's existing 24px system-edge gutter remains separate from its gesture
owner. Explicit Back/Forward continues through the application navigation owner.
Ordinary Web tabs, Electron, embedded views and non-Apple installed PWA input are
unchanged. Native OS gesture cancellation still depends on delivery of a
cancelable event and requires physical-device acceptance.

This boundary does not prove arbitrary iOS status-bar drawing, live system tint
adoption, installation metadata refresh or a specific OS regression. The existing
window projection keeps native system appearance unobserved.
