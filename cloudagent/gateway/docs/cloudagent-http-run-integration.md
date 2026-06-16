# CloudAgent HTTP Run API Integration Guide

This guide is for channel gateways, backend services, and test clients that need
to call CloudAgent without holding a long-lived ACP WebSocket.

Use this API for durable channel traffic. Do not multiplex many channel
conversations over one ACP WebSocket.

## Base URL

Use the CloudAgent gateway HTTP base URL. Do not append `/acp`.

Devcloud internal endpoint:

```text
http://21.6.84.6
```

In-cluster endpoint:

```text
http://cloudagent-gateway.dep.svc.cluster.local
```

## Authentication And Scope

Every request must identify the caller scope by either:

- `Authorization: Bearer <token>`, or
- both `X-Tenant-ID` and `X-Project-ID`.

Devcloud test scope:

```bash
export CLOUDAGENT_BASE_URL=http://21.6.84.6
export CLOUDAGENT_TENANT_ID=tenant-devcloud-dep
export CLOUDAGENT_PROJECT_ID=project-devcloud-dep
```

Common error if scope is missing:

```json
{
  "error": {
    "message": "X-Tenant-ID/X-Project-ID or Authorization: Bearer is required",
    "type": "invalid_request_error",
    "code": "identity_missing"
  }
}
```

## Capability Probe

Check this before switching traffic to the HTTP run API:

```bash
curl -sS \
  -H "X-Tenant-ID: $CLOUDAGENT_TENANT_ID" \
  -H "X-Project-ID: $CLOUDAGENT_PROJECT_ID" \
  "$CLOUDAGENT_BASE_URL/v1/cloudagent/capabilities"
```

Expected fields:

```json
{
  "object": "cloudagent.capabilities",
  "protocol": "cloudagent.run",
  "version": "v1",
  "run_protocol": true,
  "features": [
    "session_create",
    "session_load",
    "session_list",
    "run_submit",
    "run_list",
    "idempotency_key",
    "server_generated_run_id",
    "after_seq_replay",
    "ndjson_event_stream",
    "durable_result",
    "cancel"
  ]
}
```

## Basic Flow

1. Create or load a session.
2. Submit a run with a caller-generated `Idempotency-Key`.
3. Read events using `after_seq`.
4. Read the final durable result.
5. If the observer disconnects, resume from the last committed `after_seq`.

Stable endpoints:

```text
GET  /v1/cloudagent/capabilities
GET  /v1/cloudagent/sessions
POST /v1/cloudagent/sessions
GET  /v1/cloudagent/sessions/{session_id}
POST /v1/cloudagent/sessions/{session_id}/runs
GET  /v1/cloudagent/runs
GET  /v1/cloudagent/runs/{run_id}
GET  /v1/cloudagent/runs/{run_id}/events?after_seq=N
GET  /v1/cloudagent/runs/{run_id}/events?after_seq=N&stream=true
GET  /v1/cloudagent/runs/{run_id}/result
POST /v1/cloudagent/runs/{run_id}/cancel
```

### Create Session

```bash
curl -sS \
  -H "Content-Type: application/json" \
  -H "X-Tenant-ID: $CLOUDAGENT_TENANT_ID" \
  -H "X-Project-ID: $CLOUDAGENT_PROJECT_ID" \
  -d '{
    "cwd": "/workspace",
    "agent_version": "builtin.v1",
    "workspace_version": "builtin.v1"
  }' \
  "$CLOUDAGENT_BASE_URL/v1/cloudagent/sessions"
```

Response:

```json
{
  "session_id": "session_xxx",
  "state": "ready",
  "runtime_generation": 1
}
```

Stable request fields:

| Field | Required | Notes |
| --- | --- | --- |
| `cwd` | No | Defaults to `/workspace` for channel clients. |
| `agent_version` | No | Prefer registered versions such as `builtin.v1` or the configured release alias. |
| `workspace_version` | No | Prefer registered workspace versions such as `builtin.v1`. |

Other artifact fields such as `sidecar_url` are deployment/debug surfaces. Do
not expose arbitrary URLs to untrusted end users.

### Load Session

```bash
curl -sS \
  -H "X-Tenant-ID: $CLOUDAGENT_TENANT_ID" \
  -H "X-Project-ID: $CLOUDAGENT_PROJECT_ID" \
  "$CLOUDAGENT_BASE_URL/v1/cloudagent/sessions/$SESSION_ID?cwd=/workspace"
```

Use this when a channel conversation already has a `session_id`.

### List Sessions

```bash
curl -sS \
  -H "X-Tenant-ID: $CLOUDAGENT_TENANT_ID" \
  -H "X-Project-ID: $CLOUDAGENT_PROJECT_ID" \
  "$CLOUDAGENT_BASE_URL/v1/cloudagent/sessions?limit=50"
```

Response:

```json
{
  "object": "list",
  "data": [
    {
      "session_id": "session_xxx",
      "state": "ready",
      "runtime_generation": 1,
      "cwd": "/workspace",
      "workspace_key": "",
      "closed": false,
      "created_at": "2026-06-16T10:00:00Z",
      "updated_at": "2026-06-16T10:01:00Z"
    }
  ]
}
```

The list is scoped by the caller identity. It never returns sessions from other
tenant/project scopes.

### Submit Run

Generate a stable idempotency key per inbound channel message:

```bash
export IDEMPOTENCY_KEY="job_channel_${MESSAGE_ID}"
```

Submit:

```bash
curl -sS \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $IDEMPOTENCY_KEY" \
  -H "X-Tenant-ID: $CLOUDAGENT_TENANT_ID" \
  -H "X-Project-ID: $CLOUDAGENT_PROJECT_ID" \
  -d "{
    \"text\": \"请只回复 CLOUDAGENT_RUN_OK\",
    \"cwd\": \"/workspace\",
    \"inbox_mode\": \"prompt\"
  }" \
  "$CLOUDAGENT_BASE_URL/v1/cloudagent/sessions/$SESSION_ID/runs"
```

Response:

```json
{
  "run_id": "job_server_generated_123",
  "session_id": "session_xxx",
  "idempotency_key": "job_channel_msg_123",
  "status": "running"
}
```

`Idempotency-Key` is idempotent within `(tenant, project, session_id)`. If the
same key and request body are retried, the server returns or resumes the same
durable run. The returned `run_id` is server-generated and must be used for
events, result, status, and cancel. Legacy body field `run_id` is accepted as an
idempotency key for older callers, not as a caller-chosen resource id.

`inbox_mode` values:

| Value | Meaning |
| --- | --- |
| `prompt` | Normal user message. This is the default for channel adapters. |
| `follow_up` | Queue after the active run without interrupting it. |
| `steer` | High-priority steering input; may interrupt active work depending on runtime policy. |

### List Runs

List recent runs in the caller scope:

```bash
curl -sS \
  -H "X-Tenant-ID: $CLOUDAGENT_TENANT_ID" \
  -H "X-Project-ID: $CLOUDAGENT_PROJECT_ID" \
  "$CLOUDAGENT_BASE_URL/v1/cloudagent/runs?limit=50"
```

List runs for one session:

```bash
curl -sS \
  -H "X-Tenant-ID: $CLOUDAGENT_TENANT_ID" \
  -H "X-Project-ID: $CLOUDAGENT_PROJECT_ID" \
  "$CLOUDAGENT_BASE_URL/v1/cloudagent/runs?session_id=$SESSION_ID&limit=50"
```

Response:

```json
{
  "object": "list",
  "data": [
    {
      "run_id": "job_channel_msg_123",
      "session_id": "session_xxx",
      "status": "completed",
      "stop_reason": "end_turn",
      "output_text": "CLOUDAGENT_RUN_OK"
    }
  ]
}
```

### Read Events

Non-streaming replay:

```bash
curl -sS \
  -H "X-Tenant-ID: $CLOUDAGENT_TENANT_ID" \
  -H "X-Project-ID: $CLOUDAGENT_PROJECT_ID" \
  "$CLOUDAGENT_BASE_URL/v1/cloudagent/runs/$RUN_ID/events?after_seq=0"
```

Response:

```json
{
  "run": {
    "run_id": "job_channel_msg_123",
    "session_id": "session_xxx",
    "status": "running"
  },
  "events": [
    {
      "seq": 1,
      "run_id": "job_channel_msg_123",
      "session_id": "session_xxx",
      "kind": "message_delta",
      "event": {}
    }
  ]
}
```

Persist the largest observed `seq` and request `after_seq=<last_seq>` after any
disconnect or process restart. The API must not replay events with
`seq <= after_seq`.

### Stream Events

```bash
curl -N -sS \
  -H "X-Tenant-ID: $CLOUDAGENT_TENANT_ID" \
  -H "X-Project-ID: $CLOUDAGENT_PROJECT_ID" \
  "$CLOUDAGENT_BASE_URL/v1/cloudagent/runs/$RUN_ID/events?after_seq=0&stream=true"
```

The response is newline-delimited JSON:

```json
{"type":"event","event":{"seq":1,"run_id":"job_channel_msg_123","kind":"message_delta","event":{}}}
{"type":"heartbeat","after_seq":1}
{"type":"run","run":{"run_id":"job_channel_msg_123","status":"completed","stop_reason":"end_turn","output_text":"CLOUDAGENT_RUN_OK"}}
```

Stream connections are observer channels only. If the HTTP stream disconnects,
the run continues. Reconnect with the last committed `after_seq`.

### Read Result

```bash
curl -sS \
  -H "X-Tenant-ID: $CLOUDAGENT_TENANT_ID" \
  -H "X-Project-ID: $CLOUDAGENT_PROJECT_ID" \
  "$CLOUDAGENT_BASE_URL/v1/cloudagent/runs/$RUN_ID/result"
```

Terminal response:

```json
{
  "run_id": "job_channel_msg_123",
  "session_id": "session_xxx",
  "status": "completed",
  "stop_reason": "end_turn",
  "output_text": "CLOUDAGENT_RUN_OK"
}
```

Terminal statuses:

| Status | Meaning |
| --- | --- |
| `completed` | Model/runtime completed normally. |
| `failed` | Runtime/provider/infra failure. See `error`. |
| `cancelled` | Run was cancelled by caller. |
| `interrupted` | Runtime interrupted the run. |

### Cancel Run

```bash
curl -sS -X POST \
  -H "X-Tenant-ID: $CLOUDAGENT_TENANT_ID" \
  -H "X-Project-ID: $CLOUDAGENT_PROJECT_ID" \
  "$CLOUDAGENT_BASE_URL/v1/cloudagent/runs/$RUN_ID/cancel"
```

Cancellation is best-effort. Always read `/result` after cancellation to learn
the final stored state.

## Client Loop Pseudocode

```text
session_id = load_conversation_binding()
if session_id is empty:
  session_id = POST /v1/cloudagent/sessions
  save_conversation_binding(session_id)

run_id = stable_id_for_channel_message(message_id)
POST /v1/cloudagent/sessions/{session_id}/runs { run_id, text, inbox_mode: "prompt" }

after_seq = load_last_seq(run_id)
while true:
  frame_or_batch = GET /v1/cloudagent/runs/{run_id}/events?after_seq=after_seq&stream=true
  for each event:
    handle event
    after_seq = max(after_seq, event.seq)
    save_last_seq(run_id, after_seq)
  result = GET /v1/cloudagent/runs/{run_id}/result
  if result.status is terminal:
    send result.output_text to channel
    break
  retry with after_seq
```

## ChannelGateway Configuration

Use HTTP run protocol:

```bash
CHANNELGATEWAY_ACP_URL=http://cloudagent-gateway.dep.svc.cluster.local
CHANNELGATEWAY_RUNTIME_PROTOCOL=cloudagent
CHANNELGATEWAY_TENANT_ID=tenant-devcloud-dep
CHANNELGATEWAY_PROJECT_ID=project-devcloud-dep
```

`CHANNELGATEWAY_ACP_URL` is a legacy variable name. In
`CHANNELGATEWAY_RUNTIME_PROTOCOL=cloudagent` mode it is treated as the
CloudAgent HTTP base URL.

## Error Semantics

Errors use JSON response bodies:

```json
{
  "error": {
    "message": "text is required",
    "type": "invalid_request_error",
    "code": "run_submit_failed"
  }
}
```

Common statuses:

| HTTP | Code | Meaning |
| --- | --- | --- |
| 400 | `invalid_json`, `invalid_after_seq`, `run_submit_failed` | Caller request is malformed or unsupported. |
| 401 | `identity_missing` | Missing scope headers or bearer token. |
| 403 | `scope_mismatch` | Session/run is outside caller scope. |
| 404 | `session_load_failed`, `run_not_found` | Resource does not exist in caller scope. |
| 409 | `run_submit_failed`, `run_events_failed`, `run_cancel_failed` | Runtime/ownership/conflict failure. Retry only when safe and idempotent. |

Do not create a new session on generic run failure. Keep the existing
conversation-to-session binding unless the user explicitly resets the
conversation.

## Live E2E

Client-level e2e:

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

Dispatcher-level e2e:

```bash
cd cloudagent/channelgateway
CHANNELGATEWAY_LIVE_CLOUDAGENT_URL=http://21.6.84.6 \
CHANNELGATEWAY_LIVE_CLOUDAGENT_TENANT_ID=tenant-devcloud-dep \
CHANNELGATEWAY_LIVE_CLOUDAGENT_PROJECT_ID=project-devcloud-dep \
GOWORK=off go test ./internal/router \
  -run TestProtocolE2ELiveCloudAgentHTTPDispatcher \
  -count=1 \
  -timeout=15m
```
