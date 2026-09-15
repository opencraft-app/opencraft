# Profile-scoped Model Reset

## goal
Allow the diagnostics center to reset only the currently selected Bot's Hermes Profile model configuration without changing sibling Bots.

## non_goals
- No CTL API, database, service-gateway, OpenCraft, GitOps, deployment, or production mutation.
- No instance AI Gateway key rotation or model replacement copied from another Profile or the product catalog.
- No change to instance-scoped reinstall, backup/restore, resource, billing, or lifecycle operations.

## requirement_ids / requirement_refs / requirement_excerpt
- User request, 2026-09-15: "Profile 级的重置当前 Bot 模型配置"; other Bots must remain unchanged.
- Supersedes only the temporary reset limitation recorded in `docs/context/tasks/2026-09-10-multi-bot-diagnostics.md`; the rest of that task's Profile/instance boundary remains authoritative.

## interface_refs / data_structure_refs
- `Bot.profileId`: backend-owned Profile scope; public `main` maps to Hermes native `default`.
- `buildHermesModelConfigCommand`: existing Profile-root resolution and mutation lock.
- `createHermesModelConfigClient`: typed frontend command client.
- Invariant: model/provider operations are Profile-scoped; instance AI Gateway key ownership is not changed by this action.

## history_context
- `current_design_refs`: `docs/engineering/domains/agent-gateway-runtime.md`.
- `relevant_evolution`: the 2026-09-10 implementation blocked model reset when multiple Profiles existed because the old CTL endpoint rotated one shared instance key.
- `superseded_refs`: only the sentence declaring model reset temporarily single-main-Bot in `docs/engineering/domains/agent-gateway-runtime.md`.

## acceptance
- Running root and named Bots can reset their own model configuration even when sibling Bots exist.
- Reset command is scoped by the selected backend `profile_id`; sibling Profile files are untouched.
- Selected Profile restores CTL's reserved `custom` provider/default model as primary, preserves its credential, and loses fallback routes, user-added providers, model-management metadata, and only credentials referenced exclusively by removed providers.
- Missing or invalid built-in provider/default model/credential fails closed without changing the selected Profile.
- Save or credential-cleanup failure rolls back selected Profile config and credentials.
- UI identifies the current Bot as the target and sends no instance reset request.
- Focused tests, frontend lint/type/build, documentation checks, and changed-path checks pass.

## affected_paths
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/pages/marketing/agent-diagnostics-panel.tsx`
- `frontend/src/pages/marketing/agent-reset-config.ts`
- `frontend/src/pages/marketing/agent-model-config/hermes-model-config-command.ts`
- `frontend/src/pages/marketing/agent-model-config/model-config-client.ts`
- Focused frontend tests and diagnostics documentation.
- `docs/engineering/domains/agent-gateway-runtime.md`

## required_context
- `frontend-product-surface`
- `service-frontend`
- `site-environment-routing`

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/project/services/frontend.md@origin/master` | Frontend ownership and gates | Limit implementation to the frontend product surface and run its gates. |
| `docs/context/domains/site-environment-routing.md@origin/master` | Routed domain context | Preserve CN/global environment behavior. |
| `frontend/AGENTS.md@origin/master` | Frontend service rules | Follow React/TypeScript conventions and validation commands. |
| `docs/context/tasks/2026-09-10-multi-bot-diagnostics.md@origin/master` | Previous reset guard rationale | Replace only the temporary model-reset limitation. |
| `docs/engineering/domains/agent-gateway-runtime.md@origin/master` | Profile/instance source of truth | Keep model operations Profile-scoped and maintenance instance-scoped. |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@origin/master` | Required adjacency check | Include focused UI/helper tests and i18n/doc checks. |

## evidence
- Context router selected frontend-product-surface, service-frontend, and site-environment-routing.
- Bounded source search confirmed the old handler calls `resetInstanceConfig`, unscoped `acli backend reset-config`, then Profile-scoped provider/model commands.
- CTL source confirms the reset endpoint owns one instance AI Gateway key and rejects multi-Profile instances.
- Existing Hermes model-config helper already resolves `profile_id` to an isolated `HERMES_HOME`, locks mutations, reloads persisted config, and supports rollback.
- FEAI usage-context write could not run because the global `feai` executable is unavailable; the repository-local native engine remains usable.
- The diagnostics handler now calls `createHermesModelConfigClient(..., activeBot.profileId).resetToBuiltIn()` and sends no instance reset or unscoped reset command.
- The helper preserves the selected Profile's reserved `custom` provider/default model/credential, removes sibling provider routes and exclusive credentials, validates the persisted result, and rolls back config plus credentials on failure.
- UI and seven diagnostics documentation variants identify the current Bot as the only target and distinguish restored system configuration from removed user configuration.

## risks
- Hermes serialization drift: validate by reloading with Hermes config APIs and focused helper tests.
- Partial config/credential mutation: snapshot referenced credentials and restore both config and credentials on failure.
- Destructive selected-Profile action: name the current Bot and loss boundary in confirmation copy.

## validation
- `PATH=<bundled-python>/bin:$PATH pnpm exec vitest run src/pages/marketing/__tests__/agent-reset-config.test.ts src/pages/marketing/agent-model-config/__tests__/model-config-client.test.ts src/pages/marketing/__tests__/agent-diagnostics-multi-bot.test.tsx`: 3 files / 127 tests passed.
- `PATH=<bundled-python>/bin:$PATH pnpm test:model-config`: 7 files / 232 tests passed.
- `pnpm check`: passed; i18n extraction/validation, Traditional Chinese generation, docs sync, MDX, and typecheck baseline completed with 0 new TypeScript diagnostics. The 172 Indonesian missing translations and 57 warnings are the existing accepted baseline plus intentional string-fragment spacing.
- `pnpm build:cn`: passed; 100 pages generated and SEO validation completed. The two build-generated tracked artifacts were restored to `HEAD` afterward.
- Full `pnpm test` was attempted and interrupted after unrelated existing failures plus an open-handle hang. Observed failures included stale sidebar/channel assertions, missing mocks, layout/search/docs suites, and the pre-existing Indonesian renewal translation; no reset/model-config focused suite failed.
- `python3 .agents/context/scripts/validate_documentation.py --repo . --format json`: passed with 0 broken first-party links and 0 warnings.
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`: passed after staging only this isolated worktree's changes; the index was restored afterward.
- `git diff --check`: passed.

## decisions
- Use the existing Profile-scoped model-config helper, not the instance reset API.
- Restore the selected Profile's existing reserved `custom` provider/default model; do not infer or copy another Profile's model.
- Preserve the built-in credential; remove only credentials referenced exclusively by removed providers and preserve unrelated environment keys.

## scan_scope
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/pages/marketing/agent-reset-config.ts`
- `frontend/src/pages/marketing/agent-model-config/**`
- `ctl/pkg/instance/reset_config.go`
- `docs/engineering/domains/agent-gateway-runtime.md`

## scan_output
- Bounded `rg` and `sed` inspection summarized under evidence; no standalone scan artifact.

## handoff
- Implementation and scoped verification are complete in `/Users/pablozhong/codex/lightvela-profile-model-reset` on `fix/profile-reset-0915-current-bot`.
- No commit, push, MR, deployment, or production mutation was performed.
- FEAI native verify passed and is awaiting the user's explicit archive instruction.
