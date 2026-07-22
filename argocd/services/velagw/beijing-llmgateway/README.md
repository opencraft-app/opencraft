# velagw / beijing-llmgateway

GitOps source for the existing Beijing LLMGateway integration cluster
`cls-nxamet2z`.

This release unit owns the static LLMGateway Deployments, Services,
set-manager CronJob, and the namespaced VelaGWSet controller/provisioner
resources. Runtime Secrets, CRDs, KRO/RGD, the `LLMFleet` instance, individual
`VelaGWSet` resources, and dynamically generated new-api resources remain
externally managed and must not be added to this application.

The single `VELAGW_IMAGE` pin in `velagw-platform.env` is updated by
`.ci/velagw.yml` and applies to every VelaGW process, including the
VelaGWSet provisioner. Keeping one release pin prevents a control-plane release
from leaving lifecycle reconcilers on an older binary.
