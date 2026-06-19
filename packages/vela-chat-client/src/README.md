# src

Public TypeScript entrypoint for the velad chat client.

Keep this module renderer-free. It may use browser APIs such as `fetch`, `EventSource`, and `crypto`, but must not import React or Next.

Wire response validation belongs here when the OpenAPI contract uses a
discriminated union that ordinary `response.json()` cannot protect, such as
`CommandAck`.

Mutation response envelope validation belongs here when OpenAPI requires a full
`EventCursor` or small enum, such as create-session and update-agent-config
responses.

Query response envelope validation belongs here for simple OpenAPI required
wrappers, such as `GET /sessions/{session_id}` requiring `session` and
`GET /backends` requiring a `backends` array.

Backend catalog item validation also belongs here for OpenAPI-required backend
identity, status, display label, and capability flags before composer controls
consume the catalog.

Path/query parameter validation belongs here before URLs are constructed,
including OpenAPI string parameters such as `session_id` and `after_id`.

Header parameter validation belongs here for OpenAPI mutating command
boundaries, including explicit `Idempotency-Key` values before a request is
sent.

View-window query validation belongs here for OpenAPI shared parameters, such
as `Limit`, `ViewWindowDirection`, anchor id strings, and `include_live`
boolean rules before transcript/activity requests are sent.

Wire request validation also belongs here for client-originated discriminated
unions, such as `InputPart`, so renderer bugs or plain JavaScript callers cannot
send malformed content blocks to `velad`.

Create-session request validation belongs here too. The client boundary should
reject requests that are missing OpenAPI-required `working_directory`, use an
unknown backend kind, or include malformed nested `agent_config`.

OpenAPI object-shape validation also belongs here when ordinary TypeScript
types do not protect plain JavaScript callers, such as `AgentConfig` patches
requiring at least one supported field, no unknown fields, and known
field-type/enum checks.

Read-model envelope validation belongs here too. The client boundary should
reject transcript/activity views that are missing OpenAPI-required `session_id`,
`window`, or full `EventCursor` fields before UI layers consume them.

Read-model row/item validation belongs here for OpenAPI-required transcript
row and activity item fields/enums. Surface projection, virtualization, and
renderers should receive already validated read-model items instead of
inventing fallback wire shapes.
