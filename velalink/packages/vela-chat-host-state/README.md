# `packages/vela-chat-host-state`

Host-provided local state adapters for Vela chat surfaces.

This package intentionally stores only client-side state. It does not own
velad facts, OpenAPI contracts, agent configuration, or provider secrets.

- `conversation_scroll`: local, disposable per-session scroll resume state.
  Missing state means the conversation opens at the bottom.
- `composer_draft`: local per-session draft text. Hosts should treat this as
  private user content and may disable or expire it.
- `shell_layout`: host-owned desktop shell layout such as sidebar width and
  visibility. ChatUI should not read this namespace.
- `session_selection`: host-owned navigation memory for the currently opened
  session. Missing state means the host may choose its usual default session.

The host injects concrete storage. Browser hosts can use Web Storage; Electron
or native hosts can swap in their own key-value implementation without changing
ChatUI or the controller.
