# Local PVM runtime deployment

This directory deploys the `minisandbox-hermes-v1` PVM execution pool into the existing local
runtime A/B clusters. It is intentionally separate from `mesh/`: the Fleet topology can be
qualified without PVM, while this package owns the kernel/EROFS image, exact `/dev/kvm` grant,
`sbxlet`, runner config, and PVM-specific admission tests.

## Security boundary

`sbxlet` is not privileged. It runs as UID/GID 4059 with the runtime-default seccomp profile, a
read-only root filesystem, no Linux capabilities, and no service-account token. The only host
device it receives is the `rivet.dev/kvm` extended resource. A separate, pinned generic device
plugin runs privileged on `rivet.dev/pvm=true` nodes solely to register `/dev/kvm` with kubelet;
the Kubernetes device-plugin socket necessarily requires privileged access.

Every PVM node also carries `rivet.dev/compute=true:NoSchedule`. Both the device plugin and sbxlet
select the compute and PVM identities and tolerate only that exact taint. Engine and other control
workloads stay on `rivet.dev/control=true` nodes and cannot share the PVM host kernel or memory
failure domain.

The kernel, base EROFS, application EROFS, and sparse ext4 ActorBlockVolume template are immutable
operator image assets. Each `sbxlet` Pod creates a sparse ext4 system upper in `emptyDir`; this is
clone-private and intentionally not durable. The system upper mounts with
`noatime,lazytime,discard,commit=20`. The persistent ActorBlockVolume uses 4 MiB immutable COS
objects, 4 KiB FDB hot pages, and mounts with `noatime,lazytime,discard,commit=5`.
Deployment resolves the Engine's live `fdb-config` ConfigMap instead of deriving its name; the
verifier rejects any Engine/PVM FDB mismatch because the Actor generation fence must be read from
the same UniversalDB cluster that owns Pegboard state.

## Build and deploy

Large build outputs and the Docker image archive live under `/data/build-cache/minisandbox/deployment` by
default. The image embeds content hashes for `sbxlet`, the PVM Linux kernel, and both EROFS layers.

```sh
infra/cells/deploy/local/pvm-runtime/build-image.sh
infra/cells/deploy/local/pvm-runtime/deploy.sh
infra/cells/deploy/local/pvm-runtime/verify.sh
```

`deploy.sh` imports the image archive directly into only the PVM-labeled k3d nodes, registers
`minisandbox-hermes-v1` before starting `sbxlet`, installs one runtime host in each Cell, and waits
for the Envoys to become active. A restricted CronJob repeats the idempotent runner-config PUT once
per minute, so replacing the Cell's FDB or losing the record converges without another PVM deploy.
The reconciler has no service-account token, `/dev/kvm`, host mount, runtime credential, or guest
input. It reuses the Engine image and is pinned to the trusted control node, so no api-peer control
authority is introduced into the PVM compute-node boundary.

## Qualification

```sh
infra/cells/deploy/local/pvm-runtime/qualify.sh
```

The qualification creates concurrent PVM-backed Hermes Rivet Actors split across A/B, reaches
each through the opposite Cell, verifies authenticated HTTP, sleeps and wakes all Actors, destroys
them, and runs the live PVM COW conformance suite. Evidence is written under
`~/.agents/benchmarks/pvm-runtime/` unless `PVM_EVIDENCE_DIR` is set.
