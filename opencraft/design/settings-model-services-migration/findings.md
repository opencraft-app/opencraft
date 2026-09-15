# Findings

## Requirements

- Remove the Environment application surface as a whole.
- Move local Model Services into Settings as its user-facing entry.
- Preserve local model/provider storage and DSH adapter/runtime behavior.

## Repository State

- Root context route had no matching pack; bounded exact source search is required.
- The shared worktree is heavily dirty from the ongoing OpenCraft migration. Changes must be narrow and must not revert unrelated files.
- `graphify-out/graph.json` is absent. A full mono2 graph build would be disproportionate for this bounded navigation migration, so current-source exact search is the fallback.
- `opencraft/AGENTS.md` requires the OpenCraft maintenance guide and cross-package gate for this navigation change.

## Current Source Shape

- `App` owns a distinct `environments` application route, breadcrumb, context navigation, content surface, and environment-creation modal.
- The application rail contributes a dedicated `shell.environments` action labelled `环境`.
- `SettingsNavigation` deliberately hides settings pages with an `environment` owner; `App` redirects such pages from Settings into the Environment route.
- Model Services is currently implemented as an extension settings contribution and its controller remains scoped to one Host/environment service.
- Therefore the migration boundary is presentation/routing: Settings must select the local Host for this page, while the underlying per-Host model controller stays unchanged.

## Removal Boundary

- Remove the dedicated Environment route, rail action, breadcrumb, environment navigation/content, and creation-modal entrance.
- Keep environment-directory/Host runtime services because Chat still needs targets and model configuration remains Host-scoped internally.
- Candidate files for deletion after confirming no remaining consumers: `components/environments-page.tsx`, `components/environment-breadcrumbs.tsx`, `styles/environments.scss`.

## Prior Invariants

- Model configuration remains OpenCraft-owned and environment/connection/model identities remain distinct internally.
- Settings is intended to own container/navigation composition rather than each capability inventing an isolated route.
- Product-facing removal of Environment must not delete Host identity or connection runtime needed by Chat.

## Architecture Evidence

- `platform-architecture.md` currently documents Environment as the parent of local model-service pages; the user's new decision supersedes that presentation contract.
- `local-agent-custom-providers.md` confirms `LocalAgentSettingsService` is a UI-free Host-scoped client and Model Services is the accepted Lobe-style view. This lets the view move without migrating storage or engine logic.
- Settings already renders extension pages and owns the adaptive master/detail container. The current exclusion of environment-owned pages and redirect to `openEnvironments` are the specific seams to remove.
- The app's current Environment surface also owns an environment-creation modal; removing the surface removes that entry, but not account discovery or persisted Host profiles.

## Target Contract

- Settings contains a visible `模型服务` item for the real local profile only.
- Selecting it renders the existing Model Services contribution in the Settings container, bound to that immutable local Host ID.
- If no local profile exists, the item is absent rather than silently targeting the active remote Host.
- Existing Chat target-settings actions may open a provider's Settings page only when that provider contributes one; fallback must no longer point to deleted Connections/Environment UI.

## Focused Source Findings

- Built-in Agents creates exactly one `LocalAgentSettingsService(options.requestHost, "local")`; the existing view is already permanently bound to local independent of the active chat Host.
- Its settings contribution currently carries `environment: { providerId: "vela.builtin-agents", hostId: "local" }` solely so the Shell redirects it to the Environment container. Removing that presentation metadata makes the same view a normal Settings page without changing the controller.
- Both connected `App` and `HostlessWorkbench` independently reproduce Environment routing, navigation, breadcrumbs, content, and creation UI; both must be removed to avoid two different products.
- Environment route APIs also exist in base navigation and navigation-transaction wrappers. They should be removed rather than left as dead public surface.
- `SettingsPageContribution.environment` has one production contributor: Built-in Model Services. Other matches are Environment-only tests/smokes. It is presentation metadata, not model-service data ownership.
- The existing Settings navigation already shows ordinary public extension pages and supports `layout: "master-detail"`; Model Services can enter this path by dropping the environment metadata.
- Environment-specific production UI is isolated to connected `App`, `HostlessWorkbench`, two component/style modules, route APIs, and tests/smokes. Account discovery/creation services are separate and can remain dormant without a Shell entrance.

## Compatibility Choice

- Historical `/environments` URLs should parse into Settings rather than remain a dead route. A former concrete configuration `section` can be retained as the Settings slug; `overview` and `connections` fall back to `appearance` because their UI is being removed.
- The removed `connections` fallback from Chat target settings must not silently open Appearance. If a provider has no Settings page, the action should simply open Settings' default page only where the UI explicitly promises generic settings.

## Planned Code Removal

- Remove `ApplicationRoute.kind = "environments"`, `openEnvironments`, `closeEnvironments`, and `environmentsUrl` from browser navigation and transaction interfaces.
- Remove Environment imports/state/rendering from connected and hostless shells.
- Remove `SettingsPageContribution.environment`; make Built-in Model Services an ordinary Settings contribution, still backed by its hard-bound local service.
- Remove Environment-only components/style and UI-only tests/smokes. Keep environment directory and LightVela creation service tests because they are domain/runtime capabilities rather than the deleted surface.
- Remove the hidden/unreachable Settings `connections` page branch so the Environment UI does not survive as dead code.

## Test Migration

- The model-service functional smoke had a decorative Environment breadcrumb wrapper; it can render the same accepted Model Services view directly.
- The Composer catalog smoke must navigate through `Settings → 模型服务` instead of `环境 → 模型服务`.
- The shared sidebar smoke used Environment content only as a resize fixture. It should keep testing one shared contextual sidebar, but with its generic task context so deleted product UI is not reconstructed in tests.
- A replacement navigation test now asserts both shells lack the Environment surface, the local service remains bound to `local`, and legacy `/environments` URLs normalize to Settings.

## Residual Scan

- Production route/component/style references are gone after the primary edits.
- Remaining `environmentOpen` occurrences are confined to an isolated authentication-flow fixture that validates the retained LightVela creation service, not the application Shell.
- `AppShellHeader.breadcrumbs` now has no consumer and was introduced for Environment; it can be removed as dead presentation API.
- Three formal documents still describe the superseded Environment parent navigation and must be updated before verification.

## Documentation Delta

- Replace the old `Fixed navigation entrances` contract with Chat + Settings as the visible application routes.
- State that Model Services is Settings-owned in presentation but still writes only through `LocalAgentSettingsService("local")`.
- Preserve the background EnvironmentDirectory/LightVela discovery ownership documentation; remove claims about a visible Environment list, breadcrumbs, overview, or creation entrance.
- Replace the old “Environment configuration navigation” feature rule with a Settings-owned model-services rule.

## Desktop Visual Finding

- The first packaged preview visibly removed the Environment action and opened Model Services through Settings at `/settings/vela.builtin-agents.model-services`.
- Its Settings group still rendered the old `Local Agent` label instead of the worktree source's `本机`. Root cause: the temporary borrowed `node_modules` contains npm workspace symlinks pointing back to `/Users/skipzhang/mono2/opencraft`, so package imports can mix main-checkout code with this worktree.
- That preview is diagnostic only and cannot be final acceptance evidence. Local worktree-owned workspace links are required before rebuilding and rerunning gates.
- The final current-worktree preview renders `Chat` and `Settings` only in Applications. Settings shows a `本机` group with one `模型服务` entry, selected at `/settings/vela.builtin-agents.model-services`.
- The existing provider navigation/detail surface remains intact; no Environment navigation, breadcrumb, overview or content container is mounted.

## Local Gate Environment Root Cause

- Lockfile-exact installation with `--ignore-scripts` left `node-pty/prebuilds/darwin-arm64/spawn-helper` at mode `0644`; the known-good main checkout has the byte-identical helper at executable mode `0744`.
- This precisely explains every `posix_spawnp failed` in process/terminal tests. Rebuilding the dependency (or its install step) is the correct verification-environment repair; no application source workaround is warranted.
