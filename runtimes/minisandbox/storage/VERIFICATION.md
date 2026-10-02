# Verification record

## Authoritative model

The algorithm source is [`spec/Storage.tla`](spec/Storage.tla); its safety
oracle is kept separately in [`spec/StorageSafety.tla`](spec/StorageSafety.tla).
Both are independent of the Rust prototype. The Rust model's earlier
11,203-state result is not used
as evidence because its state and properties were derived from the same
boolean implementation and omitted block contents, competing CAS operations,
and delayed callbacks.

TLC version: TLA+ Tools 1.7.2, SHA-1
`7f21faa2cdae3189e7d5fadb4488f0dfcc658407`, SHA-256
`fa18543e44ed5974a85bd2c60c0dc16620ae117680ea8e693d2691999ed90b22`.

## Reproducible configurations

`StorageQuick.cfg` completed with:

```text
8,856 states generated
1,230 distinct states
depth 20
no invariant violation
```

`StorageCI.cfg` completed with:

```text
31,941,115 states generated
2,174,742 distinct states
depth 35
no invariant violation
```

`Storage.cfg` covers two blocks, two content values, two issued versions, two
writer epochs, two manifest CAS generations, every asynchronous completion
ordering, crash/recovery, and all S3 outcomes. Its result is recorded below
after running `spec/check.sh full`:

```text
99,898,463 states generated
6,750,052 distinct states
depth 36
no invariant violation
```

## Mutation adequacy

Five deliberately broken algorithms must fail with the expected invariant:

```text
AckBeforeSync          -> AcknowledgedDataRecoverable
CommitBeforeObjects    -> ManifestObjectsExist
ReclaimBeforeManifest  -> AcknowledgedDataRecoverable
AcceptStaleWrite       -> StaleEpochsAreFenced
AcceptStaleCommit      -> ManifestNeverRegresses
```

`spec/check.sh ci` treats a mutation that passes, or fails for an unexpected
reason, as a test failure.

TLC explores all enabled successor transitions rather than sampling random
sequences. This gives behavior-sequence coverage inside the declared finite
bounds, but it is not source-code branch coverage. Semantically equivalent
fail-closed outcomes can collapse to the same state. The mutations therefore
act as guard-adequacy tests: each named unsafe change must produce the expected
safety counterexample.

## Exact claim

For every reachable state in each finite configuration, TLC checked all nine
declared invariants. This is a pure algorithm result. It does not establish:

- an unbounded inductive theorem for arbitrary blocks, versions, or epochs;
- correctness of a CBS WAL, filesystem barriers, or block device firmware;
- Tencent COS availability, visibility delay, SDK, or checksum behavior;
- refinement of a future Rust service to this specification;
- liveness under permanent S3 failure.

Those are deliberately outside the present proof boundary.
