# MyChat CloudAgent Auth and File Transfer

This document describes how a local MyChat frontend connects to the production
CloudAgent gateway, how request identity is resolved, and how file upload and
download work.

## Local URL

Start the MyChat frontend locally:

```bash
cd cloudagent/mychat
pnpm dev --host 127.0.0.1
```

Open:

```text
http://127.0.0.1:5173/?acp_url=http://cloudagent.lightvela.com
```

`acp_url` is the gateway base URL. MyChat derives:

```text
ACP WebSocket: ws://cloudagent.lightvela.com/acp
HTTP base:     http://cloudagent.lightvela.com
```

The old `cloudagent.lightclaw.cn` host is normalized to
`cloudagent.lightvela.com`.

## Identity

CloudAgent scopes sessions and files by tenant and project. The production
debug scope used by MyChat is:

```text
X-Tenant-ID: tenant-live
X-Project-ID: project-live
```

MyChat sends these headers for HTTP requests such as file upload, file download,
and session-scoped envd transfer.

Browser WebSocket clients cannot reliably set custom headers. For `/acp`, the
gateway can fall back to the server default scope. Production is configured to
use the same default scope:

```text
tenant-live / project-live
```

Custom clients should still pass identity explicitly when they can:

```text
Authorization: Bearer <token>
```

or:

```text
X-Tenant-ID: <tenant>
X-Project-ID: <project>
```

Do not put Tencent Cloud keys, AGS keys, TokenHub keys, or sidecar secrets in
the browser. Those belong in the CloudAgent gateway runtime configuration.

## Scope Rules

The same identity must be used for:

- creating or resuming the ACP session
- uploading files to the session workspace
- downloading files from the session workspace

If a file request uses a different tenant/project from the one that owns the
session, the gateway rejects it:

```text
HTTP 403 scope_mismatch
```

If no identity is present for an HTTP request, the gateway rejects it:

```text
HTTP 401 identity_missing
```

## Two File Paths

There are two different file APIs.

### Prompt Attachment Files

Prompt attachments are uploaded to the gateway file store:

```text
POST /v1/files
GET  /v1/files/{file_id}/content
```

Use this when the file should be attached to a model prompt.

Upload:

```bash
curl -sS -X POST \
  'http://cloudagent.lightvela.com/v1/files' \
  -H 'X-Tenant-ID: tenant-live' \
  -H 'X-Project-ID: project-live' \
  -F 'purpose=assistants' \
  -F 'file=@./README.md'
```

The upload response contains a file id. Download with:

```bash
curl -sS \
  'http://cloudagent.lightvela.com/v1/files/<file_id>/content' \
  -H 'X-Tenant-ID: tenant-live' \
  -H 'X-Project-ID: project-live' \
  -o README.md
```

### Session Workspace Files

Workspace files are proxied into the inner sandbox through envd:

```text
POST /v1/acp/sessions/{session_id}/envd/files?path=/workspace/name
GET  /v1/acp/sessions/{session_id}/envd/files?path=/workspace/name
```

Use this when the file should appear inside the session's inner workspace.
The first envd file request can trigger creation of the inner sandbox.

The path is the target path inside the sandbox. MyChat defaults to `/workspace`.

## Session Workspace Upload

Multipart upload:

```bash
curl -sS -X POST \
  'http://cloudagent.lightvela.com/v1/acp/sessions/session_xxx/envd/files?path=%2Fworkspace%2Fa.sh' \
  -H 'X-Tenant-ID: tenant-live' \
  -H 'X-Project-ID: project-live' \
  -F 'file=@./a.sh;type=text/x-sh'
```

Raw body upload is also accepted by the CloudAgent gateway. The gateway wraps
the body as envd multipart upload before forwarding it:

```bash
curl -sS -X POST \
  'http://cloudagent.lightvela.com/v1/acp/sessions/session_xxx/envd/files?path=%2Fworkspace%2Fa.sh' \
  -H 'X-Tenant-ID: tenant-live' \
  -H 'X-Project-ID: project-live' \
  -H 'Content-Type: application/octet-stream' \
  --data-binary @./a.sh
```

Successful upload returns envd file metadata, for example:

```json
[
  {
    "name": "a.sh",
    "path": "/workspace/a.sh",
    "type": "file"
  }
]
```

## Session Workspace Download

Download from the session workspace:

```bash
curl -sS \
  'http://cloudagent.lightvela.com/v1/acp/sessions/session_xxx/envd/files?path=%2Fworkspace%2Fa.sh' \
  -H 'X-Tenant-ID: tenant-live' \
  -H 'X-Project-ID: project-live' \
  -o a.sh
```

The gateway strips upstream envd CORS headers and returns gateway CORS headers
so local MyChat can call it from:

```text
http://127.0.0.1:5173
```

Expected CORS behavior for the production gateway:

```text
Access-Control-Allow-Origin: *
Access-Control-Allow-Headers: Authorization, Content-Type, X-Request-ID, X-Tenant-ID, X-Project-ID, X-Sandbox-Scope
Access-Control-Allow-Methods: GET, POST, OPTIONS
```

## Browser Behavior

For workspace upload, MyChat builds:

```ts
POST /v1/acp/sessions/{session_id}/envd/files?path=<workspace_path>
headers:
  X-Tenant-ID: tenant-live
  X-Project-ID: project-live
body:
  FormData(file)
```

For workspace download, MyChat builds:

```ts
GET /v1/acp/sessions/{session_id}/envd/files?path=<workspace_path>
headers:
  X-Tenant-ID: tenant-live
  X-Project-ID: project-live
```

The browser page should be opened with the same gateway URL used by the ACP
session:

```text
http://127.0.0.1:5173/?acp_url=http://cloudagent.lightvela.com
```

## Common Errors

`HTTP 401 identity_missing`

The request did not include `Authorization` or both `X-Tenant-ID` and
`X-Project-ID`. Add the identity headers.

`HTTP 403 scope_mismatch`

The file request identity does not match the session owner. Use the same
tenant/project that created the session, or create a new session with the
intended scope.

`HTTP 404 session_not_found`

The session id is unknown to the gateway process or has already been deleted.
Create a new ACP session.

`HTTP 410 stale_session`

The session runtime generation is stale. Refresh session state or create a new
session.

`HTTP 502 inner_envd_unavailable`

The gateway could not create or reach the inner envd endpoint. Check gateway
logs for `inner_envd_ensure_*` and `envd_proxy_*` events, plus the configured
sidecar URL and sha.
