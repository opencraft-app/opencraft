# velagw / shprod

GitOps source for the independent Shanghai LLMGateway production cluster.

This release unit owns the static LLMGateway Deployments, Services,
set-manager CronJob, RBAC, disruption budget, and the LLMFleet KRO
ResourceGraphDefinition. The namespace, runtime Secrets, the `LLMFleet/prod`
instance, and dynamically generated new-api resources remain externally
managed and must not be added to this application.

The image pin in `velagw-platform.env` is updated by `.ci/velagw.yml` through
the shprod promotion workflow. Production sync is always manual. The initial
pin matches the image that was live when this application was created, so the
ownership handoff does not intentionally roll workloads.
