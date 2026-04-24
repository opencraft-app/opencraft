# GitLab Group Naming Contract

GitLab groups are the v1 source of truth for mono release-group membership.

## Pattern

Parent group:

- `mono-release-groups`

Children:

- release: `mono-<env>-release`
- readonly: `mono-<env>-readonly`

Examples:

- `mono-beijing-sandbox-release`
- `mono-beijing-sandbox-readonly`
- `mono-shprod-release`
- `mono-shprod-readonly`

Rendered full paths used by Argo:

- `mono-release-groups/mono-beijing-sandbox-release`
- `mono-release-groups/mono-shprod-readonly`

## Rules

- One GitLab user may belong to multiple release groups.
- Effective permissions are the union of those groups, but only inside each mapped `repo × env` scope.
- Release rights are granted to leaf applications only in v1.
- Root environment apps do not inherit release rights from child release groups.

## Mapping Intention

- `*-readonly`
  - app get
  - project get
  - logs get
- `*-release`
  - same read/log visibility
  - plus sync on all leaf apps in the matching environment

