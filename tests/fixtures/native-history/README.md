# Native-history fixtures for execution-scoped CLI notes

These files are anonymized excerpts of real native transcripts written by the
connected CLIs. Only session/user identifiers, timestamps, cwd values and the
launcher directory were replaced. Record types, field names, block shapes and
ordering are unchanged.

- `claude-code-thread-cli.jsonl`: Claude Code project transcript. The first user
  turn keeps the original OpenCraft note shape (before the marker existed); the
  second turn uses the marked shape emitted by current versions.
- `codebuddy-thread-cli.jsonl`: CodeBuddy project transcript, captured from
  CodeBuddy's ACP session (`codebuddy --acp`) with the same two-block prompt.
- `codex-thread-cli.jsonl`: Codex rollout. It keeps the real `response_item`
  user record and the `event_msg` records the history reader consumes. The
  second turn exercises the older `user_message` string event.
- `pi-opencraft-input.json`: one real `opencraft.input` durable entry (with the
  original input and the model-facing content) plus a native `pi.user` fallback
  entry with the same model-facing content. Pi projects the original input, so
  the fallback only matters for native entries without structured input.

The tests assert that the generated note disappears while the user's own text
and every other block survive, and that the internal launcher path never
reaches a projection.
