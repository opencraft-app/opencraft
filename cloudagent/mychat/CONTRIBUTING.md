# Contributing

Thanks for contributing to MyChat ACP. This repository contains a local ACP chat UI and gateway used to exercise ACP-compatible agents.

## Development Setup

Requirements:

- Node.js and pnpm
- Go 1.24 or newer for the local gateway

Install dependencies:

```bash
pnpm install
```

Run the frontend:

```bash
pnpm dev --host 127.0.0.1
```

Run checks:

```bash
pnpm test -- --runInBand
pnpm build
go test ./...
```

For a local `gateway` backend, use:

```text
http://127.0.0.1:5173/?acp_url=http://127.0.0.1:18094/acp
```

## Pull Requests

Before opening a PR:

1. Keep UI, protocol, and gateway changes scoped.
2. Add tests for session restore, streaming, attachments, tool timelines, or gateway behavior when those areas change.
3. Run `pnpm test -- --runInBand`, `pnpm build`, and `go test ./...`.
4. Update README or protocol docs for visible behavior changes.
5. Do not commit generated build output, local state, `.env` files, or reference repositories unless explicitly required.

## UI and Protocol Expectations

- Preserve the canonical message model: messages contain typed blocks such as text, attachment, reasoning, tool call, and artifact.
- Do not synthesize attachment text fallbacks when the file upload path fails.
- Treat `replay_done` as the end of session load replay.
- Avoid introducing UI behavior that depends on timing instead of explicit protocol events.

## Secrets

Never commit API keys, provider tokens, cookies, private URLs, or local `.env` files. If a secret is accidentally committed, rotate it immediately and report it privately.
