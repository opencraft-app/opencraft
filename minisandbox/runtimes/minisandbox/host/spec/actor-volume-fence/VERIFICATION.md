# ActorVolume fence verification

## Scope

The model is an interface refinement for the Rivet generation, ActorVolume writer epoch, PVM
admission, durable commit, uncertain-result retry, sbxlet capability, stop, and crash boundaries.
It deliberately permits overlapping old and new PVM execution.

It does not model block payload layout, Device Mapper exception metadata, filesystem crash
consistency, COS settlement, or volume deletion/GC. It therefore assumes that an opaque COW store
is always reopened with the same immutable origin-template identity. Those remain the
responsibility of the detailed storage workspace models, deployment validation, and tests.

The model assumes UniversalDB transactions are serializable and that a serializable generation-key
read conflicts with Pegboard's generation write. It treats local capabilities as unforgeable
symbols and verifies exact matching, revocation, and non-reuse; it does not prove random-number
generator entropy or Unix-socket credential enforcement. It checks safety only, not eventual
failover or teardown liveness.

## 2026-08-21 baseline

Tool: TLA+ Tools 1.7.2 with the pinned SHA-1 and SHA-256 in `check.sh`.

| Configuration | Fingerprint projection | Generated states | Distinct states | Depth | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| `ActorVolumeFenceQuick.cfg` | 23 | 34,568 | 11,286 | 18 | No violation |
| `ActorVolumeFenceCI.cfg` | 29 | 26,101,576 | 5,891,190 | 26 | No violation |
| `ActorVolumeFenceCI.cfg` | 47 | 26,101,576 | 5,891,190 | 26 | No violation |

The two CI runs use independent fingerprint projections and reached the same complete state count.
The checked-in `ci-twice` mode reproduces projections 29 and 47. The projection number does not
change the modeled state graph.

All eight unsafe mutations produced their required, mutation-specific counterexample:

```text
AcquireWithoutGenerationFence -> WriterAcquisitionsAreGenerationFenced
CommitWithoutPegboardFence -> CommittedWritesHeldAuthorityFence
AdmitBeforeWriterFence -> AdmissionsCarryWriterFence
ReturnIngressAfterRevocation -> ReturnedIngressWasLiveAndExact
StopWrongGeneration -> StopTargetsExactGeneration
ReuseCapability -> ActiveCapabilitiesNeverRetired
CompleteStopBeforeTeardown -> StopCompletionAfterTeardown
ReplayUnknownBeforeFence -> ReplayedResultsWereGenerationFenced
```

The existing Rust minisandbox host lifecycle suite also passed all eight tests, including stale
generation replacement, delayed stop, failed teardown admission revocation, and ingress-open versus
destroy races.

## Model-to-code gate

This verification establishes the protocol to which production code must refine. It does not claim
that the current local SQLite block pool implements the production protocol. That claim becomes
valid only after the UniversalDB/FDB ActorVolume adapter maps:

- `AcquireWriter` to a serializable read of Pegboard's exact generation key plus an atomic writer
  epoch update;
- `CommitWriteKnown` and `CommitWriteUnknown` to one transaction containing both fence reads,
  block metadata, and the operation result;
- `RetryUnknown` to ownership revalidation before durable-result replay;
- `AdmitInstance` to the host transition performed only after writer acquisition and PVM readiness.

The Depot VFS adapter now maps every SQLite page commit to the same-transaction Pegboard generation
comparison and retains the Block Engine's durable writer epoch and operation-result tables. Its
in-memory Depot transport test exercises create, acquire, write, DISCARD, FLUSH, and verifies that
all page traffic carries the exact generation. A live FDB/COS fault run and guest `dm-snapshot`
crash-recovery run remain required before the deployment is marked production-ready. Filesystem
formatting is now an offline template-build operation rather than a first-attachment state
transition.
