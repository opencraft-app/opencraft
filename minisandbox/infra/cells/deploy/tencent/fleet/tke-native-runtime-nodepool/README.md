# Portable TKE Native Actor compute capacity

This MachineSet supplies ordinary Actor execution capacity for workerd hosts.
It is physically separate from `tke-native-control-nodepool`, which runs
Engine, NATS and Cell agents, and from `tke-native-nodepool`, whose nodes are
tainted and dedicated to FDB.

The base owns the portable contract: three initial postpaid Native nodes,
`ZoneEquality`, a BSSD system disk, and the
`rivet.dev/compute=true:NoSchedule` taint. Only Actor runtime Pods may tolerate
that taint. Unlike the small control and FDB pools, elastic runtime capacity
must not set TKE's `spread-placement-group-type` or `spread-placement-group-id`
labels. TKE binds the whole MachineSet to one Tencent placement group, whose
CVM quota becomes a hidden ceiling below the declared `maxReplicas`. Runtime
Pods already have hard zone/hostname spreading, while Actor generations and
durable FDB ownership make a runtime Node disposable.
The regional overlay supplies candidate subnets, a region-qualified instance
type, security group, break-glass key and Cell tags. Applications schedule with
`topology.kubernetes.io/zone` and `kubernetes.io/hostname`; they never select a
concrete availability zone.

Render and review before applying billable capacity, then use the checked-in
installer so Machine reconciliation is not confused with Kubernetes Node
readiness:

```sh
kubectl kustomize overlays/actor-bj-k01
KUBECONFIG=/path/to/admin.kubeconfig ./install.sh overlays/actor-bj-k01
```

The first Beijing Cell uses three `SA9.LARGE8` nodes in a 1/1/1 shape. Automatic
scaling and repair remain disabled until their replacement drills pass. Scaling
the fleet means changing the declarative MachineSet replica envelope, not
editing application AZs or attaching individual CVMs by hand.

Tencent documents placement-group labels as immutable after a native node pool
is created. A legacy runtime MachineSet that already has one must therefore be
replaced by a new MachineSet without either placement label; do not try to
delete the label in place. Admit the replacement Nodes with their exact new
MachineSet UID before draining the legacy pool, and never force-delete a Node
that still hosts an Actor runtime Pod.

These TKE Native nodes are not PVM-qualified. Standard CVM capacity must not be
labelled `rivet.dev/pvm=true` merely because the workload wants KVM. A PVM
compute node must independently prove a usable `/dev/kvm` (for example on
registered bare metal) before the KVM device plugin and sbxlet can run there.
