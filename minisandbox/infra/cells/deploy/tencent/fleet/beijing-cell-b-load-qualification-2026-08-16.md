# Beijing Cell B Actor load qualification — 2026-08-16

## Scope and safety boundary

All load originated inside Tencent Cloud Beijing. Three temporary private-only CVMs in zones 6,
7, and 8 were used as clients; none was joined to TKE and none was a workload node. The laptop only
orchestrated TAT commands and ran local unit tests. The Cell B runtime and six FDB members were not
temporary load generators.

Every run wrote an exact manifest of created Actor IDs before lifecycle transitions. Cleanup used
only those IDs; there was no namespace-wide Actor scan, global pointer scan, FDB prefix clear, or
COS `LIST`. After each failed run, its exact-manifest cleanup and bounded generation-fence probe
returned the authenticated host snapshot to `host_active_actors=0`,
`bridge_active_actors=0`, `quiescent=true`. The final durable-reconciliation rerun also reached
that state without a repair probe.

After the three-source regression completed, the three exact load-generator instance IDs were
terminated through the CVM API. A subsequent exact-ID lookup returned `TotalCount=0`. They were
standalone, private-only, postpaid CVMs used only as pressure clients; no load generator remains
running and none was ever attached to TKE. The builder, runtime, and six FDB members were outside
that deletion set.

## Loopback overload finding and fix

The first three-source run used concurrency 16 per source (48 total), 192 Actors, and 3072 writes.
Two sources each saw ten `fetch_failed` results. Bounded logs localized the failure to
host → workerd `127.0.0.1:18080` connection resets. workerd had no restart, OOM, core, or systemd
restart, and FoundationDB remained healthy.

Two independent mechanisms were fixed:

1. `RIVET_WORKERD_MAX_IN_FLIGHT=16` now acquires a semaphore permit before health, eviction, or
   fetch traffic reaches workerd.
2. reqwest loopback connection pooling is disabled. workerd and reqwest had independent keep-alive
   lifetimes; reusing a stale connection produced an ambiguous reset. A mutation POST is not
   blindly retried because SQLite/FDB may already have committed it.

The loopback-fix host artifact SHA-256 was
`45b2c608dd7837b798e076501cf57602f6ecd3d633e4c49a4a0aef89e7d8dd74`. The currently deployed host,
which additionally exposes authenticated exact registry diagnostics, is
`9e8fc1af5f753202a3d4e07d64e64077806dc6f4ca620f9a5a14936f29b57fd5`. Its bounded-in-flight,
fresh-connection, gateway response, and registry tests pass.

## Three-source regression

TAT invocation: `inv-87f35gg26m`.

| Source zone | Actors | Writes | Workload duration | Throughput | Increment p50 / p95 / p99 |
|---|---:|---:|---:|---:|---:|
| ap-beijing-8 | 64 | 1024 | 118.649s | 8.6305/s | 1843.81 / 1932.66 / 2293.62 ms |
| ap-beijing-6 | 64 | 1024 | 118.214s | 8.6623/s | 1846.09 / 1919.23 / 2333.65 ms |
| ap-beijing-7 | 64 | 1024 | 117.630s | 8.7053/s | 1861.97 / 1932.61 / 2391.56 ms |

Aggregate: concurrency 48, 192 exact Actors, 3072 acknowledged writes, approximately 25.9
writes/s. All sources passed and final runtime registry was `0/0`. This is a regression point for
the current counter workload, not a throughput ceiling or SLA.

## Cardinality stages

| Stage | Result | Runtime evidence |
|---|---|---|
| 64 Actors, concurrency 8 | Passed active → cold → wake → cleanup | Sleep registry settle 252 ms; workerd peak RSS delta approximately 16.7 MiB |
| 256 Actors, concurrency 8 | Passed active → cold → wake → cleanup | Sleep settle 252.65 ms; workerd peak RSS delta approximately 73.1 MiB; Engine delta approximately 21.8 MiB |
| 256 Actors, concurrency 32 | Failed with one ambiguous fetch before final loopback fix | Exact cleanup passed; result is retained as a negative regression case |
| 1024 Actors, concurrency 8 — first run | Full active SQL exactness and `1024/1024` registry passed; cold gate left `1/1` after 300s | The missing exact Actor had Start/Running but no Stop event; exact cleanup returned registry to `0/0` |
| 1024 Actors, concurrency 8 — latch rerun | All Actors were created and exercised; two host/bridge entries did not return to baseline within 300s | Invocation `inv-87f5bq0q7q`; exact manifest cleanup ran, then a bounded generation-fence probe against only the two residual identities returned `writer_fence_mismatch` and flushed both; authenticated stats were `0/0` (`inv-47f5t8gcuv`) |
| 1024 Actors, concurrency 8 — durable reconciliation | **Passed** active `1024/1024` → cold `0/0` → wake `1024/1024` at generation 2 → cleanup `0/0` | Invocation `inv-67f7t708au`; result SHA-256 `cd55b470ad1162ff706c0bad955eec2631828962aa02e6eaed8aa7d3b5d5b849`; sleep settle 252.09 ms; no cleanup errors or repair probe |

The 1024 failure was not a random timeout. Rivet actor2 explicitly discarded `Sleep` while the
lifecycle was `Allocating`, `Starting`, or `GoingAway`. At this cardinality, one durable Sleep
signal was processed before the delayed Running event. The workflow returned HTTP 200 for the
signal but never stopped that Actor.

The first repair adds a serde-defaulted `sleep_after_start` latch to durable lifecycle state. Sleep in
Allocating/Starting is remembered; Running immediately emits the normal sleep stop command;
Wake clears the latch; destroy retains precedence; GoingAway is converted to SleepIntent. Local
state-machine tests cover latching, wake cancellation, precedence, and decoding old durable state.

The latch rerun exposed a second, independent delivery defect. `ActorCommandKey` entries were
durable in FDB, but a connected Envoy depended on transient pub/sub for prompt delivery; the server
replied before websocket admission, and there was no periodic connected fallback. The client also
marked Stop processed before proving the Actor mailbox accepted it, removed stopped Actor entries
before the five-minute ACK timer could derive their checkpoint, and ignored failed mailbox sends.

The deployed cloud build repairs this with a deterministic-jittered, paginated scan of only the
connected Envoy's FDB command prefix (512 commands/page, one page/10s), while retaining pub/sub as
the fast path. Command publication is acknowledged only after hydration and websocket admission;
the client advances checkpoints only after mailbox admission and sends the command ACK immediately.
Directed local tests cover page/cursor isolation, duplicate replay, stopped-entry ACK, failed
mailbox replay, and failed ACK send. The final Engine SHA-256 is
`c82a23c5c68e0baced4ef46fe2726cc1c2e080680486088d25805b3543601bea`; its forced cloud build ran
the server suite `2/2` and client suite `6/6`. The final 1024 rerun passed all lifecycle and exact
registry gates in 223.37 seconds. Wake p95/p99 were 434.47/830.76 ms; workerd, host, and Engine
peak RSS were 243.55 MiB, 25.26 MiB, and 422.45 MiB respectively.

The final `0/0` registry is not a claim that every process returned memory to its initial RSS.
After exact deletion, workerd ended at 135.14 MiB versus 124.05 MiB initially, the host at 25.26
MiB versus 6.77 MiB, and the Engine at 422.45 MiB versus 91.09 MiB. This can be allocator high-water
retention, caches, durable-workflow state, or a leak; this run cannot distinguish them. Repeated
bounded lifecycle cycles and heap attribution are therefore a production gate even though idle
isolate ownership itself reached zero.

One protocol gap remains explicit: the client currently clears its in-memory dedup checkpoint when
ACK bytes leave the process, before the server confirms the corresponding FDB delete commit. A
strict ACK-of-ACK plus disconnect-injection test is required before production qualification.

## Current verdict

The loopback concurrency regression is **passed**. The 64, 256, and 1024 Actor lifecycle density
baselines are **passed**, including a 1024 all-active → all-cold → all-awake → deleted cycle. This
closes the observed lost-Stop defect, but it does not close the ACK-of-ACK protocol window described
above. No result here proves 1M dormant metadata cardinality, multi-workerd/multi-Runner recovery
storms, or a production SLO; those gates are tracked in
[`capacity-admission-and-operating-policy.md`](capacity-admission-and-operating-policy.md).
