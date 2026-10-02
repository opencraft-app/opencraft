# PVM Linux guest

This is the production guest direction for minisandbox. A complete PVM-aware
Linux kernel and its applications are untrusted guest state. Linux implements
the broad syscall surface internally; minisandbox exposes only bounded devices
and an eventual capability ring at the outer PVM boundary.

The source is pinned in `source.toml`; `minisandbox.config` is a deliberately
small config fragment merged over `allnoconfig`. Source and build trees live in
ignored `target/pvm-linux/` paths and are never linked into the minisandbox host
binary.

The default source is the `loopholelabs/linux-pvm` `pvm-v6.7` commit matching
the installed 6.7.12 PVM provider. Its legacy PVCS layout, event-enable flag,
and `MSR_PVM_RETS_RIP` startup contract are intentionally not interchangeable
with the newer `virt-pvm/linux` ABI.

`patches/0001-map-decompression-output-before-pvm-events.patch` closes one
64-bit direct-boot bootstrap gap: after the decompressor replaces the loader's
page tables but before PVM events exist, it explicitly preserves the output
identity mapping. The patch changes no runtime syscall or hypercall surface.
`source.toml` records the exact upstream base commit for every patch and
`patches/series` records replay order. `cargo xtask pvm-linux configure`
reconstructs the guest from those inputs; changes under `target/pvm-linux/`
are generated state and are never the source of truth.

`patches/0002-register-pmem-resources-without-pci.patch` closes an x86 init
ordering gap: upstream normally registers non-busy E820 resources during the
PCI survey, but this guest deliberately has `CONFIG_PCI=n`. In the PVM/no-PCI
configuration it invokes the existing late E820 registration directly, making
the type-12 range visible to `e820_pmem` without adding a PCI surface.

`patches/0003-publish-pvm-idle-deadline-to-minisandbox.patch` is an opt-in
idle-scheduling experiment. With `minisandbox.wait_until=1`, the PVM idle path
reads the already-programmed per-CPU clockevent deadline, sends one relative
nanosecond value through fixed hypercall operation 7, and then still executes
`PVM_HC_IRQ_HALT`. The existing atomic virtual-interrupt enable and LAPIC
deadline therefore remain the correctness fallback. The option is deliberately
off by default: the 64-clone attribution benchmark has not shown a material CPU
win over the provider's native halt path.

The added host parser is one versioned 32-bit operation word plus one `u64`
relative timeout read from `RDI`; it accepts no guest address, length,
descriptor, or queue index. The runtime caps every wait by the already-armed
host run deadline, keeps waits below 50 us in KVM, and uses one fixed eventfd
allocated with the machine rather than allocating per request. The first wait
only arms device-wake forwarding and immediately re-enters KVM, closing the
race with an IRQ already being raised. Guests that never use operation 7 add no
eventfd write to the normal IRQ path. A malicious guest can force PIO exits,
short waits, and host scheduling work on its own runner until its run deadline;
it cannot create host descriptors or memory through this operation, select an
IRQ, extend the host deadline, or make the runtime dereference guest memory.

`patches/0004-expose-native-inet-kernel-socket-factory.patch` supports true
guest-local TCP without surrendering public `PF_INET` routing. It exposes a
kernel-only native INET constructor, uses it for IPv4 control sockets, and
suppresses native INET's public family registration when the PVM provider is
built. It adds no hypercall, guest pointer, host parser, or host file
descriptor.

The PVM socket provider is maintained separately under
`socket-service/guest/`, then copied into `net/pvm_socket/` by the reproducible
overlay installer. The kernel has `CONFIG_INET=y`, but the provider alone
registers public `PF_INET`: TCP `127/8` and wildcard listeners use hidden
native guest INET, while non-loopback TCP and restricted UDP DNS use the fixed
clone-private mailbox. Its exact source hashes are recorded in `source.toml`.
Mailbox ABI v6 retains the four fixed wrapping event indices from v5 and adds
bounded host TCP offer/accept commands without changing descriptor size,
mailbox mappings, IRQ, or hypercall. Guest listeners remain local until the
host explicitly stages a stream; accepted ingress children use the same broker
data path and capability quotas as outbound TCP. The indices allow the guest
and broker to suppress redundant command doorbells, response IRQs,
and reverse credit notifications without adding a hypercall or variable-length
parser. Each arm/recheck and cursor/event producer pair uses a full memory
barrier; event indices remain notification hints and never cursor authority.

The immutable root path uses native x86 legacy PMEM rather than a custom
filesystem transport. The host opens the base EROFS artifact read-only and maps
its existing page cache directly into KVM slot 1 with both `PROT_READ` and
`KVM_MEM_READONLY`; the guest command line marks that GPA range with
`memmap=<size>!<start>`. The mapping is demand-paged and not locked in RAM; the
trusted host must keep the artifact immutable while templates exist. Built-in
`e820_pmem`, `pmem`, and EROFS drivers expose `/dev/pmem0`, mounted read-only
with `dax=always`. The image must be uncompressed, use 4096-byte blocks, and be
padded to the PMEM subsection alignment (2 MiB on this kernel).

The fixed application layer uses a second type-12 range at 16 GiB and audited
KVM slot 4. Linux names it `/dev/pmem1`. With
`minisandbox.app_layer=1`, PID 1 mounts it read-only and uses
`lowerdir=/run/minisandbox-app:/`, so app paths override base paths before the
private ext4 upper is considered. Slots 2/3 remain the socket service; no new
hypercall, device parser, or guest-writable shared-memory protocol is added.

## Writable root with bounded virtio-blk

The writable layer uses the kernel's standard built-in virtio-mmio,
virtio-blk, ext4, and OverlayFS drivers. This milestone changes only
`minisandbox.config`; it carries no new guest Linux source patch or hypercall.
That distinction is part of the source record: the exact config change is
versioned in this repository, while the existing guest patch series and pinned
Linux base remain unchanged.

The host parser lives independently in `block-service/` and pins rust-vmm's
`vm-virtio` workspace commit
`87bf424736548126983c278b0d49a7b061e38b12`. PVM exposes three fixed modern
virtio-mmio attachment points, each with an independent queue of size 128. The
system disk is at `0x100100000`, IRQ 5; the persistent ActorVolume COW disk is
at `0x100101000`, IRQ 6; and its immutable ext3 template is at `0x100102000`,
IRQ 7. All register pages are above the 3 GiB RAM ceiling and
the socket mailbox, so large agent profiles cannot silently turn device accesses
into ordinary RAM. Linux discovers them from explicit command-line tokens, so
no PCI or ACPI device surface is needed:

```text
virtio_mmio.device=4K@0x100100000:5
virtio_mmio.device=4K@0x100101000:6
```

The warm machine attaches only the first device. Reads from the reserved but
absent ActorVolume page return zero, so Linux leaves that platform device
unbound. A clone injects one opaque generation-fenced sparse ext3 backend before
state restore. Consequently no ActorVolume queue, block cache,
inode, or journal state leaks into the global warm template.

The dedicated E2E warms `/dev/vda`, injects the persistent sparse ext3 volume
into a clone, and rebinds the failed warm probe. It writes a marker and a temporary allocation,
deletes the allocation, runs `fstrim`, and proves DISCARD reached the persistent
backing. It then performs the real PID-1 graceful shutdown and starts a second
clone over the same volume to prove the marker survived detach and recreation:

```text
python3 rootfs/build.py upper --output target/pvm-linux/system-upper.ext4
python3 rootfs/build.py actor-volume-template \
  --output target/pvm-linux/actor-volume-template.ext3 --size-mib 2048
cargo run -p minisandbox-core --example pvm_linux_actor_volume -- \
  target/pvm-linux/build/arch/x86/boot/bzImage \
  target/pvm-linux/debian-trixie-20260713-x86_64.erofs \
  target/pvm-linux/system-upper.ext4 \
  target/pvm-linux/block-clones \
  target/pvm-linux/actor-volume-template.ext3
```

Build a fresh 2 GiB sparse ext4 upper, then run a direct writable guest:

```text
python3 rootfs/build.py upper
cargo run -p minisandbox-core --example pvm_linux_overlay -- \
  target/pvm-linux/build/arch/x86/boot/bzImage \
  target/pvm-linux/debian-trixie-20260713-x86_64.erofs \
  target/pvm-linux/minisandbox-upper-2g.ext4
```

The maintained init mounts the immutable EROFS as the lower layer and ext4
`/dev/vda` as the persistent `upper`/`work` storage, then pivots into the
writable OverlayFS. `MINISANDBOX_OVERLAYFS_OK` is emitted only after a root
write/remove probe succeeds.

Warm-checkpoint the resulting Python process and create at least two isolated
RAM-and-disk clones with:

```text
python3 rootfs/build.py upper \
  --output target/pvm-linux/minisandbox-upper-warm-2g.ext4
cargo run -p minisandbox-core --example pvm_linux_overlay_clone -- \
  target/pvm-linux/build/arch/x86/boot/bzImage \
  target/pvm-linux/debian-trixie-20260713-x86_64.erofs \
  target/pvm-linux/minisandbox-upper-warm-2g.ext4 \
  target/pvm-linux/block-clones 2
```

At the stopped checkpoint boundary the host drains and syncs virtio-blk,
snapshots its queue/config/interrupt state, then retains an unlinked block
baseline. Each clone receives a distinct unlinked writable file. `FICLONE` is
used when the pool filesystem supports it (for example suitably configured
XFS); otherwise only allocated sparse extents are copied. Python creates one
nonce-named marker file after resume. The nonce is generated before checkpoint
and shared by that checkpoint's clones, but changes on the next benchmark run;
success from both sequential clones therefore proves that neither sibling
observed the other's ext4 changes without requiring a pristine reusable upper.
The immutable EROFS mapping and 256 MiB `MAP_PRIVATE` RAM template remain shared
as before.

### Database-backed block volumes (no block image)

PVM also accepts an opaque typed block backend. In this path the machine owns
no writable block-image fd or path and does not use NBD at runtime:

```text
guest /dev/vda
  -> bounded virtio-mmio request parser
  -> BlockBackend
  -> SQLite hot/meta reference implementation
  -> Tencent COS emulator cold tier
```

The SQLite database is currently a local file; it stands in for the future
remote FDB repository. “No block image” therefore means no `upper.ext4` image,
loop/NBD device, reflink, sparse copy, or per-sandbox block file. It does not
mean the current reference MetaStore is memory-only.

After provisioning an ext4 logical volume in the database, run it directly:

```text
cargo run -p minisandbox-core --example pvm_linux_sqlite -- \
  target/pvm-linux/build/arch/x86/boot/bzImage \
  target/pvm-linux/debian-trixie-20260713-x86_64.erofs \
  /path/to/blocks.db /path/to/cos-root volume-id
```

Warm-checkpoint it and prove two sibling volume forks remain private:

```text
cargo run -p minisandbox-core --example pvm_linux_sqlite_clone -- \
  target/pvm-linux/build/arch/x86/boot/bzImage \
  target/pvm-linux/debian-trixie-20260713-x86_64.erofs \
  /path/to/blocks.db /path/to/cos-root volume-id 2
```

Checkpoint ordering is vCPU stop, virtqueue drain, SQLite FLUSH barrier, RAM
capture, then repository snapshot. Snapshot commit fences the warm writer.
Every clone performs an O(1) metadata fork and receives a fresh writer epoch;
the guest-visible device and saved virtio queue state are restored normally.

Build the current boot milestone with:

```text
cargo xtask pvm-linux prepare
cargo xtask pvm-linux configure
cargo xtask pvm-linux build
cargo xtask pvm-linux initramfs
```

Kernel artifacts:

```text
target/pvm-linux/build/arch/x86/boot/bzImage
target/pvm-linux/minisandbox-initramfs.cpio
```

The maintained Debian userspace is built by the standalone build-time adapter
(not by the Rust runtime):

```text
python3 rootfs/build.py debian
```

It produces `target/pvm-linux/debian-trixie-20260713-x86_64.erofs` plus a
provenance sidecar. See `rootfs/README.md` for OCI import and the exact
Docker-compatibility boundary.

After both artifacts exist, run the live PVM smoke with:

```text
cargo run -p minisandbox-core --example pvm_linux -- \
  target/pvm-linux/build/arch/x86/boot/bzImage \
  target/pvm-linux/minisandbox-initramfs.cpio
```

The smoke `/init` deliberately exercises `fork`, `execve`, `waitpid`, pipes,
`eventfd`, `epoll`, futex, signals, `mmap`, `mprotect`, and `munmap`. Seeing
`MINISANDBOX_PVM_LINUX_OK` on the emulated serial console proves those calls
were handled inside the guest kernel rather than forwarded as host syscalls.
It also verifies cross-process loopback TCP, a client registered with epoll
before `connect`, and a listener kept open across checkpoint/resume. The two
completion markers are `MINISANDBOX_PVM_LOCAL_TCP_OK` and
`MINISANDBOX_PVM_LOCAL_TCP_RESUMED_OK`; this path allocates no broker
capability and emits no service notification.

Run the transparent TCP/IRQ smoke with:

```text
cargo run -p minisandbox-core --example pvm_socket -- \
  target/pvm-linux/build/arch/x86/boot/bzImage \
  target/pvm-linux/minisandbox-initramfs.cpio
```

Seeing `MINISANDBOX_PVM_SOCKET_OK` proves a guest-native
`socket/connect/send/recv/close` round trip through the bounded rings, Rust TCP
broker, and irqfd-backed service interrupt. The companion
`MINISANDBOX_PVM_SOCKET_STREAM_FIFO_OK` marker covers a deterministic stream
larger than six RX slots, with unaligned reads that force slot reuse and verify
TCP byte order. `MINISANDBOX_PVM_SOCKET_CLOSE_DRAIN_OK` additionally proves
that an immediate `close(2)` does not cancel bytes already accepted by
`send(2)`. The warm-clone lifecycle path also emits
`MINISANDBOX_PVM_SOCKET_HALF_CLOSE_OK` after peer FIN, reverse-direction TX,
ordered guest `SHUT_WR`, and post-shutdown `EPIPE`; an abortive peer close must
separately emit `MINISANDBOX_PVM_SOCKET_RST_OK`.

Run the typed host-ingress and teardown smoke with:

```text
cargo run --locked --release -p minisandbox-core \
  --example pvm_socket_ingress -- \
  target/pvm-linux/build/arch/x86/boot/bzImage \
  target/pvm-linux/minisandbox-initramfs.cpio
```

It cancels one ACKed offer before `accept(2)`, completes a separate
bidirectional accepted stream, races 64 injectors against destruction of an
actual clone, and proves the destroyed clone's retained handle cannot submit
into the fresh clone.

Run the default-deny public DNS and HTTPS TCP smoke with one explicitly chosen
resolver:

```text
cargo run -p minisandbox-core --example pvm_socket_public -- \
  target/pvm-linux/build/arch/x86/boot/bzImage \
  target/pvm-linux/minisandbox-initramfs.cpio \
  <resolver-ipv4> example.com
```

The host prints the exact resolver `IP:53` and every HTTPS `IP:443` inserted
into the two independent allowlists. Success markers are
`MINISANDBOX_PVM_DNS_OK` and `MINISANDBOX_PVM_HTTPS_TCP_OK`.

Run the immutable Debian/glibc/Python PMEM/DAX profile without an initramfs:

```text
cargo run -p minisandbox-core --example pvm_linux -- \
  target/pvm-linux/build/arch/x86/boot/bzImage \
  /dev/null \
  target/pvm-linux/debian-trixie-20260713-x86_64.erofs
```

Its Rust PID 1 mounts procfs, sysfs, devpts, and bounded tmpfs instances,
supervises one workload process group, reaps all guest children, and powers off
without ever returning from global PID 1. The warm workload script verifies the
Debian glibc/Python userspace and the maintained command
set (`curl`, `wget`, `vim`, `strace`, `screen`, `tmux`, `git`, `gcc`, and
`node`), then executes Node, strace, and a GCC compile/link/run probe inside
the PVM. It publishes `MINISANDBOX_DEBIAN_TOOLS_OK`,
`MINISANDBOX_DEBIAN_GLIBC_PYTHON_OK`, and the generic
`MINISANDBOX_EROFS_DAX_OK` marker before entering the warm Python workload.

The same init implementation is available as both the main CLI subcommand and
a standalone guest artifact:

```text
cargo build --locked --release -p minisandbox-cli -p minisandbox-init --bins
target/release/minisandbox init --help
target/release/minisandbox-init --help
```

This userspace change adds no Linux source patch and no new host hypercall. The
guest driver exposes the already-reserved, status-byte-bounded `Exit` operation
to PID 1 only through its mode-0600 control device. Its
source and dependency lock are committed in this repository; the built binary
hash is also written to `/usr/share/minisandbox/init.sha256` in the maintained
Debian image.

## Warm CPython checkpoint and clones

The default `warm` mode starts `/opt/minisandbox/minisandbox-warm`, whose final
operation execs `python3 /opt/minisandbox/python-warm.py` as PID 1's supervised
workload.
Python imports its modules, allocates and pre-faults a 64-page application
working set, and then calls `ioctl(MINISANDBOX_IOCTL_CHECKPOINT)`. The built-in
guest driver issues a completed four-byte PIO hypercall while preemption is
disabled. Since this configuration has one vCPU, the exit is a quiescent
checkpoint boundary.

The host captures general and special registers, XSAVE/XCR state, debug state,
MSRs including PVM control MSRs, vCPU events, MP/LAPIC state, PIC/IOAPIC, PIT,
clock, UART, and CMOS. It seals the 256 MiB RAM image once. Every clone maps
that RAM memfd with `MAP_PRIVATE`, maps the same EROFS memfd read-only, restores
the captured state, and enables KVM dirty logging on RAM slot zero.

`minisandbox.block_stress=1` enables the bounded filesystem workload in
`block_stress.py` after the checkpoint. Four forked guest workers use disjoint
directories on the clone-private ext4 upper, perform dense/sparse writes and
metadata mutations, fsync files and directories, and validate every surviving
extent by SHA-256 before publishing
`MINISANDBOX_PYTHON_BLOCK_STRESS_OK`. The mode is opt-in so the ordinary clone
latency benchmark remains comparable.

### PVM wall-clock model

This PVM guest uses `clocksource=tsc tsc=reliable`; it does not register Linux's
`kvm-clock`. The host therefore does not depend on pvclock or
`KVM_CLOCK_REALTIME`. The auditable legacy RTC boundary is isolated in
`crates/minisandbox-pvm-sys/src/machine/legacy_cmos.rs`. Its first calendar-data
read latches a coherent BCD UTC timestamp directly from host `CLOCK_REALTIME`,
replacing the earlier fixed 2024 epoch. It implements no alarm, periodic IRQ,
or continuously ticking RTC. This fix changes no guest kernel overlay and adds
no hypercall ABI operation.

After boot, normal `clock_gettime()` calls remain guest vDSO/TSC operations and
cause no host exit. Warm templates and clones currently remain on the same PVM
provider and host TSC, so both realtime and monotonic time naturally include
the interval while a template is parked. Restore only re-arms the RTC latch so
a later explicit `hwclock`-style read also sees clone-start UTC. Cross-host
migration is outside this clock contract and will require explicit virtual-TSC
frequency/offset handling before it can be enabled safely.

Run the release benchmark with:

```text
cargo run --release -p minisandbox-core --example pvm_linux_clone -- \
  target/pvm-linux/build/arch/x86/boot/bzImage \
  target/pvm-linux/debian-trixie-20260713-x86_64.erofs \
  8
```

Immediately after the checkpoint ioctl returns, Python calls a second
measurement-only ioctl. Its typed `BenchmarkPoint` hypercall measures resume
latency without including a serial string's per-character exits. Python then
updates all 64 preallocated pages and emits a checksum marker together with
observed realtime and monotonic nanoseconds. `private_pages`
is the number of distinct RAM GPAs KVM observed being written and not later
returned to the template; because each clone uses `MAP_PRIVATE`, those pages
are that clone's outstanding COW-private set.

One release run on the development host produced a roughly 0.9--1.2 ms
post-cold clone construction time, 0.9--1.2 ms restore-to-Python benchmark
point, 8.3--8.8 ms through the 64-page workload and console marker, and
132--134 dirty pages (528--536 KiB) per clone. These are host-specific samples,
not a stable performance contract. The first VM creation in the run paid a
separate roughly 9 ms cold KVM cost.

This milestone still uses the PVM project's known guest config and a legacy
PIT/8250 boot surface. A later device milestone should replace data-plane exits
with a shared capability ring; only notify/checkpoint/page-report/exit remain
synchronous during development, with the benchmark operation removable from a
production ABI. Linux socket tasks sleep on ordinary waitqueues; there is no
whole-vCPU `HC_WAIT` operation.

## Stream-service implementation baseline

The first stream-service host-exit is now reserved as
`PvmHypercall::ServiceNotify = 6`, encoded as `0x4d53_0106`. RDI contains only
a nonzero queue-set mask; ABI v1 currently accepts bit zero, the fixed command
ring. Zero, unknown bits, pointers, GPAs, descriptor counts, capability IDs and
network endpoints are rejected at the low-level PVM exit boundary. A runtime
without a configured broker fails the run explicitly rather than silently
consuming the notification.

`minisandbox_guest.c` and `socket-service/guest/` are hashed source overlays
rather than edits hidden in a generated Linux tree. The latter contains the
public `PF_INET` TCP/restricted-DNS provider, hidden native-loopback adapter,
matching C ABI header, Kconfig, and Makefile. `source.toml` pins every file
hash. Generated changes under `target/pvm-linux/source` are never the source
record.

The guest enables Linux's existing `NO_HZ_IDLE` and `HIGH_RES_TIMERS` support.
On the pinned PVM provider, Linux uses TSC as its clocksource and the KVM
in-kernel LAPIC timer as its clockevent. High-resolution timers reduce
`CLOCK_MONOTONIC`'s advertised resolution from the `HZ=250` 4 ms jiffy to 1 ns,
while `NO_HZ_IDLE` stops the scheduler tick when the single vCPU has no runnable
work. Neither feature adds a minisandbox hypercall, host parser, fd, worker, or
guest memory mapping.

This is also the smaller untrusted-guest boundary. A malicious PVM supervisor
could already reprogram its existing LAPIC timer at high frequency, regardless
of Linux's config. A separate `NEXT_TICK` hypercall would add a second host
timer parser/state machine and rearm-churn surface without removing that KVM
surface, so it is deliberately not introduced. The standalone scheduler suite
keeps both one-millisecond absolute-timer latency and 1/4/16/64/128 parked-clone
cost as regressions for this decision.

## Returning private pages to the template

The guest enables Linux 6.7's existing `PAGE_REPORTING` framework after a clone
returns from the checkpoint hypercall. Buddy-free pages are temporarily
isolated by Linux, encoded in a fixed 4 KiB descriptor page, and reported in
bounded batches through `PvmHypercall::PageReport`. The descriptor GPA is
published once at checkpoint and is immutable for the lifetime of every clone;
runtime page-report calls carry no guest-selected pointer.

The complete host input boundary lives in
`crates/minisandbox-pvm-sys/src/machine/page_reclaim.rs`. It copies the fixed
descriptor before parsing, validates all counts, flags, alignment, arithmetic,
slot-zero bounds and overlap, intersects the ranges with a host-owned lifetime
private bitmap, and applies `MADV_DONTNEED` only to coalesced ranges in that
clone's sealed-memfd `MAP_PRIVATE` mapping. A successful discard clears those
private bits; a later guest write is logged by KVM and becomes private again.

The first reporting callback drains the single-vCPU guest's per-CPU free-page
cache once. This makes pages released immediately after checkpoint visible to
the initial delayed buddy scan without adding a periodic guest timer. Normal
reports remain event-triggered, delayed and batched by Linux. An untrusted guest
can falsely discard its own live RAM, but checked GPA-to-HVA translation and the
private mapping prevent it from modifying the template, a sibling clone, the
EROFS slot, or unrelated host memory.

Checkpoint publication is a one-shot lifecycle transition. The guest driver
sets an atomic latch before the completed checkpoint `OUT`, so the sealed image
contains the consumed state: each clone completes the original ioctl once, but
a newly issued checkpoint ioctl returns `EALREADY` without a host exit. This is
only a misuse guard. A malicious supervisor can execute `OUT` directly, so the
host runner independently treats `CheckpointReady` from an already-running
clone as a fatal protocol violation. No guest flag is trusted as the security
boundary.

The optional live reclaim probe materializes and releases 4096 post-checkpoint
private anonymous pages:

```text
cargo run --release -p minisandbox-core --example pvm_linux_clone -- \
  target/pvm-linux/build/arch/x86/boot/bzImage \
  target/pvm-linux/debian-trixie-20260713-x86_64.erofs \
  1 --reclaim
```

One development-host run handled six bounded reports, returned 4151 pages to
the template, and finished with 276 private pages (1104 KiB). The clone resumed
and reached Python's post-report marker after the KVM MMU notifier invalidated
the discarded mappings. These values are validation samples, not stable
performance contracts.

The concurrent mode creates every clone from the same template first, then
moves each independent VM to a host worker and enters all vCPUs together:

```text
cargo run --release -p minisandbox-core --example pvm_linux_clone -- \
  target/pvm-linux/build/arch/x86/boot/bzImage \
  target/pvm-linux/debian-trixie-20260713-x86_64.erofs \
  8 --concurrent-reclaim
```

On the same development host, eight concurrent clones completed in 3282 ms,
versus 24596 ms for eight sequential clones. Every concurrent clone handled six
reports and returned exactly 4151 pages; the batch returned 33208 pages and
retained 2208 private pages. Concurrent resume latency ranged from 19 to 34 ms,
compared with roughly 3.3 ms without contention. This demonstrates the expected
outer host-scheduler jitter while keeping each clone's reclaim state isolated.
