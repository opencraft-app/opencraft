# workerd automatic sleep gate

This gate proves the outer Rivet Actor lease follows workerd's serverless residency model instead
of retaining one placement slot for every logical Durable Object forever. It uses the public
Workers API to create and increment a native Counter, waits without calling the explicit sleep API,
and requires:

- Pegboard to make the Actor durably sleeping;
- Host and SQLite bridge counts to return to their exact pre-test baseline;
- the next request to wake the same Object under a strictly newer Actor generation;
- acknowledged SQLite state to continue from `1` to `2`;
- the second idle period to release the same capacity again.

For a quick local qualification, temporarily set `RIVET_WORKERD_IDLE_SLEEP_MS=2000` on the Cell's
workerd Host and run:

```sh
python3 infra/cells/deploy/local/mesh/workerd-auto-sleep-e2e/run.py \
  --runtime-kubeconfig "$HOME/.local/state/rivet-local-mesh/runtime-a.kubeconfig" \
  --cell local-runtime-a
```

Production defaults to 30 seconds. The timer only proposes a generation-scoped intent; Pegboard
remains the sole placement owner and performs Stop, slot release, and any subsequent generation
allocation.
