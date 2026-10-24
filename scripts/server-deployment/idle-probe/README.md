# AppHost idle probe

Readonly maintenance probe for an OpenCraft app-host (`/apphost`) ingress. Used by
host-side maintenance flowbooks to decide whether a join core is idle before
maintenance actions. This tool is a probe: it mutates nothing on the server and
does not replace any gate; callers own their own gates and thresholds.

## Commands (run from the repository root)

Install pinned dependencies once (uses this checkout's lockfile):

    npm ci

Build the self-contained bundle (esm, `ws` inlined; dependencies come from this
checkout's pinned install):

    node scripts/server-deployment/idle-probe/build-idle-probe-bundle.mjs

The bundle is written to `build/idle-probe/preflight-cand.mjs` (git-ignored).

Run the differential suite (16 cases; fixtures and the legacy client run against
an isolated loopback server inside ephemeral temp roots; the runner asserts no
leftover processes per case):

    bash scripts/server-deployment/idle-probe/run.sh

The runner writes a timestamped results log next to `run.sh` and exits non-zero
if any assertion fails.

Probe a single endpoint directly (no fixture; read-only semantics):

    PREFLIGHT_ENDPOINT="ws://127.0.0.1:PORT/apphost" node build/idle-probe/preflight-cand.mjs

## Semantics

- hello `protocolVersion` is imported from
  `packages/app-host-protocol/src/version.mjs` (not hand-written); URL `attempt`
  and hello `rendererId` share one UUID; the `ready` reply's
  `protocolVersion` is re-checked and mismatches exit non-zero.
- Success ACK is not a reply: only the matching host/frame result (or a failed
  ACK / native error / fatal / close / ws error) settles each request, and any
  such failure rejects pending and future requests immediately with their 10s
  timers cleared (no 10s masking).
- `host/frame` envelopes are validated strictly (hostId, generation, leaseId)
  for replies matched by inner RPC id; frames without a matching pending id are
  broadcasts and are never treated as replies; missing/foreign lease,
  generation or host fields exit non-zero (exit 3) and can never yield idle.
- Full readonly contract is preserved: initialize -> thread/loaded/list ->
  `thread/read` (`includeTurns:false`) for every loaded thread -> active and
  unknown counts. Missing/unknown status and malformed lists are never idle
  (exit 2).

## Exit codes

- 0: idle (all loaded threads idle/known and counts consistent)
- 2: not idle (active/unknown/malformed/missing status)
- 3: protocol, handshake or envelope failure (immediate, before the 10s bound)
