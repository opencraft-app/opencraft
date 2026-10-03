# Command ACK disconnect qualification

This gate injects one disconnect on the real Beijing Host/Engine/FDB path at
the exact `after_commit_before_barrier` boundary. It proves that the Host keeps
the processed checkpoint, reconnects, resends the same ACK, observes the
replacement commit barrier, and leaves the Envoy-scoped durable command
backlog empty without applying the Stop side effect twice.

The fault surface is deliberately not an HTTP API. A platform operator with
existing Kubernetes `exec` authority places one strict, bounded JSON plan in
the Engine container that owns the target Envoy websocket. The Engine consumes
the file once, writes a local fired receipt, and closes the socket after the
FDB clear commits but before sending the ACK-of-ACK frame. Actor containers and
user JavaScript cannot reach this filesystem.

Run on the same-VPC reviewed builder after publishing a runtime image that
contains the hook:

```bash
ACTOR_REVIEWED_SOURCE=/var/lib/actor-build/deploy/q01-src-<git>-<manifest> \
  ./run-on-builder.sh <32-hex-run-id>
```

The immutable receipt is written below
`load-tests/command-ack-disconnect-<run-id>/receipt.json`. A missing exact
Engine owner, malformed fault receipt, duplicate processed Stop, absent ACK
replay/barrier log, non-empty reconciliation footprint, changed Actor/Cell
identity, or incomplete cleanup fails the gate.

The builder entry point forwards the Hub's private
`worker-registry-system/worker-registry:8080` through the existing Kubernetes
API, checks `/readyz` before any public API mutation, and closes the loopback
forward on both success and failure. It must not reuse the Workers API's
cluster-internal DNS URL outside the cluster. A directly reachable Registry
can still be selected explicitly with `qualify.py --registry-endpoint`; this
is mutually exclusive with `--registry-service`.

The qualification log parser accepts the runtime's ANSI-colored tracing text,
quoted Envoy keys and Kubernetes timezone timestamps. Only SGR presentation
escapes are removed; checkpoint identity and generation/index matching stay
strict. The observed Host line is a permanent regression fixture.

The gate uses separate existing Engine listeners: Guard `6420` for Actor
sleep, API Peer `6421` for the private reconciliation footprint. Both forwards
must be healthy before creating the Counter and must close during cleanup.
The footprint route is not part of the public Guard API.

Runs reuse one stable qualification Worker because the public delete contract
intentionally retains Workers that have Durable Object namespace history. Each
run uses and then deletes only its deterministic Object, so repeated evidence
does not create an unbounded set of retained Workers.
