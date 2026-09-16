---
id: opencraft-authentication-flows-20260913
type: task
scope: OpenCraft application-owned Cordis authentication flows
owner: mingyuxiao
authority: primary
source_of_truth: [opencraft/packages/workbench-runtime/src/authentication]
status: retired
reviewed_at: 2026-09-13
review_due: 2026-10-13
revision: 1.0.0
precedence: task
derived: false
---

## goal
Separate session authority, interactive sign-in coordination and account presentation through application-lifetime Cordis services.
## non_goals
- No credential storage or native OAuth redesign; no Keychain, billing, cloud creation, deployment or Git operations.
- No wholesale WorkBuddy migration; the local reference is read-only.
## requirement_ids / requirement_refs / requirement_excerpt
- Current conversation: implement the reviewed long-term ownership model as Cordis services; successful sign-in must not open Account automatically.
## interface_refs / data_structure_refs
- AuthenticationProvider / AuthenticationFlowPort; PlatformViewHost; LightVelaAccountSnapshot.session.
- Session restoration never creates a flow; explicit completion includes epoch, not identity comparison.
- Only the active flow may complete its presentation; abandonment revokes continuation, not valid global session installation.
## history_context
- current_design_refs: opencraft/docs/platform-architecture.md; docs/engineering/domains/agent-gateway-runtime.md.
- relevant_evolution: private Main session storage and environment directory already implemented in this dirty worktree; preserve them.
- superseded_refs: ref/wb desktop account/provider modeling is inspiration, not authority.
## acceptance
- Footer Sign in closes on matching success; explicit Account survives refresh; restoring session opens no modal.
- Test cancellation, supersession, same-account login, stale response, plugin disposal, inline environment continuation, profile/catalog errors.
- Focused tests, workspace typecheck, full OpenCraft gate, rendered browser/native preview evidence.
## affected_paths
- opencraft/packages/workbench-runtime/src/authentication/
- opencraft/packages/extension-react/src/index.ts
- opencraft/apps/workbench-web/src/runtime/ and account presentation
- opencraft/plugins/lightvela-hermes/src/account/ and sign-in consumers
## required_context
- identity-access; nearest OpenCraft AGENTS; platform architecture.
## context_receipt
| File | Reason | Use |
|---|---|---|
| AGENTS.md | Repo authority | Preserve dirty work and no external writes |
| opencraft/AGENTS.md | Service boundary | Own workspace gate |
| docs/context/domains/identity-access.md | Router must_read | Provider authority, not UI-derived session |
| opencraft/docs/platform-architecture.md | Current model | App-owned lifecycle and trusted contribution channels |
| docs/context/project/adjacency/frontend-runtime-openspec-i18n.md | Adjacent validation boundary | Confirm frontend tests are separate; no frontend changes |
| frontend/vitest.config.ts | Adjacency test neighbor | Do not invoke or modify the unrelated frontend workspace |
| opencraft/docs/build-matrix.md | Native QA | Independent signed preview, no replacement of existing profile |
## evidence
- Bounded source inspection: current signIn awaited refreshBots; account modal morphed from sign-in to account on auth changes.
- `npm run gate` passed, exit 0; `/tmp/opencraft-auth-flow-gate.log` (boundaries, all workspace types, service tests, Web/Expo exports).
- `npm run test:desktop-login` passed 42/42, including new Cordis flow tests and independent session/late-401 cases.
- `scripts/smoke-authentication-flows.ts` passed six real-rendered scenarios: close/focus/draft; explicit account + same-account reauth; cancellation/stale callback; restore/navigation; environment preflight without POST; resource 503. Report `/tmp/opencraft-authentication-flows/report.json`, no browser errors.
- Existing `smoke-account-controls.ts` and `smoke-environment-creation.ts` passed after migrating fixtures to the explicit session contract.
- `npm run build:electron:release`, independent `release/auth-flow-preview` packaging and `codesign --verify --deep --strict` passed.
- Packaged native app, isolated profile `/tmp/opencraft-auth-flow.16pYvu`, CDP 19699: anonymous Composer first, separate Sign in dialog, Escape closes, focus returns, no Account modal. Screenshot `/tmp/opencraft-authentication-flows/native-sign-in.png`.
- Real native browser OAuth completion was not performed with the user's credentials this turn; completion/cancellation races exercised through test ports. Existing Main protocol/store integration tests retained.
- Documentation validator errors empty; staged impact check empty (nothing staged); explicit mapped-file impact check passed with owner-review advisory.
## risks
- Cross-epoch 401, cancelled native transaction joining new flow, conditional View unmount during authentication.
## validation
- Completed gates and UI smoke above. Last compact-layout fix covered by fresh browser regression and Electron release build.
## decisions
- Generic Cordis broker + interactive coordinator; provider keeps credentials. Presentation consumes narrow flow capability.
- Keep legacy catalog phase for Host compatibility while introducing explicit independent session status.
## scan_scope
- OpenCraft authentication, extension projection, App/Hostless shell surfaces.
## scan_output
- No external scan.
## handoff
- Implementation and independent Mac preview complete; no commit, push, remote writes, real cloud creation or production release.
- Preserve unrelated dirty changes. Main token ownership and private plaintext storage remain unchanged. Legacy Bot `phase` retained only for Host compatibility; new consumers use `session`.

## checkpoint
- Current goal achieved: application-scoped Cordis provider broker and interactive coordinator installed before extension activation, with startup rollback and shutdown cleanup.
- Runtime reference: newly opened auth-flow-preview uses the isolated profile above. Other preview apps and user sessions were not stopped or overwritten.
- Next user step: real-account browser login in this new preview to confirm external end-to-end behavior; automated flow completion already verified through test providers.
