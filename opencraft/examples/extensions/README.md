# Trusted extension example

`hello.mjs` is a self-contained module using only the public extension contract.
Serve this directory with an HTTP server that enables CORS, then install the
module's URL from the Workbench plugin settings. HTTPS Workbench requires HTTPS
module URLs. Select the new sidebar entry to open an application-owned window.
Disabling the extension removes the entry and closes its pending window.

The JSDoc import supplies development types; the browser executes no package
imports. `api.signal` is aborted before retirement cleanup. Async work should
consume it, and acquired resources should be registered with
`api.subscriptions.add(dispose)`. Registration of contributions happens during
activation; resource subscriptions can also be added while active.

This is the trusted development channel: code runs in the renderer realm. It is
not a sandbox or a signed distribution artifact. New installations store the
self-contained module and its SHA-256 alongside the source URL. Restart uses
those bytes after integrity validation; Reload explicitly fetches an update.
Bundle all imports, avoid import.meta, and keep the UTF-8 bundle under 512 KiB.
