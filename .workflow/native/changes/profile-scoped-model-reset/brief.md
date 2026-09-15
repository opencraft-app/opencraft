# Profile-scoped model reset

## Requirement

Make the diagnostics action "Reset model configuration" operate on the currently selected Bot's Hermes Profile. It must be available when an Agent has multiple Bots and must not change any sibling Bot's model configuration.

## Scope

- Remove the single-main-Bot and multi-Bot frontend guard for model reset.
- Execute reset through the existing Profile-scoped Hermes model-config command path, using the backend-provided `profile_id` (`main` continues to resolve to Hermes `default`).
- Restore the selected Profile's reserved Hermes `custom` provider as the primary system model, preserving that provider and its credential.
- Clear only the selected Profile's user-added model routes, configured providers, model-management metadata, and credentials referenced exclusively by those removed providers.
- Keep workspace, memory, channels, skills, other Profile files, sibling Profiles, and instance-level credentials/metadata unchanged.
- Keep Agent reinstall, backup/restore, resource, billing, and other maintenance operations instance-scoped and main-Bot-only.
- Update the diagnostics copy and product documentation so users know the current Bot is affected, the system built-in model is restored, and custom model choices must be configured again if still needed.

## Non-goals

- No CTL API, database, service-gateway, OpenCraft, GitOps, deployment, or production mutation.
- No instance API-key rotation and no attempt to copy model settings from the main Bot or another Profile.
- No model replacement copied from the main Bot, a sibling Profile, or the current product catalog.

## Key findings and design

- The old path calls `resetInstanceConfig`, which rotates one instance-owned AI Gateway key and is therefore intentionally incompatible with independent multi-Profile reset.
- Hermes Profile invocations have independent config and environment roots. The frontend already has a hardened command helper that resolves the selected Profile root, locks mutations, validates persisted state, and rolls back failed writes.
- Add one `resetToBuiltIn` mutation to that helper and expose it through the model-config client. The diagnostics handler will call the client for the active Bot/Profile and will not call the instance reset API or the unscoped `acli backend reset-config` command.
- The platform-owned provider is identified by the reserved Hermes provider key `custom`, which CTL uses during Agent onboarding. Its saved provider definition, default model, and credential are preserved; reset fails closed without writes if that baseline cannot be established from the selected Profile.
- Credentials are removed only when referenced exclusively by providers being removed. Configuration and credential writes must roll back together on failure.

## Acceptance criteria

- Root and named Bots can open and confirm model reset while sibling Bots exist, provided the selected Bot is running and no maintenance operation is active.
- The executed command resolves exactly the selected `profile_id`; product `main` maps to Hermes native `default`.
- A successful reset makes the selected Profile's reserved `custom` provider/default model primary, removes all fallbacks and user-added configured providers/model-management history, preserves the built-in provider credential, and removes credentials owned exclusively by deleted providers.
- Unrelated Profile configuration and unrelated keys in the selected Profile's `.env` remain unchanged.
- If the built-in provider/default model/credential is unavailable, or if save or credential cleanup fails, the action restores the selected Profile's original model config and credentials and reports failure.
- Focused unit/component tests cover multi-Bot enablement, Profile command scoping, reset behavior, rollback, and absence of the instance reset call.
- Frontend lint, type check, focused tests, build, documentation validation, and changed-path impact validation pass.

## Risks

- Older Hermes runtimes may normalize config fields differently; the reserved provider baseline and persistence are verified through Hermes' own config API.
- Credential cleanup spans config and `.env`; the implementation snapshots referenced values and restores them if any mutation fails.
- This removes user-added model configuration from the selected Profile, so the confirmation dialog explicitly identifies the current Bot and states what is restored versus removed.
