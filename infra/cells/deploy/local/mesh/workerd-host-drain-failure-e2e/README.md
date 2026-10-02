# workerd Host drain failure qualification

This destructive, bounded qualification complements the happy-path Host drain
receipt. It uses the real Engine, Pegboard Envoy, workerd Hosts and Kubernetes
controller while injecting six failures:

1. new actor demand after the target is fenced;
2. controller Pod replacement in `Selected` and `ScalingDown`/`Converging`;
3. an unreachable Host management endpoint (malformed JSON is covered by the
   same strict Go client contract test);
4. target Pod UID replacement while the durable state names the old UID;
5. a concurrent StatefulSet scale-up, equivalent to the HPA actuator output;
6. a drain timeout while actor eviction is deliberately delayed.

The harness temporarily increases the existing runner config's
`actor_eviction_delay`, restarts the two qualification Hosts so their connection
captures that config, and restores the exact original multi-datacenter runner
config during cleanup. It never modifies a published runner protocol.

```bash
python3 run.py \
  --kubeconfig /root/.local/state/rivet-local-mesh/runtime-a.kubeconfig \
  --cluster rivet-runtime-a \
  --controller-image rivet/actor-fleet-controller:<revision>
```

Receipts are written under
`~/.agents/benchmarks/local-mesh/workerd-host-drain-failure-e2e/`.
