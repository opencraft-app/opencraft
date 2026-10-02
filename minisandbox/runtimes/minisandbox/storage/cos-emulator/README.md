# Tencent COS consistency emulator

This is a narrow, deterministic test double for the weak object-observation
contract used by minisandbox. It is not a general object store, an S3 signing
implementation, or a production service.

It separates:

- durable immutable payload truth in `objects/<key-digest>.bin`;
- path-local `visible`, `hidden`, or `stale` observations;
- one-shot scripted `not_found`, `stale`, `corrupt`, read `timeout`,
  `timeout_before_apply`, and `timeout_after_apply` actions;
- append-only `history.jsonl` with request sequence, action, provider truth,
  response status, range, and hashes.

Data requests use a small write-ahead `pending_history` record in `state.json`.
State/script consumption is fsynced first, the JSONL event is then fsynced, and
the pending marker is cleared last. Restart either appends the missing event or
deduplicates an event already present, then verifies that replayed provider
truth exactly matches persisted object metadata.

The data listener supports path-style `PUT`, `HEAD`, single-range `GET`, and
idempotent `DELETE` at `/{bucket}/{key}`. Select an independent access path
with `x-cos-emulator-access-path`; the default is `default`. A successful PUT
makes the object visible only through the path that issued it. Other paths
remain hidden until the control API changes their visibility.

## Run

```text
cargo run -p minisandbox-cos-emulator -- serve \
  --root /tmp/minisandbox-cos \
  --token local-test-token-1234
```

Both listeners reject non-loopback bind addresses. The process prints its
selected data and control ports after startup.

Control requests carry `x-cos-emulator-token`:

```text
POST /v1/scripts
{
  "access_path":"access-b",
  "operation":"get",
  "bucket":"test",
  "key":"extent/sha256/abc",
  "actions":[
    {"kind":"not_found"},
    {"kind":"corrupt"},
    {"kind":"normal"}
  ]
}

PUT /v1/visibility
{
  "access_path":"access-b",
  "bucket":"test",
  "key":"extent/sha256/abc",
  "visibility":"visible"
}

GET /v1/history
GET /healthz
```

`timeout_after_apply` is meaningful for PUT and DELETE: provider truth changes
durably, but the caller sees a delayed HTTP 504. `timeout_before_apply` leaves
truth unchanged. For reads both represent a delayed failed observation. A
client deadline shorter than the scripted delay observes a transport timeout;
a client that waits sees the explicit 504.

The local state directory is single-owner locked. Scripts, visibility,
tombstones, and their remaining queue positions survive restart. DELETE never
physically removes retained payload bytes because they are needed to reproduce
stale observations; discard the entire test directory when a run is complete.

The emulator returns `x-cos-emulator-sha256` rather than pretending its digest
is a COS ETag. It ignores S3 authorization and implements no LIST, multipart,
versioning, lifecycle, inventory, or physical GC APIs.

MinIO remains useful later for S3 signing, header, and SDK compatibility tests.
It is intentionally not used as the consistency oracle because its stronger
visibility would erase the Tencent COS failure schedules this emulator exists
to exercise.

## Security boundary

This binary is test infrastructure. Both listeners are forced to loopback;
the control listener requires a 16--256 byte token; the server uses a bounded
worker count; object/control bodies, identifiers, script lengths, and delays
are bounded; and object filenames are SHA-256-derived rather than caller
paths. The control worker remains separate so intentional timeout faults cannot
starve fault administration.

The data listener is intentionally unauthenticated and the test directory has
no aggregate byte quota. A local process can consume its worker slots or disk.
Do not expose it outside a trusted test host and never use it as a production
COS proxy.
