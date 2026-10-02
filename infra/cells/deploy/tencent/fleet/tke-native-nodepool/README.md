# Portable TKE Native FDB node pool

This directory separates portable scheduling policy from regional cloud
inventory:

- `base/` owns one TKE `MachineSet`, `ZoneEquality`, the dedicated FDB taint,
  HOST-level placement spreading, BSSD system-disk policy and container runtime
  settings. It must not contain a concrete region, AZ, subnet, security group,
  key or Cell identity and must not be applied directly.
- `overlays/<cell>/` supplies the regional candidate subnets, instance types,
  security groups, keys, cloud tags, Cell identity and replica count.

Render the Beijing Cell without contacting a cluster:

```sh
kubectl kustomize overlays/actor-bj-k01
```

Release a reviewed envelope transactionally, with FDB/backup/ObserveOnly
preflight and exact rollback of the old `replicas/scaling` fields:

```sh
KUBECONFIG=/absolute/path/to/kubeconfig \
ACTOR_FDB_NODE_MIN=9 ACTOR_FDB_NODE_MAX=30 \
  ./release-envelope.sh
```

Applying the rendered object may create billable nodes. The production overlay
keeps `spec.replicas` and `minReplicas` at the nine-node safety floor and sets
`maxReplicas` to the profile's 30-process ceiling. The presence of
`spec.scaling` enables TKE's managed autoscaler. The fleet controller raises
`minReplicas` to the selected FDB process target before publishing that target
to the FDB Operator, so a pending stateful Pod is not the only scale-up signal.
After a downscale is healthy, backed up, and its released CBS volumes are
quarantined, the controller lowers the floor. TKE alone owns `spec.replicas`
and removes the empty Native nodes. `deletePolicy: Newest` is mandatory: the
fleet controller's per-zone removal plan selects the newest steady-state FDB
Pod/node in each zone, the Operator drains those exact process groups, and TKE
then retires the same now-empty Machines.

`ZoneEquality` is mandatory for every autoscaled step. A 9 -> 12 expansion is
therefore requested as one additional node per candidate zone without encoding
concrete AZ names. Node autoscaling must remain fail-closed whenever the FDB
profile is `ObserveOnly`; widening the MachineSet envelope alone never changes
the database process count.

## Topology contract

No application manifest contains a concrete AZ value. TKE chooses capacity
evenly from the overlay's candidate subnets using `ZoneEquality`. The Fleet
controller generates FDB Pod constraints using:

- `topology.kubernetes.io/zone`, `maxSkew: 1`, `DoNotSchedule`;
- required anti-affinity on `kubernetes.io/hostname`;
- one FDB process group per eligible node.

For three available zones this produces 1/1/1 for three Pods, 2/2/1 for five,
and 3/3/3 for nine. Those are placement shapes, not equivalent durability
claims. The current `three_data_hall` production profile requires nine process
groups and nine coordinators. Three- and five-node profiles require a separate,
weaker redundancy and admission contract before they may be offered.

## Adding another region

For Seoul or another region, copy only an overlay and replace:

1. candidate subnet IDs covering at least three real zones;
2. a qualified instance type available in every candidate zone;
3. the node security group and break-glass key ID;
4. Cell identity, cloud tags, nine-node floor and the profile-matched ceiling.

The controller, base MachineSet and FDB topology keys do not change. Admission
must prove that the resulting Nodes expose at least three distinct standard
zone-label values, satisfy `maxSkew: 1`, share no HOST placement failure domain,
and run the network and CBS CSI DaemonSets.

## TKE control-plane access

Use a TKE VPC-private cluster endpoint for fleet operations. During Beijing
qualification, TKE registered Native nodes as backends of the public API CLB;
the CLB reported every backend Alive while TLS handshakes failed. The private
endpoint continued to operate. Public API access is therefore not an accepted
production control path and is disabled after bootstrap.

References: [TKE Native node declarative operations](https://cloud.tencent.com/document/product/457/78649),
[Native node scaling and `ZoneEquality`](https://cloud.tencent.com/document/product/457/78648).
