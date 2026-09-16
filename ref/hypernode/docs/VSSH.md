# vSSH

`vSSH` is Hypernode's Cordis-owned SSH implementation. It keeps SSH protocol
semantics in the same JavaScript service graph as users, virtual filesystems,
threads, and the Codex app-server bridge.

## Boundary

Go owns only the listening TCP socket, byte transport, SQLite host capabilities,
and a generic cryptographic acceleration ABI. `RawServer` passes connection-open,
byte-chunk, poll, and close events into QuickJS. It does not parse an SSH packet or
choose an SSH algorithm.

`VSSHService` owns:

- SSH identification and binary packet framing;
- Curve25519 key exchange and the exchange hash;
- the persisted Ed25519 server identity from `node_identities`;
- AES-128-CTR encryption and HMAC-SHA-256 integrity;
- `none` and signed Ed25519 public-key authentication;
- session channels, flow-control windows, exec and interactive shell requests,
  PTY allocation/resizing, exit status, and streaming channels;
- authenticated `direct-tcpip` channels for local SSH port forwarding;
- forwarding the Codex app-server byte stream into the existing Cordis
  WebSocket virtual server.

`VSSHService` feature-detects each generic `hostCrypto` primitive independently.
When present it uses the Go standard library for SHA-256, HMAC-SHA-256,
AES-128-CTR, X25519, Ed25519, OS randomness, and constant-time comparison. A
missing primitive falls back to pure JavaScript (`@noble/curves`,
`@noble/hashes`, and `aes-js`), so the same service can run without the Go host.
Go does not expose SSH packet operations or any SSH-specific crypto API.

Outbound TCP follows the public Cloudflare Workers contract. Application and
service code imports `connect` from `cloudflare:sockets`. It receives a Socket
with `readable` and `writable` Web Streams, `opened` and `closed` promises,
`close()`, and `startTls()`. Both `SocketAddress` and `host:port` addresses are
accepted; `secureTransport` supports `off`, `on`, and `starttls`, and
`allowHalfOpen` controls half-close behavior.

`OutboundTcpService` owns that JavaScript API and Socket lifecycle. The only Go
surface below it is the private, transport-neutral `hostTcpOutboundDriver` ABI:
`open`, `write`, `drain`, `shutdownWrite`, `startTls`, and `close`. Policy code
must not call that driver directly. `PortForwardService` opens its target through
`cloudflare:sockets`, then claims a synchronous Cordis transport adapter because
SSH channel framing itself is synchronous inside QuickJS. The claim also establishes
one consumer for inbound bytes, so the background Web Stream pump cannot race the
SSH channel drain.

Neither `OutboundTcpService` nor the private driver knows about `direct-tcpip`,
SSH windows, or channels. Reverse `tcpip-forward` is intentionally not
implemented yet; it requires a separate listener/ownership policy rather than
another dial operation.

## Desktop host process contract

Codex Desktop also uses app-server `process/*` methods for host probes and
terminal tabs. Hypernode forwards `process/spawn`, `process/writeStdin`,
`process/resizePty`, and `process/kill` to the authenticated user's persistent
local Codex backend. Client `processHandle` values are remapped per frontend
connection, so two Desktop windows can reuse the same handle without sharing
output or lifecycle. `process/outputDelta` and `process/exited` are routed only
to the owning connection and rewritten back to the original handle. A dropped
frontend connection kills its remaining host processes.

The QuickJS bootstrap also feature-detects the Workers/browser behavior of
`Uint8Array.from(string, mapper)`. It installs a narrow iterable compatibility
path only when the host lacks it; conforming runtimes retain their native
implementation.

The host ABI is deliberately Node-like and transport-neutral:

- `createHash("sha256")` and `createHmac("sha256", key)`;
- `createCipheriv("aes-128-ctr", key, iv)` and `createDecipheriv(...)`;
- `x25519(privateKey, publicKey)`;
- `ed25519Sign(privateKey, data)` and `ed25519Verify(publicKey, data, signature)`;
- `randomBytes(size)` and `timingSafeEqual(left, right)`.

## Latency model

Host processes, PTYs, host WebSockets, and JavaScript-side fanout publish a
coalesced wake edge through `hostEvents`. Every active transport subscribes to
that edge and drains its own authoritative queue; newly opened legacy streams
also perform one initial drain to close the subscribe race. The one-second
timer remains only for background-service housekeeping. Host WebSocket input
has a separate tick-wake edge, so remote-control work progresses immediately
without running every background service for ordinary SSH output. SSH output
no longer waits on the former 25 ms polling loop.

`thread/list` follows the app-server list contract: it applies bounded `limit`,
opaque keyset `cursor`, `nextCursor`, and `backwardsCursor`, while returning
thread summaries with an empty `turns` array. Full turn trees remain available
through `thread/read(includeTurns: true)` and `thread/resume`. Filtered and
sorted summary projections are cached and invalidated whenever the thread
catalog changes.

Binary transport paths retain `Uint8Array`/Go `[]byte` values across the ABI.
Raw TCP input uses an acknowledged reusable read buffer, so Go does not make a
second defensive copy before the synchronous QuickJS call.

## Running

The legacy Go SSH stack remains available as a rollback path:

```sh
./bin/hypernode serve --ssh-stack go ...
```

Run the Cordis stack with:

```sh
./bin/hypernode serve --ssh-stack vssh ...
```

Both stacks read the same database-owned host private key, so switching stacks
does not change the OpenSSH host fingerprint.

## Verification

`npm run e2e:vssh` starts a fresh server and verifies the complete path with the
system OpenSSH client: key exchange, stable host identity, bootstrap `none`
authentication, issued Ed25519-key authentication, Codex's wrapped remote probe,
SSH channel streaming, a real identity-scoped PTY shell, WebSocket upgrade,
Cordis RPC, per-user file projection, real Codex model/config discovery,
multi-client fanout, thread lifecycle, and sensitive-output redaction.
The vSSH gate also verifies `process/spawn` output/exit routing and a real
OpenSSH `direct-tcpip` echo path.
`npm run e2e:policy` runs the compatible protocol gate against the rollback Go
stack.
