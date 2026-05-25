# LibreChat Integration

This note covers the local LibreChat smoke path for the Responses wrapper. The goal is to run the unmodified LibreChat UI against the local wrapper and prove that a real UI message reaches the AGS/Hermes execution chain.

## Scope

Current milestone:

- Chat-first UI integration.
- OpenAI Responses-compatible upstream at `http://host.docker.internal:18096/v1`.
- Bearer auth from LibreChat mapped to the wrapper's default mock tenant/project.
- Streaming response display in the LibreChat UI.
- Existing `gateway` E2E must remain green.

Out of scope for this milestone:

- Modifying LibreChat business source.
- LibreChat file upload UI.
- LibreChat artifact download UI.
- Product-grade tenant/project management. Bearer auth currently maps to default mock scope unless explicit tenant/project headers are supplied.

## Start the wrapper

From the wrapper directory:

```bash
cd /Users/skipzhang/cloudagent/gateway
make server

GATEWAY_ADDR=127.0.0.1:18096 \
GATEWAY_DATA_DIR=/tmp/gateway-librechat-real \
GATEWAY_MODELS=agent-sidecar-chat \
./scripts/start_agent_sidecar_server.sh
```

The script loads the repository `.env`, publishes or reuses the Hermes sidecar URL, and starts the local wrapper. Keep this process running while LibreChat is open.

Expected wrapper compatibility surface for LibreChat:

- `GET /v1/models`
- `POST /v1/responses`
- `GET /v1/responses/:id`
- `Authorization: Bearer <token>`
- `previous_response_id` accepted for same-scope responses
- Responses SSE events: `response.created`, `response.output_text.delta`, `response.output_text.done`, `response.completed`

## Start LibreChat

The local checkout at `/Users/skipzhang/cloudagent/research/LibreChat` is configured through files only:

- `/Users/skipzhang/cloudagent/research/LibreChat/.env`
- `/Users/skipzhang/cloudagent/research/LibreChat/librechat.yaml`
- `/Users/skipzhang/cloudagent/research/LibreChat/docker-compose.override.yaml`

Start it with:

```bash
cd /Users/skipzhang/cloudagent/research/LibreChat
docker compose up -d
```

Then open:

```text
http://localhost:3080
```

Register or log in with a local test account, select the CloudAgent model/spec, and send a normal chat message.

## Verification

Use these checks before claiming the integration works:

```bash
cd /Users/skipzhang/cloudagent/research/LibreChat
docker compose ps
docker compose logs --tail=100 api
curl -sS http://localhost:3080/api/config >/tmp/librechat-config.json
```

Then verify from the wrapper logs that the UI message reached the real chain. A successful pure chat request should include wrapper timeline events such as:

- `response_request_start`
- `worker_run_start`
- `sidecar_download_start`
- `sidecar_download_done`
- `response_completed`

For a chat-only request, `inner_sandbox_id=""` in `sidecar_result_envelope` proves the inner AGS sandbox was not created unnecessarily. Tool requests should instead show `kind=tool_call`, `kind=tool_call_update`, and a non-empty `inner_sandbox_id`.

Finally rerun wrapper regression:

```bash
cd /Users/skipzhang/cloudagent/gateway
go test ./...
make e2e-agent-sidecar
```

## Known Limits

- LibreChat custom endpoint wiring is file-based in this repo; the LibreChat source tree remains unmodified.
- File upload and artifact UI behavior still need a second milestone.
- Bearer auth is a compatibility shim, not a final tenant/project security model.
- `previous_response_id` is currently a pragmatic compatibility behavior with same-scope validation, not a full OpenAI server-side state-machine clone.
