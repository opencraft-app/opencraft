# Website stateless backend hidden production release — 2026-10-01

## Objective and authorization

User explicitly requested hidden release of the backend, with no frontend release.
Domestic shprod and international sgprod remain independent targets. New fullstack creation
must stay disabled; no owner allowlist, stock Skill TAT rollout, credential rotation or
production user/website resource creation is authorized by this phase.
Normal source/GitOps release workflow is used; do not force merge or bypass protected review.

## Current preparation

- Clean task-owned worktree from current master7eb0d7227ed28806b4250f020edea9ff14310ba1.
- Composed108 task paths from fixed tested source tree911685db96ca9f5496db36fc57e036fbde545a9dd33f98230b4c05054cee6e1c
  over source base48905e3f83137bd19a451a5c05b03b22cd34d7b8; application scopes unchanged
  upstream. Excluded inherited frontend/font changes. Existing desktop allowlist assertions
  retained solely to align tests with routes already present on current master; no desktop
  behavior or configuration is changed.
- Current production CTL/worker/site-gateway do not have runtime env bindings; all target
  workload replicas inspected are available. Recorded image identifiers are evidence only.
- Current production Argo apps are manual-sync. ctl-shprod,ctl-sgprod,site-gateway-sgprod,
  workers-website-deployer-sgprod already OutOfSync before this release; ownership and exact
  resources must be reconciled before any sync. No mutation executed at this checkpoint.
- Hidden gate regression observed RED in both regional real source renders; source patches
  explicitly close API/service/bypass; current tests and release gates are being rerun.

## Release scope

CTL/migration32, website-deployer, site-gateway and rollback route config are the required
hidden control-plane changes. Auth code in the prepared change supports testing issuer
registries; production branch retains its original registry validation path. Do not assume
an auth image rollout is necessary without actual production compatibility verification.
Runtime provisioning, its TLS/Secret binding and regional new-machine image adoption remain
separate execution stages; ordinary capabilities remain closed until they are accepted.

## Context receipt

Read root/CI AGENTS, site-environment-routing, release-gitops, source-to-production journey,
CI docs and local protected login guidance. No secrets may appear in source, Git or evidence.
Use explicit kubeconfigs and preserve root and previous task dirty worktrees.

## Completion gates

- Current source-focused race/vet, complete CI runtime + materialized smoke, hidden default
  gate and actual regional source renders, docs impact and diff check.
- Precise source MR accepted under normal review/CI. No frontend files in commit/promotion.
- Production DB backup/migration32 verification before activating compatible binaries.
- Scoped regional GitOps diff, no unrelated preexisting drift; manual Argo sync.
- Expected revision/immutable images, Synced/Healthy, actual closed capability and old static
  request/publication compatibility. Do not report hidden deployment until these pass.

## Integration gate corrections

Actual full-root integration exposed frozen snapshot omissions, despite the earlier temporary
subset passing: restore existing ticket bundle registration and current release-domain sections
(ticket, sandbox migration Job, Trade testing routing). Keep only website changes on top of
current master. The VelaGW contract parser now handles both JSON6902 lists and strategic patch
objects; its original forbidden-override check remains enforced. Hidden gate real-source16 tests
pass; full CI648 passed after corrections. Service gateway full tests require the preexisting
desktop route assertions; this is test-only alignment, not a desktop release. Re-running current
source focused gates before commit. Prior frozen archive is preparation evidence, not the exact
source to promote blindly over current master. No production mutation or source push yet.

## Current verification before source MR

- Full-root CI648 tests/materialized CLI smoke pass; focused current-source race/vet, website
  contracts and image scripts pass. Source render gate16 tests passes both regions and phases.
- Staged credential inventory scan checks114 exact task paths against local protected values,
  with no values printed; no frontend/private evidence staged.
- Identity-access context/design receipt added for owner-only backend/OIDC test-issuer boundary;
  production Auth registry path unchanged. Normal protected Owner review is still required.
- Existing Argo drift narrowed read-only to ctl API/service Deployments, sgprod site-gateway
  ConfigMaps/Deployment and sgprod worker ServiceAccount; exact desired/live deltas remain
  to be reviewed before any production sync. No production mutation yet.

## Source MR preflight completed

Current source full CI648, materialized help smoke, focused race/vet, real regional render16,
full user/auth race tests, staged docs-impact and diff whitespace gates pass. Staged115 paths
pass protected local credential inventory scan; no frontend/private evidence files present.
The next permitted action is normal source commit/push/MR. Do not auto-approve or force merge;
production migration, drift reconciliation, regional promotion and manual sync remain pending.
