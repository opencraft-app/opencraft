# Capacity failures and pressure evidence, 2026-10-03--04

## Runtime 2757：低容量自动扩容仍在预热，非资格通过

当前唯一 run `7d5fa6acee6a4a0fa60ea59d4b9ffe91` 的
[20:21:13 UTC 快照](2757-run-7d5fa6ac-progress-202113-20261004.json)绑定原
systemd InvocationID/PID、runtime2757、tools120及Native request/response SHA。
2,274 ready/2,270 proven、127,081成功交互，普通重试/失败/身份漂移均零。
自动Host目标A/B65/68，Ready52/60、Machine Ready59/62；容量采样与SDK累计ready
时间不同。warm backpressure累计6,732次/543 Object、最长约243秒，尚无timeout；
post-warmup三秒创建样本零。不能由这些数据提前放行完整万级/Router资格。

只读snapshot `inv-d9fccv04e3`产生7,174,665字节完整append-only prefix，SHA
`a743a7be1291a558cb02b2d096b24d76d93ebadf1eeea999079728c46f1867c5`。
原COS relay metadata/upload `inv-c9fcd5g0qu`/`inv-e9fcd6gn98`均SUCCESS/0，
本地 `/data/tmp/minisandbox-strict10k-7d5fa6ac-pressure-prefix-20261004.ndjson`
逐字节验长度/SHA。全69行两Cell完整且观察errors/warnings为空。
Native摘要pressure最后一行在8,192字节处被截断，虽Dropped=0也不能证明完整，
该不完整行被舍弃，不补零、不重发producer。

[20:02:00--20:20:55 UTC schema-v4分析](2757-run-7d5fa6ac-pressure-early-v4-20261004.json)
SHA为`18c86ed7d5c36d0af9568512b9d764605f3b5bf1f315597f9aaf41321145fcee`，
每Cell67样本、原容量身份完整。末尾五分钟query窗口均含于已证明仍在warmup的范围；
首版20:20:40截止正确屏蔽晚于边界361ms的B rates，其本地结果保留而不覆盖。

| 早期压力口径 | A | B |
| --- | --- | --- |
| UDB pending采样峰值 | 96 | 126 |
| compaction waiter采样峰值 | 0 | 0 |
| hot-stage成功exit均值 | 145 ms | 228 ms |
| hot-install成功exit均值 | 174 ms | 198 ms |
| stage每完成txn读取量 | 96.9 KB | 114.2 KB |
| stage txn attempts/completion | 1.0 | 1.0 |
| authority逻辑账本正斜率 | 60.9--63.6 KB/s | 64.8--68.5 KB/s |
| 末尾成功FDB reclaim速率 | 0 | 0 |

这里KB为十进制千字节。短暂任务可能在采样间隙排队；成功exit不等于每次exact
publication，缺失结果维度仍unknown。低负载零waiter不能证明10k服务曲线或长期
冷热平衡，账本与planned-byte计数不能相减为COS成本或eligible debt。保持原
持续heartbeat、零普通retry、三秒post-warmup、精确cleanup和自然drain门禁。

## Independent bucket-read correctness regression

`engine/packages/depot/tests/fork_bucket_read.rs` runs against real temporary
RocksDB/UniversalDB state, independently of the cloud load. The first four
counterexamples failed before the read-cap/lazy-write correction. Expansion
then found an unwritten database-fork virtual head (6/7 passed), and an exact
database-fork VTX gap incorrectly falling back to an earlier commit (0/1).
Those red logs are retained under `/data/tmp/minisandbox-bucket-read-*20261003.log`;
the exact-gap log is `minisandbox-bucket-read-exact-cap-red-20261003.log`.
The corrected suite passed 10/10, together with library 61/61, proof
invalidation 6/6, bucket fork 4/4 and database fork 7/7, in
`/data/tmp/minisandbox-bucket-read-final-v2-20261003.log`.

The existing `cold_workflow_publish` hot-prefix regressions passed 12/12,
and its 513-root bucket-proof pagination regression passed 1/1 in
`/data/tmp/minisandbox-bucket-read-hot-prefix-20261003.log`. The production
library check without test fault hooks and scoped Clippy both exited zero;
Clippy retains 47 existing library warnings, with no new warnings from the
changed branch-resolution/read-plan helpers. This is not a repository-wide
warning-free result.

This proves the tested snapshot/read/first-write boundaries, not cloud
performance, all parent-pointer mutation semantics, or the first 502 cause.
It changes no persistent schema and does not relax generation, retention,
history, publication or backup fences. The running c631 has not been changed.
Ordinary non-inherited reads avoid the new VTX/COMMIT snapshot lookups.

## Current c631 run: rising population is not a controlled service curve

Run `200a42ae03ef4e128505b0def22e8af8` subsequently failed at 10:49:47 UTC;
its supervisor is waiting for natural drain. The observations below precede
that failure, not a qualification result.
Read-only `inv-c9esir0vn4` completed SUCCESS/0 at 10:13 UTC with the original
MainPID 1728155 and systemd InvocationID `8a1ff14bc64e49c889255161316c32e8`.
At load elapsed 2,370 seconds it reports 4,703 ready / 4,698 proven Objects,
550,495 successful interactions, zero ordinary retries, failures and identity
mismatches. Warmup backpressure retries remain 4,673; there are still zero
post-warmup three-second SLO samples. Runtime active A/B is 2,299/2,363, not
the same measurement as cumulative SDK-ready. Hosts desired/Ready are 136/123
and 135/126, with Machines Ready 130/135; no manual scaling was performed.

Immutable trace-prefix capture `inv-a9esj90bq8` completed SUCCESS/0 at
10:13:38 UTC. It read a fixed 24,001,977-byte append-only prefix and omitted
its last row, retaining 23,689,705 bytes. Remote snapshot:
`/data/actor-build/release/strict10k-pressure-200a42ae-20261003.m3SJ1w/capacity.ndjson`.
Local verified copy:
`/data/tmp/minisandbox-strict10k-200a42ae-pressure-prefix-101338-20261003.ndjson`.
SHA-256: `ae7f122bf73ca8c388a0db48ad85c4894c85f0bf3592d0bdc4b41da933536e25`.
Official COS relay metadata/upload `inv-c9esjigixx` / `inv-d9esjjgt3t` both
completed SUCCESS/0, with source/local length and hash verified. The temporary
relay key was deleted; the remote and local evidence files remain. This is not
a permanent COS backup or a live-workload mutation.

Two reproducible, non-qualification schema-v3 analyses bind that entire input:

| Diagnostic | SHA-256 |
| --- | --- |
| [09:40--09:55 UTC](200a42ae-pressure-early-v3-20261003.json) | `0542a59507945eb8a9b8fe095dcdf82c7fbe04fe25e43744c0d01a5d1d9b6aab` |
| [09:55--10:12 UTC](200a42ae-pressure-middle-v3-20261003.json) | `2b08d907df4cb8f45c95cf9270cd022f5c6c503e27dcdb11a27ff7fd3f048dee` |

Their last query windows are fully inside the selected intervals. Actual
observation counts are 53 and 56 per Cell. Stage completed-execution means at
the window ends are A/B 166/197 ms and 117/155 ms; stage prepare read bytes per
completed transaction are about 141/136 KB and 105/108 KB. Compaction waiter
peaks are 0/0 and 2/14. These observations do not show rising stage unit cost
at this population, but do not establish sustainable throughput at 10k.

Whole-Cell authoritative-byte net-growth bounds rise from about A/B
104--111 / 107--117 KB/s to 327--352 / 345--364 KB/s. Successful FDB reclaim
rate remains explicitly zero at both ends. In the second window cold-publish
planned-byte rates are only about 21.8/21.9 KB/s; they measure a different
logical population from the authoritative-byte ledger. Do not subtract them
to calculate eligible debt, provider throughput or lost data. The original
trace baseline already contains 4,939,956,034 / 5,629,379,954 authoritative
bytes, so total Cell stock is not current-run business data.

Warmup increases both population and database age. A retained prefix becoming
eligible for maintenance changes the work mix even with constant per-job cost.
The next causal comparison must separate steady request rate, database age,
eligible prefix bytes, coverage count, base size and invalidated/replayed work.
Neither gross maintenance completions per Object nor rising total hot bytes
alone proves superlinear per-Object cost or a reclaim defect. Preserve history,
PITR, pin, backup and lifecycle fences; inspect due/lease/attempt and progress
while a slow exact job is still present, before cleanup removes the evidence.

Schema v3 makes the window boundary explicit: a rolling rate whose actual
query interval crosses the selected start/end is unknown, while gauges and
ledger bounds are still usable. Null scope means no workload window was
specified, not steady load. No old v2 receipt is rewritten, and the running
tools120/workload, heartbeat cadence and qualification predicate are unchanged.

## Current run: first failure and bounded pre-error window

Read-only `inv-c9etu9ga0j` completed SUCCESS/0 at 10:57:23 UTC against the
original MainPID and InvocationID. Its [projected native output](200a42ae-first-error-20261003.txt)
is 2,518 bytes, SHA-256
`b48603e2b634650a1a59f6f5654c5096d3d8b7ffaefeb2149bc5c4b394d4e2ac`.
It is a diagnostic projection, not the raw receipt. The original load receipt
SHA-256 is `affced2c82eabaa761f73ee7dc45e23047970740499e4abf20cae8026c45767b`.
The first journal error is index 9035, initialize, `502 indeterminate_result`,
at 10:49:47.171 UTC. Terminal load verdict is failed, with 9,086 ready /
9,074 proven, 2,070,235 successful interactions, one initialize error and
2,294 active `network:20` errors after global cancellation. Those cancellation
errors are not 2,294 independent server failures. Ordinary retries and identity
mismatches are zero; post-warmup three-second samples remain zero. Exact cleanup
has exit zero; final natural-drain qualification is still pending.

The old 64 MiB full-prefix capture `inv-d9etkq068h` failed without an artifact.
A bounded, fixed-EOF tail capture `inv-d9etnrgcxh` succeeded at 10:51:32 UTC:
source dev:inode `64769:1313642`, byte interval `[56460531,73237747)`, first
fragment and final row omitted, 15,782,786 bytes retained. Remote immutable file:
`/data/actor-build/release/strict10k-pressure-tail-200a42ae-20261003.qbR4sW/capacity.ndjson`.
Local verified copy:
`/data/tmp/minisandbox-strict10k-200a42ae-pressure-tail-105132-20261003.ndjson`.
SHA-256 `c46c9437d2c118bbbfe60dfadc5750f40e2620bcfe31762ffa77240a9121eccf`.
Official COS relay `inv-d9etqdgtxh` / `inv-d9etqe07hh` completed SUCCESS/0;
length/hash were verified and the temporary relay object deleted.

[Pre-error schema-v3 analysis](200a42ae-pressure-preerror-v3-20261003.json),
20,297 bytes, SHA-256
`25021376ae4e63e54607405335a0fb441b3278076f0aeec84f7ce56dc598180f`,
selects 10:40:46--10:49:00 UTC, with actual rows 10:40:46.515--10:48:51.220
UTC and 24 samples per Cell. Its last rolling windows are fully pre-error;
windows crossing the selected boundary remain unknown, not zero. It does not
include the original run baseline and is not qualification evidence.

At the last sample A/B stage completed-execution means are 0.482/2.031 seconds,
stage admission means 2.143/9.256 seconds, prepare bytes per completed stage
transaction 168,584/270,300 and completion rates 20.09/5.14 per second.
UDB pending peaks are 1,063/4,156, compaction waiter peaks 90/96. Whole-Cell
authoritative-byte net growth bounds are about 901--1,034 / 927--1,027 KB/s;
successful reclaim is zero at the end. This shows late maintenance degradation,
not the exact cause of index 9035 or a per-Object superlinear service curve.
Completed stage work may still be rejected at install; its success count is not
installed/reclaimed progress. Population, age, eligible prefix and rework must
be separated before changing concurrency or sizing FDB.

## Current run: first-failure transport and Cell binding

Two immutable, projected native observations explicitly set
`qualificationEvidence=false`. No raw payload, authorization header, config or
unredacted error is archived:

| Observation | Bytes | SHA-256 |
| --- | --- | --- |
| [API transport](200a42ae-api-first-error-20261003.json) | 52,765 | `2f3daf872443d0a71b024d424e32dfee1a2f863f5d03fdfcda334cb0361dad85` |
| [Engine address and bounded logs](200a42ae-engine-first-error-20261003.json) | 4,548 | `bd5dfdeb8370f069c4fbbd1abc1aed2fd17c79c5cb9d0afcb169df82b7e6a3a3` |

API collector `inv-d9eufq0xh5` completed SUCCESS/0 at 11:18:08--11:18:10 UTC.
The exact Deployment UID/image matched the original release; desired/Ready was
12. Its selector included 55 Pods, including retained Succeeded Pods, **not 55
active replicas**. The first collector `inv-a9eudj0jie` failed its metadata
count bound before logs/artifact creation; metadata `inv-c9euefgf8n` established
the reason. The corrected diagnostic bound is 128 metadata Pods, with 39
terminated-before-window Pods excluded and 16 bounded log reads. It matched
2,125 rows in 10:49:35--10:49:49 UTC, retaining only the first 32 rows; this is
neither a complete request history nor an additional load/rollout.

The earliest row is 10:49:47.163 UTC, response-header timeout, Actor
`dl048ozwnqe1135wwtkz1qc5lgcl00`, request
`req_905d883bddc2602882a690218fb4c0ba`, engine `10.162.0.2:6420`.
The API Pod UID was checked before/after the read. Connection took 2 ms, local
write completed at 3 ms, elapsed was 25,003 ms without first response byte;
the connection was not reused. Later rows are chiefly context cancellation.
The original client first error is 8 ms later but has no request ID, so this is
the unique earliest timeout **candidate**, not an exact client-to-server join.
Local write completion does not prove dispatch into user code or durable commit.

Remote original:
`/data/actor-build/release/strict10k-api-error-200a42ae-20261003.aqcl1m1z/observation.json`.
Official COS relay metadata/upload `inv-c9eugqg09m` / `inv-a9eugr0pvm`
completed SUCCESS/0, length/hash verified and exact temporary key deleted.

Engine collector `inv-c9eupdgeaa` completed SUCCESS/0 at 11:26:19--11:26:21 UTC.
It bound B Cell UID `87a07636-737c-4a57-8693-9d02f61883f8`, the existing
Engine Deployment UID/image, Service `actor-bj-b01-engine-private` UID
`11ee72e5-8f4e-42a5-b57c-46cc44a8b1e4`, address `10.162.0.2` and port 6420
to target `api`. This is a current post-error address binding, **not historical
route or exact backend proof**. Six existing Engine Pods had zero restarts;
all native bounded log reads succeeded but yielded zero matching Actor/request
rows in 10:49:15--10:49:49 UTC. Four 2 MiB byte caps were reached. Logs from
deleted Pods/previous containers were not collected. Therefore the blocking
phase remains unknown: a missing match is not evidence of no execution or a
successful commit. Do not silently increase/scan unrestricted log history.

Remote original:
`/data/actor-build/release/strict10k-engine-error-200a42ae-20261003.ek8ezcb2/observation.json`.
Official relay `inv-a9euprghrm` / `inv-d9eups08ec` completed SUCCESS/0,
length/hash verified and temporary key deleted. Both archived files match the
verified originals byte-for-byte. The original supervisor remained running at
11:25:27 UTC (`inv-d9eunjg5tw` SUCCESS/0), cleanup exit zero and natural drain
waiting 1,503 seconds; the load itself remains failed.

Source confirms DO databases use `conn.namespace_id` as the shared bucket and
Actor ID as the database ID in `pegboard-envoy::actor_db()`. The exact live
branch below also binds that namespace/bucket. Consequently the old tree-wide
catalog invalidation couples proofs within a namespace; independent-root
`N/256` is only a hypothetical collision model, not this observed DO mapping.
The master source fix narrows ordinary catalog invalidation, but is not deployed
in c631. Neither this deterministic source defect nor late pending/stage
degradation alone proves the earliest timeout's causal chain.

## Current run: exact live-branch install rejection

Two byte-identical, read-only observations preserve a live B Object before
cleanup can remove its workflow. Both explicitly set `qualificationEvidence=false`:

| Observation | Bytes | SHA-256 |
| --- | --- | --- |
| [Branch, 10:29:23--10:29:27 UTC](200a42ae-exact-branch-20261003.json) | 5,985 | `b7ea65cd5dd499e8394831d566d9056dbabec928f8695f097f3e831aa7f9cd5d` |
| [Manager active history, 10:31:41--10:31:42 UTC](200a42ae-exact-loop-20261003.json) | 12,328 | `95a6feab593816f638e2501d620ec56e6825a9ee5e3017a99e97e5859ae24e16` |

Collector invocations `inv-d9et210ru6` / `inv-d9et46gi5r` completed SUCCESS/0.
Remote immutable files remain at
`/data/actor-build/release/strict10k-exact-branch-200a42ae-20261003.ji2m4atg/observation.json`
and
`/data/actor-build/release/strict10k-exact-loop-200a42ae-20261003.1o7zta2n/observation.json`.
Official COS metadata/upload pairs `inv-d9et2igvk5` / `inv-e9et2jg6nq` and
`inv-a9et5605jg` / `inv-a9et56gn5r` completed SUCCESS/0; length/hash were verified
and temporary relay keys deleted. Collection success means identity and transport
checks passed, not that every queried key existed or the workload qualified.

The selected Object is index 0 of Worker
`scale-200a42ae03ef4e128505b0def22e8af8-s000`, Actor
`9u4isd43dgw6j26tsc0wprue6pal00`, branch
`813ded40-c89d-4e9b-81a0-625ab4c240d0`. The evidence binds the original B
Cell/FDB UID and exact Engine Pod UID/image. Queries use the normal private
Registry/Peer APIs and bounded exact UDB prefixes, never business fetch,
checkpoint, wake, reclaim, workflow-catalog scan or fault injection. Each
capture is a sequence of reads, not a single transaction across all keys.

The first snapshot has head 335, hot/cold watermarks 294/279, generation 21,
15 logical pages and 750,037 write-debt bytes, below the 12,582,912-byte limit.
Its manager error is `activity install_hot_job admission deferred`, a controlled
admission delay, not an execution failure. Generic workflow `data/.../state/0`
is absent: LUPE state lives in loop history, so this does not prove the manager
lost its state. Likewise, an absent global lease with a future wake deadline
does not prove a dead workflow. Native UDB CLI can print `key does not exist`
with exit zero; the text must be interpreted, not just the process exit code.

The second snapshot reads at most 48 active-history entries. It contains a
successful hot-stage completion with three staged rows, followed by
`install_hot_job` returning `Rejected: bucket fork proof is ambiguous`.
The subsequent `refresh_manager` creates another Hot job with the identical
input fingerprint, selected range 295--347 and coverage 308/338/347. This
proves one observed stage-to-install rejection/replan, not a rejection rate or
the full request-latency root cause. The limited history is not a complete
workflow/loop-state dump. Refresh reports `reclaim:no-actionable-work` and a
future reclaim deadline; that must not be relabelled as a reclaim defect.

Source inspection explains a possible feedback path: catalog create/tombstone
already invalidates the changed database's proof, but also bumps its bucket-root
epoch and the shared 256-way epoch shard. Other databases on that root/shard
then reset bounded proofs. Hot planning does not gate on the unresolved proof,
while hot install does. Continuous catalog churn can therefore waste staging
work and shared admission capacity. This is a concrete code path and exact
branch counterexample, not measured fleet-wide attribution. Preserve all
fork/history/PITR/manifest/lifecycle fences. A scope correction needs real UDB
tests for unrelated database churn, relevant membership changes, new bucket
forks and concurrent paginated proof progress before release.

Read-only `inv-d9et8r0gak`, 10:36 UTC, still observes the original running service:
7,523 ready / 7,509 proven, 1,410,802 successful active interactions, zero
ordinary retries, failures or identity mismatches, no final receipt and zero
post-warmup SLO samples. At query time the two Cells have 12 compaction
executions each and 71/77 waiters. This is shared-lane pressure, not exact
offered load or a proof of which operation should receive more capacity.

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

### A rollout completed; new qualification still in flight

The original `inv-a9ep2a0399` has progressed, without resubmission. Read-only
`inv-c9ep9c0npq` SUCCESS/0 at 08:20:40 UTC observed the completed native
operations cycle and a live Bottomless harness. The original receipts were
copied only to the approved relay evidence root in `inv-c9epaigfn2`, then
downloaded through the existing COS relay helper with source/copy/local byte
and SHA checks. Native relay metadata/upload invocations
`inv-c9epatg7pw`, `inv-d9epau028s`, `inv-a9epau0puv` and `inv-a9epav0q7i`
all completed SUCCESS/0.

The byte-identical receipts are now archived in runtime evidence:

- [A release ledger](../../../runtime/evidence/beijing-point-read-c631f554-a01-release-20261003.json):
  5,330 bytes, SHA-256 `462be8f387ce6643d9445be478ed0cd6f66e927b5d715b15507a2754dd84dcbc`.
- [A operations cycle](../../../runtime/evidence/beijing-point-read-c631f554-a01-cycle-20261003.json):
  1,497 bytes, SHA-256 `0ae9e25860776388dcbcc9298c339b7e800db528b3ebb6f343dccb75e74dc868`.

The production ledger validator recomputed the release identity and accepted
the exact A namespace, c631 source/manifest and `d3a6e41e` Engine/Host/init
image references. The cycle preserves preControl=allow/0, action exit="0"
and postControl=block/"1". It is rollout evidence, not a fabricated successful
operations-cycle or qualification receipt.

Read-only `inv-c9epcvga64`, 08:24:27 UTC, proves the original A Engine UID is
6/6 Ready and the original Host StatefulSet UID is 4/4 Ready at the new digest
and converged revision. In `inv-c9epdmgv72`, 08:25:16 UTC, the native inflight
stage is `waiting_for_exact_cold_state`: 48 Actor records, 48 initial/final
checkpoints and post-sleep reclaim requests; 20/48 exact cold, 28 pending,
elapsed 275,868.841 ms, zero cold-state read errors and no cleanup errors.
This is progress evidence, not final data integrity, cold-wake, HA or activation.

The later read-only `inv-c9epk8gk9c` completed SUCCESS/0 at 08:32:17 UTC:
36/48 exact cold, twelve pending, elapsed 704,189.414 ms, zero read errors and
no cleanup errors. The same gate remains in `waiting_for_exact_cold_state`.
Do not derive exact reclaimed-byte throughput from these changing shard counts
or equate qualification progress with the unchanged strict10k passing.

The intermediate post-action audit's one static finding was not ignored.
`inv-e9epebgcb5` SUCCESS/0 binds the reason to the previous release directory:
`external_release_receipt_missing_or_mismatched`, while the live ledger payload
hash already matches. The following audit against the new release directory
reports static ready=true, driftCount=0, payload/external hashes matched,
FDB available/fully replicated and backup restorable; its only failures are
missing new Bottomless/HA receipts. Keep these transitions distinct. Qualification
may proceed only through its existing recovery authorization, not a generic
block bypass. B, unchanged strict10k and the full Phase 5 matrices remain pending.

### A qualification completed; B started with the same immutable product

Native TAT RequestId `57667815-2657-418f-aaf2-9491118ccc5b` proves original
`inv-a9ep2a0399` ended SUCCESS/0 at 08:36:16 UTC. No resubmission occurred.
`inv-e9eprjgpda` and `inv-c9epsg0h0v` copied only the five exact completed
receipts into the approved COS-relay root; the existing relay verified every
remote/copy/local byte count and SHA. The archived files remain byte-identical:

| Native receipt | Bytes | SHA-256 |
|---|---:|---|
| [Bottomless](../../../runtime/evidence/beijing-point-read-c631f554-a01-bottomless-20261003.json) | 263,220 | `922a7cba934ae50db81907b02395e508d25c89cf538aada41c73fa9882fa83d3` |
| [Engine HA](../../../runtime/evidence/beijing-point-read-c631f554-a01-engine-ha-20261003.json) | 12,977 | `bcf821139d7159c3a9c1b0842f8ccb1cacfe710ff0e8cf7a156fda2eccd3c07c` |
| [Activation](../../../runtime/evidence/beijing-point-read-c631f554-a01-activation-20261003.json) | 4,190 | `0858168f3607ea610924a3070aedd4042c0cb1da8fcc8c220c345796e3547f29` |
| [Control](../../../runtime/evidence/beijing-point-read-c631f554-a01-control-20261003.json) | 1,066 | `130f41068e982dcf92c09075a1616e98f538f75e6a39abb78325dfae6b45692d` |
| [Audit](../../../runtime/evidence/beijing-point-read-c631f554-a01-audit-20261003.json) | 29,269 | `9b100d943e11a9992d9e46002ebb96e8b62a67f1e78948e9127e686b492f286a` |

The formal production-cell verifier passes 48 Objects and 6,240 writes,
reporting cold-wake p95 719.303432 ms and p99/max 1,998.496521 ms.
`claim_eligible=false` is preserved: this is not a standalone full-product
Bottomless or strict10k capacity claim. The HA canonical hash, unchanged
artifact, six-replica 2/2/2 topology and exact victim replacement all verify;
ten concurrent public Objects receive 1,500 requests with zero failures and a
verified post-failure SQLite write. Activation/control/audit SHA chaining,
allow/passed and static drift zero verify independently. Fresh live observation
confirms the same Cell UID, observed generation four and readyForPlacement.

The native audit has four Python `Infinity` leaves, solely in memory/storage
headroom ETA forecasts, and no trailing newline. Its exact bytes are preserved;
strict JSON readers will reject that historical serialization. Do not silently
normalize it or alter the control receipt's source hash. A future tool-only
serialization fix must retain explicit non-finite semantics, not invent zero
or finite headroom. These forecasts are not measured workload throughput.

After A's complete prerequisites passed, B was submitted once as
`inv-d9epts0437`, StartTime 08:40:20 UTC. Native RequestId
`c562ccbe-c6ef-4621-9489-1563bfbc6f1b` reports RUNNING, not terminal success.
Resume its existing five-minute waiter. The same checksum-bound wrapper,
c631 product receipt and operation-lock domain are retained; there was no
new workerd build, manual scaling, monitoring installation or second load.
Only B's complete qualification can permit the unchanged strict10k next.

Read-only `inv-c9eq32g9ba` completed SUCCESS/0 at 08:48:05 UTC. The original
B Engine UID is 6/6 and Host UID 4/4 at exact `d3a6e41e`, with converged Host
revision `6767cb4bd`. Its original cycle preserves pre allow/0, action exit
string zero and post block/string one. The inflight gate has 48 Objects and
48 online/final/post-sleep reclaim records, but is only beginning exact-cold
waiting: zero cold-ready, 48 pending, elapsed 50.709 ms, zero read errors and
no cleanup errors. Three staged-hot rows are not proof of failure or a stuck
task. No B cold-wake, HA, activation or strict10k pass is claimed.

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

## Current run final cleanup and natural contraction

`200a42ae-final-qualification-receipt-20261003.json` preserves the original
supervisor's final bytes, SHA-256
`397d6b334418b52d6f58ecbf9df8659cfd643aa38427047858abf5889c9616c6`.
It is a **failed** strict qualification: load, sustained 10,000 active and active
capacity did not pass. Automatic scale-up, stable capacity identities, valid
trace, exact Object cleanup, safe drain and final low capacity did pass. Those
partial results must not override the failed verdict or open Router qualification.

The final capacity observation at `2026-10-03T12:54:03.838003+00:00` binds both
Cells to four Ready Hosts and four desired/current/Ready canonical Machines.
Original service InvocationID `8a1ff14bc64e49c889255161316c32e8` was terminal
(`MainPID=0`, `ActiveState=failed`, exit status 1) when the read-only progress
capture `inv-c9exb3003w` completed with native TAT SUCCESS/0 at 12:55:34 UTC.
This is natural contraction, not a manual replica edit or timeout shortcut.

Archive invocation `inv-c9exehgiqx` verified the original terminal identity,
schema, failed verdict and exact SHA before copying only this 2,463-byte receipt
to the builder's approved qualification evidence root. Its short lock probe
reported the original operations lock available; it is an observation, not
permission for a later workflow to omit the real held lock.
The existing COS relay metadata/upload invocations `inv-a9exgbg97k` and
`inv-a9exgc0w3e` both completed SUCCESS/0. Download verified identical bytes/SHA;
only the temporary relay key was removed, and original/archived builder evidence
remains. No load was restarted and no capacity predicate was changed.

## Runtime 2757 strict run: one active retry, exact cleanup

Run `7d5fa6acee6a4a0fa60ea59d4b9ffe91` stopped irreversibly on one ordinary
active retry at 2026-10-03 20:47:07.847 UTC: index 360, HTTP 503,
`upstream_unavailable`. The preserved original-byte
`2757-run-7d5fa6ac-load-failed-20261004.json` reports 5,394 ready Objects,
5,381 proven active, 721,990 completed interactions and zero identity mismatches.
Its failed verdict is not a successful 10,000-active qualification. The
post-warmup three-second creation sample never started.

`2757-run-7d5fa6ac-cleanup-20261004.json` binds the failed receipt and reports
5,394 exact deletions, zero pending and zero cleanup retries. Both original-byte
hashes were verified after COS relay download; the original supervisor remained
the only operation owner. By 21:07:48 UTC, A/B active counts were zero and Ready
Hosts had naturally contracted to 129/126; Machines were 131/129. This is not
final low-capacity evidence: both floors remain four and the supervisor is live.

The immutable remote archive
`/data/actor-build/release/strict10k-failed-7d5fa6ac-20261004.4KmuSQ/evidence.tar.gz`
also retains the complete event journal and an append-only capacity prefix:
209 valid rows, 47,756,875 uncompressed bytes. Local archive SHA-256 is
`105328ba791c85167e8f1842279099cff1e21bbe5f25ca95f1092db762dc59fa`.
Only the helper's own temporary COS relay object was deleted; original evidence
and the immutable builder archive remain recoverable.

C monitoring is in `mesh-observability`, not the empty `observability`
namespace. Historical Prometheus queries ending at 20:48 UTC found 12/12 API
scrapes up, zero deployment-read/ObjectRouter overload counters, and one new
unassigned-target server-error series on Pod `workers-api-7d567c894f-wbtzz`.
Deployment reads on that Pod did not increase in the five-minute window.
Claim errors did increase, but include other requests and cannot identify this
one request. Prometheus `increase()` values are extrapolations, not literal
integer event counts; lifetime error counters include older experiments.
The exact Pod's bounded fault-window log was empty. These observations narrow
the likely failure to placement resolution before business fetch forwarding,
but do not prove a socket cause or absence of control-plane side effects.
`2757-run-7d5fa6ac-control-diagnostic-20261004.json` preserves the native
invocation identities and parsed successful historical queries, explicitly as
non-qualification evidence.

Public `upstream_unavailable` collapses multiple internal errors. The control
HTTP client previously discarded its transport error. A source-only diagnostic
now records socket milestones and a bounded error classification without URLs,
credentials, payloads or raw error strings. A real HTTP peer that closes after
receiving a POST proves one attempt, EOF classification and sanitized logging.
This is diagnostic coverage, not a fix or deployed qualification for this 503.
