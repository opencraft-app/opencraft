# Infra Pulumi Migration Design

Date: 2026-03-28

## Goal

Create a new `infra_pulumi/` tree that migrates the current Tencent Cloud Beijing landing zone from OpenTofu to Pulumi with Go, while keeping the existing `infra/` tree intact as the verified baseline during migration.

The end state is:

- `infra_pulumi/` becomes the new infrastructure control plane
- Beijing is imported into Pulumi and managed there
- future environments can be created with the simplest possible entry point
- `infra/` remains available as a reference and rollback aid during migration

## Non-Goals

- Do not delete or replace `infra/`
- Do not change the Beijing environment model during migration
- Do not redesign workload deployment in this phase
- Do not add Shanghai in this phase

## Constraints

- Migration target is full Pulumi adoption, implemented in Go
- Runtime target is a single environment-level Pulumi stack
- Migration execution must still happen incrementally, by resource domain
- Beijing inventory lives under `infra_pulumi/envs/` and remains the source of non-secret environment facts
- Secrets must not move into committed inventory files

## Recommended Shape

### Runtime Model

Use a single large Pulumi stack per environment.

Examples:

- `beijing-sandbox`
- `shanghai-sandbox`

This favors the user's primary goal: future environment creation should have the simplest possible entry point.

### Migration Model

Even though the target is one large stack, migration should be executed in batches:

1. networking
2. security
3. tke
4. cynosdb
5. redis
6. tcr
7. storage
8. monitoring
9. compute

Each batch must be imported, previewed, and verified before the next batch starts.

## Directory Structure

```text
infra_pulumi/
  README.md
  go.mod
  Pulumi.yaml

  cmd/
    infra-pulumi/
      main.go

  pkg/
    app/
      program.go
      context.go
    config/
      inventory.go
      loader.go
      validate.go
    components/
      networking/
      securitygroup/
      tke/
      cynosdb/
      redis/
      tcr/
      storage/
      cls/
      compute/
    importplan/
      beijing.go
    naming/
      naming.go

  cmd/
    infractl/
      main.go
```

## Configuration Model

### Source of Truth

Continue reusing:

- `infra_pulumi/envs/tencentcloud/beijing-sandbox/inventory.yaml`

The Pulumi program should parse this inventory directly instead of creating a third infrastructure configuration model.

### Pulumi Config

`Pulumi.<stack>.yaml` should stay thin and only carry runtime-level inputs such as:

- `environmentName`
- `inventoryPath`
- provider/project settings
- Pulumi secrets references where needed

### Secret Handling

Keep secrets outside committed inventory. Sensitive values should come from:

- Pulumi config secrets
- environment variables

Expected secret categories:

- Tencent Cloud API credentials
- TKE node password
- CynosDB password
- Redis password

## Code Architecture

### `pkg/config`

Responsibilities:

- load inventory YAML
- validate required fields
- normalize shared values

This layer should make invalid environments fail early.

### `pkg/components`

Each domain becomes a focused Pulumi component:

- `networking`
- `securitygroup`
- `tke`
- `cynosdb`
- `redis`
- `tcr`
- `storage`
- `cls`
- `compute`

These components should remain reusable across environments even though the runtime stack is large.

### `pkg/app`

This layer assembles the full landing zone from inventory plus secrets and wires domain dependencies together.

### `pkg/importplan`

This layer centralizes import IDs for Beijing resources. Import IDs must not be scattered across component implementations.

## Import Strategy

### Principle

The target stack is large, but import must still be staged by resource domain so that every migration step is auditable and reversible.

### Per-Batch Workflow

For each domain:

1. implement the component
2. define import IDs in `pkg/importplan`
3. run `pulumi preview`
4. confirm preview shows adoption rather than unintended mutation
5. import resources
6. run `pulumi preview` again
7. confirm no unexpected resource changes remain
8. record that the domain is now Pulumi-managed

### Import Order

1. networking
2. security
3. tke
4. cynosdb
5. redis
6. tcr
7. storage
8. monitoring
9. compute

This order keeps dependency handling straightforward and reduces migration risk.

## Coexistence During Migration

### `infra/`

Role during migration:

- verified baseline
- reference for resource intent
- rollback support

It should not be the active change path for a domain after that domain is imported into Pulumi.

### `infra_pulumi/`

Role during migration:

- new implementation
- import and verification path
- final source for post-migration changes

### Rule

No dual write.

Once a resource domain is migrated into Pulumi, that domain must no longer be changed through OpenTofu.

## Validation Standard

A migrated batch is accepted only when:

- Pulumi preview shows no unintended create/replace/destroy
- imported resources match the current Beijing environment
- known provider normalization noise is understood and documented
- the migration does not require changing environment semantics

## Benefits of This Shape

- future environments stay simple: new inventory plus new Pulumi stack config
- all cross-domain dependencies can be expressed naturally in one Go program
- current Beijing migration remains staged and auditable
- code stays maintainable because component boundaries remain explicit

## Risks

### Risk: Large-stack blast radius

Mitigation:

- incremental import by domain
- strict no-dual-write rule
- verify each batch before proceeding

### Risk: Provider parity issues

Mitigation:

- compare every Pulumi preview against the current OpenTofu-verified Beijing baseline
- document provider-specific normalization behavior

### Risk: Inventory and code drift

Mitigation:

- keep a single non-secret inventory source
- avoid duplicating environment facts into Pulumi config

## Rollout Plan

1. scaffold `infra_pulumi/`
2. add inventory loader and validation
3. add component shells
4. implement Beijing import plan
5. migrate networking
6. migrate remaining domains in order
7. complete Beijing Pulumi takeover
8. evaluate Shanghai creation from the new Pulumi stack model

## Recommendation

Proceed with:

- a new `infra_pulumi/` implemented in Go
- a single large Pulumi stack per environment
- staged domain-by-domain import for Beijing
- `infra/` retained during migration as the verified baseline
