# MyChat ACP

MyChat ACP is a local web chat client for ACP-compatible agents. It provides a React chat UI plus a small Go gateway that can bridge browser WebSocket traffic to an ACP agent process.

The project is now part of the `cloudagent` monorepo. External reference repositories used during early research are intentionally not vendored here.

## What It Does

- Connects the browser to an ACP backend over WebSocket.
- Supports session list, new, load, resume, close, delete, prompt, and cancel flows.
- Renders assistant text, reasoning, tool calls, attachments, and artifacts as timeline blocks.
- Treats `replay_done` as the explicit end of session replay.
- Uploads files through `/v1/files` and passes uploaded file references into ACP prompts.
- Includes a Go local gateway for app-envelope WebSocket compatibility and optional `/v1/*` file API proxying.

## Local Development

Install dependencies:

```bash
pnpm install
```

Run the frontend:

```bash
pnpm dev --host 127.0.0.1
```

By default, MyChat connects to `http://cloudagent.lightvela.com`. Open:

```text
http://127.0.0.1:5173/
```

When targeting a local gateway, override it with `?acp_url=http://127.0.0.1:18094/acp`.

Run the optional Go gateway:

```bash
go run ./cmd/gateway --addr 127.0.0.1:8765
```

If the gateway should proxy file uploads/downloads to a backend that serves `/v1/files`, configure:

```bash
MYCHAT_FILE_API_BASE_URL=http://127.0.0.1:18094 go run ./cmd/gateway --addr 127.0.0.1:8765
```

Then open:

```text
http://127.0.0.1:8765
```

## Verification

Run:

```bash
pnpm test -- --runInBand
pnpm build
go test ./...
```

## Smoke Testing

The minimal ACP smoke tool lives in `tools/acp_smoke.go`.

Example:

```bash
go run ./tools/acp_smoke.go -prompt "Hello"
```

Use smoke tests carefully against real agents, because prompts may trigger model calls, tool calls, file operations, or sandbox work.

## Repository Hygiene

Do not commit:

- `node_modules/`
- `dist/`
- `.runtime/`
- `.omx/`
- `outputs/`
- `.env` files
- local reference checkouts
- logs containing prompts, headers, signed URLs, or credentials

## Security

This is a development-oriented UI and gateway. Do not expose it directly to the public internet without authentication, origin controls, tenant isolation, and file access controls.
