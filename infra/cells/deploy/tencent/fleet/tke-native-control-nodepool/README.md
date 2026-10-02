# Portable TKE Native control capacity

This MachineSet supplies the stable, non-Actor capacity for Engine, Pegboard
Envoy, NATS and Cell management agents. It is physically separate from both
the tainted Actor compute pool in `tke-native-runtime-nodepool` and the
dedicated FDB pool in `tke-native-nodepool`.

The base owns a three-node, three-zone `ZoneEquality` contract. The regional
overlay supplies cloud inventory and the immutable Cell identity. Control
nodes deliberately carry neither `rivet.dev/compute=true` nor
`rivet.dev/pvm=true`; `/dev/kvm` must never be registered on this pool.

The production overlays use `SA9.4XLARGE32` (16 vCPU, 32 GiB) in each zone.
The 10,000-active-Agent qualification proved that the earlier three-node,
8-vCPU envelope saturated at 22.49 of 24 total Engine cores even though FDB
write utilization remained below 0.22. Six Engine replicas reserve four cores
and may burst to six; two Engines per zone therefore retain four physical cores
for Kubernetes, NATS, controllers, and observability at the Engine limit. A
production control pool must retain that physical headroom as well as enough
schedulable request capacity after evicting one zone's Engines; steady-state
Ready alone is not a capacity or upgrade qualification.

Render and review before applying billable capacity:

```sh
kubectl kustomize overlays/actor-bj-k01
KUBECONFIG=/path/to/admin.kubeconfig ./install.sh overlays/actor-bj-k01
```

For q01, select the renamed MachineSet explicitly:

```sh
CONTROL_MACHINE_SET=np-control1 \
KUBECONFIG=/path/to/actor-bj-q01.kubeconfig \
./install.sh overlays/actor-bj-q01
```

TKE treats the CPU/memory shape of an existing MachineSet as immutable. A
shape upgrade must therefore create a new generation (for example
`np-control1` carrying `fleet.actor.dev/control-pool-generation=v2`), wait for
all three zones, move control workloads onto that generation, and reduce the
old MachineSet one replica at a time. Each reduction must wait for every
Deployment/StatefulSet and PDB to recover before the next replica is removed.
Afterward, publish the new `machineSetName` and `generation` in the reviewed
Cell spec so Argo owns the replacement and prunes the empty predecessor. An
unpublished replacement is running capacity, but it is not reconstructable
desired state.

Install this pool before changing Engine or NATS scheduling. Wait for all
three zones to become Ready, release the control workloads onto this pool,
and only then taint or replace the former mixed runtime nodes. The installer
fails if a selected control node also advertises compute, PVM, or FDB identity.

The timeout path must retain the result of the actual Node topology check.
Cloud Ready replica counts cannot turn an unsuccessful three-zone check into
a successful install. The same rule applies to the runtime pool installer.
Run `python3 test_install_topology.py` for both installers' real CLI regression
cases, including an initially Ready `2/0/1` pool.
