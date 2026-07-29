# velagw / sgprod

GitOps source for the independent Johor Bahru LLMGateway production cell that
serves the Singapore business environment.

This release unit owns the static LLMGateway Deployments, Services, the
`VelaGWSet` CRD, deletion policy, Controller, Provisioner, Shard Manager, RBAC,
disruption budgets, and the LLMFleet KRO ResourceGraphDefinition. The
namespace, runtime Secrets, and the `LLMFleet/prod` instance remain externally
managed and must not be added to this application.

Cluster-scoped API definitions carry `Prune=false` so a GitOps packaging error
cannot cascade-delete live Fleet or Set instances. Their Beijing and Shanghai
copies are intentionally identical and enforced by release bundle contract
tests.

New capacity requests use the `velagwset` runtime backend with writer epoch 2.
The Provisioner materializes them as `VelaGWSet` resources and the Controller
owns their new-api workloads. The Shard Manager watches
`LLMFleet.spec.shards` read-only and admits immutable Shard facts into the
control plane so the Set autoscaler can place new capacity. It does not patch
the Fleet or manage Set lifecycle.

The image pin in `velagw-platform.env` is updated by `.ci/velagw.yml` through
the sgprod promotion workflow. Production sync is always manual.

This cell uses standard TKE nodes, one 4C8G node in each availability zone.
Set autoscaling keeps a minimum of two warm Sets across the two shards. Each
shard is capped at four Sets until node capacity and production traffic justify
raising the regional limit.
