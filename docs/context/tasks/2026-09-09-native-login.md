# Native Expo login callback

## goal
Reuse LightVela's unified provider UI for Workbench Web, and complete the existing OIDC native-client path for Expo in Shanghai and Singapore.

## non_goals
- New authentication providers, TAT device registration, or widening the site-gateway client.

## requirement_ids / requirement_refs / requirement_excerpt
- Current user request: use the existing unified login surface and fix the Shanghai native client registration.

## interface_refs / data_structure_refs
- `user/auth/internal/httpapi/oauth_return_to.go`: web session handoff remains the authority for Workbench Web.
- `frontend/src/pages/auth/sign-in-page.tsx`: shared provider UI relays only exact Workbench return origins.
- `user/auth/internal/oidc/code_store.go`: shared, atomic, expiring S256 code consumption.
- `/vela/apps/workbench-expo/src/runtime/lightvela-account.native.ts`: native account owner.
- Native callbacks carry only code/state, never a session token. The verifier stays on the device.

## history_context
- current_design_refs: `docs/engineering/domains/identity-access.md`.
- relevant_evolution: current native client requests `opencraft://auth/lightvela`; production clears this return_to cookie. HTTPS return_to is retained (read-only probes on 2026-09-09).
- superseded_refs: Google-only native start and provider callback overrides from 9c657c758; removed in this follow-up.

## acceptance
- Exact redirect validation; failed PKCE and replay rejected; independent handlers share code state.
- Callback state/address validated, cancellation/expiry/disposal cannot publish credentials.
- Both production registries contain the exact native client without changing the site-gateway redirects.
- Workbench Web delegates provider selection to the shared sign-in page without creating an OIDC JWT/session ambiguity.
- Go tests/vet, native TypeScript tests/typecheck, simulator Release build.
- Production login remains unverified until separately authorized deployment.

## affected_paths
- `user/auth/internal/httpapi`, `user/auth/cmd/lightclaw-auth`, auth API and identity design.
- `frontend/src/pages/auth`, `frontend/src/repositories`: constrained Workbench Web delegation to the shared sign-in page.
- `argocd/services/lightclaw-auth/{shprod,sgprod}` and `argocd/services/service-gateway/{shprod,sgprod}`: exact native-client registration and token route.
- `docs/engineering/domains/{identity-access,release-gitops}.md`: Web/native authority boundary and paired regional delivery invariant.
- `service-gateway/internal/gateway/native_login_test.go` and production configuration policy tests.
- `/vela/apps/workbench-expo`, `/vela/tests`.

## required_context
- identity-access.

## context_receipt
| File | Reason | Use |
|---|---|---|
| `AGENTS.md` | repository rules | no production writes |
| `frontend/AGENTS.md` | mobile authorization UI | focused tests and viewport validation |
| `frontend/openspec/changes/2026-08-24-oidc-site-auth-spec.md` | existing OIDC design | extend clients, not providers |
| `user/auth/AGENTS.md` | service rules | Argo-only release |
| `docs/context/domains/identity-access.md` | routed context | auth owns sessions |
| `docs/context/domains/agent-gateway-runtime.md` | routed context | public route must be verified at gateway |
| `docs/engineering/domains/identity-access.md` | design | minimal, expiring credentials |
| `docs/engineering/domains/release-gitops.md` | design | client registration and token route publish as one regional capability |
| `service-gateway/AGENTS.md` | gateway delivery rules | production source config stays under Argo CD paths |
| `docs/context/tasks/TASK-TEMPLATE.md` | task contract | this record |
| `docs/context/tasks/CHECKPOINT-TEMPLATE.md` | checkpoint contract | handoff |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md` | nearest auth UI neighbor | inspected frontend/vitest.config.ts and existing authorization tests; reuse authorization page |
| `.agents/context/change-impact.json` | design impact | update identity design |

## evidence
- Fresh `origin/master` (`ccef1a5ed`) already contains the Singapore native client and exact token route, but Shanghai source configuration contains neither; this matches the reported domestic `unauthorized_client` response.
- The first production build after changing only the legacy React page omitted `/auth/sign-in`; after adding the Next App Router route, the build manifest contains `○ /auth/sign-in` and 97 static pages.

## risks
- Production code store must be shared MySQL. Native session adapter may consume only the registered native OIDC client grants; native JWT redemption is rejected.

## validation
- Current focused frontend tests pass (108 passed, 1 skipped); typecheck reports 0 new diagnostics; production Next build passes and publishes `/auth/sign-in`.
- Current Service Gateway and UserAuth full Go suites pass with Go 1.25.4 and `GOWORK=off`; release bundle contract tests pass 84/84.
- Current Workbench account/native login tests pass 15/15; plugin typecheck and LightVela Web production build pass.
- The frontend package has no `lint` script; `pnpm lint` exits with `Command "lint" not found`.
- Previous simulator build was Google-only; this follow-up has NOT been rebuilt/installed on the Mac.

## decisions
- Reuse OIDC authorization page, provider, registry and code store. A registered first-party session adapter is the only native redemption path; no new login page.
- Workbench Web delegates provider choice to `/auth/sign-in`, then keeps the existing Web session handoff. It does not masquerade as a native OIDC client.

## scan_scope
- auth HTTP, code store, bootstrap; Expo native account/routes.

## scan_output
- No credential values retained.

## handoff
- User authorized local commits on 2026-09-09. Commit the OIDC follow-up and the separate Expo changes; do not push, merge or deploy.
- Deployment must register the native OIDC client, preserve sites redirects, expose existing /oauth2 paths and only POST /auth/native/token in /auth public_allow. Remove old native/start deployment instructions.
- Existing migration 000018 owns the reused authorization-code table; verify it exists in the target environment, do not auto-run migrations.
- App source changes reside in /vela; backend MR does not include that separate repository.

## stage
Latest `origin/master` inspected at `ccef1a5ed`; unified Web login delegation and missing Shanghai native registration/route are implemented and locally validated. No commit, push, MR, or deployment is claimed.

## verified
- Native credentials are issued only by the registered-client PKCE session adapter; generic web return_to still rejects custom schemes.
- Source checkout began clean; all modifications in this MR belong to this task.

## unverified
- Production rollout, actual IdP login/native callback, iOS binary build and live MySQL integration are not claimed for this follow-up.

## discard
- Do not widen the domain allowlist or reuse TAT device-bind tokens for app login.

## restore
- Mac build: /Users/skipzhang/Developer/opencraft-expo-build; source app: /vela.

## next_action
- Owner review and separately authorized push/release with OIDC client registration. No production or simulator rollout is implied by these local commits.
