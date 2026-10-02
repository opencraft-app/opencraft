# PVM Linux scheduler benchmarks

This directory is deliberately independent from the production workspace and
guest overlay. It consumes the existing public `minisandbox-core` API and
extracts an already-built Debian EROFS into a private staging directory. Nothing
under `crates/`, `guest/`, or the workspace manifest is modified by these
benchmarks.

The isolation boundary is intentional:

- this directory is its own Cargo workspace;
- the dependency on `minisandbox-core` is one-way and uses only public APIs;
- benchmark guest files never enter the production guest overlay;
- generated binaries, staging roots, and EROFS images stay under the ignored
  `build/` and `target/` directories;
- deleting this directory removes the whole experiment without a production
  revert.

The suite measures:

- fixed-duration CPython integer, SHA-256, and Node/V8 loops at 1/4/8/16 clones;
- futex, pipe, and absolute-timer wake latency at p50/p99/p999;
- four-process single-vCPU fairness;
- periodic-tick cost while many clones sleep in an idle guest;
- a 30-second steady-idle A/B/C comparison of the native PVM halt path,
  per-VM `KVM_CAP_HALT_POLL=0`, and opt-in `HC_WAIT_UNTIL`;
- bounded 10 us high-resolution timer rearming as a hostile timer-load probe;
- known-count benchmark hypercalls under the persistent host execution timer.

## Build the private root image

First build the production kernel and maintained Debian root once, then run:

```text
./benchmarks/pvm-linux-scheduler/build-rootfs.sh
```

The script extracts the maintained Debian EROFS, installs only the benchmark
init and workloads in the temporary copy, compiles the static native latency
helper, and writes:

```text
benchmarks/pvm-linux-scheduler/build/debian-scheduler-bench.erofs
```

## Run

Run the standard matrix:

```text
./benchmarks/pvm-linux-scheduler/run-suite.sh
```

Or invoke one mode directly:

```text
cargo run --release \
  --manifest-path benchmarks/pvm-linux-scheduler/Cargo.toml -- \
  target/pvm-linux/build/arch/x86/boot/bzImage \
  benchmarks/pvm-linux-scheduler/build/debian-scheduler-bench.erofs \
  cpu-python 1,4,8,16 1000
```

The final argument is milliseconds for CPU, wakeup, fairness, and idle modes;
for `exit` it is the exact number of benchmark hypercalls per clone. Output is
JSON Lines plus the exact guest result line for each clone.

The workload intentionally uses guest monotonic time. Until PVM steal-time
accounting exists, its fixed-duration results include outer host descheduling;
that is part of what this suite is designed to expose.

Historical results from the removed guest profile were intentionally deleted;
new baselines must be recorded against this Debian image.

## Idle attribution

Run the long steady-state comparison separately from the normal suite:

```text
./benchmarks/pvm-linux-scheduler/run-idle-attribution.sh
```

The default is 64 clones for 30 seconds per variant. Override it without
editing the script, for example:

```text
MSBENCH_IDLE_COUNTS=1,64 \
MSBENCH_IDLE_DURATION_MS=60000 \
MSBENCH_IDLE_REPETITIONS=3 \
./benchmarks/pvm-linux-scheduler/run-idle-attribution.sh
```

With multiple repetitions the script rotates variant order so host warmup or
thermal drift cannot consistently favor the same variant.

Each JSON record attributes process CPU and runner-thread CPU, guest total and
timer interrupt deltas, `KVM_RUN` and host-visible HLT exits, internally
serviced UART/CMOS/block exits, fixed `WAIT_UNTIL` events, and CPU charged to
this process's `kvm-pit/<pid>` threads. The latter comes from each thread's
nanosecond `schedstat` runtime rather than coarse process CPU ticks.
The attribution script suppresses per-clone result lines by default; set
`MSBENCH_PRINT_GUEST_RESULTS=1` when investigating clone-level variance.
