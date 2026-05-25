# CloudAgent

CloudAgent is an experimental agent runtime monorepo. The current focus is an ACP/OpenAI-compatible wrapper that can route chat, files, reasoning, and tool execution through Tencent AGS sandboxes.

## Packages

- `gateway/`: Go backend exposing OpenAI-compatible HTTP APIs and ACP WebSocket APIs.
- `mychat/`: React ACP chat frontend for local development and manual testing.
- `research/`: upstream/reference checkouts used for implementation research.

## Current Cloud ACP Endpoint

The current Beijing cloud deployment is:

```text
http://cloudagent.lightvela.com
```

Raw ACP WebSocket endpoint:

```text
ws://cloudagent.lightvela.com/acp
```

`18094` is the local development port. The cloud service listens on `8080`.

## MyChat Quick Start

Start the local static frontend:

```bash
cd mychat
pnpm install --frozen-lockfile
pnpm dev
```

Open MyChat. It uses the current cloud ACP backend by default:

```text
http://127.0.0.1:5173/
```

Equivalent default gateway base:

```text
http://cloudagent.lightvela.com
```

If you open the URL from another machine, `127.0.0.1:5173` means that machine itself. Start `mychat` on that machine, or expose the frontend through a reachable host.

## Headers

For the raw ACP WebSocket debug endpoint, no header is required:

```text
ws://cloudagent.lightvela.com/acp
```

When no identity header is provided, the backend falls back to its configured default scope:

```text
tenant-live
project-live
```

If your ACP client supports custom WebSocket headers, prefer one of these:

```text
Authorization: Bearer smoke-key
```

or:

```text
X-Tenant-ID: tenant-live
X-Project-ID: project-live
```

HTTP APIs such as `/v1/models`, `/v1/files`, `/v1/responses`, and `/v1/chat/completions` require identity headers:

```bash
curl -sS \
  -H 'Authorization: Bearer smoke-key' \
  http://cloudagent.lightvela.com/v1/models
```

File upload example:

```bash
curl -sS -X POST http://cloudagent.lightvela.com/v1/files \
  -H 'Authorization: Bearer smoke-key' \
  -F purpose=assistants \
  -F file=@./README.md
```

`smoke-key` is not a Tencent Cloud key, TokenHub key, or AGS key. In the current deployment it only triggers default tenant/project resolution. If the backend is configured with `GATEWAY_API_KEY` or `CLOUDAGENT_API_KEY`, the Bearer token must match that configured value.

Do not put Tencent Cloud secrets, TokenHub keys, or AGS keys in the frontend.

## Minimal ACP Flow

Connect to:

```text
ws://cloudagent.lightvela.com/acp
```

Initialize:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}
```

Create a session:

```json
{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"/workspace"}}
```

Inspect CloudAgent runtime status:

```json
{"jsonrpc":"2.0","id":20,"method":"_cloudagent.session.status","params":{"session_id":"session_xxx"}}
```

Send a text prompt:

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "session/prompt",
  "params": {
    "sessionId": "SESSION_ID",
    "prompt": [
      {"type": "text", "text": "你好，请只回复 OK"}
    ]
  }
}
```

## More Documentation

- Backend details: `gateway/README.md`
- Cloud ACP endpoint and protocol notes: `gateway/docs/acp-cloud-endpoint.md`
- ACP backend integration: `gateway/docs/acp-backend.md`
- LibreChat integration notes: `gateway/docs/librechat.md`
- MyChat frontend notes: `mychat/README.md`

## Local Backend

For local backend development:

```bash
cd gateway
make publish-hermes-sidecar
make start-agent-sidecar-server
```

Then call the local wrapper:

```bash
curl -sS -N -X POST http://127.0.0.1:18094/v1/responses \
  -H 'Content-Type: application/json' \
  -H 'X-Tenant-ID: tenant-live' \
  -H 'X-Project-ID: project-live' \
  -d '{"model":"agent-sidecar-chat","stream":true,"input":"你是哪个模型？用一句话回答。"}'
```

Run the full live AGS flow:

```bash
cd gateway
make e2e-agent-sidecar
```
