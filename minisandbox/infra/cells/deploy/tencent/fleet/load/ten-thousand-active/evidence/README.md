# Capacity failures and pressure evidence, 2026-10-03

## Terminal result for the original strict run

Read-only observation `inv-e9ekt2gfn9` at 06:57:09 UTC completed SUCCESS/0.
The original service has MainPID zero and failed/exit one, with unchanged
InvocationID `8ee84c21e87944c983932c62a5df5c56`. The underlying strict run did
not pass: `activeCapacityReady`, `loadReceiptPassed` and
`tenThousandActiveSustained` are false. Exact cleanup, observed automatic
scale-up, safe drain and final low capacity are true. The final observation at
06:53:45.902833 UTC has four Ready Hosts and four Ready Machines in each Cell,
zero active Actors and 694 complete samples. Natural drain took 7,801 seconds.
Peak capacity was 523 Hosts and 525 Machines across the two Cells; this is
observed supply, not successfully qualified active-object capacity.

The original raw receipt remains at
`/data/actor-bootstrap/beijing-rebuild-20260915/load-tests/ten-thousand-active-55b558752ba2454987491cdea655ff68/receipt.json`
on the original operations host. Its reported SHA-256 is
`a49cb93099fd010d5cc8d01d934fdd5f1c021acd7520502eae668ec65f98ad9e`.
The local observation log
`/data/actor-build/local-admission-c631f554-20261003/progress-0659.log`
hashes to `aa93679765de92ce3c99e50f96576e6cfbbd06cc1fcc9858a020561d46ac2894`.
It contains the original command's receipt output, not a byte-identical
download of the raw receipt. The observation command's success is not a
qualification pass. Do not restart this failed run.

## Dedicated builder template, not deployed recovery

The strict platform bootstrap validator rejects a root `runtimeBuilder` field.
The old platform fixture did not represent that added Terraform output, so its
passing tests were not evidence for the combined contract. Build identity is now
a separate `runtime_builder_inventory` output, with a regression that preserves
the management platform's exact root schema. No platform schema is loosened and
no build disk is folded into C bootstrap identity.

The new read-only `validate-runtime-builder-storage.py` joins fresh native
CVM/CBS responses, management nodes and guest metadata/lsblk/by-id/wipefs.
Seven tests include exact identity, root ancestry, existing production-disk
refusal, stale evidence, missing filesystem columns, duplicate JSON and real
file/subprocess refusal. A separate read-only collector now exercises native cloud
projections, exact C membership and the real TAT helper through local protocol
processes. Its six regressions include refusing wrong metadata before disk probes
and refusing already-used disks; stock Python 3.6 syntax is checked. These tests
do not prove the not-yet-created standalone builder, disk initialization, mount
recovery or build handoff. Its passed plan deliberately
reports `storageReady=false`.

The subsequent full management Terraform plan failed while refreshing the original
C bootstrap attachment: native TKE reported `DiskPressure:True,Ready:True`, not a
provider false positive. It was not saved or applied. Local-cache retirement
preflight `inv-a9encv0inv` passed under the original operations/build locks, protecting
40 C/A/B image references and proving all sixteen old immutable refs remained in TCR.
Mutation `inv-a9end9g59c` then stopped partial after one local image; no `--force`
was used and the other fifteen were not successfully deleted. Read-only
`inv-d9endv081c`, 07:51:22 UTC, confirmed 90 local images, the second exact candidate
unchanged, 16,882,380,800 root-available bytes and DiskPressure still true. This is
neither storage isolation nor repaired cloud admission. Registry objects, business
data, existing PVs, source trees and Cargo caches were not deleted. A replacement
cleanup plan must be re-observed rather than blindly replaying the partial operation.

Read-only `inv-d9enge0843`, 07:54:04 UTC, completed SUCCESS/0 and captured native
kubelet stats/config projections. Both nodeFs and imageFs reported capacity
105,620,869,120 and available 15,495,536,640 bytes (about 14.67%), below the actual
`imagefs.available=15%` hard-eviction threshold. Native imageFs usage was only
4,391,030,784 bytes, but it shares the full backing's free-space signal. The
configured pressure transition is five minutes. These samples explain the current
pressure guard, not the original business 502. They are not simultaneous with the
earlier `df`; their difference is not an attributable build-write rate.

### Exact cache retirement and observed recovery, not storage isolation

The fresh v2 dry-run `inv-e9ens0gbt4` and execution `inv-e9ensrg8cq` both completed
SUCCESS/0. The latter's non-secret native receipt is
[`beijing-builder-cache-retirement-20261003.json`](beijing-builder-cache-retirement-20261003.json),
SHA-256 `73037af55910bb64710d5623feed7d09010ae17be87280488ae2f306a73759bc`.
It binds the verified COS-relayed operator artifact, complete 36/36 TCR archive,
forty current/rollback protection references and the original operations/build locks.
Exactly fifteen remaining local image IDs were deleted; `implicitDeletedIds` is empty.
Root available bytes increased from 16,886,652,928 to 21,554,479,104. Immutable
registry copies remain recoverable. Business data, PVCs, source trees and Cargo
caches were not removed. This was a new re-observed plan, not a replay of the
partial v1 mutation. Buildah 1.33.11 refuses multi-name deletion by ID, so each
exact mutable alias was removed first, the remaining immutable identity checked,
and only then the exact local ID deleted, without force or broad prune.

Read-only `inv-e9ep100q67` completed SUCCESS/0 at 08:11:44 UTC. It reports the
same C Node UID, DiskPressure=False since 08:07:59, Ready=True, and all twelve
desired Workers API replicas Ready with the expected digest. Native nodeFs and
imageFs share 105,620,869,120 capacity and 20,180,090,880 available bytes, about
19.1%. The latest three API disruption conditions explicitly record kubelet
ephemeral-storage eviction; they establish this control-plane failure mechanism,
not the cause of the earlier 04:36 business 502. The complete projected local log
`/data/tmp/minisandbox-current-api-node-health-20261003.log` hashes to
`6461c1486ce9c684a45b92bb3fe8a2531afba32fb201bb933b194db51a5ae38b`.
Its earlier unbounded Pod-detail diagnostic was truncated and is not the complete
evidence. HPA current custom metrics are zero with ValidMetricFound at idle;
continuous correctness under offered load is still unqualified.

Native TKE RequestId `e2c33cbd-f074-4c6b-a1c9-fa1a8266f17d` subsequently reports
all three original C workers running. A new full Terraform plan succeeded and
was saved locally; its JSON projection has exactly five builder-only creates,
no existing-resource change/destroy and no drift. No apply or disk initialization
has occurred, and the original control/build root remains shared.

Both A/B c631 preflights passed in `inv-d9ep1i0ech` SUCCESS/0. A's formal
release/qualification was submitted once as detached `inv-a9ep2a0399`, retaining
the original release wrapper and shared operation-lock domain. It is pending,
not a release, Bottomless, HA, activation or strict10k pass. Resume this exact
invocation, do not submit it again. No workerd recompilation or second load was
performed by these recovery steps.

Read-only observation `inv-a9em5wgcj7`, 07:08:46 UTC, completed SUCCESS/0.
The original C control/builder node still reports DiskPressure and shares its
root with data/build paths, with 14,845,512 KiB available. Workers API is 12/12
Ready, Hub Prometheus is now Ready, and the HPA condition says ValidMetricFound.
Actual custom metric values were not queried; this does not establish a restored
control loop or fix the resource coupling. Both observed data disks are live
Kubernetes PVs and must not be initialized as builder storage. The complete local
observation log `/data/actor-build/local-admission-c631f554-20261003/control-storage-current-0710.log`
hashes to `3b126f9f914bfb9181a618d4ea49509b9e0da74b74f8aa7366f2dbec22f2e7b0`.

Management Terraform now declares a standalone private build-only CVM and
separate CBS, exposing the exact instance/disk/attachment identity. It does
not attach that instance to TKE, replace existing control workers or move the
release operation-lock domain. The management-only renderer and storage
contract each pass nine tests. Terraform 1.9.8 with the locked Tencent provider
1.83.11 validates the actual configuration with zero errors or warnings after
backend-disabled initialization. No cloud plan/apply, disk initialization,
mount, cache migration, runtime build or rollout was performed by this change.
Storage bootstrap and actual build handoff remain unimplemented; the existing
build admission must continue to fail closed until they are qualified.

## Release preflight and management resource coupling

The first read-only `runtime/verify-builder-storage.py` diagnostic hashes to
`3c2c7a652e4275dbb6662fab6e4f80371fb7a83737c371ab3de53a32893ee186`.
Fifteen component and real-filesystem CLI tests pass. The formal build wrapper
checks before push authority and rechecks under its workspace lock; the direct
image builder checks the actual writable output paths before pull/compile.
These tests prove refusal and budget arithmetic, not successful provisioning
of an isolated cloud disk or runtime performance improvement.

Read-only cloud negative gate `inv-c9ekcp03c6`, 06:41:50 UTC, completed
SUCCESS/0 because the checker correctly returned blocked/exit one. `/data`,
`/var/lib/actor-build` and the actual `/var/lib/containers/storage` GraphRoot
all remain on `/dev/vda1`, device 64769. Capacity is 105,620,869,120 bytes,
available 16,602,746,880 bytes, below the 21,474,836,480-byte system reserve
and the 79,456,894,976-byte build requirement. No build, formatting, mounting,
cache deletion, push token or runtime mutation was performed. Original local
log `/data/actor-build/local-admission-c631f554-20261003/builder-storage-negative-gate.log`
hashes to `ca6699a06b9edf18ee64fe8523f62c532ed12566e7a17465485b6aaccb623beb`.
The conservative 64 GiB increment is not a measured peak or a disk quota.

The final checker additionally reserves inodes and rejects excess CLI paths
before observing filesystems. Its source hashes to
`47d1aed61e11c97c5e4079e8d8b7abc3d10a3d688cec560a3642c0c634dc66ce`;
all seventeen focused tests pass. Cloud negative gate `inv-a9ekgn0vip` at
06:46:04 UTC confirms this exact source still blocks the shared system backing,
with 15,225,659,392 available bytes and 3,389,309 available inodes. The inode
budget is satisfied; the isolation and byte budgets are not. The complete local
log `builder-storage-negative-gate-final.log` in the same protected directory
hashes to `3bfdb89dbe2c126cfd309bfea018b29cce7dbfe1db786b253e0fd2758e2455a6`.
This read-only negative result is not a positive builder qualification.

Original supervisor progress `inv-a9eke8g65p`, 06:43:18 UTC, remains the same
live handle. A has reached four Ready Hosts and four Ready Machines. B has
25 Ready Hosts and 27 Ready Machines. Active Actors remain zero; final natural
floor convergence is still not established for both Cells.

The c631 release operator wrapper was verified and relayed as 12,103 bytes,
SHA-256 `1a44fbcfad285fc4b0058b3c5452078fd2b11f537e09a06e3a629d868d0dfaf7`.
It reuses the formal release, shared operation lock, qualification and activation
paths. Bash syntax and six existing release-hold tests passed. This operator
artifact is not a product rebuild or a deployment. Actual read-only preflight
`inv-d9ejqjg5u6` succeeded as a diagnostic but reported both Cell preflights
exit one. No release or second load was launched.

Readiness diagnostic `inv-e9ejtk0j3t`, 06:23:37 UTC, completed SUCCESS/0.
Its full 84,546-byte JSON was downloaded through verified COS relay
`inv-c9ejv0gw05` / `inv-e9ejv10m41`; SHA-256 is
`7f723c22039da4de588c729e4da7b4ceab75586454f0ce8931299394cf39d24d`.
Remote original:
`/data/actor-build/release/api-readiness-c631f554.HLwRFW/diagnostic.json`.
Local original:
`/data/actor-build/local-admission-c631f554-20261003/api-readiness-diagnostic.json`.
The earlier v1 TAT output was truncated and is not a complete artifact.

The C node `10.160.0.4`, UID `cdea12a3-7dab-47c9-bb43-7d45cd321f0b`,
is the builder CVM. It reports DiskPressure, not MemoryPressure. Eighteen
DisruptionTarget records identify this node; eviction events continue at
06:17:22 and 06:23:19 UTC. The API's own temporary usage was only 36--140 KiB.
Disk diagnostic `inv-d9ejv00vae` at 06:25:04 UTC confirms `/data` and
`/var/lib/{actor-build,containerd,containers}` all share `/dev/vda1`:
105,620,869,120-byte capacity, 15,240,155,136 bytes available, with no inode
exhaustion. Buildah occupied 14,825,512,960 bytes, containerd 4,703,731,712,
and logs 827,445,248. The actor-build du timed out after 45 seconds; its total
size is unknown. No files, caches, disks or live capacity were changed.

Read-only `inv-e9ek3igvri`, 06:32:05 UTC, proves both actual custom-metrics
requests fail with InternalError. The unique APIService points to the Hub
Adapter and both Adapter Pods are Ready, but Hub Prometheus is Pending.
Follow-up `inv-a9ek410d4r` at 06:32:34 UTC captured its actual scheduling
condition: one node has an untolerated disk-pressure taint and two have volume
node affinity conflicts. This follow-up's aggregate TAT output is truncated;
the initial complete Pod condition is usable, not the full events/inventory.
Historical HPA warning counts do not establish one continuous outage duration.
These management failures do not prove the cause of the original 04:36 502.

Original strict supervisor `inv-d9ek3i08h1`, 06:32:04 UTC, retains the same
MainPID and InvocationID. A/B Host desired/Ready counts are 15/52, Machines
24/55, and active counts zero. Natural floor convergence remains pending;
load failed and exact cleanup passed remain separate from the final verdict.

## Local million-key Router cache component gate

The production `objectrouter.Router` at parent source `40adcd4e` was exercised
with one million distinct SHA-256 Object keys, not one million cloud Actors.
Test source `internal/workersapi/objectrouter/million_churn_test.go` hashes to
`61d7e0935c16b859a999ca296f99edc1fd57e8e634a2baa048d5d5c44105a2f5`.
Its resolver retains no history and returns only a fixed-size ID. The clock is
frozen, so expiry cannot disguise retention or eviction bugs. Cache capacity is
32,768; miss capacity is 256. This sequential churn fixture validates miss-table
cleanup, not the throughput or admission of 256 simultaneous misses.

All three package tests passed natively and under the race detector, with no
skip or reduced count. `go vet` exited zero. The independent module used the
existing Go 1.25.4 binary with `GOWORK=off` and `GOMAXPROCS=4`; both caches and
temporary files stayed under `/data`. The initial system Go 1.24.4 attempt was
blocked by the enclosing workspace's toolchain requirement before tests ran.
Neither the workspace nor the module version was downgraded.

| GC live heap sample | Native bytes | Race bytes |
|---|---:|---:|
| Baseline | 1,861,320 | 1,874,424 |
| 131,072 distinct keys, cache full | 10,773,840 | 10,787,008 |
| 1,000,000 distinct keys, cache full | 10,774,144 | 10,787,552 |
| Exact Worker cache deletion, zero entries | 1,862,168 | 1,875,176 |

The million-key fixture took 2.27 seconds natively and 9.85 seconds under race.
These include key generation and test checks and are not a production QPS
curve. Both full-cache phases retained exactly 32,768 entries. Before the final
hit/eviction checks there were exactly one million backend misses, zero hits,
zero overloads, and no remaining miss flights. A previously evicted key resolved
again; a recent key refreshed once. Exact Worker deletion removed cache entries
and LRU nodes, but this operation did not delete any durable Worker or Actor.

Original native and race logs remain outside Git:

- `/data/tmp/minisandbox-router-million-churn-v2-20261003.log`, SHA-256
  `3b99e3d70f51239a4531d5f33c17f508488935f225b304a09acf09458fbc36eb`.
- `/data/tmp/minisandbox-router-million-churn-race-20261003.log`, SHA-256
  `dc250f40f727a4b2eca8e50b63b5600c54a746599147a77faa199a0ad1625f45`.

The fixture growth guard is `capacity * 1024 + 8 MiB`, not a product memory
quota. Live Go heap after forced GC is not process RSS. Real binding sizes,
HTTP bodies, other caches, native allocation, FDB metadata, and cloud ownership,
creation, sleep, and wake are outside this component proof. The strict10k
qualification remains failed and the million-dormant public-path gate remains
unproven.

## Explicit-admission run 55b55875

Run `55b558752ba2454987491cdea655ff68` used Runtime source
`59e865199b8d841e6c8ecb6469240c3be13d12ab`, image
`sha256:05840b4817f33d9047d350bf59fe99a809c8e538805c6af0b74388555f3f431e`,
tools source `12080fbe94ac5b39324a98c7a3ec60d82b87f6c1`, and the unchanged
Workers API image `sha256:d2e890c531e1979f74dbc83714b365ee11a43050fd45bcd5a1131c83ca95f9d5`.
The original load failed at 9,127 ready / 9,111 proven after 2,086,955 successful
active interactions. It never reached the post-warmup three-second sample.
The first error is initialize index 9086, HTTP 502 `indeterminate_result` at
`2026-10-03T04:36:35.187Z`. The 2,043 subsequent active `code=20` errors are
global cancellation, not independent transport faults. Exact cleanup passed:
all 9,159 scheduled test identities were deleted, with zero retries or pending
deletes. Natural drain remains owned by the original supervisor; no final
capacity verdict or floor-convergence success is claimed here.

The unchanged original supervisor was still running at 06:06:26 UTC, read-only
`inv-d9ejbh07va`, with the same MainPID and InvocationID. A/B Host desired counts
were 76/90, Ready 76/89, and Ready Machines 86/91. Both Cells reported zero
active Actors and no observer errors. These are ongoing natural-drain samples,
not final floor convergence or a new qualification attempt.
The next read-only sample, `inv-e9ejja0pwn` at 06:14:44 UTC, retained that same
supervisor identity. A/B Hosts were desired/Ready 56/87, Ready Machines 66/87,
active Actors zero, and observer errors empty. Final convergence remained pending.

The replacement Runtime was built separately from immutable source
`c631f5542f45b974455543d5bb458e0b3b3cf395`, source manifest
`a54e7daa59d1b1a48403d6766a866486630b2cb7d1187a1e0d2a4427eb82bd0c`.
Original build `inv-a9eij1gqpt` and temporary-auth cleanup `inv-a9ejfgge4q`
finished with SUCCESS/0. The product receipt reports passed container checks
and registry pull verification for
`actor-fleet-beijing.tencentcloudcr.com/actor-fleet/rivet-runtime@sha256:d3a6e41e3d1c4726998f8261d3b75648249df4a60d26a948820d28067a797711`.
The existing workerd stage was reused, and the Host's six focused tests passed.
This build is not an A/B release or evidence that the failed load now passes.

Original 673-byte product receipt:
`/data/actor-qualification/builds/product-rivet-runtime-c631f5542f45b974455543d5bb458e0b3b3cf395-8vj0eL.json`,
SHA-256 `d49da48b0ec04edd39bd53252910a20e2cbaa4c44930f92fd1a89bef44685cb1`.
Official relay `inv-d9ejgg0jmg` / `inv-d9ejgh03tg` verified identical bytes at
`/data/actor-build/local-admission-c631f554-20261003/product-runtime.receipt.json`
and removed only its temporary relay key. The original completed build log
`/data/actor-qualification/builds/runtime-c631f5542f45b974455543d5bb458e0b3b3cf395.OJTtUP.log`
hashes to `06ec7b3b4e48484747e6452b4f04fcc8cd07f1c76df096a4cb7fd75e7f6e6727`.

| Committed original/diagnostic | Raw SHA-256 |
|---|---|
| `55b55875-load-receipt-20261003.json` | `91e10cdd037e382187f2facd08753b9d13af224eaeee0beb598004bd3b7a7e05` |
| `55b55875-cleanup-receipt-20261003.json` | `5331e9b3506c08e0d633a3102461441ff0d3941784e028e77f3af19a168dfc74` |
| `55b55875-pressure-late-20261003.json` | `2628460d5fbd8906cb3f6b3dc31c3836786544c5a63d4749a14a30a8b3704359` |
| `55b55875-pressure-prefailure-20261003.json` | `c2af117532fabf7cf042164384887fe96d754f98686a48a301b467ae1f6d4df2` |

The 04:15--04:29 UTC diagnostic binds 59,971,839 trace bytes, SHA-256
`b080ebd57a0bdceb427090903f00b5f64cadea4917ea124504c8c12a072ad5dc`.
Its fixed-prefix publication was `inv-a9eggx0803`; official relay metadata/upload
`inv-a9eghu0595` / `inv-c9eghv03s2` completed successfully. Each Cell has 41
selected observations with complete capacity identity. Both compaction lanes
reach 12 in-flight; waiter peaks are 89/88. This is not a successful 10k receipt.

The failure archive contains only `load-receipt.json`, `events.ndjson.gz`, and
the complete-row fixed prefix `capacity.ndjson.gz`. Builder publication
`inv-c9egqm0ktj` succeeded:
`/data/actor-build/release/strict10k-failure-55b55875-20261003.HuUc12/evidence.tar.gz`.
The 8,099,833-byte archive hashes to
`cfd762515131a7e0a8dc5b9ed2ed24f14ae42db971b1135f287967fda86d1472`.
Official relay `inv-a9egr30m47` / `inv-e9egr3g42x` verified the same bytes;
its exact temporary COS key was removed. This is not permanent COS archival.
Local extraction is `/data/tmp/minisandbox-strict10k-55b55875-failure.V19y9o/`.
Its 72,264,143-byte trace hashes to
`c8f32a8b26881b2e8e080a274ae74260273c682bc2d9ee5673027a0446f83143`.
Reproduction uses the unmodified v2 analyzer:

```bash
python3 ../analyze_pressure.py --trace capacity.ndjson --output pressure.json \
  --from-observed-at 2026-10-03T04:25:00Z \
  --until-observed-at 2026-10-03T04:36:35.187Z
```

That window has 32 observations per Cell, latest query timestamps before the
first error. A/B pending peaks are 4,373/717. Stage execution mean rises to
856/466 ms and the completion rate falls to 11.87/22.75 per second. These
completed-work metrics are not offered demand, unique progress, or a full
causal explanation. The bounded queue is working but did not make this run pass.

Read-only transport/cost `inv-a9egtq0md4` succeeded. The raw 195,048-byte JSON is
outside Git at
`/data/actor-build/release/strict10k-cost-55b55875-20261003.an9T9Q/transport-cost.json`,
SHA-256 `a831e7c8439a8714977e72a7e33c5cbd296ab49d47e1685e0d9dca7ce1ee28f9`.
Official relay `inv-d9egu8g0xp` / `inv-d9egu9g22k` verified it locally at
`/data/tmp/minisandbox-strict10k-55b55875-transport-cost-v3-20261003.json`.
Twelve bounded range queries cover 04:25--04:36:30 UTC, 30-second steps,
without query errors; missing throttle series are unknown.
The earliest sanitized API transport record matches the journal timestamp:
`req_1ae818ff4410d89378c8dc7915bd8603`, connection/write 2 ms, 25,002 ms waiting
for response headers from `10.161.0.7:6420`. The 1,935 other matching warnings
classify as cancellation. Only the earliest 128 are retained, and one evicted
API Pod's logs were unavailable. Its eviction timing/cause is not established.
The same API Deployment UID had already grown to 13 Ready, with HPA max 30;
this observation does not use the initial three-replica state as a failure cause.
The two earlier temporary diagnostic attempts failed on diagnostic-only row
caps (12 Pods / 128 errors); those are not extra workload failures.

Read-only request-path `inv-e9eh5ugs4b` succeeded. Its 161,966-byte JSON remains
outside Git at
`/data/actor-build/release/strict10k-path-55b55875-20261003.LXBrcQ/request-path.json`,
SHA-256 `8681733c4e3934485147041390cb50f5704298c7995021e3b81111c5f2ee4bb1`.
Official relay `inv-d9eh96geat` / `inv-c9eh970f0f` verified local original bytes
at `/data/tmp/minisandbox-strict10k-55b55875-request-path-20261003.json`.
The first-error Actor ID is `5jtio0wprc5klcki8595arbwolal00`. Current bounded
Engine logs had no matches; that does not prove the request never executed.
Two combined-name phase queries returned HTTPError and remain in the original.

Corrected separate fixed-phase queries `inv-e9ehaqg4md` succeeded with no query
errors. The 411,749-byte artifact is
`/data/actor-build/release/strict10k-phases-55b55875-20261003.jsIK5D/route-phases.json`,
SHA-256 `8a65d1812adfbfde355fe4a0d2cca04331a94ad3c8e479e7d50cadfc4c580ddb`.
Official relay `inv-d9ehbf0rqc` / `inv-a9ehbfgu7m` verified it at
`/data/tmp/minisandbox-strict10k-55b55875-route-phases-20261003.json`.
The query window is 04:25--04:36:30 UTC at 30-second steps. A's ready-wait
histogram p99 rises from 0.97 to 24.22 seconds; B ends at 2.35 seconds.
Subscribe p99 remains below five milliseconds in both Cells. A's Depot commit,
gateway lookup, metrics recording, and Gasoline transactions all slow together.
At the final rolling sample, A/B Depot commits are 427.7/451.1 per second,
gateway accounting transactions 865.4/904.6 per second, and gateway lookups
898.5/908.9 per second. These are completed transaction rates, not causal
per-HTTP amplification ratios or offered load.
The observed Engine services are ClusterIP, not the API's `10.161.0.7` peer;
the intermediate internal route still needs identity confirmation.

Cleanup's original receipt was independently verified via official relay
`inv-d9eh98gjkc` / `inv-a9eh99056w`; it is bound to the same failed load receipt
and exact owned manifest. No resources outside that test cohort were deleted.
At 04:55:42 UTC, `inv-a9eh970n7b` confirms the original supervisor identity and
natural reduction to 246 Hosts per Cell, but not final floor convergence.

Read-only FDB cost/topology v2 `inv-a9eht400a3` completed successfully. Original
307,079-byte JSON is retained at
`/data/actor-build/release/strict10k-fdb-55b55875-20261003.1qNi9u/fdb-diagnostic.json`,
SHA-256 `b9476d6015d5dce7e9eb09337546a38755c96d4e8b7badcf1ee287021d160dd2`.
Official relay metadata/upload `inv-c9ehvtgg4b` / `inv-e9ehvug1ju` verified
identical local bytes at
`/data/tmp/minisandbox-strict10k-55b55875-fdb-diagnostic-20261003.json`.
The first diagnostic attempt `inv-c9ehrugfrk` failed at Python parsing before
Kubernetes or Prometheus reads. It was not a workload attempt or business error.

The window remains 04:25--04:36:30 UTC, step 30 seconds. Each Cell currently has
nine storage Pods on nine `SA9.LARGE16` Nodes, with nine 200 GiB PVCs. Historical
`kube_pod_info` has exactly the same eighteen Pod UIDs. Each FDB container has
2 CPU / 8 GiB requests and limits, and zero observed restarts.

| Sampled quantity | A | B |
|---|---:|---:|
| Peak simultaneous total FDB CPU, cores | 6.756 | 6.585 |
| Peak single FDB container CPU, cores | 0.887 | 0.856 |
| Peak single FDB container RSS, GiB | 4.126 | 5.445 |
| Peak full-refresh completed attempts/transaction | 1.950 | 1.523 |
| Released/limit transaction-rate range | 0.085--0.191 | 0.117--0.177 |

Foreground Depot commit, gateway lookup/accounting, and signal-pull attempts
remain approximately one. This does not establish absence of FDB latency,
single-thread or range hotspots. Node CPU/I/O/disk and CFS throttling queries
returned empty series, not zero values. The source disables nodeExporter;
there is no historical disk telemetry in this artifact. Current CR health is
not substituted for fault-time latency. Existing disk headroom and ratekeeper
gauges cannot establish a sustainable low-tail service curve.

The new source correction overlaps at most sixteen adjacent native point reads
per transaction. It does not reduce FDB key reads, mutate the online Runtime,
or turn this failed run into a successful 10k result. FIFO mutation, range,
commit, retry, and state-change barriers remain explicit. Only the original
supervisor owns natural drain. At 05:23:48 UTC, `inv-e9ei3i03tb` confirms the
same supervisor identity, 178 Ready Hosts per Cell, and 188/185 Ready Machines;
final floor convergence and the capacity receipt are still pending.

## Historical input-prefix run d3a16351

Run `d3a163511fd849bf9a466553e4ab4f48` used runtime source
`072e504bb9784e7d2d0b73def169e886a7f30e31`, immutable runtime image
`sha256:6e4d982e8ca66b8a7841c720143464927cb0f7c09d656f3c1fab1e189b07f3d2`,
and observer/load tools source `d7ff0a90245e1787377146be3fb2e6f7a2051d1f`.
The supervised service completed with exit 1. Submission success was not a
qualification result. These JSON files preserve the original bytes and verdicts.

| Original receipt | Raw SHA-256 |
|---|---|
| `d3a16351-capacity-receipt-20261003.json` | `71d6af2f143a6f7d057c4b6adfe4d362782a903bacd266cc4d0910e7f43297d4` |
| `d3a16351-load-receipt-20261003.json` | `7446442c3bbb7d720aa0207c6295b0a0e96de6bab1911108987eea375d95cec2` |
| `d3a16351-cleanup-receipt-20261003.json` | `789680d82a2d7365a6f53ba00150ad866db1ed0eb473c96746da19d50baf2b6b` |

## Result and boundaries

The load reached 9,194 ready Objects and 2,117,371 successful active
interactions. The first unexpected error was initialization of index 9153 at
`2026-10-02T20:27:13.993Z`, HTTP 502 `indeterminate_result`. Global cancellation
then generated 2,643 active `code=20` errors. Those are not 2,643 independent
network failures, but they still invalidate the load. No identity mismatch or
ordinary request retry was recorded. Warmup did use 7,718 classified capacity
backpressure retries. The steady three-second creation sample never started.

The capacity verifier recorded automatic expansion, stable resource identities,
valid trace, exact cleanup, safe drain, and return to the genuine floor.
It rejected sustained 10,000 active Objects, peak active capacity readiness,
and the load verdict. Peak measured active was 9,162; peak desired Hosts was
528 across both Cells. Samples and load counters are not atomic observations.
Cleanup deleted all 9,226 scheduled identities with no retry. Natural final
capacity convergence took 7,308 seconds after cleanup, returning both Cells to
four admitted/Ready Nodes, Machines, and Hosts. None of these partial successes
allows Router performance qualification.

## Retained raw evidence

Original builder root:
`/data/actor-bootstrap/beijing-rebuild-20260915/load-tests/ten-thousand-active-d3a163511fd849bf9a466553e4ab4f48/`.

The complete 189,670,807-byte `capacity.ndjson` hashes to
`5869f78fded0af51d1f278700f69676637dec017175f1d3428529c2833135cd0`;
the 4,371,604-byte load journal hashes to
`9664977d06f3202b26511e27bd515cc9cbd73588bf423cc9af9ed242d4940e3d`.
They remain outside Git. Builder archive
`/data/actor-build/release/strict10k-d3a163511fd849bf9a466553e4ab4f48/evidence.tar.gz`
contains compressed raw inputs, receipts, state log, and a derived pressure
summary. Its SHA-256 is
`6d3ac610927dd0a66e9f039ab83b6c7d2fcc863855421c64ffbd9c9a5993bf19`.
It was transferred through COS and verified locally; the temporary relay key
was removed by the transfer helper. This transfer is not a permanent COS archive.

Historical Prometheus `query_range` evidence covers 20:07 through 20:28 UTC,
at a 30-second step. Raw `extended-metrics.json` hashes to
`ca9f3dbd7fda077788cc9e47ea1922dcf485e7416c2e4bc77f397c51e29ec0c6`.
The bounded API transport diagnostic hashes to
`39315d9d18f03f4d96d5bb7d39298c9b0f71e54bef44df8df526fc56cc911724`.
Builder `extended-evidence.tar.gz`, in the same archive directory, hashes to
`e04b9a117692e18cb625c7cd48f4f95caf9584bc396fd373b0637d7ca678fd3d`.
Both archives were downloaded to
`/data/tmp/minisandbox-strict10k-d3a16351-evidence-20261003/`.

Only 570 post-cancellation warnings survived the bounded current-Pod API log
selection. They all classify as `context canceled`; they do not establish the
original transport cause. Missing throttle series are missing evidence, not
proof of no CPU throttling. Samples after the first error are excluded from
pre-failure causal comparisons.

## Diagnostic implications, not a complete root cause

The last pre-failure sample at 20:27:02 UTC has A/B active 4,519/4,643,
compaction in-flight 12/12 and waiters 1,360/1,102. B UDB pending is 3,989.
FDB remains healthy/full-replicated and Hosts show zero restarts. Before the
first error, aggregate Engine CPU peaks near 10.6/10.8 cores per Cell; the
six-Engine envelope is not exhausted in aggregate. B UDB operation p99 reaches
about 0.988 seconds, workflow-history mean about 1.007 seconds, and Actor-create
operation p99 about 4.913 seconds. These histogram estimates are not exact
request durations or a single-replica saturation proof.

The sampled final 27-minute window reports zero successful reclaim rate while
authority bytes increase by about 1.35/1.41 GB in A/B. Live pins and retention
can legitimately defer reclaim; zero reclaim alone does not prove a defective
cold planner. Separate hot folding, cold publication, reclaim eligibility,
history replay bytes, transaction retries, and per-Pod CPU before selecting a
remedy. Reducing background permits bounded execution but did not make this
10k run pass. Neither blind replica growth nor looser retries/timeouts is a
validated correction.

## Work-amplification follow-up

Read-only invocation `inv-c9e9u20q2x` succeeded with exit zero. Its historical
queries stop at 20:27:00 UTC, before the first error, with 30-second steps and
bounded responses. Raw builder file `work-amplification.json`, alongside the
archives above, is 718,367 bytes and hashes to
`e73676dd1ad9ddd37278a243a8f9d3ebbab63eafac3549b6fb01a818a2b879ce`.
The same bytes were verified locally through COS relay. The transfer removed
only its temporary relay object and did not delete the builder evidence.

At the final five-minute window, A/B manager reads are approximately
23.16/24.19 MB/s and hot-stage reads are 9.22/7.00 MB/s. Manager transaction
attempts average 1.460/1.453. Per-Pod one-minute CPU peaks are at most
2.09/2.34 cores. These are sampled logical client metrics, not provider billing
or physical FDB I/O, and no business-byte amplification ratio is established.

Hot-stage activity duration averages 27.77/28.26 seconds; install averages
26.40/26.33 seconds. The old histogram collapses success, failure, and timeout
into the same empty error label. Its roughly 39.13/35.80 stage completions/s
are therefore attempt completions, not successful materializations.

Source inspection and a real RocksDB-backed ActivityCtx test prove that
admission wait consumes the activity timeout and can record a durable timeout
without executing any data job. This supports investigating queue/replay
feedback, but does not retrospectively prove how many of these historical
attempts timed out or caused the primary HTTP 502. The added bounded-result
attempt metric is a source change, not a deployed runtime or repaired capacity
qualification. Router performance remains blocked by the failed strict run.
