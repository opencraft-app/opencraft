# Stateless executor termination E2E

This gate exercises the real Kubernetes lifecycle wiring, not only the Rust
drain state machine:

1. scale one local Cell to two executor Pods;
2. delete a Pod while it owns a bounded in-flight Worker request;
3. prove readiness is removed, new work reaches the healthy peer, and the
   in-flight response completes before the Pod exits;
4. repeat with a request longer than the 45 second production drain budget;
5. prove the timeout counter advances and Kubernetes eventually interrupts the
   indeterminate request instead of keeping a terminating Pod forever.

The Worker has no Durable Object binding. It is uploaded once and reused by all
requests. The gate restores the original Deployment replica count and deletes
the temporary Worker even when the qualification fails.

Run it after `deploy/local/local-workers/up.sh`:

```bash
python3 infra/cells/deploy/local/mesh/stateless-termination-e2e/run.py \
  --receipt /data/tmp/stateless-termination.json
```
