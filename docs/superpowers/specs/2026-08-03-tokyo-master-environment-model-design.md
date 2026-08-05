# Tokyo Master Environment Model Design

## Status

Approved in conversation on 2026-08-03. This document defines the first,
source-facing slice only. It does not make Tokyo a live GitOps environment and
does not authorize cloud mutations.

## Context

Tokyo already has a partial environment and live infrastructure, but neither
the current `master` branch nor the `gitops` branch models it as a supported
environment. An older branch, `codex/sandbox-jp-1-master-20260708`, contains a
prototype. That branch is substantially behind `master`, mixes environment
modeling with release activation, and configures Pulumi in a way that could
attempt to create resources already present in Tencent Cloud.

Read-only cloud inspection confirmed that Tokyo has an existing data and
compute plane, including:

- TKE cluster `tke-tokyo-sandbox` in `ap-tokyo`
- CynosDB MySQL cluster named `cynosdb-jp1`
- Redis instances `sandbox-route-redis-jp1` and `ctl-mq-redis-jp1`

The environment must therefore adopt existing resources. It must not recreate
them.

## Goals

This slice makes current `master` understand Tokyo as a first-class environment
model:

- retain the environment family `sandbox-jp-N`, starting with
  `sandbox-jp-1`
- retain `tokyo-sandbox` as the singleton infrastructure stack name
- model Tokyo as the Beijing Playground baseline plus a small JP delta
- let release tooling recognize, resolve, validate, and explicitly build a JP
  environment
- provide the source-side generator profile needed by a later GitOps bootstrap
- record the existing Tokyo infrastructure as adoption metadata without making
  the Pulumi stack executable
- add regression tests for environment recognition, registry/catalog mapping,
  configuration projection, and non-activation

## Non-goals

This slice does not:

- generate or commit `argocd/services/**/sandbox-jp-1` artifacts
- generate or commit a Tokyo Argo CD application or catalog instance
- add Tokyo to `MASTER_BUILD_ENVS` or `MASTER_AUTO_PIN_ENVS`
- enable a `promote-sandbox-jp-*` workflow or automatic promotion policy
- enable Argo CD auto-sync
- run Pulumi `preview`, `up`, `import`, or any cloud write
- add an executable `Pulumi.tokyo-sandbox.yaml` stack configuration
- copy or expose production credentials
- change Beijing, Korea, Shanghai, or Singapore runtime behavior

## Environment Identity

Tokyo uses two related identities with separate responsibilities:

| Identity | Value | Responsibility |
| --- | --- | --- |
| Playground environment | `sandbox-jp-1` | release contracts, generated service config, namespace and per-environment behavior |
| Environment family | `sandbox-jp-N` | parser and workflow matching for future Tokyo playgrounds |
| Infrastructure stack | `tokyo-sandbox` | Tencent Cloud infrastructure inventory and Pulumi ownership |
| Tencent Cloud region | `ap-tokyo` | infrastructure and registry locality |
| Playground catalog root | `argocd/catalogs/playground/tokyo-playground` | later deploy-facing catalog projection |
| Container registry | `lightclaw-jp1.tencentcloudcr.com` | JP image destination |

The release environment and infrastructure stack are deliberately not
collapsed into one name. Multiple future `sandbox-jp-N` application
environments may share the singleton Tokyo infrastructure stack.

## Configuration Model

### Beijing Baseline Plus JP Delta

The generator must treat Beijing Playground behavior as the shared baseline.
Tokyo overrides only values that are materially regional or international:

- public and internal domains
- international-site frontend/runtime mode
- OAuth and payment endpoints or provider selection
- Tencent Cloud region and availability zones
- TKE destination and node pool identity
- TCR registry and credential selector
- MySQL and Redis endpoints and secret references
- environment-specific SSM/SOPS secret identity

Service manifests must not be copied wholesale from Beijing. Shared defaults
stay in the existing generator and service templates so later baseline fixes
apply to both environments. JP-specific behavior belongs in an explicit,
reviewable environment profile.

For Stage 1, "Beijing baseline" means the current source-side release and
rendering contracts, not the generated Beijing manifests on `gitops`. The
implementation must cover this concrete checklist:

1. playground environment parsing and region/catalog lookup
2. release-bundle image repository resolution for an explicitly supplied JP
   environment
3. frontend build arguments and public endpoint resolution
4. source-side Playground profile, domain, infrastructure, and data-plane
   replacements
5. Tokyo infrastructure inventory and import metadata

Tokyo uses a managed data-plane profile. Unlike the namespace-local default,
it must not render an `env-bootstrap` MySQL/Redis workload. The profile points
service configuration at the existing Tokyo CynosDB and Redis endpoints and
keeps credentials as secret references. The exact endpoints must come from
read-only live reconciliation and the committed Tokyo inventory, not from a
copied Beijing render.

### Secret Boundary

Only secret names, references, expected keys, and validation metadata may be
committed to `master`. Secret values remain in Tencent Cloud SSM and are later
projected to SOPS on `gitops` during the GitOps bootstrap slice.

Because `lightclaw-auth` participates in real-name verification, the future
Tokyo secret manifest must require:

- `TENCENT_REALNAME_SECRET_ID`
- `TENCENT_REALNAME_SECRET_KEY`
- `TENCENT_REALNAME_ENDPOINT`
- `REALNAME_ENCRYPTION_KEY`

The encryption key must be unique to Tokyo and decode to exactly 32 bytes.

## Source-side Components

### Stage 1 Contract Boundary

| Contract area | In-scope source files | Explicitly out of scope | Non-live verification |
| --- | --- | --- | --- |
| Environment identity | `.ci/runtime/contracts/bundles.py` | Any `argocd/catalogs/**/sandbox-jp-1` instance | Contract unit tests call `is_playground_env`, `playground_region`, and `playground_catalog_root` |
| Explicit manual build contract | `.ci/runtime/commands/build_release_image.py` and its pure contract helpers | JP branch triggers in `.ci/*.yml` or `.ci/templates/service-release.yml`; adding JP to any `MASTER_BUILD_ENVS`, `MASTER_AUTO_PIN_ENVS`, `PLAYGROUND_BUILD_ENVS`, or `PLAYGROUND_AUTO_PIN_ENVS` value | Unit tests resolve build metadata for `--env sandbox-jp-1`; do not invoke Docker or start CI |
| Image destinations | `.ci/runtime/bundles/*.bundle` and bundle contract helpers | Image push, registry mutation, or GitOps pin | `load_bundle` and `require_build_metadata` unit tests resolve JP repositories without invoking Docker |
| Frontend JP build inputs | Existing frontend build-contract helpers and their tests | Cloudflare/EdgeOne publication and master-triggered JP image build | Unit tests assert JP auth/API URLs and build arguments only |
| Playground profile/rendering | Pure profile, planning, and rendering code in `.ci/runtime/gitops/playground_environment.py` | `write_clone_plan`, command wrappers, SOPS encryption, and writes under `argocd/**` | Temporary-repository fixtures call plan/render functions and inspect bytes in memory or temp paths |
| Infrastructure model | `infra_pulumi/envs/tencentcloud/tokyo-sandbox/inventory.yaml` and `infra_pulumi/pkg/importplan/**` | `Pulumi.tokyo-sandbox.yaml`, Pulumi state creation, provider execution, preview, import, or up | Inventory loader tests and import-plan completeness tests only |
| Secret contract | `scripts/ssm_manifest.lightclaw-auth.sandbox-jp-1.yaml` containing references and required-key documentation | Generated `argocd/secrets/**`, SSM writes, secret values | YAML/schema tests and secret scanner; no export command |

The `.ci/runtime/gitops/` path contains source code as well as deploy-related
operations. Stage 1 may modify only its pure environment-profile, planning, and
rendering logic. File location alone does not make a change deploy-facing; the
boundary is whether the code writes a GitOps tree, invokes Argo/Kubernetes, or
changes live promotion behavior. Those side effects remain out of scope.

### Release Contracts

The release contract layer will recognize `sandbox-jp-N`, map `jp` to
`tokyo-playground`, and select the JP TCR registry. An operator or test may pass
`--env sandbox-jp-1` explicitly to the build command contract. Stage 1 does not
add a JP source-branch trigger because existing Playground branch defaults also
auto-pin GitOps.

The implementation must audit every current Beijing Playground deployable
bundle. Each service that can be generated for Tokyo must have a valid JP image
repository mapping. The older Japan branch is reference material, not the
authoritative service list, because current `master` contains newer bundles.

### Playground Generator

The generator will gain a JP environment profile rather than a separate Tokyo
generator. The profile supplies the JP delta while continuing to use the shared
generation path, validation, and service templates.

The profile must explicitly include the Tokyo catalog root, destination cluster
and project, JP registry, region/zones/node pool, international domains, and
managed data-plane mode. Rendering tests use a temporary fixture. This slice
must not call `write_clone_plan`, alter its default target, or write a real Tokyo
catalog or service tree into `gitops`.

### CI Activation Boundary

Recognition and activation are separate contracts:

- `sandbox-jp-N` is a valid environment for explicit/manual build commands.
- `master` push remains unchanged and does not automatically build Tokyo.
- `playground/sandbox-jp-*` is not added to service CI push triggers.
- no service receives `sandbox-jp-1` in `MASTER_BUILD_ENVS`.
- no service receives `sandbox-jp-1` in `MASTER_AUTO_PIN_ENVS`.
- no service receives JP in `PLAYGROUND_BUILD_ENVS` or
  `PLAYGROUND_AUTO_PIN_ENVS`.
- no JP promotion branch policy is added in this slice.

Tests must assert these negative conditions explicitly. This prevents a future
refactor from silently turning model support into deployment activation.

## Existing Infrastructure Adoption

### Inventory and Ownership

`infra_pulumi` will gain a `tokyo-sandbox` inventory that describes the live
Tokyo topology. The inventory uses stable logical names and values confirmed by
read-only Tencent Cloud queries. Existing TKE, CynosDB, Redis, networking, TCR,
and other discovered resources are classified as external-but-candidates-for-
adoption until a complete provider import identity exists.

The old branch's inventory may be selectively ported only after each resource
identity is reconciled against the live account. Stale IDs or guessed IDs are
not acceptable.

### Import Safety

The current Pulumi program only has a hard-coded Beijing import plan. A Tokyo
import plan must be added for resources that already exist and are represented
by the Tokyo inventory. Stage 1 deliberately does not add
`Pulumi.tokyo-sandbox.yaml`; therefore the normal Pulumi entrypoint cannot select
or execute Tokyo from committed stack configuration.

The import plan is static adoption metadata, not permission to run Pulumi. It
must contain explicit provider IDs for every resource it claims as adoptable.
Resources whose IDs or provider import syntax are not verified stay external
and are omitted from the managed set. The old `enableImport: "false"` setting
and encrypted values must not be copied.

Tokyo import metadata must expose two disjoint component sets:

- `adoptable`: every represented resource has an exact provider import ID
- `external`: the resource exists but is not yet safe for Pulumi ownership

A static validator must require every Tokyo inventory component to be in
exactly one set and reject an `adoptable` component with any missing resource
ID. This metadata is consumed by tests in Stage 1 and becomes the input to the
fail-closed runtime guard in Stage 2.

Safety invariants:

1. Stage 1 has no committed Tokyo stack configuration, so no Tokyo component is
   registered with a Pulumi provider.
2. A resource is marked adoptable only when its exact provider import identity
   is present; name-based Redis discovery is not an accepted import identity.
3. Missing import identity means external/unmanaged. It must never fall through
   to the current create-on-empty-ID or name-based Redis auto-adopt paths.
4. This slice performs static checks only. It does not run `infractl validate`
   because that command includes Pulumi preview behavior.
5. Stage 2 must add a fail-closed adoption guard before adding
   `Pulumi.tokyo-sandbox.yaml`: import-only mode must validate all selected
   managed components before provider resource registration, reject missing
   IDs, and disable Redis name discovery for Tokyo.
6. Pulumi state initialization and the first reviewed import/preview are a
   later, explicitly approved operation.

If the current Pulumi resource model cannot safely import a live component,
that component remains external/unmanaged in this slice and is documented as a
follow-up. The implementation must not distort inventory to force ownership.

## Validation Strategy

The implementation uses focused tests around the changed contracts:

- parser accepts `sandbox-jp-1` and rejects malformed JP names
- catalog resolution maps JP to `tokyo-playground`
- registry resolution maps JP builds to `lightclaw-jp1.tencentcloudcr.com`
- generated JP configuration applies the international/regional delta while
  retaining shared Beijing defaults
- cross-region substitutions do not retain Beijing-only endpoints, registry
  names, cluster names, or secret references
- all Tokyo-generated services have JP image repository mappings
- CI service definitions do not add JP to master build or auto-pin lists
- no JP automatic promotion policy exists
- `python3 -m unittest discover -s .ci/runtime/tests/contract_tests -p
  test_release_bundle_contracts.py` covers identity, workflow non-activation,
  and bundle resolution without Docker
- `python3 -m unittest discover -s .ci/runtime/tests/contract_tests -p
  test_build_release_image.py` covers JP frontend auth/API build arguments and
  build metadata resolution without invoking Docker
- `python3 -m unittest discover -s .ci/runtime/tests/gitops_tests -p
  test_playground_environment.py` renders JP fixtures only under a temporary
  directory
- `bash .ci/runtime/check_ci_runtime.sh` passes without starting a build or
  performing a GitOps write
- `GOWORK=off go test ./pkg/config ./pkg/importplan` passes from
  `infra_pulumi/`; these tests load inventory and validate static import
  metadata only
- repository assertions prove there is no `Pulumi.tokyo-sandbox.yaml` and no JP
  deploy-facing instance under `argocd/**`

Tests should be added before implementation where the current test harness
supports an isolated red/green cycle.

## Delivery Stages

### Stage 1: Master Environment Model

This document's implementation scope. Merge source-side recognition,
generation support, image mappings, non-executable inventory/import metadata,
and tests. There is no live rollout.

### Stage 2: GitOps Bootstrap

In a separate reviewed change:

- create the Tokyo Argo project/application/catalog structure on `gitops`
- render `sandbox-jp-1` service artifacts
- provision and export environment-specific secrets
- validate DB/Redis bindings and namespace resources
- perform the controlled Pulumi import/preview if infrastructure ownership is
  desired
- add `Pulumi.tokyo-sandbox.yaml` only after the import-only runtime guard is in
  place and every selected managed component passes completeness validation
- verify Argo applications manually before enabling automation

### Stage 3: Continuous Delivery Activation

Only after Stage 2 is healthy:

- add selected services to Tokyo master-build policy
- enable automatic GitOps pin/promotion
- enable Argo CD auto-sync
- verify source commit, image tag, GitOps revision, workload image, and public
  endpoint convergence end to end

## Failure Handling and Rollback

Stage 1 is inert for live environments. Its rollback is a source revert because
it adds no automatic release target and performs no cloud mutation.

If static validation discovers incomplete JP mappings, the implementation must
fail closed and leave the missing service unsupported. If live resource
reconciliation is ambiguous, record the resource as external and stop before
Pulumi preview/import. No fallback may create a similarly named Tokyo resource.

## Acceptance Criteria

Stage 1 is complete when:

1. Current `master` recognizes `sandbox-jp-1` through the normal playground
   contracts.
2. An explicit JP build resolves the Tokyo catalog family and JP registry.
3. The generator can render a JP model in tests using Beijing defaults plus the
   documented JP delta.
4. Every generated Tokyo service has a current JP image mapping.
5. Tokyo infrastructure inventory/import metadata identifies verified existing
   resources, unverified resources remain explicitly external, and no
   executable Tokyo Pulumi stack config exists.
6. Focused Python and Go tests pass.
7. Repository searches and contract tests prove JP is absent from automatic
   master build, auto-pin, promotion, GitOps instance, and auto-sync paths.
8. No cloud write, deploy-facing GitOps change, credential disclosure, or live
   rollout occurred.
