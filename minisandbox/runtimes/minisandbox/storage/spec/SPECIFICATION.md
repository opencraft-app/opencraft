# Storage algorithm model

## State

An object reference contains `block`, a globally ordered `version`, and a
symbolic content value. The value represents an ideal content hash and is the
S3 key; block and version remain manifest metadata. Equal content values may
therefore deduplicate in S3 even when their block versions differ.

The algorithm state contains:

- volatile writes and an in-progress FLUSH image;
- durable CBS objects and a durable per-block CBS head;
- the latest successfully acknowledged FLUSH image as specification history;
- actual S3 content keys and references verified in the current epoch;
- in-flight PUT, HEAD, and manifest commit operations, which survive a crash;
- manifest image, CAS generation, and ghost high-water marks;
- current fencing epoch and the epoch held by each writer.

## Environment transitions

S3 PUT has three nondeterministic outcomes:

- success: content exists and a current-epoch result verifies it;
- timeout after commit: content exists, but is not yet verified;
- timeout before commit: no new content is known to exist.

HEAD may return correct content, transient `NotFound`, or corrupt/wrong data.
Only a correct response for a current-epoch operation enters `verified`.
Tencent COS visibility therefore has no assumed time bound.

Crash loses volatile writes, FLUSH progress, and current verification cache.
Durable CBS, S3, manifest state, and in-flight external operations remain.
Recovery increments the fencing epoch; delayed old operations may still
complete but cannot authorize a current manifest update.

## Safety invariants

The transition system lives in `Storage.tla`; the oracle below is defined in
the separate `StorageSafety.tla` module. This separation does not eliminate
specification mistakes, but prevents an algorithm edit from automatically
rewriting its checker predicate in the same block of code.

`AcknowledgedDataRecoverable` is the central property. For every block with a
successful FLUSH, the current durable source must contain the same or a later
issued version. That source is either a valid CBS head backed by CBS data or a
manifest reference backed by S3 content.

The remaining invariants establish the premises independently:

- `ObjectAuthenticity`: no storage layer fabricates an unissued block value;
- `CbsHeadIsDurable`: CBS metadata never points at volatile/absent data;
- `CbsHeadNeverBehindManifest`: CBS precedence cannot hide a newer manifest;
- `VerifiedObjectsExist`: verification implies the content key exists in S3;
- `ManifestObjectsExist`: every committed reference is complete in S3;
- `ManifestNeverRegresses`: CAS generation and block versions are monotonic,
  and the same expected generation cannot succeed twice;
- `StaleEpochsAreFenced`: stale writes cannot mutate state;
- `TypeOK`: every record, set, function, and finite bound is well typed.

## Explicit assumptions

- One FLUSH lane is serialized; writes are accepted only while it is idle.
- Version order is globally monotonic. A concrete design can encode this as
  `(fencing_epoch, local_sequence)` rather than persisting a single counter.
- Symbolic content values are collision-free hashes.
- `CbsSync` is the abstract durable boundary; its physical implementation is
  outside this algorithm model.
- S3 objects are immutable and addressed by content. Correctness never uses
  LIST or overwrites an existing key.
- No liveness is claimed during permanent provider failure. Safe backpressure
  is allowed indefinitely.

## Bounds

TLC checks every behavior inside each configuration, but the configurations
are finite. The full checked configuration uses two blocks, two content values,
two issued versions, two writer epochs, and two successful CAS generations.
An unbounded claim requires a separate inductive proof; state-count growth is
not a substitute for one.

TLC enumerates enabled transitions rather than randomly fuzzing sequences.
Equivalent fail-closed results may converge on the same successor state: HEAD
`NotFound` and corrupt data, for example, both remove the attempt without
granting verification. The mutation configurations separately demonstrate
that each safety-critical guard is capable of detecting its intended fault.
