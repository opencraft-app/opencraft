# Mutation counterexamples

These are intentionally broken algorithm variants. TLC breadth-first search
must find an invariant violation for each configuration.

## AckBeforeSync

```text
Write(A) -> BeginFlush -> AckFlush
```

The acknowledged object exists only in volatile state.

## CommitBeforeObjects

```text
Write(A) -> BeginFlush -> CbsSync -> AckFlush
-> StartCommit -> CommitResult
```

The manifest becomes visible before its content exists in S3.

## ReclaimBeforeManifest

```text
Write(A) -> BeginFlush -> CbsSync -> AckFlush -> Reclaim
```

The only durable copy of acknowledged content is discarded.

## AcceptStaleWrite

```text
Crash -> Recover(new epoch) -> StaleWrite(old epoch)
```

A superseded writer changes volatile state.

## AcceptStaleCommit

```text
Flush(A) -> upload and verify A -> StartCommit(epoch 1, expected 0)
-> Crash -> Recover(epoch 2) -> reverify A
-> Commit(epoch 2, expected 0) -> Commit(epoch 2, expected 1)
-> Complete old Commit(epoch 1, expected 0)
```

The delayed old callback regresses the durable manifest generation.
