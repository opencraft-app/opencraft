# Hypernode Remote Control

Hypernode implements the Codex Remote Control transport as a tenant-aware Cordis service. Each
Hypernode user connects to OpenAI directly; no child Codex app-server sits in the Remote ingress
path.

```text
ChatGPT client
  -> OpenAI Remote Control WebSocket
  -> hostNetwork (generic HTTP/WebSocket I/O)
  -> RemoteControlService (user router)
  -> RemoteControlChannel (per-user wire protocol and durable state)
  -> AppServerVService (JSON-RPC dispatch)
  -> RootThread / AllThread / VFS / skills / transparent localhost threads
```

## Ownership boundary

Go owns only operating-system I/O:

- `hostNetwork.request({ method, url, headers, body })`
- `hostNetwork.openWebSocket(id, url, headers)`
- `hostNetwork.sendWebSocket(id, text)`
- `hostNetwork.drainWebSocket(id)`
- `hostNetwork.closeWebSocket(id)`
- the policy `onTick` scheduler

All OpenAI-specific behavior belongs to `policy/src/services/remote-control.js`: URL layout,
enrollment and refresh bodies, pairing, protocol headers, connection state, cursor recovery,
per-client stream sequencing, ACK retention, chunking, reassembly and App Server connection
lifecycle.

## Persisted state

Each SSH user's ChatGPT login is read exclusively from that user's private
`<users-root>/<user>/.codex/auth.json`. API-key auth is not accepted by this transport. Every user
has an independent installation ID, enrollment, enabled preference, WebSocket, cursor, ACK queue
and remote client set. Remote enrollment is keyed by Hypernode user, installation ID, ChatGPT
account and WebSocket target. It contains the server ID, environment ID, Remote bearer and expiry.
`ephemeral: true` never changes restart behavior.

Remote App Server connections retain the owning Hypernode identity. Notifications are emitted only
to local connections for that same user; one user's phone can neither drive nor observe another
user's channels.

Secrets are never placed in protocol diagnostics or SSH observation logs.

## Wire compatibility

The implementation follows protocol version `3` from the pinned Codex source. Server messages are
split near 100 KiB and capped at 150 KiB per wire envelope; reassembled messages are capped at
100 MiB and 1,024 chunks. Outbound envelopes remain buffered until the matching client/stream ACK.
After reconnect, the subscribe cursor is sent in `x-codex-subscribe-cursor` and unacknowledged
envelopes are replayed with their original sequence IDs.

`remoteControl/enable`, `disable`, `status/read`, `pairing/start`, `pairing/status`, `client/list`
and `client/revoke` are owned by the master service. They are intentionally no longer forwarded to
a per-user child Codex.

## Verification

Run:

```sh
npm run test:remote
npm run check:policy
go test ./...
```

The protocol tests cover UTF-8 across chunk boundaries, out-of-order chunks, bounded server
segmentation and request ID `0`. The Go tests verify the generic HTTP and WebSocket host ABI.
