# velagw / shprod

GitOps source for the independent Shanghai LLMGateway production cluster.

This release unit owns the static LLMGateway Deployments, Services, the
`VelaGWSet` CRD, deletion policy, Controller, Provisioner, legacy set-manager
CronJob, RBAC, disruption budgets, and the LLMFleet KRO
ResourceGraphDefinition. The namespace, runtime Secrets, and the
`LLMFleet/prod` instance remain externally managed and must not be added to
this application.

New capacity requests use the `velagwset` runtime backend with writer epoch 2.
The Provisioner materializes them as `VelaGWSet` resources and the Controller
owns their new-api workloads. Existing Sets already present in
`LLMFleet.spec.sets` stay on the legacy path until they are naturally retired;
the set-manager remains only for those legacy Sets and cannot claim new
`velagwset` requests.

The image pin in `velagw-platform.env` is updated by `.ci/velagw.yml` through
the shprod promotion workflow. Production sync is always manual. The initial
pin matches the image that was live when this application was created, so the
ownership handoff does not intentionally roll workloads.
