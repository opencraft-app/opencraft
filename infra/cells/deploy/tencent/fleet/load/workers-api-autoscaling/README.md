# Workers API cloud autoscaling qualification

This is the permanent production-policy gate for the regional Workers API and
Object Router in management cluster C:

```text
3 API Pods
  -> 200+ real streamed stateless fetches through the private /v1 endpoint
  -> per-Pod Router in-flight metric
  -> Hub Prometheus and custom.metrics.k8s.io
  -> unmodified production HPA scales above 3
  -> every request completes and the temporary Worker is deleted
  -> the five-minute stabilization and one-Pod-per-minute policy return to 3
  -> both dependent A/B stateless pools and their Native NodePools return to 3
```

Unlike the fast local E2E, this gate never patches the HPA or Deployment. It
hashes the HPA spec in every sample and fails if ownership changes during the
run. Router requests necessarily execute in A/B, so the gate treats downstream
stateless Pod/Node expansion as a composed capacity side effect: both Cells
must start at and naturally return to their three-Pod/three-Node floor before
the receipt can pass. It never assumes that a regional request total maps
evenly onto per-Cell executor metrics.

Run on the same-VPC builder from an immutable reviewed source:

```sh
ACTOR_REVIEWED_SOURCE=/data/actor-build/reviewed-source \
  run-on-builder.sh 0123456789abcdef0123456789abcdef
```

The only product mutations are creating and deleting one temporary Worker.
The harness does not change replicas, HPA policy, Nodes, admission labels, or
Argo desired state.
