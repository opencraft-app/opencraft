# CloudAgent HTTP Session Events Protocol

This document records the Qoder-like durable HTTP session-event protocol used
by channel adapters that must survive transport disconnects and long-running
prompts.

For caller-facing setup and curl examples, see
[`cloudagent-http-run-integration.md`](cloudagent-http-run-integration.md).

## Purpose

ACP WebSocket remains the interactive compatibility protocol. Channel adapters
such as `channelgateway` should use the CloudAgent HTTP session-event protocol
when they need a durable request/replay boundary:

- append `user.message` events without keeping a WebSocket open;
- poll or stream public session events with `after_seq`, `after_id`, or the
  standard SSE `Last-Event-ID` header;
- recover after channel gateway restart;
- observe terminal session status without coupling clients to internal run ids.

The gateway owns session/runtime state. Channel adapters should not create
their own ACP websocket multiplexing layer for multiple conversations.

`run_id` still exists as an internal durable ledger id. Public clients may see it
as metadata on events for debugging and cancellation, but should not model the
conversation around `/runs`.

## Endpoints

Base URL is the CloudAgent gateway HTTP URL, not `/acp`.

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

Internal/debug endpoints still exist for gateway operators:
`GET /v1/cloudagent/runs`, `GET /v1/cloudagent/runs/{run_id}`,
`GET /v1/cloudagent/runs/{run_id}/events`,
`GET /v1/cloudagent/runs/{run_id}/result`, and
`POST /v1/cloudagent/runs/{run_id}/cancel`.

Capabilities must return:

```json
{
  "object": "cloudagent.capabilities",
  "protocol": "cloudagent.session_events",
  "session_event_protocol": true,
  "run_protocol": true,
  "features": ["session_event_submit", "session_event_replay", "session_event_stream", "idempotency_key", "last_event_id_replay", "sse_event_stream", "internal_run_ledger"]
}
```

## Event Identity

The submit retry key, public session event id, and internal run id are
different:

- callers send `Idempotency-Key` or `client_event_id` to deduplicate retries for
  the same session and user message;
- the gateway appends public session events with stable `id` and `seq`;
- the gateway creates a server-generated `run_id` internally to execute the
  message;
- clients resume observation with session-level `after_seq`, `after_id`, or
  `Last-Event-ID`.

The idempotency scope is `(tenant, project, session_id, idempotency_key)`.
The same key may be reused in a different session without conflict. Reusing the
same key in the same session with a different request body is rejected.

## Event Stream Shape

Submit a user message:

```json
{
  "events": [
    {
      "type": "user.message",
      "client_event_id": "msg_123",
      "content": [{"type": "text", "text": "hello"}]
    }
  ]
}
```

Non-streaming `GET /v1/cloudagent/sessions/{session_id}/events` returns JSON:

```json
{
  "object": "list",
  "events": [
    {
      "id": "evt_session_xxx_1",
      "seq": 1,
      "type": "agent.message",
      "run_id": "job_durable_123",
      "session_id": "session_xxx",
      "schema_version": "1.0",
      "content": [{"type": "text", "text": "hello"}]
    }
  ]
}
```

`GET /v1/cloudagent/sessions/{session_id}/events/stream` returns
`Content-Type: text/event-stream`:

```text
id: evt_session_xxx_1
event: agent.message
data: {"id":"evt_session_xxx_1","seq":1,"type":"agent.message","run_id":"job_durable_123","session_id":"session_xxx","schema_version":"1.0","content":[{"type":"text","text":"hello"}]}
```

Public event types are `user.message`, `agent.thinking`, `agent.message`,
`agent.tool_use`, `agent.tool_result`, `session.status_idle`, `session.error`,
and `heartbeat`.

The public event stream must not expose ACP `sessionUpdate` payloads, Hermes
`WRAPPER_EVENT_JSON`, or `timeline source=hermes_sidecar` stdout as visible
assistant text.

## ChannelGateway Configuration

Devcloud uses the HTTP session-event protocol:

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
- user.message submit succeeds;
- session events are replayable by `after_seq`;
- the durable terminal event can be observed after completion.

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
