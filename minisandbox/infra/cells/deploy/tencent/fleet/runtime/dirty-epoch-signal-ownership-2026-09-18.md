# Depot dirty epoch signal ownership

## Qualification evidence

The strict shared-Agent run `23534a2d7f36a1e101d76fd50af7adfa` uses 16 immutable
Worker Versions, creates 200,000 Objects at 20 Objects/s after warm-up, and keeps
1,000 Objects writing one idempotent heartbeat every ten seconds. The run remained
functionally live, but its first post-warm-up compaction wave produced 3-second
`actor_ready_timeout` responses and therefore invalidated the strict zero-retry
qualification verdict.

This was not runtime slot or VM capacity exhaustion. During the failure window:

- both Cells retained 50/50 Ready FDB Machines;
- runtime Hosts were Running and Ready with no Pending Pods;
- each primary FDB cluster remained available, healthy, and fully replicated;
- FDB reported roughly 48,000-61,000 key reads/s, 24,000-28,000 writes/s, and
  3,100-3,450 committed transactions/s;
- storage processes reached roughly 50%-76% CPU and individual CBS devices reached
  roughly 65%-81% busy time;
- Engine logs contained repeated `depot_db_manager` transaction retry exhaustion,
  transaction age timeouts, hot-publish conflicts, and signal receive lag up to
  approximately 40 seconds.

The previous jitter change spread durable retry deadlines, but the normal commit
path still emitted another durable `DeltasAvailable` signal whenever a dirty branch
received a write more than 500 ms after its previous signal. A continuously active
Agent therefore emitted one workflow signal per heartbeat until compaction cleared
the dirty marker. When compaction slowed, the additional signals caused more full
manager refreshes, creating a positive feedback loop.

## Ownership invariant

One database branch has exactly one compaction wake owner per dirty epoch:

1. The clean-to-dirty commit atomically writes the dirty marker and one exact due
   locator, then sends one best-effort low-latency workflow signal after commit.
2. Later commits may advance the dirty marker but must neither move the durable due
   deadline nor send another foreground workflow signal.
3. The due locator, not the marker timestamp embedded in the immutable due key,
   fences retry ownership. At expiry the reconciler reads and signals the latest
   dirty marker, then atomically installs the next bounded retry.
4. Clearing the dirty marker also clears its locator. A delayed due row whose locator
   no longer matches cannot resurrect an old dirty epoch.

This makes foreground signal amplification `O(dirty epochs)` instead of
`O(writes while dirty)`, preserves the lost-response recovery path, and removes two
FDB mutations from every later dirty commit.

## Verification and rollout gate

The source change is covered by:

- all 40 Depot library tests;
- all 29 `conveyer_commit` integration tests;
- all 23 `forced_compaction_test_driver` tests with `test-faults`;
- a regression proving later commits retain the original deadline and send no second
  signal;
- a regression proving the reconciler claims that old deadline but signals the newest
  marker and persists the next retry before returning it.

Do not change the runtime image while the existing 200,000-Object run is live. Its
terminal receipt remains evidence for the old immutable release. After it finishes,
publish the fix transactionally to both Cells, requalify the release combination,
then repeat the same exact strict run. Success still requires 200,000/200,000
Objects, 1,000 active/proven Objects, zero failures, zero retries, zero Ready SLO
breaches, and zero identity mismatches.
