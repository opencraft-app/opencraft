## goal

Align Hermes AppServer model identity handling with Hermes Desktop provider aliases, so a current session selection remains usable when `session.resume` and `model.options` express the same provider with different identifiers.

## non_goals

- Do not change Hermes Desktop, shared AppServer protocol, user credentials, or provider configuration.
- Do not send a live model switch or mutate an active Bot while diagnosing identity mapping.

## requirement_ids / requirement_refs / requirement_excerpt

- User request: migrate Hermes Desktop provider alias semantics to the bridge and compare same-session `session.resume` and `model.options` fields.

## interface_refs / data_structure_refs

- `ref/hermes-agent/apps/desktop/src/lib/model-options.ts`: provider match permits slug, display name, and aliases; catalog is session/profile scoped.
- `opencraft/plugins/lightvela-hermes/src/hermes-appserver-bridge/model-catalog.ts`: internal AppServer selection encoding.
- Invariant: a current Hermes session model is not invalid solely because the picker catalog uses an equivalent provider alias.

## history_context

- `current_design_refs`: `opencraft/docs/platform-architecture.md`, `opencraft/docs/dsh-appserver-boundaries.md`.
- `relevant_evolution`: current bridge maps raw provider/model and catalog slug to strict, independently encoded IDs; Desktop supports aliases for this exact custom-provider boundary.
- `superseded_refs`: none.

## acceptance

- Same-session raw provider alias maps to the catalog's canonical option without changing the model route.
- An unrelated same-named model under another provider is not selected by alias matching.
- The selected option retains a human display name rather than leaking encoded internal identity.

## affected_paths

- `opencraft/plugins/lightvela-hermes/src/hermes-appserver-bridge/model-catalog.ts`
- `opencraft/plugins/lightvela-hermes/src/hermes-appserver-bridge/adapter.ts`
- `opencraft/plugins/lightvela-hermes/src/hermes-appserver-bridge/types.ts`
- `opencraft/tests/lightvela-hermes-plugin.test.ts`

## required_context

- `identity-access`, `agent-gateway-runtime`, and OpenCraft maintenance guidance.

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/domains/identity-access.md` | session route trigger | Confirm no identity/credential change. |
| `docs/context/domains/agent-gateway-runtime.md` | provider and runtime route | Retain upstream/bridge boundary. |
| `ref/hermes-agent/apps/desktop/src/lib/model-options.ts` | Desktop authority | Reuse alias and owner-scoped catalog semantics. |
| `opencraft/plugins/lightvela-hermes/src/hermes-appserver-bridge/adapter.ts` | Current bridge owner | Locate raw `session.resume` and `model.options` projections. |

## evidence

- A same-session fixture captures `session.resume` as `custom:111` plus `kimi-k2.8-preview`, and `model.options` for that exact `session_id` / `profile` as canonical `111` with alias `custom:111`; the bridge exposes one selectable row under the raw active selection and does not map the identical model under `222`.
- Passive CDP observation of the current desktop window received no `session.resume` or `model.options` frames. No live interaction, restart, or credential inspection was performed; current-instance raw-field confirmation remains pending a user-triggered resume/catalog refresh.

## risks

- Alias matching could merge distinct providers with the same model; only declared aliases, slug, and display name may match.

## validation

- `npx tsx --test tests/lightvela-hermes-plugin.test.ts` (78 passed).
- `npm run test:bot-management` (32 passed).
- `npm run typecheck` and `git diff --check` passed.
- Current-instance raw payload comparison remains pending as described in evidence.

## decisions

- Keep provider normalization bridge-local. The shared AppServer protocol stays provider-agnostic.

## scan_scope

- Hermes Desktop model options, Hermes bridge model catalog/adapter, and focused plugin tests.

## scan_output

- Desktop uses session/profile-scoped `model.options` and alias-aware matching; bridge currently encodes raw resume provider and catalog slug independently.

## handoff

- Source implementation is complete and uncommitted. Existing user changes in the same Hermes bridge files are preserved. To finish runtime evidence, open the affected Bot conversation or refresh its model menu while a read-only CDP observer is attached; this does not require sending a prompt.
