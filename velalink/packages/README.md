# packages

Frontend packages live here.

Each package owns one layer of the Chat Surface pipeline. Keep dependencies one-way:

`vela-chat-client -> vela-chat-surface -> vela-chat-render-model -> vela-chat-web`.

Host adapters sit outside that core pipeline:

- `vela-chat-controller` wires read models, streams, drafts, and commands for a single active session.
- `vela-chat-query` adapts cache-backed React read models and command writeback without owning transport or streaming runtime.
- `vela-chat-next` adapts the controller and ChatUI to a normal Next.js host page.
- `vela-desktop-shell` adapts the same ChatUI to the desktop app shell.
- `app/chat` remains the debug workbench, not the embedding contract.

Do not hide transport, projection, render policy, and React UI in one component.

## Cross-host UI boundary

Reusable UI is split by altitude:

- **Surface** packages are feature renderers that can be embedded by different hosts. Examples: `SessionListSurface` and `ChatSurface` from `vela-chat-web`.
- **Shell** packages own host chrome and platform layout. Example: `vela-desktop-shell` owns Electron-style sidebar chrome, traffic-light safe areas, drag regions, resize behavior, and desktop-only sidebar composition.
- **App hosts** own page layout, navigation, auth, runtime endpoints, and platform capabilities.

Web, cloud, or mobile hosts should compose their own sidebar or page layout and embed `SessionListSurface` / `ChatSurface` directly. They must not import `VelaDesktopShell`, `SessionSidebar`, desktop Electron CSS, traffic lights, or drag-region components.

If a component lives in `vela-desktop-shell`, treat it as desktop-only unless its docs explicitly say otherwise.
