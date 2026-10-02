# Workers API Router autoscaling E2E

This permanent local gate proves that the regional Workers API/Object Router capacity loop is real,
not merely a rendered HPA:

```text
streamed stateless fetches
  -> per-Pod workers_api_routing_requests_in_flight
  -> Hub Prometheus
  -> custom.metrics.k8s.io
  -> Workers API HPA 3 -> 4
  -> load release -> 4 -> 3
```

The gate temporarily lowers only the HPA in-flight target and scale-down stabilization window. It
does not patch the Deployment replica count. It restores the exact original HPA spec, deletes its
temporary Worker, and records exact Pod UIDs and metric observations in a new receipt.

```sh
infra/cells/deploy/local/mesh/workers-api-autoscaling-e2e/run.py \
  --receipt /data/actor-qualification/receipts/local-workers-api-autoscaling-$(date +%s).json
```
