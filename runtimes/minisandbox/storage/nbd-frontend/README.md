# Linux NBD validation frontend

This crate exposes the reference `SQLite` + deterministic Tencent COS engine
as a disposable Linux block device. It exists to let ext4, fio, blktests, and
xfstests exercise the real block API. NBD is not part of the PVM product path.

The dated evidence inventory, known cross-revision gaps, and closed admission
gates are recorded in [`QUALIFICATION.md`](QUALIFICATION.md). The reference is
currently provisional rather than qualified.

```text
Linux ext4 / fio
      |
  /dev/nbdX (512-byte logical sectors)
      |
  direct socketpair + NBD_SET_SOCK / NBD_DO_IT
      |
  28-byte NBD transmission parser
      |
  bounded 256-frame socket drain
      |
  single ordered backend executor
      |
  4 KiB RMW and 512 KiB transaction splitting
      |
  BlockEngine
      +-- SQLite WAL + synchronous=FULL
      `-- deterministic persistent COS emulator
```

The frontend directly configures the kernel NBD device with ioctls. It does
not listen on TCP or Unix-domain paths and does not implement the NBD network
negotiation phase. This keeps the validation parser small and prevents it from
becoming a product-facing protocol surface.

## Implemented semantics

- `READ`: 512-byte aligned, up to 1 MiB; internally reads authenticated 4 KiB
  blocks and returns the requested slice.
- `WRITE`: 512-byte aligned, up to 1 MiB; partial blocks use read-modify-write.
  Every internal transaction is at most 512 KiB. A Linux request larger than
  that may use multiple durable transactions; NBD does not promise large-write
  power-failure atomicity.
- `FLUSH`: records an actor-ordered durable barrier covering the highest write
  sequence processed before it. COS is not in the acknowledgement path.
- `FUA`: every SQLite mutation is already `synchronous=FULL`; the frontend also
  records a FLUSH barrier before replying to a FUA data-changing request.
- `TRIM`: the reference chooses deterministic zero semantics stronger than the
  NBD minimum. Complete 4 KiB blocks become payload-free versioned DISCARD
  values in atomic requests of at most 512 KiB; unaligned edge sectors use the
  ordinary RMW write path. The attachment programs Linux
  `queue/discard_max_bytes=512KiB`, so a larger filesystem discard is split by
  the block layer and may recover as a legal prefix of complete requests.
- `WRITE_ZEROES`: writes actual zero bytes through the normal RMW/write path;
  FUA and `NO_HOLE` are accepted. Fast-zero is not advertised.
- `DISC`: terminates the session without a reply, as required by NBD.

The kernel-facing parser caps data allocation at 1 MiB. A WRITE declaring a
larger payload is a fatal session error after the fixed 28-byte header; the
parser does not drain an attacker-controlled length. It validates overflow,
volume bounds, 512-byte alignment, command flags, magic, and echoed handles,
and maps backend failures to request-local `EIO`. A raw TRIM request above
512 KiB is rejected before the backend even though it carries no payload; this
prevents one request from monopolizing the serialized SQLite actor past the
kernel watchdog. The sysfs queue limit is verified during attachment and setup
fails closed if Linux does not enforce it. A peer transport close while a
reply is being delivered ends that attachment and increments
`transport_disconnects`; it is distinct from both a backend `errors` count and
a framed `DISC`.

### DISCARD work-amplification boundary

Linux's legacy NBD path initially exposed a `queue/discard_max_bytes` value of
about 2 TiB. On a 2 GiB qualification volume, `mkfs.ext4` therefore submitted
one 2 GiB TRIM. Merely splitting that request inside the backend was not a
safe bound: it expanded one untrusted descriptor into 4,096 synchronous
512 KiB SQLite transactions, held the single executor until all of them
finished, and withheld the one NBD reply for longer than the kernel's
30-second watchdog. The kernel then detached the device and ext4 observed I/O
errors.

Internal splitting also weakened the failure contract. A disconnect could
leave a durable prefix of those 4,096 transactions even though the original
request had no reply, so the outcome was neither one bounded atomic DISCARD
nor a clean rejection. This is an availability and work-amplification attack
surface, not a memory-safety escape: an untrusted guest can monopolize the
serialized backend, head-of-line block READ/WRITE/FLUSH, and force device
disconnect with one small descriptor.

The frontend therefore enforces the limit twice:

1. `queue/discard_max_bytes=512 KiB` makes a normal Linux producer emit
   separately acknowledged requests; this is a performance and compatibility
   control, not a trust boundary.
2. The NBD parser rejects any raw TRIM above 512 KiB instead of internally
   looping over it. This is the security boundary and keeps one descriptor to
   at most 128 4 KiB blocks and one bounded transaction.

The same rule applies to the future PVM ring: descriptor byte length alone is
insufficient unless it also bounds worst-case backend work. Oversized
DISCARD, WRITE_ZEROES, scatter/gather lists, and batches must be rejected at
ingress rather than accepted and expanded into an attacker-controlled loop.
Request timeouts remain fault detection; they are not the resource-boundary
defense.

Only one kernel socket/queue is configured. A dedicated reader completely
drains and validates at most 256 framed requests while the single backend
executor processes them in socket order. At the 1 MiB protocol limit this is
a hard queue allocation bound of about 256 MiB; Linux 6.7's legacy ioctl path
has 128 tags, so its reachable bound is about 128 MiB. The split is required
for correctness under stress, not throughput: if slow SQLite work fills the
kernel socket, Linux NBD can partially send and requeue a request with a new
blk-mq tag while retaining the old header cookie, eventually rejecting the
correct echoed cookie as a `Double reply`. A regression test blocks the first
backend write and proves that all 128 kernel-depth requests are drained before
the backend resumes.

The drained queue is still useful correctness evidence, not an NBD performance
frontend or evidence for future PVM multi-queue ordering. It is reachable only
from the directly attached local kernel socket; it does not add a listener or
enter the PVM product attack surface.

## Deterministic protocol fuzz gate

`tests/protocol_fuzz.rs` runs 8,192 reproducible structured cases over every
implemented command plus unknown commands. Fixed seed generation combines
boundary lengths through `u32::MAX`, aligned/misaligned/overflowing offsets,
and valid/invalid flag sets. An independent test oracle requires that only a
bounded, aligned, in-volume operation can reach the backend and checks reply
magic, errno, handle, payload length, and statistics.

The malformed corpus separately checks every truncated header length, every
single-bit request-magic corruption, a truncated WRITE payload, and an
oversized WRITE with no payload. It runs as an ordinary hermetic Rust test:

```bash
cargo test --manifest-path storage/Cargo.toml \
  -p minisandbox-nbd-frontend --test protocol_fuzz
```

This gate qualifies the validation frontend parser; NBD still does not enter
the PVM product attack surface.

## Run a 2 GiB ext4 smoke test

The script is intentionally destructive to the explicitly supplied unused
`/dev/nbdX`. It refuses a non-NBD path, a device with an active kernel pid, or
a device whose current size is non-zero. It never selects `vda`, `vdb`, or any
other disk itself.

```bash
cargo build --release --manifest-path storage/Cargo.toml \
  -p minisandbox-nbd-frontend

sudo storage/nbd-frontend/scripts/ext4-smoke.sh /dev/nbd0
```

Set `MINISANDBOX_NBD_SETTLE=0` for the faster hot-SQLite-only run. The default
disconnects after writing, settles all live payloads into the fake COS, then
reopens the same volume under a fresh writer epoch. The test performs:

```text
attach 2 GiB sparse volume
  -> mkfs.ext4
  -> mount and write an 8 MiB random file + directory + hard link
  -> sync and unmount
  -> disconnect and optional 100% COS settlement
  -> reconnect from the same SQLite/COS state
  -> e2fsck -fn
  -> read-only mount, SHA-256 and inode checks
  -> clean disconnect
```

The script preserves its temporary evidence directory and prints the path.
Server logs include operation counts and any NBD error replies.

## Online settlement while ext4 remains mounted

The separate online gate proves that COS settlement is not merely a disconnect
hook. It writes a deterministic 64 MiB payload, waits for an immutable object
while the same ext4 mount is still active, writes another 32 MiB, disconnects,
then reopens for `e2fsck -fn` and SHA-256 verification:

```bash
sudo storage/nbd-frontend/scripts/online-settle-ext4-smoke.sh \
  /dev/nbd1 /path/to/new-evidence-directory
```

Defaults are a 16 MiB high watermark, 8 MiB low watermark, and 1 MiB maximum
pack. A watermark crossing persists one fixed commit-version cutoff and byte
budget. Every pack in that round is bounded, but changing pack size cannot
move the cutoff or alter crash correctness. The evidence includes every
durable round's cutoff, target and completed bytes, the server binary hash,
mounted-online observation, NBD counters, filesystem check, and content hash.

The emulator intentionally records weak-COS observations durably. Reopening a
cold 64 MiB file is therefore a correctness workload, not a COS throughput
benchmark; the current reference reader issues authenticated 4 KiB ranges and
does not yet implement production pack cache/readahead.

## Deterministic block oracle and process crash

`minisandbox-block-oracle` drives a raw NBD device with a reproducible xorshift
seed and a bounded test region. It mixes 512-byte, 4 KiB, 64 KiB, and 1 MiB
reads/writes, periodic `fsync`, `O_DSYNC` writes, and `BLKDISCARD`. Its state
file stores the seed, completed operation count, geometry, and one SHA-256 per
known 4 KiB block, followed by a SHA-256 over the complete state file.

TRIM-affected blocks become unknown because the protocol does not define their
contents. A later full-block write makes one known again; a partial write does
not invent knowledge about the rest of an unknown block. State publication is:

```text
device fsync
  -> write new oracle state
  -> fsync state
  -> atomic rename
  -> fsync parent directory
```

Run the deterministic server-crash test with another explicitly unused NBD
node (or the same node after the ext4 test finishes):

```bash
sudo storage/nbd-frontend/scripts/oracle-crash-smoke.sh /dev/nbd0
```

The script completes a final device/state checkpoint, sends `SIGKILL` to the
whole NBD/SQLite/COS process without normal cleanup, reconnects the same sparse
volume under a fresh fencing epoch, then verifies every known block against
the digest-protected state.
Environment variables select the seed, operation count, checkpoint interval,
and region size. This proves recovery at a completed FLUSH boundary. It does
not yet cover a kill after an arbitrary unflushed overwrite; that requires the
next write-ahead oracle/history refinement so post-checkpoint dirty blocks can
be treated as a set of possible values.

For a crash *inside* one direct WRITE rather than after a checkpoint, run:

```bash
sudo storage/nbd-frontend/scripts/inflight-write-crash-smoke.sh \
  /dev/nbd0
```

`minisandbox-inflight-oracle` durably records the complete before/after 4 KiB
hash set before releasing one `O_DIRECT|O_DSYNC` write through a FIFO. The
script first raises this disposable NBD queue's `max_sectors_kb` to 1024 and
requires a clean calibration to prove that one 1 MiB userspace write arrives
as one NBD command. It then tests 512 B, 4 KiB, 64 KiB, and 1 MiB writes at
four SIGKILL delays across four fixed base seeds (64 fresh backends by default).
`MINISANDBOX_INFLIGHT_SEEDS` accepts a deterministic whitespace-separated seed
list for wider sweeps. On recovery, an unfinished write may match only a prefix
of the frontend's atomic 512 KiB SQLite transactions; a torn 4 KiB block or
non-prefix combination fails closed. The original queue limit is restored by
the EXIT trap. Evidence records the selected matrix, repository commit, and
both executable hashes.

## fio CRC32C matrix

With fio 3.35 or newer installed, run the guarded verification matrix:

```bash
sudo storage/nbd-frontend/scripts/fio-verify-smoke.sh /dev/nbd0
```

The gate keeps a comparable full matrix of all twelve combinations of 512 B,
4 KiB, 64 KiB, and 1 MiB random writes at queue depths 1, 32, and 128. It then
adds sequential-write and 50/50 random READ/WRITE coverage for every request
size at queue depth 32, an explicit overlapping-random-write job, and a 1 MiB
job ending exactly at the final byte of the 2 GiB volume. All use `io_uring`,
`direct=1`, CRC32C verification, fatal-on-first-mismatch, and durable end-of-job
sync where applicable. Sizes are deliberately small for the serialized SQLite
reference backend and can be raised independently with
`MINISANDBOX_FIO_SIZE_512`, `_4K`, `_64K`, and `_1M`.

The same gate issues real Linux `BLKDISCARD` and `BLKZEROOUT`, verifies the
zeroed bytes, writes a final fio verification region, disconnects the NBD
server, reopens the same SQLite state under a fresh fencing epoch, and runs
fio `verify_only`. On this Linux 6.7 NBD driver, `BLKZEROOUT` is translated to
ordinary zero WRITE requests even though `SEND_WRITE_ZEROES` is advertised;
the exact NBD `WRITE_ZEROES | FUA | NO_HOLE` command is therefore claimed only
by the scripted protocol test, not by this real-kernel fio run. Every one of
the 24 default fio JSON jobs must report `error=0`, and both NBD sessions must
report zero rejected/failed requests.

This is a correctness gate, not a meaningful performance benchmark: the NBD
validation frontend has one socket and processes requests in order. The
existing SQLite benchmark measures transaction throughput without this Linux
test stack.

On Linux 6.7, both the oracle's `O_DSYNC` writes and fio's write barriers were
observed as explicit NBD `FLUSH` commands, not data commands carrying the FUA
flag. The parser/backend FUA mapping is covered by the scripted transmission
test, but is not claimed as a real-kernel fio result on this host.

## Upstream blktests and xfstests

The repository does not vendor either Linux test suite. Build an upstream
checkout, then pass its path to the guarded adapters:

```bash
make -C /path/to/blktests
sudo storage/nbd-frontend/scripts/blktests-smoke.sh \
  /dev/nbd0 /path/to/blktests

# Real kernel request timeout; builds an isolated fault-enabled test binary.
sudo storage/nbd-frontend/scripts/timeout-smoke.sh /dev/nbd0

make -C /path/to/xfstests
sudo storage/nbd-frontend/scripts/xfstests-ext4-smoke.sh \
  /dev/nbd0 /dev/nbd1 /path/to/xfstests

sudo storage/nbd-frontend/scripts/xfstests-xfs-smoke.sh \
  /dev/nbd0 /dev/nbd1 /path/to/xfstests
```

The blktests adapter runs the applicable generic-device cases for variable
discard ranges, flush-intensive writes, read-only transitions, and unusual
direct-I/O offsets. Every blktests case gets a fresh SQLite/COS backend so a
flush workload's retained history cannot distort a later alignment test.

The timeout gate first seeds a non-zero old block, then stalls the first backend
WRITE for six seconds while the NBD driver and socket reader remain live. With
a two-second `NBD_SET_TIMEOUT`, the real direct write must return `EIO` near the
configured deadline and the device must detach without a residual NBD session.
`EIO` is treated as outcome-unknown: an offline authenticated read must return
exactly the complete old or new 4 KiB value. The harness then retries the exact
same deterministic `(volume, epoch, op_id)` and requires either one new commit
or a replay of the late commit, followed by epoch rotation and a real NBD read
of the new value. It also requires exactly one durable result for that identity.

The stall and deterministic-session arguments exist only under the crate's
`fault-injection` feature; the script builds them in an evidence-local Cargo
target. A normal release rejects both hidden arguments.

The guarded versioned-DISCARD gate writes a non-zero three-block extent through
the real kernel device, pins a pre-DISCARD snapshot through the offline admin
API, issues `BLKDISCARD`, and verifies zeroes both immediately and after source
restart. It then forks the pinned snapshot and verifies the original bytes
through a second real NBD attachment. Finally it requires three payload-free
discard versions and one durable range-operation result in SQLite:

```bash
sudo storage/nbd-frontend/scripts/discard-smoke.sh /dev/nbd0
```

The ext4 adapter defaults to the explicit 23-case admission manifest in
[`scripts/xfstests-block-semantics.list`](scripts/xfstests-block-semantics.list),
while XFS uses the explicit 22-case
[`scripts/xfstests-xfs-block-semantics.list`](scripts/xfstests-xfs-block-semantics.list).
The manifests cover checked create/write/unlink chains, hard links,
zero/fallocate/punch, multiprocess fsstress, mmap/truncate/remount, two
dm-flakey journal replays, buffered and O_DIRECT fsx, Linux AIO, fsync/remount,
sendfile, FITRIM, ENOSPC, read-only remount, and mmap/fallocate races. This is
deliberately called the minisandbox block-semantics supported set; it is not
represented as all 643 tests in the upstream `generic/quick` group. A selected
case that emits `.notrun` fails the adapter instead of silently shrinking the
claimed set. Each adapter persists the full xfstests console stream and writes
`admission-status` only after clean detach, epoch-3 reopen, zero frontend
errors, and the final read-only filesystem check.

The ext4 adapter uses two independent 2 GiB backends, cleanly detaches, reopens
the TEST volume under a fresh fencing epoch, and requires a clean `e2fsck -fn`.
The XFS adapter applies the same guarded lifecycle and requires a clean
`xfs_repair -n`. Its supported profile explicitly uses
`mkfs.xfs -m reflink=0`, recorded in every evidence directory, instead of
inheriting the host's mkfs default. On this Linux 6.7.12 kernel, the first
direct-I/O fsx permutation in `generic/091` reproducibly returned zero data at
operation 383 with `reflink=1`. An independent qemu raw-file NBD control failed
at the same byte and operation, excluding the SQLite/COS backend; the otherwise
identical `reflink=0` control completed all 10,000 operations and passed
`xfs_repair -n`. Reflink-enabled XFS is therefore not an admitted filesystem
profile on this kernel.

The XFS manifest omits `generic/438`: upstream defines it as an ext4
mmap/fallocate corruption regression, and it performs 262,144 byte-sized
fallocate operations while another process continuously calls `fsync`. The
ext4 admission run retains and passes it. On the append-only SQLite reference
backend, XFS may run it explicitly through `MINISANDBOX_XFSTESTS_CASES`, but it
is treated as a durability performance canary rather than duplicated XFS
filesystem coverage.

Because xfstests uses host-global systemd scope names, both adapters hold one
nonblocking host lock and reject concurrent suite processes; separate block
devices alone are insufficient. `MINISANDBOX_XFSTESTS_CASES` selects a smaller
explicit list for harness diagnosis, for example:

```bash
sudo MINISANDBOX_XFSTESTS_CASES='generic/001 generic/002 generic/013' \
  storage/nbd-frontend/scripts/xfstests-ext4-smoke.sh \
  /dev/nbd0 /dev/nbd1 /path/to/xfstests
```

The validation frontend normally keeps Linux NBD's 30-second request timeout.
The xfstests adapters explicitly use 300 seconds because `generic/113` can put
twenty AIO workers behind this deliberately serial reference frontend; a
queued request timing out would disconnect the whole test device and turn all
later cases into misleading mount failures. Override the gate value with
`MINISANDBOX_XFSTESTS_REQUEST_TIMEOUT_SECONDS`. The selected value is recorded
in the evidence directory. This prevents a qualification harness false
negative; it is not a claim that the serial frontend's throughput is adequate,
and NBD remains outside the PVM product path.

Under a concurrent long-running ext4 soak, `generic/269` exposed the separate
Linux NBD partial-send/tag-requeue failure described above: the kernel logged
`Double reply` and disconnected the scratch device, so later test failures
were cascading harness failures. With the bounded drain in place, the same
ENOSPC/fsstress case passed under the same contention in 277 seconds. The
scratch session completed 43,295 writes, 2,399 flushes, and 2,384 FUA commands
with zero request errors, followed by a clean unmount; the test volume then
reopened under writer epoch 3 and passed all five `e2fsck -fn` phases.

These adapters remain test-only. blktests/xfstests parsers and dependencies do
not enter the PVM runtime or the product block ABI.

Every multi-phase qualification script copies its NBD frontend (and any oracle
binary) into the fresh evidence directory before the first attach, records the
copied artifact hash, and executes only that immutable path for restart and
recovery phases. Rebuilding `target/release` while a long gate is running
therefore cannot silently mix repository schema or protocol versions within
one result.

For filesystem-level persistence prefixes, the same built xfstests tree
provides the upstream `replay-log` helper:

```bash
sudo storage/nbd-frontend/scripts/dm-log-writes-smoke.sh \
  /dev/nbd0 /dev/nbd1 /path/to/xfstests
```

The script places the origin behind the kernel `dm-log-writes` target, writes
two deterministic 1 MiB files separated by sync marks, and records the ext4
WRITE/FLUSH/FUA stream into a bounded loop-backed log. It then replays
`after-a`, `after-b`, and clean-unmount `end` into three fresh SQLite/COS
volumes. Each prefix must mount/recover, expose exactly the expected files and
SHA-256 values, unmount, and pass `e2fsck -fn`. The device-mapper target and
replay parser are host-only qualification tools, not product dependencies.

The companion flakey gate verifies explicit media unavailability without
accepting silent loss:

```bash
sudo storage/nbd-frontend/scripts/dm-flakey-smoke.sh /dev/nbd0
```

It writes and checkpoints a deterministic 64 KiB region, reloads a guarded
device-mapper target into a permanent down interval, and requires both direct
READ and WRITE to return `EIO`. After reloading the target into the up state,
the possible-values oracle must still match the complete pre-failure hashes.
This covers error propagation and recovery; `drop_writes` and intentional data
corruption are deliberately not treated as acceptable durability modes.

## Two-hour ext4 soak gate

The long-duration gate runs upstream `fsstress` and `fsx` concurrently over a
fresh ext4 filesystem. Its default is the product-admission duration of 7,200
seconds; shortening it is useful only to validate the harness:

```bash
sudo storage/nbd-frontend/scripts/ext4-soak.sh \
  /dev/nbd0 /path/to/xfstests

# Harness smoke, not a two-hour qualification result:
sudo MINISANDBOX_SOAK_SECONDS=30 \
  storage/nbd-frontend/scripts/ext4-soak.sh \
  /dev/nbd0 /path/to/xfstests
```

`fsstress` uses eight processes by default while `fsx` continuously checks a
bounded 256 MiB file and requests synchronous mutations. `fsstress` runs
128-operation-per-process cycles by default and uses its upstream `-c` mode to
remove the per-process namespace after every cycle. This bounds live guest
space on the deliberately small 2 GiB volume; it does not silently reinterpret
ENOSPC as success. Set `MINISANDBOX_SOAK_FSSTRESS_OPS` to change the cycle size.
The harness also stops the peer immediately if either worker fails.

After both complete, the script syncs and unmounts, runs read-only `e2fsck`,
disconnects the NBD server, reopens the same SQLite/COS state under a fresh
writer epoch, reruns `e2fsck`, and verifies an independent sentinel from a
read-only mount. The server is an evidence-local immutable copy for the entire
run. Evidence also records the minisandbox and upstream xfstests commits, the
exact server binary SHA-256, and the host kernel identity.

The two-hour gate deliberately exercises the synchronous hot SQLite path and
does not enable the online settler; online settlement has the independent gate
above. The reference engine retains immutable write history until asynchronous
settlement/reconciliation. A two-hour run therefore needs an evidence path
with tens of GiB free at the current reference throughput. The bounded cleanup
only controls live space inside ext4; backend history remains complete, and a
short run is never reported as a qualification result. Reopening a large
reference history can also take substantially longer than an ordinary fresh
attach, so this gate uses a bounded 7,200-second attach timeout; override it
with `MINISANDBOX_SOAK_ATTACH_TIMEOUT_SECONDS` when diagnosing startup. The
single-actor SQLite reference path can also queue more than 30 seconds of work
under this deliberately saturated workload, so the harness separately sets a
300-second kernel request watchdog through
`MINISANDBOX_SOAK_REQUEST_TIMEOUT_SECONDS`. This is a deadlock guard for the
integrity soak, not a latency target or evidence that the production frontend
may take 300 seconds to serve an I/O.

The bounded-space behavior has its own regression evidence. The original
unbounded harness filled a clean 2 GiB ext4 volume to 520,125 of 524,288 blocks,
after which `fsx` correctly received `SIGBUS` from an mmap write while
`e2fsck -fn` still reported a clean filesystem. With bounded cycles, a fresh
60-second run completed 30 fsstress cycles and 1,992 fsx operations, retained
about 1.8 GiB free, then passed both pre- and post-reconnect `e2fsck`. Its NBD
sessions handled 11,491 writes, 912 total flushes, 816 FUA commands, two trims,
and zero error replies. A separate fail-fast regression sent `SIGKILL` to fsx;
the harness reported status 137, terminated the full fsstress process group,
unmounted ext4, and disconnected the NBD device without a residual worker or
mount.

## Recorded real-kernel result

On 2026-08-18, Linux 6.7.12 and ext4 1.47.0 completed the full workflow:

- fresh 2 GiB ext4: 619 writes, 11 flushes, one trim;
- 8 MiB payload SHA-256 and hard-link inode matched after reconnect;
- 75 bounded pack passes settled all hot payload into the COS emulator;
- the reopened epoch read about 11.5 MiB from the cold image;
- all five `e2fsck -fn` phases passed with no filesystem error.

After correcting large-TRIM validation, a second fresh run completed 567
writes, 11 flushes, two trims, reconnect, hash verification, and `e2fsck` with
zero NBD error replies in both sessions.

The durable-round online gate then ran with 16 MiB/8 MiB high/low watermarks
and 1 MiB packs. While ext4 remained mounted it observed ten immutable objects,
continued writing, and completed six rounds whose `settled_payload_bytes`
exactly equalled their fixed targets. The online session handled 1,386 writes,
18 flushes, 11 FUA commands, two trims, and zero errors; 40,408 blocks were
published and evicted, final hot payload was exactly 8 MiB, and peak hot payload
was about 66.6 MiB while foreground writes outran the asynchronous worker.
Reconnect read about 70.2 MiB, reproduced the 64 MiB payload SHA-256, and passed
all five `e2fsck -fn` phases. This demonstrates hysteresis, not a hard memory
cap; admission/backpressure remains a separate product policy.

A deterministic oracle run with seed `0xdeadbeef` completed 300 operations:
172 writes, 85 verified reads, 10 trims, and 37 durable checkpoints over a
16 MiB region. The server was then killed with `SIGKILL`; SQLite WAL recovery
and epoch rotation from 2 to 3 succeeded, and all 3,678 known blocks matched
the digest-protected oracle state after reconnect. The remaining 418 blocks had
been explicitly marked unknown by TRIM rather than assumed to contain zero.

The fio quick gate completed all twelve block-size/queue-depth combinations
with CRC32C verification. The complete session handled 6,561 writes, 6,860
reads, and 12 flushes with zero NBD errors. As expected for the serialized
reference frontend, increasing queue depth did not produce linear throughput.

The expanded admission gate completed 24 fio jobs: the twelve-combination
random-write matrix, eight per-size sequential/mixed jobs, explicit overlapping
4 KiB writes, a 1 MiB volume-tail job, and write/`verify_only` across a real
frontend restart. Linux `BLKDISCARD` reached one NBD TRIM, `BLKZEROOUT` returned
authenticated zero bytes through ordinary WRITE requests, and the committed
gate's initial and recovery sessions completed 14,403 writes, 12,880 reads,
24 FLUSH commands, one TRIM, and zero backend errors. The recovery writer epoch
advanced from 2 to 3. The exact protocol test separately observed one NBD
WRITE_ZEROES carrying FUA and NO_HOLE.

Upstream blktests commit `ddc0babaccc4fa9b0d652ce1a359bee7568834f1`
passed `block/003`, `004`, `012`, and `042`. The flush-intensive quick run
lasted 30.385 seconds and completed 11,078 writes plus 660 flushes with zero
backend errors. Upstream xfstests commit
`56c410ad0f69da5b13c5807bc47b4876dcfa02b2` passed `generic/001`, `002`, and
`013`; multiprocess fsstress took 54 seconds. The TEST session completed 10,858
writes, 465 flushes, and 298 real kernel-issued FUA commands with zero backend
errors. It was then reopened under a fresh epoch, and all five read-only e2fsck
phases passed.

The matching XFS run used the same xfstests commit and passed `generic/001`,
`002`, and `013`; its multiprocess case took 66 seconds. The TEST volume
completed 8,106 writes, 591 flushes, and 279 real kernel-issued FUA commands;
the SCRATCH volume completed 616 writes, 14 flushes, and two FUA commands.
Both sessions returned zero backend errors. The TEST volume was reopened under
writer epoch 3, and `xfs_repair -n` completed all phases without finding
filesystem corruption.

The in-flight oracle passed its 16-case default matrix. The final 1 MiB row
observed legal cuts 0, 0, 1, and 2 at 0, 1, 10, and 20 ms. A separate five-run
sweep at 8, 10, 12, 14, and 16 ms hit `cut=1` every time: the first 512 KiB
SQLite transaction survived SIGKILL while the second did not. Recovery
returned neither torn 4 KiB data nor a non-prefix transaction combination.

The `dm-log-writes` gate replayed `after-a`, `after-b`, and clean-unmount `end`
into three independent fresh backends. Every prefix recovered the exact file
set and payload hashes and passed read-only `e2fsck`; the origin observed 579
writes, 16 flushes, 10 FUA commands, and zero backend errors. The `dm-flakey`
gate then forced explicit `error_reads error_writes`: both direct operations
returned `EIO`, recovery preserved all 16 known 4 KiB blocks, and the backend
stopped with zero errors or transport disconnects.

A harness-only 10-second soak used two `fsstress` processes and a 16 MiB `fsx`
bound. `fsx` completed 446 self-checked operations, the stress namespace ended
with 399 entries, and the first NBD session handled 3,035 writes, 191 flushes,
and 154 FUA commands with zero backend errors. Reopen advanced the epoch from
2 to 3; the sentinel and both five-phase `e2fsck -fn` runs matched. The 218 MiB
evidence footprint and short duration make this a harness validation, not the
required 7,200-second qualification result.

## Deliberate next gates

The local 2 GiB SQLite + COS-emulator reference is not currently admitted. The
recorded full 7,200-second soak predates the bounded NBD request drain. Current
code now maps NBD TRIM to versioned DISCARD, reconciles the kernel timeout's
unknown outcome by exact operation identity, and provides explicit retry-safe
MetaStore retention. Clean final-revision evidence for those gates and a new
7,200-second soak are still required. Exact blockers and historical evidence
are listed in [`QUALIFICATION.md`](QUALIFICATION.md).

A future PVM multi-queue submission cut, live FoundationDB cluster, Tencent COS
endpoints, self-describing pack/repack behavior, and production
performance/backpressure remain separate product gates after local admission.

[nbd-protocol]: https://github.com/NetworkBlockDevice/nbd/blob/master/doc/proto.md
