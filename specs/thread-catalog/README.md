# Thread catalog consistency: executable ownership model

This is design/verification tooling, **not a new runtime directory or writable authority**.
The contract and current implementation gaps are in
[thread-catalog-consistency.md](../../docs/architecture/platform/thread-catalog-consistency.md).

## Run the bounded model checks

Use Java and the official TLA+ tools release [v1.7.4](https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4),
asset `tla2tools.jar`, SHA-256
`936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`.
Keep the binary and TLC state outside tracked source. The runner never downloads or installs anything.

```sh
node scripts/check-thread-catalog-model.mjs --jar /path/tla2tools.jar --output /tmp/catalog-model-run-UNIQUE
```

The runner verifies both actual exit codes and specific violated properties. A parser error,
timeout, or arbitrary Java failure is **not** an accepted negative control. It records source/tool
hashes, state counts, logs/counterexamples and a receipt. Use a fresh output directory each run.

| Model/config | Required outcome | Meaning |
|---|---|---|
| CatalogMerge / merge-legacy | counterexample | The shipping last-row-wins materialization violates unrelated-row or field ownership |
| CatalogMerge / merge-fixed | safety check passes | First-occurrence canonicalization before applying deltas avoids that overlap defect |
| CatalogOwnership / ownership-two-writes | safety and conditional liveness pass | Two commits, including repeated writes to one field, cannot be retired by an older response |
| CatalogOwnership / ownership-legacy-ack | NoRegression counterexample | A local read-start boundary is not server confirmation, including partial/missing fields |
| CatalogOwnership / ownership-legacy-scope | ScopeIsolation counterexample | A retired scope's response must not populate the successor |
| CatalogOwnership / ownership-fixed | safety and conditional liveness pass | Field-owner evidence and scope fencing preserve admitted facts |
| CatalogOwnership / ownership-unfair | temporal counterexample | No convergence claim is valid without eventual quiescence and successful refresh |
| CatalogCollaboration / collaboration-fixed | safety and conditional liveness pass | Independent admitted device replicas receive publication and eventually catch up after loss |
| CatalogCollaboration / collaboration-two-writes | safety and conditional liveness pass | Either device may write; independent replicas follow the shared owner commit order |
| CatalogCollaboration / collaboration-local-only | BroadcastCoverage counterexample | Updating the source device alone is not collaboration |
| CatalogCollaboration / collaboration-retired-response | NoRevokedDisplay counterexample | A delayed response must not repopulate a revoked replica |
| CatalogCollaboration / collaboration-stale-snapshot | NoRegression counterexample | A stale snapshot must not roll back an observed committed shared value |

Bounds: merge explores 2 Thread identities, an authoritative first occurrence plus a stale tail
duplicate, all 3 mutation types and both targets. Ownership explores 3 independent owner-field
keys (`A.name`, `A.pin`, `B.exists`), 2 scopes and 1 authoritative commit; an additional
configuration checks 2 keys and 2 commits, including repeated writes to the same field. Read cuts can lag or omit
any field; events/reads can be delayed and scope changes can retain an old response. Distinct
connections/tenants and same-ID Hosts are represented by the abstract scope/key, **not separately
enumerated**. This is not an unbounded proof or a complete formalization of archival/ACL behavior.

`CatalogOwnership` abstracts payloads by `(scope, key, owner revision)`: a trusted witness denotes
the owner value at that revision, not an arbitrary caller-supplied number. Different payload
strings/booleans are not separately enumerated. It uses an abstract comparable owner revision. The current protocol does not
supply such a revision on every path. That is a refinement obligation, not a frontend clock to
invent. Field-value confirmation can serve as a narrower witness for a specific confirmed write;
it does not order arbitrary concurrent server writes. `complete` is directory coverage only and
cannot make an old or missing field authoritative. Source incarnations cannot be compared by
arrival order. These assumptions must remain explicit when implementing the contract.

`CatalogCollaboration` adds 2 independent devices and 1 shared owner field, with configurations
for 1 and 2 committed mutations from either device.
Each device has its own view, observed cut, event queue, read and admission fence. Delivery can be
lost, delayed or duplicated as stuttering; a stale snapshot may arrive after an event. Fanout intent
must include all currently admitted connected readers, not only the source. An offline replica is
not a fictitious live subscriber and does not require a new per-device durable queue. The native
committed state supplies its later catch-up. Event delivery is not assumed reliable:
conditional liveness uses eventual healed authoritative refresh. This is a bounded abstraction,
not a model of the complete production transport/ACL, personal pin scope or two actual phones.

## Replay against the actual implementation

```sh
node --import tsx scripts/recovery-chaos.ts --suite catalog --seed 0 --cases 100 --steps 60 --output /tmp/catalog-chaos-UNIQUE
node --import tsx scripts/recovery-chaos.ts --replay /tmp/catalog-chaos-UNIQUE/failure-minimal.json --output /tmp/catalog-replay-UNIQUE
NODE_OPTIONS=--import=tsx node --test tests/chat/thread-catalog-ownership-model.test.ts tests/chat/thread-catalog-collaboration-model.test.ts
```

The `catalog` suite calls the production `ThreadCatalogUpdates` and normal page merge directly.
It reuses the existing runner's seeds, source hashes, rule-specific shrinker and replay format.
It has **no repaired implementation switch** and performs no network, model inference or production
mutation. It must exit zero after the canonical projection/native-read confirmation remediation. Former
counterexample traces are preservation assertions, not whitelisted seeds or inverted defect tests.
The shrinker/replay format remains available for any newly discovered invariant violation.
Bounded model success still does not establish production transport or full implementation correctness.

The collaboration fixture has **two distinct QueryClients and journals**, actual
`ThreadCatalogPublisher` and `bindThreadCatalogNotifications`, plus explicit synthetic fanout/network/
admission ports. It verifies peer catalog updates without opening a Thread, duplicate events,
offline fresh-read recovery without mutation replay, revoked-reader late-frame rejection, and the
overlap preservation across different page layouts and healed reads after a previously pending
fact and a mutation missed during disconnection. Passing these fixtures does
not prove the real transport's fanout or real ACL/provider registration is wired correctly.

### Trace correspondence (not automated refinement proof)

- Merge: `Receive` -> a real catalog patch/remove; `Materialize` -> real `materialize()`;
  first/backfill and tail rows match the synthetic replay fixture's overlap.
- Ownership: `DeliverEvent` -> trusted title/status fact; `ReadStart`/`DeliverRead` -> lagging-read
  replay; `LegacyAck` -> real `markRead()` + `acknowledge()`. `SwitchScope` -> a retired journal
  and a distinct successor. The replay verifies journal fencing, not the entire React lifecycle.
- TLC chooses bounded state transitions; the seed runner schedules actual component calls.
  They share named invariants and hand-translated regression traces, not identical code or a
  machine-checked refinement mapping. A green model cannot establish a green shipping implementation.
