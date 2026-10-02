# Local workerd capacity provider qualification

This isolated, destructive E2E proves the local control chain without pretending
that k3d implements Tencent Cloud:

```text
Actor pressure
  -> scale-up-only HPA
  -> unschedulable workerd StatefulSet Pod
  -> durable WorkerdCapacityRequest (exact StatefulSet and Pod UIDs)
  -> host-side fake provider creates an isolated k3d agent
  -> runtime image preparation completes before the compute label is published
  -> workerd becomes Ready and the pending Actor lands
  -> serial authenticated Host drain
  -> StatefulSet removes exactly one empty Host
  -> provider proves the Node has no non-DaemonSet workload and deletes it
  -> repeated pressure creates a new request and a new Node identity
```

The provider is test-only and lives entirely in this directory. It does not run
in a Pod, mount the Docker socket, modify production CRDs, or emulate Tencent
Cloud `MachineSet` status. Its request status is durable, every external side
effect is reconciled from observed state, and the qualification restarts the
provider before driving a second complete scale cycle. Replacement Pod or Node
UIDs, unowned Nodes, mutable request identity and busy Nodes fail closed.
Long-running `kubectl` and `k3d` subprocess groups are cancelled during provider
shutdown; cleanup preserves the CRD if shutdown cannot be confirmed.

Run against a clean local runtime Cell with exactly one initial compute Node:

```bash
python3 run.py \
  --kubeconfig /root/.local/state/rivet-local-mesh/runtime-a.kubeconfig \
  --cluster rivet-runtime-a \
  --controller-image rivet/actor-fleet-controller:<revision>
```

The harness removes the HPA, custom-metrics adapter, test CRD, provider Node,
Actors and drain controller, and restores the original Engine configuration,
StatefulSet replica count and affinity. Receipts are written beneath
`~/.agents/benchmarks/local-mesh/workerd-capacity-provider-e2e/`.
