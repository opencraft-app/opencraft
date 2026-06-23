# packages

Frontend packages live here.

Each package owns one layer of the Chat Surface pipeline. Keep dependencies one-way:

`vela-chat-client -> vela-chat-surface -> vela-chat-render-model -> vela-chat-web`.

Host adapters sit outside that core pipeline:

- `vela-chat-controller` wires read models, streams, drafts, and commands for a single active session.
- `vela-chat-next` adapts the controller and ChatUI to a normal Next.js host page.
- `vela-desktop-shell` adapts the same ChatUI to the desktop app shell.
- `app/chat` remains the debug workbench, not the embedding contract.

Do not hide transport, projection, render policy, and React UI in one component.
