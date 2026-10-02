# Hermes upstream gateway handoff

The checkpoint-aware Python bootstrap can hand a pristine restored clone to
Hermes' canonical `hermes_cli.gateway.run_gateway()` lifecycle. The template
contains no config, credential, PID file, event loop, platform socket or
background thread. A clone may install `/opt/data/config.yaml`, then make one
bounded launch request containing explicitly named environment values. The
bootstrap closes its Unix listener before the upstream GatewayRunner starts.

The launcher does not treat its acknowledgement as readiness. It waits for a
new atomic `gateway_state.json` generation, checks that the status PID matches
the bootstrap process that accepted the handoff, and accepts only upstream's
`running` or `degraded` states. A stale status file supplied with a profile
cannot satisfy readiness.

## 2026-08-17 verification

The reproducible `rootfs/build.py hermes` path built the pinned, clean upstream
revision with the reviewed Dockerfile patch and passed `fsck.erofs`. The
uncompressed, 2 MiB-aligned release artifact is 3,047,161,856 bytes with SHA-256
`6d43820edeb378c56445f3886a06b5f80816a62a49078b9f6da4ca33cfbc9a73`.
Its metadata records `pep552-checked-hash-opt0-v1`; a read-only mount found
7,648 `.pyc` files and sampled both the application and virtual-environment
trees with PEP 552 flags `0x00000003` (checked hash with source validation).

The default release smoke exercised both the retained one-shot endpoint and a
separate pristine daemon clone:

```text
Python preload            2.410 s
template warm             3.258 s
RAM snapshot              0.958 s
fresh-process answer      4.234 s
warm-interpreter answer   1.371 s
single gateway handoff    2.616 s
```

The daemon had no configured messaging platforms and reached Hermes' supported
cron-only `gateway_state=running` state. Four independent daemon clones were
then launched concurrently:

```text
batch                                 3.961 s
clone create p50 / max                13.295 / 13.623 ms
control ready p50 / max               19.273 / 25.179 ms
launch-to-gateway-ready p50 / max     3.793 / 3.842 s
clone-to-gateway-ready p50 / max      3.812 / 3.863 s
```

All four wrote and validated their own clone-private PID/runtime state. The
20-clone point also completed without state or launch cross-talk:

```text
batch                                23.787 s
clone create p50 / max                58.336 / 62.525 ms
control ready p50 / max              136.398 / 156.354 ms
launch-to-gateway-ready p50 / max     22.535 / 23.601 s
clone-to-gateway-ready p50 / max      22.658 / 23.723 s
```

Compared with the pre-bytecode test artifact on the same host, checked-hash
bytecode reduced single-gateway readiness from 4.649 to 2.616 seconds,
four-way p50 from 6.663 to 3.793 seconds and 20-way p50 from 39.442 to 22.535
seconds. The separation remains important: at 20-way concurrency only about
0.14 seconds is clone/control readiness, while roughly 22.5 seconds is
contended Hermes/Python gateway initialization. That cost should not be
attributed to PVM clone. The matrix exposes the same check at 1, 4, 8 and 20
clones through `--concurrent-gateway-clones`.

The result also identified and avoided an unsafe checkpoint boundary:
importing the resource-owning `gateway.run` module before restore probes
profile `.env` state. The final template preloads only the side-effect-free
gateway CLI graph; `gateway.run`, dotenv, event-loop and external resource
initialization remain strictly post-clone.
