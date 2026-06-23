# vela-desktop-shell

Reusable desktop shell components for Vela.

This package owns the window-level React shell: sidebar chrome, session list,
resize behavior, and host bridge contracts. It does not start `velad`, fetch
chat read models, or render conversation content. Hosts provide sessions,
callbacks, and a `DesktopHostBridge` implementation.

The first consumer is `apps/vela-desktop-electron`; the same shell can later be
hosted by a native WebView wrapper.

