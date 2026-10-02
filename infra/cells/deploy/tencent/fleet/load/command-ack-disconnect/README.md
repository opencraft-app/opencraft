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

Runs reuse one stable qualification Worker because the public delete contract
intentionally retains Workers that have Durable Object namespace history. Each
run uses and then deletes only its deterministic Object, so repeated evidence
does not create an unbounded set of retained Workers.
