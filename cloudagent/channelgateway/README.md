# CloudAgent Channel Gateway

`channelgateway` bridges external chat channels to CloudAgent ACP.

Current shape:

- channel adapter: WeCom AI Bot WebSocket
- session truth: SQLite store with embedded Go migrations
- runtime target: CloudAgent ACP over WebSocket
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
and no channel activity for that duration, the active channel owner calls
standard ACP `session/close`. CloudAgent then emits workspace lifecycle storage
events, and the channel callback may send the configured "sleep" notice. Set it
to `0` to disable proactive idle close.

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
WeCom callback -> durable inbound job -> conversation/session_key -> ACP session/new or load -> session/prompt -> durable outbox -> WeCom send
```

Database migrations live under `internal/store/migrations` and run at process start.

Hot upgrade contract:

- `channel_messages` is the inbound job ledger, not only a dedup table.
- A runner must claim inbound jobs with the current channel lease fence before calling ACP.
- Finished jobs are marked `done`; failed or interrupted jobs remain retryable.
- New owners scan `received`, `failed`, and stale `processing` jobs after acquiring the channel lease.
- `channel_outbox` remains the durable send ledger, so replies queued before a restart are sent by the next owner.
