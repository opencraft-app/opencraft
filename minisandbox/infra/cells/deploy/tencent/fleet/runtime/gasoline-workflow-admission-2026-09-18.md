# Gasoline workflow admission

## Failed qualification evidence

The strict shared-Agent run `ee805dd42f37b5868c9e7318a125f065` used 16 immutable
Worker Versions, created Objects at 20 Objects/s, and kept exactly 1,000 Objects
writing one heartbeat every ten seconds. It was stopped after the failure was
irreversible at 29,278 created Objects.

The workload retained functional correctness:

- 29,278 Objects were created with zero terminal creation failures;
- all 1,000 active Objects remained proven and retained their identity;
- 221,437 active interactions succeeded with zero active failures;
- there were zero identity mismatches.

It did not retain the production SLO:

- 2,335 Object ready operations exceeded three seconds;
- 2,336 create requests retried a `504 actor_ready_timeout`;
- ready latency reached 13.73 seconds;
- the final progress and event hashes are respectively
  `88cf2fa53956a37e8c68ddcedf9bf8c132fb68071b5f08660b2df4dd388336d5`
  and `2aa38a5e538e7d356cbf919c11707f961eed4bbe557cd9fa49782a9dfccfc0dc`.

Both Cells entered the same Depot compaction wave. In the diagnostic interval,
Cell A emitted 4,498 failed `refresh_manager` activities and Cell B emitted
5,472. Engine logs showed FoundationDB transaction timeouts, exhausted hot-publish
conflicts, and durable signal receive lag. Workers API and Registry remained healthy;
runtime Hosts and Kubernetes Nodes remained Ready.

The dirty-epoch ownership fix prevented repeated foreground signals within one dirty
epoch, but did not bound how many independent database managers Gasoline could lease
and execute at once. `gasoline_worker_pull_batch_size` bounded one lease transaction,
not the accumulated `running_workflows` map. Repeated immediate pulls could therefore
stack more work while an earlier batch was slow, turning a synchronized compaction wave
into positive feedback against FoundationDB.

The first bounded candidate proved that a global workflow limit is the wrong resource
boundary. It held every Engine at 64 ordinary workflows and preserved one reserved
`gasoline_pruner` slot, but all ordinary slots were occupied by old
`depot_db_manager` executions. The release gate passed after the reserved lane fixed
maintenance starvation; the following full Cell qualification then failed all 48 Actor
creates with the three-second `actor_ready_timeout`. The candidate remained
fail-closed and was never admitted for placement.

Inspection found a second source of amplification: after a branch had once advanced
its planning clock, its cold and reclaim deadlines were rearmed forever, even after the
branch had no dirty marker, no plan, no active job, and no forced work. That converts
historical Object cardinality into permanent scheduler load, which contradicts the
product model of many dormant Agents and a much smaller active set.

The first quiescence candidate (`7bb68f5b9aec`) passed release, drained the old manager
wave to 12 active managers, and eliminated immediate Actor-ready failures. Its full
Bottomless qualification then exposed an incomplete time invariant: all 48 Actors
completed online and final checkpoints and post-sleep force reclaim, with 220 cold
shards and zero read errors, but all 220 hot shards remained cached. The candidate had
treated “no work is actionable now” as “no future wake is required”; PITR and shard
cache retention make reclaim actionable at a later wall-clock deadline. The Cell stayed
fail-closed and this candidate was not admitted for placement.

The maintenance-deadline candidate (`2d6b1e4e15b5`) repaired that invariant. Its full
qualification completed 48/48 online checkpoints, 48/48 final checkpoints, and 48/48
post-sleep reclaims; all 48 Actors became cold, hot shards fell to zero, and pending
work and read errors remained zero. The wake phase then exposed an independent Guard
correctness window. A runtime Host accepted an Actor and reported it Running; the Actor
workflow durably committed `connectable` and its `envoy_key`, then recorded the Ready
publish. Multiple Guard requests nevertheless missed the ephemeral Ready edge and
returned `actor_ready_timeout` after 30 seconds. The candidate therefore also remained
fail-closed.

Actor readiness is now explicitly level-triggered. The Ready broadcast remains the
zero-read fast path, while a waiting Guard re-reads the durable Actor routing state
after 500 ms and then with a bounded two-second backoff. Only an actor2 record with
`connectable=true` and an `envoy_key` can satisfy that fallback. A single ready deadline
is created before the wait loop, so polling and rewake events cannot extend the public
timeout. Missing, destroyed, failed, and pool-error states retain their existing
fail-closed behavior. The durable state is the correctness source; the notification is
only a latency optimization.

## Ownership and admission invariant

Gasoline owns workflow execution admission. Depot owns activity admission and whether
compaction work exists; FoundationDB owns durable wake, dirty queue, lease, and data
state.

For each Engine process:

1. `gasoline_worker_pull_batch_size` bounds one FDB lease transaction.
2. `gasoline_worker_max_active_workflows` is a high process-safety ceiling, not the
   storage-pressure control and not the Actor-ready capacity setting.
3. Finished workflow handles are removed before calculating available slots.
4. A pull receives only the remaining available slot count and can never raise the
   process above the hard limit.
5. At workflow saturation, unleased work remains in FoundationDB. The worker performs a bounded
   local repoll; it does not acquire work and queue it in process memory.
6. A separately bounded reserved lane may lease only an exact, sorted allowlist of
   control workflows after the ordinary pool is full. Ordinary workflows can never
   consume that lane.
7. `depot_manager_refresh_max_concurrency` independently bounds latency-sensitive FDB
   planning/refresh work; it is not shared with compaction.
8. `depot_compaction_max_concurrency` bounds the activities which materialize, install,
   upload, publish, reclaim, retire, or delete data. Queued compaction cannot consume the
   manager-refresh permits.
9. Once a refresh proves no dirty marker, no planned or active job, no forced work, and
   no future PITR or shard-cache retention transition, the manager clears its cold and
   reclaim deadlines. If retained state can become reclaimable later, the manager sleeps
   until the exact earliest transition instead of polling every interval. A future commit
   wakes a fully quiescent manager through the exact dirty locator and durable reconciler.
   Delayed object deletion remains owned by the sharded GC queue rather than a per-Object
   timer.
10. Activity outputs from binaries predating the explicit maintenance-deadline proof are
    treated as unknown and retain fallback timers; an absent old field can never be
    interpreted as proof that future maintenance is unnecessary.
11. Engine restart or lease expiry preserves correctness because neither process-local
    concurrency gate owns durable state.
12. Guard routing never depends solely on an ephemeral Ready notification. A committed
    actor2 `connectable` state and `envoy_key` can recover a missed edge, but cannot
    extend the original request deadline or make a non-connectable Actor routable.
13. Host-to-workerd health, prepare, and eviction calls are bounded control-plane
    requests. A stuck loopback response fails within ten seconds; the existing
    generation fence then removes Host admission and the SQLite capability before the
    Envoy reports the failed stop. User fetches deliberately do not inherit this
    control timeout. Consequently a wedged isolate cannot hold an Actor workflow in
    `Destroying` forever or leak a runtime slot after its Registry tombstone commits.

The next Beijing candidate uses a 4,096 workflow process-safety ceiling, an 8-wide
manager refresh lane, and a 2-wide compaction lane per Engine process. With six Engine
processes this bounds the Cell at 48 concurrent refreshes and 12 concurrent compactions.
The lease transaction batch remains 256 and one additional workflow slot remains
reserved only for the unique `gasoline_pruner`. These are candidate calibration values
until the strict workload produces a passing receipt.

These bounds replace the previous 16/8 per-process candidate after the strict 10k run
`354610a58f4a66c7e0b4ec8d7978cbda` failed at 8,868 created Objects. The run began with
zero active Objects and zero compaction waiters. Near 8k active, B Cell maintenance grew
to 48 in-flight compactions with 1,258 waiters and 96 refreshes with 151 waiters. B UDB
transaction averages reached approximately 0.6--1.6 seconds while A remained near
0.05--0.12 seconds; neither Engine nor FDB CPU was saturated. The first user-visible
failures were seven B Cell `502 indeterminate_result` responses, followed by an
initialize failure. The subsequent 127 simultaneous cancellation errors were shutdown
fanout, not independent network incidents.

The new limits are a conservative calibration candidate, not proof of 10k capacity.
The identical zero-retry workload must pass after formal runtime release, while hot
bytes, compaction waiter age, and cold publish progress remain bounded. Changing the
Engine replica count requires recalculating and qualifying the Cell-wide maintenance
budget. UniversalDB pending metrics use a drop guard so cancellation releases the
gauge; the prior post-await decrement left approximately 2,640/9,513 false pending
transactions in A/B after cleanup and could not be used as a capacity truth.

The reserved lane was added after two fail-closed A-Cell release attempts. Prometheus
showed every candidate Engine pinned at exactly 64 in-flight executions, all 64 named
`depot_db_manager`, while each process recorded roughly 18,000-25,000 saturated repolls
in the 45-minute diagnostic window. The indexed pruner could not obtain a slot and the
release gate correctly rolled the Cell back. Merely increasing the ordinary limit would
recreate the original amplification failure if Depot activities were still unbounded;
the activity-class gates now enforce that resource boundary while the isolated one-slot
lane preserves maintenance progress.

The control-request bound was added after the B-Cell cold-tier qualification exposed
four terminal deletes whose Registry tombstones committed but whose workerd eviction
HTTP responses never completed. Repeating those idempotent deletes remained blocked,
and the exact four Host and SQLite registry entries stayed active. This was not a
qualification timeout problem: the unbounded Host request prevented Envoy from
emitting `Stopped`, so Pegboard could not publish `DestroyComplete`. The bounded
management request converts that permanent wait into the already-tested fail-closed
stop path.

The first strict 200,000-Object attempt after that repair was stopped at 45,603
successful Objects because two adjacent post-warmup Objects took 3.203 and 3.242
seconds. There were no create failures or retries. Both Objects and the surrounding
tail cohort landed in A while all 52 runtime Hosts were Ready; the same interval had
roughly 73 ms Pegboard allocation p99, 247 ms Actor-start p99, 49 ms UDB transaction
p99, and no Engine API request over one second. The central placement resolver was
instead holding one process-wide mutex while synchronously reading the ShardPool,
both RivetCells, and both immutable route ConfigMaps every second. A single Kubernetes
API tail event therefore blocked the complete new-Object cohort before Engine.

The corrected resolver treats `placementSnapshot.ExpiresAt` as the controller-issued
admission lease. While that lease remains valid, request paths read it immediately and
one background refresh performs the Kubernetes reads. An expired lease is never
extended: callers wait for the single refresh and fail closed at their own deadline if
fresh evidence is unavailable. This removes Kubernetes control-plane tail latency from
steady Object creation without converting a stale candidate into placement authority.

The next strict attempt, `bdf3e66f872eb76e266056af87ea1ce5`, proved that resolver
repair but exposed a separate hot-compaction phase collision. It was stopped
fail-fast at 14,707 successful Objects after two active requests timed out at 15
seconds and retried. At that point all 1,000 active Objects were still proven, there
were zero creation failures, zero ready-SLO breaches, zero active terminal failures,
and zero identity mismatches. Two different Workers API replicas recorded the timeouts
at `2026-09-18T22:31:03.80Z`; both requests traversed the stable B-Cell private load
balancer. All six B-Cell Engine Pods and endpoints remained Ready with zero restarts.

The failure window instead contained a synchronized Depot wave in both Cells. Across
the exact 90-second interval, A had 45--76 manager-refresh activities and 6--29
compaction activities in flight; B had 41--61 and 5--16 respectively. No activity
waited on the configured gates because the old per-process limits were 256 manager
refreshes and 64 compactions. A manager transaction averaged 4.09--5.12 attempts in A
and 4.93--5.48 in B, while Engine logs repeatedly exhausted the transaction retry
budget and hot-publish integrity rechecks.

The workload made the phase collision deterministic: the 1,000 active Objects were
created as one warm-up cohort and each committed one heartbeat every ten seconds. Hot
compaction used one fixed threshold of 128 deltas for every database branch, so the
cohort became actionable together after roughly 21 minutes. Cold and reclaim timer
jitter cannot spread a threshold-driven hot wave.

Hot compaction now derives one immutable threshold from the branch ID in the inclusive
range 96--160, preserving 128 as the population mean. Dirty admission, manager dirty
clearing, and hot-job planning use the same function. A ten-second cohort is therefore
spread across roughly eleven minutes without changing persisted state or wire formats;
subsequent cycles remain decorrelated because branches retain different periods. The
activity gates remain a bounded safety layer rather than the primary phase-control
mechanism. Qualification must still prove that the spread removes retry exhaustion;
the deterministic calculation and local tests alone are not production evidence.

The first strict 10,000-active-Object proof after that change failed closed at 7,767
ready Objects. Cell A had 144 manager refreshes and 134 compactions executing while the
old 256/64 per-process gates reported no waiters. Its durable-signal receive lag reached
4.81 seconds, Actor allocation p99 reached 2.28 seconds, and Guard ready-wait p99 reached
21.37 seconds. Cell B, at 51 refreshes and 33 compactions, remained healthy; Engine and
FDB CPU were not saturated and FDB retained full replication. The workload therefore
proved that threshold jitter alone cannot be the safety boundary for a fully active
cohort. That evidence motivated the previous 16/8 process-local candidate, which placed
the then-observed healthy load below the Cell-wide gate and the failed load above it.
The subsequent 8,868-Object failure documented above required the current 8/2 candidate;
the gates still queue maintenance without adding a distributed admission key or changing
durable ownership.

## Qualification gate

The candidate must pass, in order:

1. Gasoline and runtime configuration tests.
2. Both Cell release and qualification gates.
3. Strict 5,000- and 10,000-Object probes.
4. The exact strict 200,000-Object run with 1,000 active/proven Objects.

The terminal 200,000 receipt must have zero creation failures, zero request retries,
zero three-second ready SLO breaches, zero active failures, and zero identity mismatches.
Engine workflow concurrency, Depot activity admission/wait metrics, and Depot/FDB error
metrics must show that work was queued and drained rather than converted into another
transaction storm. The test must also show that clean managers stop producing periodic
wakes as historical Object cardinality grows.
