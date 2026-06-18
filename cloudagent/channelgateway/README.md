# CloudAgent Channel Gateway

`channelgateway` bridges external chat channels to CloudAgent runtime APIs.

Current shape:

- channel adapter: WeCom AI Bot WebSocket
- session truth: SQLite store with embedded Go migrations
- runtime target: CloudAgent HTTP session-event protocol, with ACP WebSocket kept as a
  compatibility fallback
- ownership: one channel account connection is held by one process lease owner
- multi-tenant runner model: every active `channel_accounts` row gets an independent lease, WeCom WSS adapter, ACP client, dispatcher, and outbox pump
- release entry: `.ci/channelgateway.yml` extends the shared service-release template

CI trigger notes:

- 2026-06-03: README-only no-op change to rerun channelgateway through the standard Git webhook auto-pin path.

## Run

```bash
cd cloudagent/channelgateway
GOWORK=off go run ./cmd/channelgateway
```

Useful environment:

```bash
CHANNELGATEWAY_DB_PATH=channelgateway.db
CHANNELGATEWAY_DB_DRIVER=sqlite
CHANNELGATEWAY_ACP_URL=ws://127.0.0.1:18094/acp
CHANNELGATEWAY_RUNTIME_PROTOCOL=acp
CHANNELGATEWAY_ACP_AUTHORIZATION="Bearer ..."
CHANNELGATEWAY_TENANT_ID=default
CHANNELGATEWAY_PROJECT_ID=default
CHANNELGATEWAY_OWNER_ID=channelgateway-local
CHANNELGATEWAY_LISTEN_ADDR=:8094
CHANNELGATEWAY_ACP_INITIALIZE_TIMEOUT=15s
CHANNELGATEWAY_SESSION_IDLE_CLOSE=1m

CHANNELGATEWAY_WECOM_ENABLED=true
CHANNELGATEWAY_WECOM_ACCOUNT_ID=wecom-default
WECOM_BOT_ID=...
WECOM_SECRET=...
WECOM_WEBSOCKET_URL=wss://openws.work.weixin.qq.com
CHANNELGATEWAY_AGENT_ID=main
```

Production multi-pod deployments should use a shared MySQL store so
`channel_conversations.session_key -> acp_session_id` survives pod switches and
process restarts:

```bash
CHANNELGATEWAY_DB_DRIVER=mysql
CHANNELGATEWAY_DB_PATH='user:password@tcp(mysql-host:3306)/channelgateway?charset=utf8mb4&parseTime=true'
```

`CHANNELGATEWAY_DB_PATH` also accepts `mysql://user:password@host:3306/db`
URLs and converts them to the Go MySQL driver DSN internally.

For durable channel traffic, use the CloudAgent HTTP session-event protocol
instead of ACP WebSocket:

```bash
CHANNELGATEWAY_ACP_URL=http://127.0.0.1:18094
CHANNELGATEWAY_RUNTIME_PROTOCOL=cloudagent
```

In this mode `CHANNELGATEWAY_ACP_URL` is a legacy variable name: it is treated
as the CloudAgent HTTP base URL. Do not append `/acp`.

The CloudAgent HTTP session-event protocol is not WebSocket. It uses ordinary
HTTP JSON for session APIs and user-message submit, plus Server-Sent Events for
session event streaming:

```text
GET  /v1/cloudagent/capabilities
GET  /v1/cloudagent/sessions
POST /v1/cloudagent/sessions
GET  /v1/cloudagent/sessions/{session_id}
POST /v1/cloudagent/sessions/{session_id}/events
GET  /v1/cloudagent/sessions/{session_id}/events?after_seq=N
GET  /v1/cloudagent/sessions/{session_id}/events?after_id=evt_x
GET  /v1/cloudagent/sessions/{session_id}/events/stream
```

All requests must include either `Authorization: Bearer ...` or both
`X-Tenant-ID` and `X-Project-ID`. Devcloud test values:

```bash
export CLOUDAGENT_BASE_URL=http://21.6.84.6
export CLOUDAGENT_TENANT_ID=tenant-devcloud-dep
export CLOUDAGENT_PROJECT_ID=project-devcloud-dep
```

Capability check:

```bash
curl -sS \
  -H "X-Tenant-ID: $CLOUDAGENT_TENANT_ID" \
  -H "X-Project-ID: $CLOUDAGENT_PROJECT_ID" \
  "$CLOUDAGENT_BASE_URL/v1/cloudagent/capabilities"
```

The response must advertise `protocol: "cloudagent.session_events"` and
`session_event_protocol: true`. `run_protocol: true` may also appear because
CloudAgent still keeps an internal durable run ledger for operators and
debugging.

Minimal HTTP session event flow:

```bash
SESSION_ID=$(
  curl -sS \
    -H "Content-Type: application/json" \
    -H "X-Tenant-ID: $CLOUDAGENT_TENANT_ID" \
    -H "X-Project-ID: $CLOUDAGENT_PROJECT_ID" \
    -d '{"cwd":"/workspace","agent_version":"builtin.v1","workspace_version":"builtin.v1"}' \
    "$CLOUDAGENT_BASE_URL/v1/cloudagent/sessions" |
  python3 -c 'import json,sys; print(json.load(sys.stdin)["session_id"])'
)

IDEMPOTENCY_KEY="msg_channel_example_$(date +%s)"

curl -sS \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $IDEMPOTENCY_KEY" \
  -H "X-Tenant-ID: $CLOUDAGENT_TENANT_ID" \
  -H "X-Project-ID: $CLOUDAGENT_PROJECT_ID" \
  -d '{"events":[{"type":"user.message","client_event_id":"'"$IDEMPOTENCY_KEY"'","content":[{"type":"text","text":"Please reply CLOUDAGENT_RUN_OK only."}]}]}' \
  "$CLOUDAGENT_BASE_URL/v1/cloudagent/sessions/$SESSION_ID/events"

curl -N -sS \
  -H "X-Tenant-ID: $CLOUDAGENT_TENANT_ID" \
  -H "X-Project-ID: $CLOUDAGENT_PROJECT_ID" \
  "$CLOUDAGENT_BASE_URL/v1/cloudagent/sessions/$SESSION_ID/events/stream?after_seq=0"
```

Streaming response frames use `Content-Type: text/event-stream`. Each `data:`
payload is one public CloudAgent event JSON object:

```text
id: evt_session_xxx_1
event: agent.message
data: {"id":"evt_session_xxx_1","seq":1,"type":"agent.message","run_id":"job_server_generated","session_id":"session_xxx","schema_version":"1.0","content":[{"type":"text","text":"CLOUDAGENT_RUN_OK"}]}

id: evt_session_xxx_2
event: session.status_idle
data: {"id":"evt_session_xxx_2","seq":2,"type":"session.status_idle","run_id":"job_server_generated","session_id":"session_xxx","schema_version":"1.0","status":"idle","stop_reason":{"type":"end_turn"}}
```

Persist the largest observed `seq` and reconnect with
`after_seq=<last_seq>` after any timeout, restart, or network disconnect. The
run continues even if the observer stream disconnects. Clients may also resume
with `after_id=<last_event_id>` or the standard `Last-Event-ID` SSE header.

`Idempotency-Key` is the caller retry key. `run_id` is returned by the gateway
and is the only id to use for stream/result/cancel. Legacy request body
`run_id` is still accepted as an idempotency key for older clients.

Devcloud uses the same mode with the in-cluster CloudAgent gateway service.
Full integration details and live verification commands are documented in
[`cloudagent-http-run-integration.md`](../gateway/docs/cloudagent-http-run-integration.md).

### Session Identity Contract

For CloudAgent HTTP mode, ChannelGateway treats `cloudagent_session_id` as the
durable identity for a channel conversation. The binding is:

```text
channel conversation -> channel_conversations.session_key -> cloudagent_session_id
```

ChannelGateway must not silently replace that CloudAgent session when runtime
restore fails. A failed restore returns the normal recovery fallback reply and
keeps the existing binding so operators can retry the same session. `/reset` is
the only user-facing path that creates a new CloudAgent session and a fresh
workspace.

`workspace_key` is retained in the ChannelGateway store for old rows and
diagnostics, but it is not part of the CloudAgent HTTP protocol unless the
CloudAgent capability document explicitly advertises workspace reuse support.
Current CloudAgent HTTP deployments should rely on the server-side session
identity to own workspace state.

For local or CI bootstrap, multiple WeCom accounts can be seeded with snake_case
JSON. This is a bootstrap surface; production should treat the database account
registry and secret backend as the source of truth, not the process environment:

```bash
CHANNELGATEWAY_WECOM_ENABLED=true
CHANNELGATEWAY_WECOM_ACCOUNTS_JSON='[
  {
    "account_id": "wecom-a",
    "bot_id": "...",
    "secret": "...",
    "websocket_url": "wss://openws.work.weixin.qq.com",
    "tenant_id": "tenant-a",
    "project_id": "project-a",
    "agent_id": "agent-a"
  },
  {
    "account_id": "wecom-b",
    "bot_id": "...",
    "secret": "...",
    "tenant_id": "tenant-b",
    "project_id": "project-b",
    "agent_id": "agent-b"
  }
]'
```

`/healthz` reports the process owner plus per-account runner status, owner, and
fencing token. Runner status is intentionally more precise than lease state:
`leased` means the account owner has been claimed, `initializing_acp` means ACP
handshake is in progress, and `running` means the WeCom adapter has started.

`/readyz` is the Kubernetes readiness surface. It returns success only when the
process is not draining and at least one account is either `running` or
`standby_lease_held`. The standby state is intentional for rolling updates:
a new pod must be considered ready once it can observe the shared store and is
ready to take over, even while the old pod still owns the single WeCom lease.
This avoids deadlocking a one-replica Deployment with `maxUnavailable: 0` while
still preserving the one-owner channel lease contract.

`CHANNELGATEWAY_SESSION_IDLE_CLOSE` controls proactive ACP session storage for
channel conversations. The default is `1m`: if a conversation has an ACP session
and no channel activity for that duration, the active channel owner calls the
runtime close operation only when the selected runtime protocol advertises it.
CloudAgent HTTP mode requires the `/v1/cloudagent/capabilities` response to
explicitly list close support; otherwise idle close is skipped without marking
the conversation closed. When close succeeds, CloudAgent emits workspace
lifecycle storage events, and the channel callback may send the configured
"sleep" notice. Set the value to `0` to disable proactive idle close.

## WeCom Handshake Check

Use the standalone handshake checker to verify WeCom AI Bot credentials without
starting the full channel gateway:

```bash
cd cloudagent/channelgateway
WECOM_BOT_ID=... \
WECOM_SECRET=... \
GOWORK=off go run ./cmd/wecom-handshake-check
```

It opens `wss://openws.work.weixin.qq.com`, sends one `aibot_subscribe` frame,
and prints a sanitized JSON result. Override the endpoint when diagnosing a
private deployment. The checker and gateway also accept
`CODEBUDDY_WECOM_BOT_WS_URL` as a compatibility alias when
`WECOM_WEBSOCKET_URL` is unset:

```bash
WECOM_BOT_ID=... \
WECOM_SECRET=... \
GOWORK=off go run ./cmd/wecom-handshake-check --url wss://example.internal/ws
```

## Model

Inbound message flow:

```text
WeCom callback -> durable inbound job -> conversation/session_key -> CloudAgent session -> CloudAgent run -> durable outbox -> WeCom send
```

Database migrations live under `internal/store/migrations` and run at process start.

Hot upgrade contract:

- `channel_messages` is the inbound job ledger, not only a dedup table.
- A runner must claim inbound jobs with the current channel lease fence before calling ACP.
- Finished jobs are marked `done`; failed or interrupted jobs remain retryable.
- New owners scan `received`, `failed`, and stale `processing` jobs after acquiring the channel lease.
- `channel_outbox` remains the durable send ledger, so replies queued before a restart are sent by the next owner.
