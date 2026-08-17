# Tokyo CI/CD Activation Design

## Status

Approved in conversation on 2026-08-06. This is Stage 3 of the Tokyo environment
model. It activates continuous image build and GitOps promotion while preserving
the existing Argo CD deny window during onboarding.

## Goal

A source change merged to `master` must enter independent Beijing and Tokyo
release lanes. The lanes use the same release bundle contracts but have separate
CI runs, registry credentials, image repositories, promote branches, GitOps MRs,
database gates, and Argo lifecycle.

Failure in Tokyo must not stop the Beijing pipeline, and failure in Beijing must
not stop Tokyo. Regional values remain independent: sharing a source revision
does not allow Tokyo to reuse Beijing TCR, SSM, database, OAuth, or runtime
credentials.

## Pipeline Shape

Each Tokyo-deployable service gets a dedicated Stream pipeline entry. The entry
reuses `.ci/templates/service-release.yml`, mirrors the service paths from its
existing release pipeline, and targets only `sandbox-jp-1` for both master build
and automatic image pinning.

This is preferred over appending `sandbox-jp-1` to existing
`MASTER_BUILD_ENVS`. The shared list is executed in one pipeline job, so a Tokyo
registry failure could otherwise block Beijing auto-pin. Separate pipeline
entries provide independent scheduling, retry, logs, and failure status while
retaining one implementation template.

The activated services are the Tokyo catalog services that already have build
metadata: admin gateway, AI gateway, CTL, frontend, gateway dashboard, auth,
nextgen dashboard, payment, sandbox, service gateway, subscription, and trade.
Credit, session, and shadow remain outside automatic build until they gain the
same standard release bundle and workflow contracts used by Beijing.

## Credential Boundary

Tokyo image builds use `TCR_JP1_PASSWORD` or the runner-local
`/etc/lightclaw-ci/tcr_jp1_password`. The resolver must fail closed when neither
exists and must not fall back to a Beijing credential.

Database migration and readiness jobs resolve the Tokyo catalog destination and
use `/etc/lightclaw-ci/kubeconfig_tokyo_playground`. No kubeconfig or credential
value is committed to Git.

## Onboarding Promotion Policy

`promote-sandbox-jp-*` branches use changed-only validation and automatic GitOps
MR merge. While the Tokyo AppProject deny window exists, post-merge verification
is merge-only and Argo sync remains manual. This lets `master` continuously
produce and pin Tokyo images without trying to deploy incomplete SOPS resources.

After the runtime credential gates pass and the deny window is removed, a
separate reviewed change will switch the Tokyo promotion policy to Argo
convergence, matching Beijing's steady-state behavior.

## Verification

- contract tests prove every Tokyo pipeline targets only `sandbox-jp-1`
- Tokyo path filters remain equal to their source service pipeline filters
- effective workflows expose the JP TCR credential
- promotion policy recognizes `promote-sandbox-jp-*` and remains merge-only
  during onboarding
- release planning reports `argo_sync=manual` for `sandbox-jp-1`
- DB gate tests resolve the Tokyo catalog, namespace, and kubeconfig filename
- CI runtime and strict release contract suites pass

## Rollout

1. Merge the source-facing CI activation into `master`.
2. Copy the GitOps promotion workflow seed to `gitops` in a separate MR.
3. Provision JP TCR and Tokyo kubeconfig files on the CI runner without logging
   their values.
4. Trigger one `service-gateway` Tokyo build and verify image push, promote MR,
   automatic merge, and no Argo sync.
5. Enable the remaining Tokyo service pipelines through normal path-triggered
   `master` changes.
6. Switch Tokyo to Argo convergence only after the runtime gate is explicitly
   approved.
