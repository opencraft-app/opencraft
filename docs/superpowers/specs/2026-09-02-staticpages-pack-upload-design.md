# StaticPages Pack Upload Design

## Context

Frontend preview artifacts no longer fit the current single-request upload path.
A recent successful preview contained:

- CN: 2,676 files and a 100.9 MiB tar.gz archive.
- Intl: 6,116 files and a 115.5 MiB tar.gz archive.

The upload API accepts at most 60 MiB per request. Uploading every generated
file directly would replace one oversized request with thousands of small PUT
requests. StaticPages therefore needs a release protocol that transfers a
small number of independently retryable packs and only exposes a release after
all packs have been verified and expanded.

## Goals

- Keep every request to the StaticPages API well below 60 MiB.
- Allow individual failed packs to be retried without rebuilding or reuploading
  the complete artifact.
- Keep the currently published preview available until the new release is
  complete.
- Avoid persistent upload state on a specific StaticPages Pod.
- Preserve the existing repository, branch, SHA, environment, and bearer-token
  authorization model.
- Keep the existing `/api/upload` endpoint available during migration.

## Non-goals

- Cross-release file-level deduplication.
- Serving files directly from compressed packs.
- Changing the production EdgeOne artifact release path.
- General-purpose user uploads.

## Artifact Format

The CI client builds deterministic, independently extractable tar.gz packs.
Input files are sorted by normalized relative path. Each pack contains complete
files only; files are never split across packs.

The packer targets 32 MiB of compressed data and enforces a 48 MiB maximum for
multi-file packs. It estimates groups from per-file compressed sizes, writes
the candidate pack, and validates the final size. An oversized multi-file group
is split deterministically and rebuilt. A single file larger than the limit is
represented as an explicitly marked one-file oversized pack; because pack data
is uploaded directly to object storage, it does not pass through the 60 MiB
StaticPages API body limit.

Each release has a manifest containing:

- format version;
- repository, branch, source SHA, StaticPages SHA, and environment;
- total file count and total uncompressed bytes;
- one entry per pack with its name, compressed size, SHA-256, and contained
  file count;
- one entry per file with its normalized path, size, SHA-256, media type, and
  owning pack.

Pack names are content addressed, for example
`pack-0003-<sha256-prefix>.tar.gz`.

## Protocol

### Create release

`POST /api/releases`

The request contains the release manifest but no artifact bytes. StaticPages
applies the existing bearer-token and repository authorization checks, validates
all paths and declared sizes, and creates a staging release record in object
storage.

The response contains:

- an opaque release ID;
- an expiry time;
- one presigned PUT URL per pack, scoped to the exact staging object key;
- required signed headers.

The release ID is derived from the authorized repository, SHA, branch,
environment, and manifest digest. It is stable for retries but cannot be used
without matching authorization metadata. Staging keys are under the private
`_staticpages/uploads/<repository>/<release-id>/` prefix.

### Upload packs

The CI client uploads packs directly to object storage using the presigned URLs.
Uploads are parallel with bounded concurrency. Each PUT carries the expected
SHA-256 as signed object metadata. A failed PUT retries only that pack.

Repeating `POST /api/releases` with the same authorized metadata and manifest
returns fresh URLs for the same release. A release that is already published is
returned immediately without asking the client to upload again.

### Commit release

`POST /api/releases/<id>/commit`

StaticPages verifies that every declared pack exists and that object size and
SHA-256 metadata match the manifest. It then moves the durable release record to
`processing`, streams each pack from object storage, verifies its digest,
validates every tar path and file digest, and uploads extracted files to the
immutable `<repository>/<staticpages-sha>/` prefix. Processing is synchronous
and idempotent; an interrupted client retries the same create and commit calls.

After all files are present and verified, the worker updates the page index and
marks the release `published`. Updating the page index remains the single
visibility commit point.

The commit response returns `published` and the final preview URLs. Repeated
create and commit calls are idempotent for repository, StaticPages SHA, branch,
environment, and manifest SHA-256.

## Durable State and Cleanup

Upload manifests and status records live in object storage, not Pod-local
directories. Only the verified extraction workspace is temporary. A restarted
API can recreate the workspace and retry processing from the durable packs.

Successful commits delete their staging packs. The COS bucket must apply a
lifecycle rule to `_staticpages/uploads/` so abandoned or failed staging packs
expire after 24 hours. Release status records use the separate
`_staticpages/releases/` prefix and are not covered by that rule. Published
release lifecycle remains governed by the existing preview-retention policy.

## Security

- Every control-plane request requires the existing bearer token.
- Release metadata is bound to repository, branch, SHA, environment, and token
  claims at creation time.
- Presigned URLs permit PUT only to exact private staging keys and expire
  quickly.
- Manifest paths reject absolute paths, parent traversal, duplicate normalized
  paths, symlinks, devices, and unsupported tar entry types.
- Declared file counts and sizes have server-side limits.
- Complete processing verifies both pack-level and file-level SHA-256 values.
- Error responses do not expose object-storage credentials, signed URLs, or
  internal object keys.

## Compatibility and Rollout

The existing `/api/upload` endpoint remains unchanged. The CI client chooses the
pack protocol when the archive exceeds a configurable threshold and can fall
back to the legacy endpoint for small artifacts while the migration is being
validated.

Rollout order:

1. Deploy StaticPages release endpoints and worker with no client traffic.
2. Run API, path-validation, checksum, idempotency, and crash-recovery tests.
3. Enable pack uploads for branch previews only.
4. Compare published file counts and sampled object digests against a legacy
   upload of the same artifact.
5. Make pack upload the default and retain the legacy endpoint for rollback.

## Test Strategy

- Deterministic pack output for identical input.
- Pack size and single-large-file behavior.
- Manifest path, duplicate, count, size, and checksum rejection.
- Presigned URL scope and authorization isolation between repositories.
- Retry of one failed pack without reuploading successful packs.
- Idempotent create and commit calls.
- API restart or request interruption followed by idempotent create/commit retry.
- No page-index update after partial upload, checksum failure, or extraction
  failure.
- Successful CN and Intl preview publication with all manifest files available.
- Legacy `/api/upload` compatibility.
