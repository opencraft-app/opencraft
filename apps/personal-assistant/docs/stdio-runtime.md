# Independent assistant runtime

The personal assistant runs in a separate Node process. Both the public CLI
`node bin/assistant.mjs serve` and the packaged `assistant-server.mjs` start
exactly the same session implementation. Desktop and headless Hosts launch the
packaged entry over private stdin/stdout pipes; the old Worker entry is removed.
This is process isolation, not an OS permission sandbox.

## Ownership

- Core owns Human/Bot identities, claims, grants, model references and native
  group/conversation history.
- Host owns installation lease, process lifecycle, recovery/backoff and the
  authorized platform/model bridge. It does not load the assistant database.
- Assistant owns its existing profile, memory, input cursor, goals and durable
  work state. Shutdown releases resources but does not delete these facts.
- Harness owns model sessions and native execution checkpoints.

The process protocol is not a public network endpoint. Possession of the private
pipe is trusted local controller access. Never expose it directly to a renderer
or untrusted remote caller. Managed mode still authorizes the original binding
before startup and at the existing operation boundaries. Local mode cannot open
a managed profile without its platform authority port.

## Protocol v1

UTF-8 newline-delimited JSON-RPC 2.0. stdout carries protocol frames only;
diagnostics belong on stderr. One initialize per process. Requests are bounded
(32 concurrent, 1 MiB per frame); default request timeout is 15 seconds, Host
startup is 30 seconds. There is no automatic replay after a transport failure.
For mutations, callers must retain the original domain input ID and inspect
persisted results before deciding whether to retry. A timeout/abort ends the
local wait, not proof that a remote mutation did not happen.

Local initialization after CLI `init`:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"profile":"/absolute/profile"}}
{"jsonrpc":"2.0","id":2,"method":"dispatch","params":{"op":"status","params":{}}}
{"jsonrpc":"2.0","id":3,"method":"shutdown","params":{}}
```

Managed initialization uses `directory` (installation storage root) and
`profileOptions` instead of `profile`. During initialization and execution the
child sends `platform/<method>` requests to its Host. These reuse the existing
allowlisted methods, claim/generation checks and model ownership; the child
cannot choose another Human credential. The existing `dispatch` envelope and
application validation are reused in either mode, without a second command
implementation. `initialize` returns protocol version, dispatch capability and
runtime PID. Notifications `activity`, `activity-unavailable` and `failed` are
transient observations, never a second durable task ledger.

Closing stdin, disconnecting the parent or SIGTERM/SIGINT stops intake and
closes the runner. Graceful shutdown has a five-second process deadline; the
Host reaps the child and force-kills it when required. Invalid framing closes
the connection. New connections do not resume an old in-memory session: they
initialize from the original durable profile and its lock/fencing rules.

## Distribution and limits

Daemon, headless Linux, Web server and Electron packaging include
`assistant-server.mjs` beside the Host, plus the existing SQLite schema. This
is still a monorepo/bundled delivery; independent package installation and remote
Agent discovery are not implemented. Other execution engines have not all been
converted by this change.

Verification: `test/stdio-server.test.mjs` exercises the real CLI, separate PID,
EOF/reopen persistence, incompatible version, abrupt death and framing limits.
`tests/identity/personal-assistant-host.test.ts` exercises managed native chat,
restart, grant revocation, installation ownership and transient inbox failure.
Fixture inference does not establish real model/network availability.

### Reply/activity ordering

The optional read-only `observe` method projects reception and work observations
from the existing runner status. Before forwarding `platform/reply`, the Host
refreshes its expiring observation from that method. Failure invalidates the
observation and does not suppress or replay the native message. Native channel
changes invalidate in-flight UI status reads before requesting another read;
periodic polling remains a fallback. Replies never imply idle: subsequent queued
or running input still belongs to the reception authority.
