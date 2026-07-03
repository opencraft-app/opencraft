# Composer Editor

This folder owns the editable prompt surface. It is intentionally narrower than
the composer shell:

- The editor owns Lexical, selection, keyboard text commands, undo/redo, IME
  behavior, and future inline token nodes.
- The editor exports plain `ComposerEditorSnapshot` data and an imperative
  `ComposerEditorHandle`.
- The editor does not own model/backend controls, permission controls,
  attachments, session creation, or message send orchestration.

Prompt text remains the canonical send payload. Future file mentions, skill
chips, terminal-context chips, and pasted context blocks should add nodes and
snapshot metadata here without leaking Lexical types to composer callers.
