# FDB elasticity qualification

`qualify.sh` is a bounded, unattended production gate for the complete
elasticity chain:

1. publish a fixed Worker and seed real Agent/Durable Objects through the public Workers `/v1` API;
2. promote a temporary, digest-bound qualification profile;
3. let the fleet controller request 9 -> 12 storage processes;
4. let the official FDB Operator create and rebalance process groups;
5. declare the exact TKE Native MachineSet replica target and matching minimum,
   publish the FDB target, and let `ZoneEquality` supply one node per zone;
6. advance exact Durable Object state through `/v1` at 12 processes;
7. change only the qualification hysteresis and request 12 -> 9;
8. require three exact CBS PVs to be Released, unattached and quarantined for
   30 days in `ObserveOnly` GC mode;
9. lower the MachineSet minimum only after FDB drain, backup and quarantine
   gates pass, then wait for TKE to remove the three empty nodes;
10. advance state again, delete only ObjectRefs recorded in the retained manifest, restore
   the production `ObserveOnly` profile, and write a terminal JSON receipt.

The load generator never calls `/actors`, `/gateway/<actor-id>`, or an internal
sleep endpoint. Its state transitions use an expected-value protocol, so a
response lost after the Durable Object commit can be retried without applying
the increment twice. Every Job records `public-api-only=true`; the receipt
verifier rejects an Engine URL even when the storage transition itself passed.

Storage topology and compute elasticity are deliberately qualified as separate
experiments. The FDB gate retains a declared number of deterministic public
Objects across both topology changes and uses the declared batch, pacing and
retry policy. The outer
qualifier independently samples Cell occupancy, the runtime StatefulSet and
the runtime MachineSet throughout the run. The receipt is rejected if active
occupancy exceeds the bounded warm envelope or either runtime resource moves
away from the declared production baseline (at least four replicas for new
receipts). Pacing is not evidence; only this independent
timeline proves that the FDB result was isolated from compute autoscaling.
Every phase's public load-generator JSON is parsed from the successful Pod,
validated for its exact run/Cell/cardinality/state, and embedded in the final
receipt. Kubernetes Job success alone is never accepted as Object evidence.
Receipt schema v5 binds cardinality, probes, concurrency, batching, pacing,
retry policy and runtime baseline to both the immutable Job and its result.
The verifier retains v4 support only for already-issued historical evidence.

The public load generator uses local manifest schema 4. Before dispatching each
batch it commits the exact Object IDs to a FULL-synchronous SQLite attempt
journal. One exclusive manifest lock covers the entire phase, so cleanup cannot
race a still-running population or probe process. Process exit releases the
lock automatically. Successful results and confirmation are committed together. Recovery
can therefore delete an Object whose PUT or initial state write committed but
whose response was lost, even when no successful result row exists. Cleanup
validates each ID against the retained run, ordinal and probe-epoch prefix;
it never lists a namespace or guesses IDs using the current probe epoch.
Explicit partial indexes bound cleanup batches and unfinished-probe lookup.

Cleanup and summary use the retained immutable release metadata and never
republish Worker code. Selected endpoint, Worker, class, run and cardinality
must match the manifest before any Code Plane mutation. Historical manifest
schema 3 runs retain their original reviewed tool; they are not silently
upgraded in place. This does not change any production storage format.

The receipt reports journal states and scheduled operations, including resumed
pending work. Cleaning all attempted IDs in a failed partial population can
pass the cleanup operation, but cannot prove the requested population existed.
The outer qualification still requires the exact target Actor inventory and
successful public state transitions. Missing results do not acquire fabricated
latency samples or count as zero-error cardinality evidence.

The script never deletes a PV or CBS disk. On failure it restores the production
profile but deliberately leaves any safe expanded FDB topology in place for
diagnosis. If the larger FDB target was never published, it terminalizes that
operation and restores the unused MachineSet floor; this is not a database
contraction. It never guesses that a forced contraction is safe.

The fleet controller is the single desired-capacity owner for the dedicated FDB
MachineSet. It transactionally writes the exact `spec.replicas` target and the
matching `spec.scaling.minReplicas`: up immediately before publishing the FDB
Pod demand, and down only after a scale-down operation has produced its
retained-volume evidence. TKE still owns Machine creation/removal and
`ZoneEquality` placement. This avoids depending on an opaque Cluster Autoscaler
decision for database capacity.

An isolated DR restore creates storage Pods without a primary FDB scale
operation. The normal Cell reconcile counts those auxiliary Pods and raises the
same MachineSet target and minimum before waiting for TKE; it never changes the
primary database's process count. Central Argo ignores `replicas` and, only for
`np-fdbpool0`, `scaling.minReplicas`, because both are controller-owned dynamic
fields. A qualification target left behind after failure continues to reserve
capacity until exact-UID cleanup. The auxiliary path does not automatically
lower a high-water floor when such a target is removed; that remains an
explicit capacity-reclamation operation, not permission to bypass volume
retirement or delete CBS disks.

All long waits and thresholds are environment variables. The storage topology
gate defaults to 10,000 real public Objects. The same reviewed entrypoint can
qualify up to one million dormant Objects when the exact parameters and timeout
are explicitly supplied; the v5 receipt prevents a smaller run from satisfying
that claim. Qualification thresholds still force one bounded topology step so
Bottomless COS drainage cannot make the test nondeterministic.

The live CRD's production lower bounds still apply: scale-up evidence is held
for at least five minutes, and scale-down evidence plus cooldown are held for
at least one hour with write utilization at or below 50%. The qualification is
asynchronous because these safety windows are not shortened for a test run.
