# Trusted extension example

`hello.mjs` is a self-contained module using only the public extension contract.
Start with the [boundary and compatibility guide](../../docs/extension-development.md)
if you are choosing between a client Extension, product composition or Host plugin.

From the repository root, using the pinned Node version:

```sh
npm ci
npm run test:extension-example
npm run dev:web
```

In another terminal at the same root:

```sh
node examples/extensions/serve.mjs
```

The server exposes only `hello.mjs`, enables CORS and disables HTTP caching.
It listens on loopback port 5174; pass another port if needed:
`node examples/extensions/serve.mjs 5175`.

1. Open the **local HTTP** Workbench URL printed by Vite.
2. Press Escape five times in quick succession to enable the existing developer
   mode for this browser tab. Then open Settings → the plugin/extension manager
   (扩展管理) and install
   `http://127.0.0.1:5174/hello.mjs` (adjust the port if changed).
3. Select **Hello extension** in the sidebar to open an application-owned announcement.
4. Disable the extension while the announcement is open. The entry and announcement disappear.
5. Enable it again. Edit the announcement text in `hello.mjs`, then use **Update from source / 从来源更新**
   in the manager and open the entry again to see the update. Saving the source
   alone does not replace an installed module.
6. Stop the example server and refresh the Workbench. The enabled extension
   restores from its stored bytes without downloading again. **Update from source** needs the
   server; restart it before requesting another update.

No model key, configured Host or private workspace is needed. An HTTPS Workbench
requires an HTTPS module URL: this local HTTP server is not for installing into
a hosted HTTPS deployment. If installation fails, check the scheme, printed port,
server process and browser console before changing the module.

`npm run test:extension-example` exercises this HTTP server, the actual module
loader/public API projection, installation, command execution, disable cleanup,
explicit reload and offline restart in Node. It substitutes only Node's importer
for the browser's `blob:` importer; it does not assert rendered browser behavior.
Run the manual steps above when changing the UI.

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
