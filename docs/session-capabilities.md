# Host session capabilities

`packages/session-capabilities` owns the transport-independent catalog and call
entry point. Trusted composition supplies a canonical `serverId/threadId`;
model arguments cannot select the calling session. Domain providers decide
which declarations are available and retain authorization, effect receipts and
recovery. Both listing and execution resolve the current catalog. Duplicate
names fail closed. A successful transport response does not itself prove an
external effect; the domain provider's receipt does.

## Protocol and lifecycle

The Streamable HTTP MCP outlet uses the pinned MCP SDK on a dedicated loopback
listener. It accepts POST `/mcp`, rejects ambient browser Origin requests, bounds
request bodies to 64 KiB and authenticates a signed session credential before
processing JSON-RPC. It exposes only authorized tools, without another CLI,
PATH dependency, global MCP configuration or renderer callback. Credentials bind
the canonical session, not a caller-controlled argument or daemon-wide token.
The signing key is a private file; creation bindings use managed SQLite v1.
There is no general connector credential store, second execution queue or
universal effect ledger in this package.

A native engine can allocate its Thread ID after MCP initialization. Trusted
composition can reserve declarations before creation, then bind that credential
once to the returned session. Unbound reservations expire in sixty seconds and
cannot execute tools. After binding, calls always use the normal domain catalog. Declarations can
remain staged for the reservation window until the admission commit is visible;
the first authorized listing retires that staging. This closes the asynchronous
MCP initialization/admission race without permitting an early effect. Persisted bindings contain only credential IDs and session references;
restart preserves identity while rotating the listener address. Pending
reservations are bounded and are not recovered as completed creations.

The Host starts capability providers before allowing Codex sessions restored
after a restart to prepare their tools. Shutdown withdraws domain providers,
drains admitted calls, then closes the listener and storage. Closing a browser does not revoke
Host ownership. Actor/channel revocation still rejects calls immediately.
Signing-key rotation invalidates credentials; native session preparation then
rebuilds the runtime configuration at its next idle boundary.

## Harness adapters

Codex existing durable sessions refresh the owned `opencraft_session` MCP entry
at an idle unsubscribe/resume boundary before the next turn. The thread ID and
history remain; model, workspace, approval and permission selections are carried
from the native live response. No native process, account writer or global
configuration is replaced. Unrelated MCP entries are inherited. Native
unsubscribe does not mean its durable catalog row disappears. Active turns are
never cancelled to refresh tools. Ephemeral inference threads cannot gain these
capabilities.

Refresh preparation is single-flight per thread and physical connection. Callers
resolve the current provider configuration after waiting; they cannot reinstall
an older captured value. The applied snapshot uses structural equality, so JSON
key order alone does not trigger native work. Provider values are cloned before
native awaits. Configuration is confirmed only after settings restoration;
the previous confirmation is invalidated before native configuration changes;
failed or retired preparations cannot publish success, send a turn, or continue
native mutations into a later connection. A blocked thread does not serialize
other threads. Both resume calls exclude turns and status reads exclude history.
The first lightweight resume preserves native settings; the second applies the
thread-local MCP override. The present native settings API has no thread-local
MCP update field, so this change retains that boundary rather than substituting
a daemon-wide reload. This is configuration preparation, not a second execution
or history owner. Live native settings and provider authorization remain their
existing authorities.

A new Codex session may have no rollout until its first accepted turn. IM
creation therefore installs a reserved MCP entry at `thread/start`, binds the
returned ID and commits message admission before starting execution. This avoids
resuming an empty thread. The adapter records the already installed runtime
configuration; it does not duplicate the first preparation. A failed native
creation is not silently retried or compensated by deleting durable history.

Pi and DSH consume `SessionCapabilityPort` natively. Host declarations are merged
with connection-owned declarations, and Host calls execute directly through the
same service. Browser registration is a full replacement of that browser
contribution only. Names cannot shadow Host tools. Browser disconnect revokes its
lease without withdrawing Host tools. DSH's native registry is reconciled at the
existing idle execution boundary; Pi uses its native registry replacement.
Neither adapter persists the Host catalog as browser-owned capabilities.

Headless IM execution supports existing durable Codex, Pi and DSH conversations.
Canonical server/thread identity selects each native input port; browser Host IDs
are presentation addresses and never replace the server identity. Pi uses native
submission receipts and DSH uses its existing Host execution journal. Busy inputs
remain admitted in Collaboration until native admission is possible. An explicit
safe deferral can return to accepted; uncertain transfers remain unknown and are
never automatically replayed. Pi/DSH reject steer before any native input.

An independent DSH Host consumes the same capability service over Remote MCP.
The gateway atomically publishes an owned private `session-capabilities.json`
endpoint descriptor beside the existing signing key. The same-uid Host signs a
single canonical session credential, refreshes its catalog before execution, and
rediscovers the endpoint on each operation. Gateway absence clears its cached Host
declarations; invocations and input authorization fail closed. No capability
provider or credential authority moves into DSH. The read-only `/admission`
endpoint checks an exact admitted input ID against current Collaboration authority
for the signed server/thread. DSH checks it after native model preparation and
immediately before `session.prompt`.

The independent Host's private `/host-inputs` HTTP lane requires its existing
owned descriptor token and rejects browser Origin requests. It is not forwarded
by the WebSocket browser proxy. Older Hosts explicitly defer without attempting
native input and need a separate drained Host upgrade; a gateway update alone
does not upgrade their execution owner. Host inputs preserve the live browser
contribution and its reply owner; browser disconnection revokes only those tools.
Actor run bindings and conversation delegation source remain Codex-scoped.

## IM reply and received-message read provider

IM contributes `im_reply(replyRef, text)` only to a conversation with a current,
authorized IM reply record. Each admitted arrival captures its own opaque
reference, source, sender, target, expiry and reply mode in SQLite migration v3.
The model cannot choose a channel or destination. Owner, human, sender linkage,
channel state and conversation permissions are checked again at invocation.

The same provider contributes `im_read_context` and `im_search_messages` only
where a current, authorized retained arrival exists. Each call uses its opaque
replyRef as an anchor to the same bot, sender and canonical conversation; context
additionally restricts the source. They read only content already admitted to
that conversation, with explicit received-only coverage and bounded excerpts.
No model-selected topic/actor/conversation scope or provider-wide history is
exposed. Reads may outlive the transport reply deadline within retention, but
always recheck current policy. See [received-message tools](im-switchboard.md#received-message-read-tools).
Trusted read declarations are also preauthorized per tool, including creation
reservations; the hint never replaces domain checks or changes global approvals.

The trusted reply declaration marks this bounded effect as preauthorized by the
admitted incoming message. The Codex adapter configuration projects that choice
only to `opencraft_session.tools.im_reply.approval_mode = "approve"`, including
creation reservations. It does not change the session approval policy, sandbox
or another tool's approval. Ordinary providers retain native approval defaults.
The hint never appears in the MCP schema and grants no domain authority: signed
session identity and all current IM checks still apply. Already pending native
approval requests are not automatically answered or replayed by configuration
refresh; native active-turn ownership remains unchanged.

New tool-mode arrivals skip processing stream feedback and automatic final
forwarding. A normal final remains in the workbench. The explicit tool sends one
complete text response within the original transport deadline and a 20,000-byte
budget. WeCom still uses its required final stream protocol frame, without
incremental content updates. No new proactive send path is introduced.

Claiming an unsent reply and persisting its text occur before transport I/O.
An identical retry after success returns the stored delivered receipt; a
concurrent call, changed second answer, expiry or unknown delivery is rejected.
A crash after the claim becomes `reply_unknown`; it never causes an automatic
resend. The existing explicit operator resend action retains its original
warning and original destination. Records admitted before migration retain
`reply_mode=final` and finish through the previous recovery path.

Verification entries: `tests/execution/session-capabilities.test.ts`,
`tests/extensions/im-tool-reply.test.ts`, `tests/execution/pi-durable-engine.test.ts` and
`tests/execution/dsh-capability-broker.test.ts`. Real native fixtures with local synthetic
models distinguish protocol/tool isolation evidence from real IM delivery.

Host tool refresh in Pi confirms an immutable schema snapshot only after native
installation. An installation failure invalidates that confirmation, including
rollback to an older declaration; the next attempt must reinstall. DSH serializes
registration per logical thread, resolves the current provider after waiting,
and skips only a confirmed identical declaration for the current bridge and
native generation. Bridge replacement clears confirmations and fences pending
results. Partial/deferred/failed registrations cannot become confirmed cache hits.
Configuration owners and permission checks remain unchanged.
