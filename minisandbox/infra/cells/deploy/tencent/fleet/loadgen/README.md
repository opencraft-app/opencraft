# Autonomous FDB autoscaling load driver

`run.sh` creates one resumable Kubernetes Job inside the Cell. The checked-in
Python harness uses the real idempotent Actor API, records every exact Actor in
a WAL/FULL SQLite manifest on a retained CBS PVC, and resumes committed batches
after Pod or node loss. It never scans a namespace for cleanup.

The default population is one million Actors. Use the same `ACTOR_LOADGEN_RUN_ID`
with `ACTOR_LOADGEN_MODE=probe` or `cleanup`; all modes consume the exact same
manifest. The Job has bounded concurrency, a 14-day deadline, Kubernetes retry
policy, immutable image enforcement, FDB/backup/runtime preflight, and runs only
on the control pool. Before a workload Job is created, a short-lived DaemonSet
forces an `Always` pull of the exact registry digest on every control node.
Missing manifests, stale credentials, node egress/DNS failures and architecture
errors therefore fail within `ACTOR_LOADGEN_IMAGE_PULL_TIMEOUT_SECONDS` instead
of surfacing later as an unattended `ImagePullBackOff`. No agent needs to tail it.

`ACTOR_LOADGEN_OPERATION_RATE` limits high-level Object operations globally
across all worker threads (zero means unbounded). The public `/v1` path retries
only idempotent PUT, monotonic advance, and DELETE operations, with bounded
`ACTOR_LOADGEN_MAX_IDEMPOTENT_RETRIES` and exponential backoff controlled by
`ACTOR_LOADGEN_RETRY_BASE_DELAY_SECONDS`. Every retry is persisted in the
manifest and reported as `transport_or_overload_retries`; ordinary 4xx semantic
errors fail immediately. Qualification wrappers expose the same values as
`ACTOR_QUALIFICATION_OPERATION_RATE`,
`ACTOR_QUALIFICATION_MAX_IDEMPOTENT_RETRIES`, and
`ACTOR_QUALIFICATION_RETRY_BASE_DELAY_SECONDS`.

The preflight reads the Runtime HPA as the floor authority. It requires at least
the four-Host production minimum, an exact settled StatefulSet at that floor,
six fully reconciled Engine replicas, an active HPA metric, no release hold and
an `Idle` Host-drain state. This avoids baking an obsolete replica count into a
long-lived cardinality harness while still rejecting an already scaling or
partially Ready Cell.

`build-image.sh` is the supported publication path. It verifies the full source
manifest, requires the current `base-golang` digest, builds and pushes the tagged
image, captures the registry's digest, reads that exact digest back, validates
its OCI source labels, and publishes `ACTOR_PRODUCT_BUILD_RECEIPT`. Its printed `repo@sha256:...` is the only value
accepted by `run.sh`; a builder-local digest is never a release identity because
registry compression or manifest conversion can change it.
The source revision and complete `RELEASE_SHA256SUMS` manifest default to the
reviewed bundle's `.actor-source` identity, so operators do not re-enter either
value.
Set `ACTOR_LOADGEN_PREFLIGHT_ONLY=1` to run the full durability and per-control-
node image pull checks without creating a PVC or workload Job.

Repeated probes of the same manifest use distinct
`ACTOR_LOADGEN_JOB_SUFFIX` values (for example `scale-up` and `scale-down`). The
suffix changes only the Job and result filename; it never changes Actor IDs or
the manifest authority.

This workload measures Actor cardinality and causes real metadata/SQLite writes.
It is not guaranteed to force FDB storage expansion: Bottomless may drain user
bytes to COS faster than FDB headroom falls. Qualification therefore records
whether an autoscaling threshold was actually crossed instead of equating one
million logical Actors with a particular CBS footprint.
