---
id: opencraft-model-connections-20260913
type: task
scope: Environment-scoped model connections and editable model declarations
owner: mingyuxiao
authority: primary
source_of_truth: [opencraft/docs/local-agent-custom-providers.md]
status: retired
reviewed_at: 2026-09-13
review_due: 2026-10-13
revision: 1.0.0
precedence: task
derived: false
---
## goal
Deliver a usable first connection-first custom model manager, reusing existing DSH settings, credentials and session selection ownership.
## non_goals
- No parallel configuration database, persisted renderer secrets, automatic provider enablement or changes to existing session/default selections.
- No unverified remote Host support, cloud writes, paid inference, Git operations or copying LobeHub code.
- No invented capability toggles unsupported by bundled DSH.
## requirement_ids / requirement_refs / requirement_excerpt
- Current conversation: implement WB-lightweight interaction with LobeHub connection/model separation, scoped by environment.
## interface_refs / data_structure_refs
- RuntimeProviderApplyParams / RuntimeDiscoveredModelView; RuntimeProviderService; LocalAgentSettingsService.
- Stable provider IDs + model IDs; DSH CAS revision, write-only credential staging; explicit Host ID on settings client.
## history_context
- current_design_refs: opencraft/docs/local-agent-custom-providers.md; opencraft/docs/platform-architecture.md.
- relevant_evolution: existing connection manager already has independent IDs and credential refs; extend instead of replacing it.
- superseded_refs: WB/LobeHub review is inspiration only; current bundled DSH source is runtime authority.
## acceptance
- Create connection with protocol/address and optional first model; disabled by default.
- Add/edit model display name, context/output limits and supported text/image input declarations; validate without overwriting unrelated models.
- Explicit draft endpoint probe distinguishes inference success from save and discovery, never borrows saved secrets or alters sessions.
- Host-scoped client prevents reads/writes crossing environments; unsupported Hosts remain capability-gated.
- Unit tests, full gate and real UI → AppServer → DSH smoke with isolated mock endpoint.
## affected_paths
- opencraft/packages/appserver-protocol/src/runtime-settings.ts and methods.ts
- opencraft/apps/local-agent-host/src/runtime-provider-service.ts and dsh-appserver-adapter.ts
- opencraft/plugins/builtin-agents/src/
- opencraft/tests/runtime-provider-service.test.ts and scripts/smoke-local-agent-settings.ts
## required_context
- No context pack matched initial exact task route; bounded source inspection used.
## context_receipt
| File | Reason | Use |
|---|---|---|
| opencraft/AGENTS.md | Scope | Preserve workspace and runtime source boundaries |
| opencraft/docs/local-agent-custom-providers.md | Current authority | Preserve credential/CAS invariants |
| opencraft/docs/platform-architecture.md | Environment ownership | Bind local feature only to supported runtime |
## evidence
- Found existing route-based model manager and provider-scoped model identity; no migration needed.
- Bundled DSH model schema supports name/contextWindow/maxTokens/input; no generic supportsToolCall field, so do not invent one.
- DSH RPC intentionally has no credential read or sessionless inference endpoint. Probe uses explicit draft key only and does not claim full runtime validation.
## risks
- Probe target credential forwarding; prevent redirects, bound time/body and use only explicitly supplied key.
- Probe consumes an external request when user explicitly clicks; automated QA only uses local synthetic server.
## validation
- `npm run gate` exit 0, `/tmp/opencraft-model-connections-gate.log` (all workspace types, boundary tests and Web/Expo builds).
- Provider/default-model focused suite 24/24 passed, `/tmp/opencraft-model-connections-unit.log`.
- Real UI → AppServer → isolated DSH smoke passed: create, discovery, model declaration validation, unapplied edit/remount preservation, draft probe, save, real catalog enable/disable/delete and unchanged default. `/tmp/opencraft-model-connections-smoke.log`.
- Environment UI smoke passed on rerun after an initial fixture navigation-detach timeout; local/remote selection isolation, draft restoration, narrow/dark layouts. `/tmp/opencraft-model-connections-environments.log`.
- Native release build and independently signed `release/model-connections-preview` succeeded; codesign strict/deep verification passed.
- Fresh Mac profile `/tmp/opencraft-model-connections.FjHegr`, CDP19731: Environment → Model services → Add provider displays request format, URL, key and first-model fields. Screenshot `/tmp/opencraft-model-connections-native.png`; no real credentials entered or config saved. App left on the creation form.
- Documentation validator has no errors; explicit changed-file impact gate passed with owner-review advisory. Staged gate has no changes because nothing was staged. `git diff --check` passed.
## decisions
- Retain current protocol scope (Chat Completions/Responses) for this first slice.
- Parameterize settings service by immutable Host ID; no remote UI advertised without matching runtime capabilities.
## scan_scope
- Local Agent provider manager and bundled DSH schema/RPC boundary.
## scan_output
- Initial route no matches; bounded searches located relevant files.
## handoff
- First slice implemented and independently previewed; no user credentials read, no paid/external inference, no commit/push or production changes.
- Current support: local Host, Chat Completions and Responses. Remote hosts need their own matching management capabilities; no unsupported UI is advertised.
- Tests use synthetic keys and local endpoints. Draft text probe does not validate streaming/tools/images or the full DSH request pipeline, and intentionally does not reuse stored secrets.
## stage
- Complete; ready for user visual review.
## verified
- Independent connection/model identities reused; DSH remains store/CAS/credential authority. Every client call binds explicit immutable Host ID.
- Model editing is service-owned, including unapplied fields; generic key/control bodies are not returned from probes.
## unverified
- User's real provider endpoint and credential; no production provider was invoked.
## discard
- No new provider DB or arbitrary DSH credential getter; both were intentionally avoided.
## restore
- Keep unrelated dirty changes and existing preview profiles. New native preview/profile are listed above.
## next_action
- User can add a connection in the new preview, configure models and explicitly test/enable it.
