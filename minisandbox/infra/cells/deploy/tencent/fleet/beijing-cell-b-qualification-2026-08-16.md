# Beijing Rivet/FDB/COS Cell B qualification — 2026-08-16

## Verdict

`actor-bj-b01` is a real, independently addressable Beijing qualification Cell. Its six-node
FoundationDB cluster, native Rivet/workerd runtime, and two Tencent COS buckets are live. Real
Actor commits, owner-generation recovery, one-AZ process loss, FDB cold-reference publication,
and exact-key COS content validation have been exercised.

The Cell remains **NonConforming** and `readyForPlacement=false`. It is not production eligible:
six FDB machines are a qualification `2/2/2` shape rather than the final `3/3/3`
compound-failure shape; runtime COS credentials are long-lived rather than an instance role/STS
session; Cell routing, reservation, retirement, and reconciliation are declarations without a
running fleet controller; and Cell B does not yet have a continuous FDB backup/restore
certificate. CBS encryption is not part of this deployment's admission contract.

## Real cloud inventory

All Cell B instances have private IPs only, termination protection enabled, and the VPC-internal
security group `sg-jfy27iab`. The FDB machines share HOST-spread placement group `ps-iitukd6q`.

| Role | Instance | Zone | Private IP |
|---|---|---|---|
| Runtime | `ins-5lt3ugbv` | `ap-beijing-6` | `10.128.6.14` |
| FDB | `ins-42ch5d9p` | `ap-beijing-6` | `10.128.6.12` |
| FDB | `ins-d5uvhap7` | `ap-beijing-6` | `10.128.6.17` |
| FDB | `ins-j2ya7ff3` | `ap-beijing-7` | `10.128.7.6` |
| FDB | `ins-jaj78h49` | `ap-beijing-7` | `10.128.7.15` |
| FDB | `ins-3mixtfnp` | `ap-beijing-8` | `10.128.8.5` |
| FDB | `ins-nhl2y78p` | `ap-beijing-8` | `10.128.8.4` |

Each FDB host has one separately retained 200 GiB `CLOUD_BSSD` data disk mounted as XFS at
`/var/lib/actor-fdb`; the observed mount source is `/dev/vdb`. `DeleteWithInstance=false` prevents
instance deletion from masquerading as storage retirement. The disks are unencrypted by the
explicit storage policy for this deployment; this is recorded inventory, not a readiness blocker.

The runtime and FDB hosts use VPC `vpc-6c2snz3a` and zone-specific subnets
`subnet-qljvksy9`, `subnet-k1rounhb`, and `subnet-kx0feejb`. Regional management resources are in
private-only TKE cluster `actor` (`cls-0zvm1btp`).

## FoundationDB qualification

- Version: `7.3.79`; supervisor: native systemd `fdbmonitor`.
- Cluster identity SHA-256: `cf215b2bb57715292c60f2df84ecac464a8bb271c558896e31dcec3c082a3776`.
- Six processes and six storage roles across `data_hall` locality `2/2/2`.
- Five coordinators; redundancy `three_data_hall`; storage engine `ssd-2`.
- Final status: `database_available=true`, data state `healthy`, six machines and six FDB zones.
- Reported fault tolerance: two FDB zone failures without losing availability or data.

For the real AZ-loss gate, both `ap-beijing-8` FDB services were stopped. A 45.079-second
continuous writer recorded 165 successful commits, one failed request, and a maximum successful
commit gap of 5.601 seconds. The final exact sentinel read matched. Both processes were restored
and the final cluster status above was captured afterwards. This is an observed bounded pause,
not an `RTO=0` claim.

The six-machine shape demonstrates progress after losing one complete two-machine hall. It does
not satisfy FoundationDB's stronger cloud operating shape for one AZ plus another machine: that
contract requires at least three machines in each of three halls (`3/3/3`).

## Native runtime and Actor persistence

The runtime is host-native systemd; no runtime container image is used.

- Release: `7951f4fa88283bde-9e8fc1af5f753202-61e0c94e3211d841`.
- `workerd` SHA-256: `7951f4fa88283bde973094379672e42fa9dc4579f1cc567c9941a87d9f8ba25e`.
- `rivet-workerd-host` SHA-256:
  `9e8fc1af5f753202a3d4e07d64e64077806dc6f4ca620f9a5a14936f29b57fd5`.
- `rivet-engine` SHA-256:
  `61e0c94e3211d841818f6be93aff619c7e7821bdb47abed2102f6378c3042eb1`.
- All three runtime binaries are native static musl. Engine embeds the source-built FoundationDB
  7.3.79 client and has no ELF interpreter, `DT_NEEDED`, GLIBC symbol version, or runtime
  `libfdb_c.so` dependency.
- Gasoline durable namespace is `actor-bj-b01`; `foundation_db.allow_shared_cluster=false`.
- Engine, workerd, and workerd-host services were active after the destructive runtime-state gate.

Actor `lnzalrzd0300gwn4g2ods33wpfal00` committed three increments and returned `count=3` at
generation 1. Stopping workerd/host caused systemd to remove both declared `RuntimeDirectory`
trees. After restarting the two services, the exact Actor ID returned `count=3` at generation 2.
No local SQLite data file was retained.

The final Engine also passed a bounded graceful-restart proof. Stateful services completed first;
the Sentry transport and Tokio blocking pool each had a five-second upper bound, and systemd
recorded a clean stop/start in 10 seconds without timeout or SIGKILL. The temporary 20-second proof
override was removed and the permanent service timeout is 620 seconds. A subsequent cloud-side
eight-Actor lifecycle run performed 24 acknowledged increments and proved registry counts
`0 -> 8 -> 0 -> 8 -> 0`, generation `1 -> 2`, stable SQL counts, and error-free cleanup.

The first qualification command incorrectly required the stopped services' `RuntimeDirectory`
roots to remain present. systemd correctly removed them, so the shell exited before restart. This
was a harness bug rather than a data failure. `reset-workerd-volatile-state.sh` now validates exact
unit directory names while treating an already-removed directory as success; its traversal and
absent-directory regression tests pass.

## COS cold tier

Real buckets:

- `actor-depot-cold-prod-bj-b01-1388575217`
- `actor-fdb-backup-prod-bj-b01-1388575217`

Both are in `ap-beijing`, have versioning `Enabled`, and default SSE-COS `AES256`. COS is not in the
SQLite commit acknowledgement path.

This is retained historical evidence, not the current production bucket contract. The current
profile requires fresh `*-nv1-*` ordinary buckets with versioning `NeverEnabled`; this old cold
publish result must be repeated against those buckets before Cell B can become Ready.

Cold qualification Actor `pe7exg2hzg2c69bpt7t0hycpa9bl00` completed 130 acknowledged
increments; p95 increment latency was 39.512 ms. After the maintenance window, the exact branch
audit found one cold reference, one atomic publish marker, one PITR interval, and one retained hot
shard. The authoritative reference was:

- Branch: `5ed33bb1-649e-49ff-8da2-b90ae771b076`
- Key:
  `6e33/cold/v2/5ed33bb1649e49ff8da2b90ae771b076/00000000/0000000000000083/l7rhb2m51eqluzdlyitr80zcbsbl00/bjP81UiD4t6_g6fr7Z0B-tGZtBgNE9F1_DZuNG3vyyk.cold`
- Size: 654 bytes
- Content SHA-256: `6e33fcd54883e2debf83a7ebed9d01fad199b4180d13d175fc366e346defcb29`
- COS ETag: `d264f552bfaca64435af4eb049ed388e`
- `as_of_txid=131`, `shard_id=0`, `publish_generation=2`

The audit resolves this one branch, parses its FDB cold ref, then performs COS HEAD and GET for the
exact referenced key and validates the object against the FDB size/hash. It neither scans a global
pointer prefix nor uses COS `LIST` for recovery.

The database-specific hot-cache retention was changed to 1 ms only for the qualification Actor.
This does not produce immediate eviction: branch accesses are bucketed at 60 seconds and the
production manager reclaimer interval is 10 minutes. A single additional commit and a second full
128-increment compaction batch both preserved the hot shard during the first three-minute polling
windows. This correctly exposed that short qualification waits cannot stand in for the real
production timer.

At the real production timer, the 21st exact audit observed eviction after 601 seconds:

- hot shard rows: `1 -> 0`;
- cold refs, publish markers, and PITR intervals: `3 / 3 / 3`;
- every referenced COS object passed exact HEAD/GET/size/hash validation;
- the original txid-131 reference above remained unchanged;
- the txid-132 object hash was
  `901a4eed607c686f81df9686b41b64e9bf637e6f49f13115db2906db2e8900ce`;
- the txid-260 object hash was
  `9c08bba3239a3c12d9249bc716e37bc0ca3eb32185b87324069c0da34f121ccf`.

workerd and workerd-host were then stopped, their declared volatile state was removed, and both
were restarted. The exact Actor advanced from generation 1 to 2 and returned `count=259` in
16.747 seconds. The follow-up branch audit found one refilled FDB hot shard and the same three cold
refs, keys, sizes, ETags, and hashes. Final publish → eviction → cold read → refill verdict:
**passed**. The 16.747-second first cold read is functional evidence, not an acceptable latency SLO;
it needs a separate performance budget and optimization pass.

## Fleet control resources

The TKE cluster contains the `RivetCellProfile`, `ShardClass`, `ShardPool`, and two `RivetCell`
objects. Cell B has its real node refs and cluster identity. Its status is deliberately
`NonConforming`, not `Ready`. There is no per-Actor Kubernetes object.

These CRDs are currently declarative. A controller image implementing route hints, CAS pending
reservations, bounded migration queues, exact placement counts, reconciliation, and proof-gated
retirement has not been deployed. Therefore the fleet is an infrastructure and data-path
qualification, not a production control plane.

## Build and regression evidence

- Runtime payload SHA-256:
  `7aacd65eb491aa7ed84e6b9045495b0324cb6b5ab33effff9a14b050f1f00716`.
- Exact cold-audit binary SHA-256:
  `bb4ad73a646afbc0344ccfde6618c585a83995369d1ddd454b9401d005bf92d4`.
- Runtime qualification JSON SHA-256 values: counter
  `fd0ab08c00624b12336a9f8789afcd6bc7dfd929c375d79f198f871b8f7c21b4`, post-loss counter
  `902be1844d484419333026d1708a1dfdce73418b40d648a53df0c5ea568e1a4c`, cold seed
  `03064eac0adf3c5cd2112a22f1da36cc4f15e3f4b1d0d3e77b012a9944bbdb3a`, and cold restore
  `83318f0c684e07535514edfb9480860e827555a228965ec72214849ab3367656`.
- Exact cold audit log SHA-256 values: initial
  `0b05b55de2b7d7d5b68135805eb979f90a6ba4d6e95efab2513c2e19accf1d74`, evicted
  `5e3b23b32b94533a6e371f715aba13d2d464ab225714bb579b34c093e27a6b0f`, and refilled
  `d4c123171a8b10bf63758e770a7b50b3575b1d63af6827f50dd7c5fac1d7096b`.
- The Engine source build ran on the Beijing builder, not the laptop; current-config FDB tests:
  6 passed.
- Multi-Actor qualification harness: 8 local bounded tests passed. The workerd-host HTTP
  transport additionally passed its bounded-in-flight and fresh-loopback-connection tests.
- FDB bootstrap selector/ambiguity tests passed.
- Fleet manifest invariants passed; manifest SHA-256:
  `3ce8bb608f73e307623c8f11c44d1b2d92fd0e500d7200a3f81768b8c5c2ed3b`.
- Source packaging and volatile-state reset negative tests passed.

Two build-path failures are now explicit regression guidance. A macOS archive contained 14,234
AppleDouble `._*` files and broke Linux source discovery; `package-rivet-source.sh` now sets
`COPYFILE_DISABLE=1` and rejects those members. Cargo's top-level `--config` did not reach the
RocksDB build script's nested `cargo metadata`; the Beijing mirror must be installed at the
effective `$CARGO_HOME/config.toml`. The audit target also requires both `LIBRARY_PATH` at link time
and `LD_LIBRARY_PATH` at run time for `libfdb_c`.

## Production blockers

| Gate | Current evidence | Required action |
|---|---|---|
| Compound fault shape | `2/2/2` passes one-hall qualification | Expand to `3/3/3`, repeat AZ plus additional-machine failure |
| Runtime identity | Long-lived COS key is installed root-only | Replace with CVM role or short-lived STS and prove rotation/expiry |
| Fleet controller | CRDs/status exist, controller does not | Implement and qualify routing, CAS reservation, reconciliation, drain, fencing, and retirement receipts |
| Backup/restore | Bucket exists, no Cell B continuous backup certificate | Deploy multi-zone backup agents and destroy/restore an empty replacement cluster |
| Cold-read latency | Exact publish/evict/refill passed; first post-loss cold read was 16.747 seconds | Define a cold-activation SLO, separate owner scheduling from COS/VFS latency, and optimize before production admission |
| Capacity | Functional tests and one AZ-loss trace only | Encode per-Cell admission SLOs and run increasing multi-runner load/recovery-storm qualification |

An account-scoped `CVM_QcsRole` trusting only `cvm.cloud.tencent.com` was briefly created during an
abandoned encryption experiment. A paginated account inventory proved that no Actor instance used
the role; its KMS policy was detached and the unused role was deleted. It is not part of the
production design.

## Cleanup and retained evidence

The builder's temporary ports 18450/18451, systemd file-serving units, exact iptables rules,
encrypted credential blob, public transfer key, and `/run` delivery trees were removed. The
runtime's transient install tree was removed without stopping the final services. The versioned
COS source-build upload was deleted by its recorded bucket/key/version and the same version then
returned 404; COS `LIST` was not used. Laptop tccli credentials, TKE token kubeconfig, COS SDK,
source archive, and upload metadata were removed.

The immutable runtime tar, build cache, audit binary/logs, FDB Cell configuration, and runtime
qualification JSON remain on the Beijing builder/runtime as the evidence referenced above. Two
qualification Actors remain intentionally (`placementCount=2`), including the cold Actor and its
production-layout COS objects, so the object layout can be inspected after this run. They were not
subjected to soak-style automatic deletion.
