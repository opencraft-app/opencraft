# workerd Pod and node autoscaling E2E

This destructive, bounded qualification proves the complete local autoscaling chain against one
otherwise idle runtime Cell:

```text
Actor slots fill
  -> Kubernetes HPA scales runtime-host StatefulSet 1 -> 2
  -> hard hostname anti-affinity leaves ordinal 1 Unschedulable
  -> the local k3d provider creates a real compute agent Node
  -> ordinal 1 becomes Ready on the new Node
  -> the pending Actor is admitted by the new Host
  -> deleting the qualification Actors leaves HPA scale-down disabled
  -> the dedicated serial Host-drain controller owns production scale-in
  -> this harness manually removes the now-empty Host and qualification Node
```

The HPA uses the per-Pod `rivet_workerd_active_actors` custom metric through the official
Prometheus Adapter chart. Its target is `capacity - 1`, retaining one Actor slot of headroom per
Host. The test temporarily adds the same required hostname anti-affinity used by the production
manifest. It records the HPA, Pod, Node and exact Host-registry transitions instead of treating a
replica patch as autoscaling evidence.

The HPA is intentionally scale-up-only. Live-actor scale-in is separately proved by
`workerd-host-drain-e2e`; allowing both HPA and the Host-drain state machine to lower StatefulSet
replicas would reintroduce the race the drain controller exists to remove.

The k3d provider is deliberately only the local cloud-provider boundary: it observes an actual
Unschedulable Pod and creates/deletes a real k3s agent container. It does not claim to qualify
Tencent's implementation. The corresponding production gate must observe the TKE MachineSet and
CA events with `minReplicas < maxReplicas`.

Run after the real runtime and spoke observability stack are healthy:

```sh
python3 infra/cells/deploy/local/mesh/workerd-autoscaling-e2e/run.py \
  --kubeconfig "${MESH_STATE_DIR:-$HOME/.local/state/rivet-local-mesh}/runtime-b.kubeconfig" \
  --cluster rivet-runtime-b \
  --cell local-runtime-b
```

The Cell must start with exactly one empty runtime Host and one compute agent. The harness refuses
to reuse an existing custom-metrics API or HPA, and always restores the Engine config, StatefulSet
template/replicas, Actors, Helm release and exact Node it created. Receipts are written under
`${AGENTS_DIR:-$HOME/.agents}/benchmarks/local-mesh/workerd-autoscaling-e2e/`.
