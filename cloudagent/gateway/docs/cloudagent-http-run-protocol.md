# CloudAgent HTTP Run Protocol

This document records the durable HTTP run protocol used by channel adapters
that must survive transport disconnects and long-running prompts.

## Purpose

ACP WebSocket remains the interactive client protocol. Channel adapters such as
`channelgateway` should use the CloudAgent HTTP run protocol when they need a
durable request/replay boundary:

- submit a run without keeping a WebSocket open;
- poll or stream events with `after_seq`;
- recover after channel gateway restart;
- read the final durable run result.

The gateway owns session/runtime state. Channel adapters should not create
their own ACP websocket multiplexing layer for multiple conversations.

## Endpoints

Base URL is the CloudAgent gateway HTTP URL, not `/acp`.

```text
GET  /v1/cloudagent/capabilities
POST /v1/cloudagent/sessions
GET  /v1/cloudagent/sessions/{session_id}
POST /v1/cloudagent/sessions/{session_id}/runs
GET  /v1/cloudagent/runs/{run_id}
GET  /v1/cloudagent/runs/{run_id}/events?after_seq=N
GET  /v1/cloudagent/runs/{run_id}/events?after_seq=N&stream=true
GET  /v1/cloudagent/runs/{run_id}/result
POST /v1/cloudagent/runs/{run_id}/cancel
```

Capabilities must return:

```json
{
  "object": "cloudagent.capabilities",
  "protocol": "cloudagent.run",
  "run_protocol": true
}
```

## ChannelGateway Configuration

Devcloud uses the HTTP run protocol:

```bash
CHANNELGATEWAY_ACP_URL=http://cloudagent-gateway.dep.svc.cluster.local
CHANNELGATEWAY_RUNTIME_PROTOCOL=cloudagent
```

`CHANNELGATEWAY_ACP_URL` is intentionally reused as the base runtime URL for
now. In `cloudagent` mode the client normalizes `ws://.../acp` to the HTTP base
URL when possible, but production config should pass the HTTP base URL directly.

## Live Verification

Devcloud internal LB:

```bash
curl -sS \
  -H 'X-Tenant-ID: tenant-devcloud-dep' \
  -H 'X-Project-ID: project-devcloud-dep' \
  http://21.6.84.6/v1/cloudagent/capabilities
```

Run the live protocol e2e:

```bash
cd cloudagent/channelgateway
CHANNELGATEWAY_LIVE_CLOUDAGENT_URL=http://21.6.84.6 \
CHANNELGATEWAY_LIVE_CLOUDAGENT_TENANT_ID=tenant-devcloud-dep \
CHANNELGATEWAY_LIVE_CLOUDAGENT_PROJECT_ID=project-devcloud-dep \
GOWORK=off go test ./internal/acp \
  -run TestCloudAgentClientLiveHTTPRunProtocol \
  -count=1 \
  -timeout=15m
```

This e2e proves:

- session create/load works through the HTTP protocol;
- run submit succeeds;
- run events are replayable by `after_seq`;
- the durable final result can be read after completion.

## MySQL Compatibility Notes

Devcloud uses MySQL for the gateway store. Local tests often default to SQLite,
so all durable run-store writes must be checked against both dialects.

Known failure modes:

- `Error 1364 (HY000): Field 'error_message' doesn't have a default value`
  means an insert omitted a `NOT NULL` text column that SQLite filled with a
  default locally.
- `Error 1064 (42000) ... ON CONFLICT(...) DO NOTHING` means SQLite upsert
  syntax leaked into the MySQL path.

Rules:

- Reserve/insert run rows with explicit values for every `NOT NULL` field.
- Use `ON DUPLICATE KEY UPDATE` for MySQL run upserts.
- Use `INSERT IGNORE` for MySQL event imports, then still load and compare the
  existing row so conflicting payloads are not silently hidden.
- Do not rely on MySQL `TEXT` / `LONGTEXT` defaults for compatibility.

## Release Checklist

1. Push code to `master`; service release pipelines only auto-build from
   `master`.
2. If only ChannelGateway changes are built, touch a gateway-owned path such as
   `cloudagent/gateway/README.md` using the existing CI trigger note convention.
3. Wait for devcloud auto-pin and Argo rollout.
4. Check `GET /v1/cloudagent/capabilities`.
5. Run `TestCloudAgentClientLiveHTTPRunProtocol` against the devcloud LB.
6. If live e2e fails with a SQL dialect error, fix the store code and redeploy
   before switching channel traffic.

