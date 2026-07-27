# velagw / beijing-llmgateway

GitOps source for the existing Beijing LLMGateway integration cluster
`cls-nxamet2z`.

This release unit owns the static LLMGateway Deployments, Services, the
Shard Manager, the `VelaGWSet` API definition and deletion policy, the
LLMFleet KRO ResourceGraphDefinition, and the VelaGWSet
controller/provisioner. Runtime Secrets, the `LLMFleet` instance, individual
`VelaGWSet` resources, and dynamically generated new-api resources remain
runtime-managed and must not be added to this application.

The Shard Manager watches `LLMFleet.spec.shards` read-only and admits immutable
Shard facts into the LLMGateway control plane. It does not manage Set runtime.
The VelaGWSet Provisioner and Controller exclusively own new Set creation and
lifecycle convergence.

The cluster-scoped API definitions are reconciled by Argo CD but carry
`Prune=false`. Removing one from this directory must never cascade-delete
live Fleet or Set instances. Beijing and Shanghai intentionally keep identical
copies of these definitions, guarded by the release bundle contract tests.

The single `VELAGW_IMAGE` pin in `velagw-platform.env` is updated by
`.ci/velagw.yml` and applies to every VelaGW process, including the
VelaGWSet provisioner. Keeping one release pin prevents a control-plane release
from leaving lifecycle reconcilers on an older binary.
