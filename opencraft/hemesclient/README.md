# hemesclient

`hemesclient` is a small, self-contained Bun binary that presents a Vela/Codex AppServer
WebSocket endpoint while using Hermes Agent's JSON-RPC gateway as the authoritative backend.
It connects to the real `/api/ws` transport and keeps Hermes' durable session id separate from
the live id returned by `session.resume`.

Implemented AppServer methods:

- `initialize`
- `thread/list` (local opaque pagination over Hermes `session.list`)
- `thread/read`, `thread/resume`, `thread/turns/list`, `thread/items/list`
- `thread/start` → Hermes `session.create`
- `turn/start` → ordered Hermes `image.attach_bytes` / `image.attach` staging followed by
  `prompt.submit` (text, image, local-image, mention, and skill input)
- `turn/interrupt` → Hermes `session.interrupt`
- Hermes `message.start/delta/complete` → AppServer `turn/*`, `item/*`, and
  `item/agentMessage/delta` notifications
- Hermes `tool.start/complete` → typed AppServer `dynamicToolCall` lifecycle
- empty capability baselines for model, permission profile, skill, and project lists

Browser image attachments are sent as AppServer `image` Data URLs. The bridge uploads their
bytes into the live Hermes session before submitting the prompt; HTTP(S) image inputs are fetched
with a 20 MB cap, and gateway-visible `localImage` paths use `image.attach`. If staging or submit
fails, staged paths are detached so they cannot leak into the next turn. Hermes' active-turn
`session.steer` is text-only, so image steers fail explicitly and can instead be queued as the next
turn. Image-only turns and image history survive the AppServer projection.

## Build

```bash
npm install
npm run typecheck
npm test
npm run build
```

The resulting `dist/hemesclient` contains Bun and all TypeScript application code; the target
machine does not need Node.js, Bun, or `node_modules`.

## Run

```bash
./dist/hemesclient serve \
  --gateway http://127.0.0.1:9119 \
  --host 0.0.0.0 \
  --port 9989
```

Point Vela at `ws://<bridge-host>:9989/rpc`. Probe the gateway without starting a server with:

```bash
./dist/hemesclient sessions --gateway http://127.0.0.1:9119
```

For a local loopback Hermes server, the bridge discovers its ephemeral dashboard session token
from the local bootstrap page and uses it only on the `/api/ws` upgrade. A token can also be
supplied explicitly for controlled deployments; it is never included in AppServer frames or logs.

On this machine the services are `hermes-gateway.service`, `hermes-serve.service`, and
`hemesclient.service`; all three are enabled for boot.

The adapter deliberately owns two identities: the durable Hermes session id is exposed as the
AppServer thread id, while Hermes' short live `session_id` is private transport state. Async
events are translated back through that map, so reconnect/resume never leaks a live id into a
Vela route.
