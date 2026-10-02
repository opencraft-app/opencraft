# ActorVolume generation fence model

This TLA+ model composes four boundaries that are otherwise easy to validate only in isolation:

```text
Pegboard actor generation
    -> ActorVolume writer epoch
    -> PVM admission and durable writes
    -> local sbxlet capability revocation
```

The production protocol and implementation mapping are documented in
[`docs-internal/engine/minisandbox-actor-volume-fencing.md`](../../../../../docs-internal/engine/minisandbox-actor-volume-fencing.md).

The model intentionally permits two PVM instances to overlap physically. It proves that a write
which reaches durable ActorVolume state was authorized by both the exact Pegboard generation and
the current volume writer epoch at the transaction linearization point.

Run the bounded model and all deliberately unsafe algorithms with:

```sh
./runtimes/minisandbox/host/spec/actor-volume-fence/check.sh quick
./runtimes/minisandbox/host/spec/actor-volume-fence/check.sh ci
./runtimes/minisandbox/host/spec/actor-volume-fence/check.sh ci-twice
./runtimes/minisandbox/host/spec/actor-volume-fence/check.sh mutations
```

`TLA2TOOLS_JAR` may point to an existing TLA+ Tools 1.7.2 jar. Otherwise the checker reuses the
storage workspace model cache and verifies both SHA-1 and SHA-256.
`ci-twice` is the qualification mode: it explores the two-instance state graph with independent
TLC fingerprint projections 29 and 47.

## Mutation oracles

Each mutation must produce the named counterexample. A syntax error or unrelated invariant failure
does not count.

| Mutation | Required counterexample |
| --- | --- |
| `AcquireWithoutGenerationFence` | A stale Actor generation acquires a new volume epoch. |
| `CommitWithoutPegboardFence` | An old PVM commits after Pegboard takeover but before epoch handoff. |
| `AdmitBeforeWriterFence` | Ingress is admitted without a writable volume session. |
| `ReturnIngressAfterRevocation` | An in-flight open returns after its capability is revoked. |
| `StopWrongGeneration` | A delayed stop revokes a different generation. |
| `ReuseCapability` | A retired handle aliases a later local incarnation. |
| `CompleteStopBeforeTeardown` | Envoy stop completion is sent while the PVM is only revoked. |
| `ReplayUnknownBeforeFence` | A stale writer replays a durable uncertain result after takeover. |

This is an interface refinement model. It does not replace the detailed block-engine models for
FLUSH, FUA, DISCARD, snapshot/fork, COS settlement, or GC.
It also assumes serializable UniversalDB transactions and abstract unforgeable capabilities; RNG
entropy, local IPC credentials, and liveness need implementation tests and operational bounds.
