# vela-chat-client

HTTP/SSE client for `velad`.

Owns URL construction, fetch calls, SSE frame parsing, command submission, and structured client errors.

This package is host-agnostic. It must not assume that the JavaScript runtime
and `velad` run on the same machine. Desktop hosts can use the default
`baseUrl + fetch` path for local `velad`; remote hosts such as Workbench should
inject their own `VeladFetch` into `createVeladClient({ baseUrl, fetch })` so
TAT/TSSH leases, remote forwarding, authentication, and network failure
classification stay outside the SDK.

Runtime code should resolve fetch through `resolveVeladFetch()` or receive an
injected `VeladFetch`; do not call bare global `fetch` from the client path.

Command submission validates both sides of the OpenAPI boundary:

- outgoing `InputPart` content blocks follow the OpenAPI `oneOf` union before
  any request is sent
- outgoing create-session requests follow OpenAPI required-field, type, backend
  enum, and nested `agent_config` rules before any request is sent
- outgoing path/query parameters follow OpenAPI string typing, such as
  `session_id` and `after_id`, before URLs are constructed
- outgoing `Idempotency-Key` header values follow OpenAPI string typing before
  mutating requests are sent
- outgoing `agent_config` patches follow OpenAPI object-shape rules before any
  request is sent: at least one supported field, no unknown fields, and known
  field types/enums
- incoming `CommandAck` follows the OpenAPI `oneOf` union before callers see it
- incoming session mutation responses include their required full `EventCursor`
  and `effective_after` enum where OpenAPI requires it
- incoming query response envelopes include OpenAPI-required top-level fields,
  such as `session` for `GET /sessions/{session_id}` and a `backends` array for
  `GET /backends`, plus `backend` for `GET /backends/{backend}`
- incoming backend catalog items include OpenAPI-required backend identity,
  status, display label, and boolean capability flags before composer controls
  consume them
- incoming backend catalog option items include OpenAPI-required model,
  reasoning effort, permission mode, and feature fields before composer
  controls consume them
- incoming backend probe results include OpenAPI-required backend kind and
  status enum before health UI or diagnostics consume them
- outgoing view-window query options follow OpenAPI `Limit`, `direction`,
  anchor id, and boolean bounds before any transcript/activity request is sent
- incoming transcript/activity read-model envelopes include their required
  `session_id`, `window`, and full `EventCursor`
- incoming transcript rows and activity items include their OpenAPI-required
  fields and enums before surface projection, virtualization, or markdown
  rendering consume them

Do not widen these contracts back into loose optional-field objects.

Does not own React state, UI projection, markdown rendering, or layout policy.
Does not own host networking, auth leases, SSH/TAT tunnels, remote port
forwarding, or provider-specific transport failure classification.
