# velagw / beijing-llmgateway

GitOps source for the existing Beijing LLMGateway integration cluster
`cls-nxamet2z`.

This first release unit owns only the static LLMGateway Deployments, Services,
set-manager CronJob, ServiceAccount, Role, and RoleBinding. Runtime Secrets,
KRO/RGD, the `LLMFleet` instance, and dynamically generated new-api resources
remain externally managed and must not be added to this application.

The image pin in `velagw-platform.env` is updated by `.ci/velagw.yml`. The
initial pin matches the image that was live when this application was created,
so onboarding does not intentionally roll the workloads.
