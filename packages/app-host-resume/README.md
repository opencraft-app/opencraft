# App Host session resumption

Optional, negotiated extension of the App Host WebSocket route (`/apphost`,
`/ssh-apphost`). Browsers, PWAs and Electron windows on a remote server all use
that route, so they all get it; local Electron uses an in-process MessagePort
and never loses its route.

Without it, a dropped socket retires the App Host connection: every lease,
logical engine client and subscription is torn down and the client rebuilds
everything, re-reading each open conversation's history and polling snapshots
while a turn is still streaming.

With it, the Gateway keeps the App Host connection (leases, logical clients,
pending requests) alive for a short detach window and both directions number
their frames. A client that reconnects within the window resumes the same
session: each side replays exactly the frames the other has not received and
streaming continues where it stopped. Nothing above the socket notices.

It is only an optimization. Every failure path (expired or evicted session,
Gateway restart, identity change, window overflow, protocol error) falls back
to today's full reconnect, so correctness never depends on it.

## Protocol (version 1)

Control frames are never numbered; every other App Host message carries `seq`
(1, 2, 3 ... per direction).

| Frame | Direction | Meaning |
| --- | --- | --- |
| `hello.resume = {v:1}` | client → server | Ask for a resumable session |
| `ready.capabilities.resume = {v, sessionId, token, detachMs}` | server → client | Session granted |
| `hello.resume = {v:1, sessionId, token, received}` | client → server | Resume on a new socket; `received` = last server `seq` seen |
| `connection/resumed {received}` | server → client | Resumed; `received` = last client `seq` seen. Unseen frames follow, then live traffic |
| `connection/resume-failed {reason}` | server → client | Not resumable; client does a full reconnect |
| `connection/ack {received}` | both | Peer may drop retained frames up to `received` |
| `connection/end` | client → server | Intentional close; release the session now |

## Bounds (server)

- Unacknowledged frames per session: 1 MiB and 8192 records. Evicting an unacknowledged frame
  makes resumption from before it impossible (it then falls back).
- All sessions together: 1 GiB and 65536 retained records; over budget, the largest session loses its
  oldest frames first.
- At most 4096 session owners, independent of retained bytes. Capacity exhaustion must use the legacy non-resumable connection, not evict another owner.
- Detached sessions live 5 minutes, then their App Host connection is closed.
- Server frame payloads are stored as `Buffer`s. They still count toward process RSS/external memory; these budgets are not a total-process memory guarantee. Empty records and live payload owners have separate count bounds. Invalid limits are rejected, and registry shutdown rejects further admission.

The client retries resumption for at most 30 seconds after it detects a dead
route, then falls back.

## Authority and receipt boundaries

A grant is a replay capability, not authentication. Every new physical socket
passes the existing HTTP/WS admission owner before the resume token is examined.
The session also binds the trusted route, principal/actor context and expiry,
admission mode and logical renderer ID. A changed identity or credential lifetime
requires a fresh logical connection. The old resource context follows the adopted
carrier/request rather than keeping a destroyed socket or superseded proof alive.

Revocation watches and expiry belong to the logical resumable session, including
while detached. Successful adoption installs the fresh authority lease and retires
its predecessor; late predecessor callbacks cannot revoke the successor. Ending
the session fences replay writers before releasing their byte/record accounting.
Server shutdown ends detached owners as well as live ones, without masking the
existing restart close code. Invalid sequence/control data ends the logical session
rather than bypassing negotiated duplicate suppression.

Frame acknowledgement only confirms transport receipt. It is not a native input
admission or completion receipt. An unavailable replay window causes full reconnect
and the existing Host/history reconciliation; it does not authorize automatically
resubmitting `turn/start`, `turn/steer` or a business mutation with an unknown outcome.

The server exposes trusted composition options `appHostResumeEnabled` and
`appHostResumeOptions` (registry budgets). `OPENCRAFT_APPHOST_RESUME=0` disables new
grants. Legacy clients retain their unnumbered, connection-scoped behavior. Registry
saturation falls back to that legacy behavior without evicting another owner.
