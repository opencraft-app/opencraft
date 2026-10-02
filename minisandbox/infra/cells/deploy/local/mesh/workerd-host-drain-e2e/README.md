# workerd Host drain qualification

This qualification isolates the scale-down safety path from the capacity and
scale-up suites. It creates a second k3d compute Node and Host, leaves a durable
actor on the highest StatefulSet ordinal, and starts the real Host drain
controller with an accelerated stabilization window.

The receipt proves that the controller:

- selected only the highest StatefulSet ordinal;
- fenced that Host from new placement through Pegboard Envoy metadata;
- waited for actor and HTTP request quiescence before changing replicas;
- scaled down exactly one Host;
- restarted the displaced actor on the retained Host with its SQLite counter intact.

The production manifest keeps `HOST_DRAIN_MODE=Disabled` until this receipt and
the separate scale-up qualification are both accepted.

```bash
python3 run.py \
  --kubeconfig /root/.local/state/rivet-local-mesh/runtime-a.kubeconfig \
  --cluster rivet-runtime-a \
  --controller-image rivet/actor-fleet-controller:<revision>
```

Receipts are written under
`~/.agents/benchmarks/local-mesh/workerd-host-drain-e2e/`.
