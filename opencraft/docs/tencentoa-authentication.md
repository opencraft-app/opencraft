# Tencent OA employee identity

The optional `tencentoa.identity` plugin recognizes the employee authenticated by
the site's TAI/TOF gateway. It registers an independent authentication provider
and an “员工身份” settings page. When configured, it owns the shared bottom-left
account entrance: the verified employee login name and available employee photo are shown automatically, and
clicking opens employee details and refresh. Without a verified identity the same
entrance is labelled “员工身份” and opens those details; no fixed login URL or
separate OAuth flow is configured. The current site's gateway supplies identity
headers on the same-origin session request.

Footer selection uses explicit `entrancePriority` (Tencent OA: 100; existing
product accounts: 0). Equal priorities remain exclusive. This changes only the
Shell presentation: LightVela's authentication, resources and account storage
remain independently owned, and its entrance returns when Tencent OA unloads.
There is no employee logout control because this integration has no gateway
logout contract. A 401 or identity expiration removes the displayed employee;
an open identity detail view remains available for refresh.

## Enablement

Start the headless server with `--tencentoa-token-file /absolute/private/token`.
The file must be a regular, non-symlink file owned by the server user, inaccessible
to group/others (mode 0600). Its content is the application's raw 32-byte token;
one trailing newline is accepted. No token is included in source or sent to the
browser. Without configuration the endpoint returns 404 and the plugin contributes
no settings page/provider. Invalid configuration stops startup.

The deployment gateway must forward signed headers and `X-TAI-IDENTITY` on the
same-origin session request. Do not expose decrypted payloads, complete headers,
tokens or ciphertext in diagnostics. The preview is not automatically enabled by
this source change.

## Ownership and invariants

- The installation owns only the private application key. Every request is
  independently verified; there is no server-global “current employee”.
- The plugin verifies uppercase SHA256 gateway signatures and a 180-second
  timestamp window, then authenticates/decrypts compact JWE (`dir` / `A256GCM`).
  The signature and GCM authentication are separate checks; neither substitutes
  for the other.
- Identity expiration is RFC3339 with the documented three-minute clock tolerance.
  Duplicate security headers, conflicting identity aliases, invalid types/dates,
  and contradictions with legacy staff headers are rejected.
- The response projects only English login name, staff ID and expiration. Actual
  gateway field casing is normalized at this boundary. `open_id` is not exposed;
  a Chinese display name is not invented when unavailable.
- Browser identity is memory-only, per client. Request generations fence late
  responses; disposal and 401 revoke identity. Network failure cannot extend an
  identity beyond its authenticated expiration plus clock tolerance.
- Recognition is not resource authorization. This plugin does not grant or isolate
  shared SSH connections, desktop access, conversations or model credentials.
  Gateway/network admission and resource permissions remain separate responsibilities.
- No undocumented nonce-replay rejection or external TOF logout flow is invented.

Protocol basis: user-provided TAI mobile signing and TOF JWE documentation, with
read-only real gateway validation. Unit tests use synthetic credentials exclusively.

## Per-message sender provenance

Headless Web verifies TAI headers on each `/apphost` or `/ssh-apphost` WebSocket
handshake. The gateway binds the verified English login name and validity deadline
to a server-owned connection context. Renderer IDs, frame fields and client-supplied
`sender` values cannot establish an employee identity. The deployment gateway must
forward the signed identity headers on WebSocket upgrades as well as HTTP session
requests. Missing or invalid handshake identity yields unattributed submissions;
an established employee context past its validity deadline rejects new submissions
until the client reconnects through employee authentication.

AppHost passes this context through an optional in-process `sendWithContext` port.
Codex Host accepts provenance for `turn/start`, `turn/steer` and `thread/queue/add`.
It records only `{ kind: "employee", loginName }`, without staff number, private
headers, credentials or token expiration, keyed by `(threadId, clientUserMessageId)`
in the stable Host's existing `codex-host-queue.sqlite`. Queue and provenance share
one connection; adding a queued submission and its sender is one transaction.
An existing message identity cannot be attributed to a different employee or
upgraded from an unknown sender. Native legacy submissions without a client ID
remain unattributed; authenticated submissions require that ID.

The enqueue-time sender remains the submitter through queue editing, reordering,
reconnects and dispatch by another client. Queue edits do not relabel the original
submitter; this feature does not provide an editor audit trail. Dispatch and
unconfirmed-delivery reconciliation retain the existing queue authority. Sender
records are stored before dispatch; they do not themselves prove native delivery.
Only matching native history items or pending queue rows expose provenance.

Live notifications, paginated history, resumed threads and shared Chat projection
carry OpenCraft's `sender` field independently of visible message text. Full-history
forks inherit provenance mappings; excluded history is not displayed and blank
forks (`excludeTurns`) do not inherit them. Unknown old messages remain unattributed.
Stored historical sender snapshots do not expire with the originating connection.
Remote Codex Hosts keep their records in their stable local Host metadata directory.
No sender field is forwarded to native Codex or injected into model input. Non-Codex
transports and direct `/appserver` proxy traffic do not advertise this capability.

## Employee footer photo

The IOA/Tencent OA plugin owns employee avatar lookup and Blob URL lifetime;
the shared account renderer only consumes its existing avatarUrl contract.
After verified identity resolves, the controller requests its 100px photo through
`/__opencraft_tencentoa/photo/100/<loginName>.png` without delaying identity display.
The server authenticates each request and only permits the current employee's
English account name and the documented 48/100/150/500 sizes. It fetches the
fixed `/ebus/rhrc/photo/<size>/<loginName>.png` route at the deployment-controlled
`OPENCRAFT_TENCENTOA_PHOTO_ORIGIN` (default `http://api-idc.sgw.woa.com`).
Gateway identity headers and application credentials are not forwarded upstream.
Images are raster-only, bounded to 1MiB, with a four-second upstream timeout and
private no-store responses. Photo availability grants no identity or resource
authority. Network failure leaves the existing name and default account icon.
Identity revocation, account changes and plugin disposal abort obsolete loads
and revoke Blob URLs; late responses cannot replace another account's photo.

## Conversation participants

The IOA plugin contributes a circular `+N` badge to each supported sidebar Thread.
N counts distinct identified employee login names in retained user-message history,
including the current employee. Opening a conversation does not join it. Clicking
the badge opens a participant Popover without selecting the Thread; no employee
number or per-participant photo is displayed. Unknown history is not reattributed.

The deployment enables a plugin-owned Thread metadata provider only when Tencent OA
is configured. `opencraft/ioa/thread-participants/list` batches up to 100 Thread IDs;
its version-1 capability is advertised by the Host, including native method-access
catalogs. Unsupported Hosts contribute no badge. The derived `ioa_message_presence`
and `ioa_participant_state` tables share the existing `codex-host-queue.sqlite` and
transaction owner. Verified message sender bindings remain the identity authority.

Only observed native user Items and native history message IDs establish presence.
Binding an identity, waiting in the queue or a rejected delivery does not count.
Confirmed input remains participation if model execution fails or is interrupted.
Each provider instance reconciles complete native history on first read; successful
start/steer and completion reconcile the affected Turn, while fork/rollback reconcile
retained full history. Concurrent Items fence late history reads. Closing the Host
revokes pending projection work before the shared DB closes.

Distinct set changes send `opencraft/ioa/thread-participants/changed` to initialized
readers of this Host, including readers viewing another Thread. The plugin batches
visible-row reads, fences connection/account changes, and keeps prior names on
transient errors with retry. Names and counts are display metadata only: no IOA RPC
is forwarded to native Codex, and metadata is never injected into model input.
