# Native Expo login callback

## goal
Extend the existing unified OIDC authorization flow to Expo, including mobile layout and transaction ownership.

## non_goals
- Production/GitOps changes, new authentication providers, TAT device registration.

## requirement_ids / requirement_refs / requirement_excerpt
- Current user request: fix native login returning to the website instead of the app.

## interface_refs / data_structure_refs
- `user/auth/internal/httpapi/oauth_return_to.go`: web redirects remain unchanged.
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
- Go tests/vet, native TypeScript tests/typecheck, simulator Release build.
- Production login remains unverified until separately authorized deployment.

## affected_paths
- `user/auth/internal/httpapi`, `user/auth/cmd/lightclaw-auth`, auth API and identity design.
- `service-gateway/internal/gateway/native_login_test.go` (policy test only; no deployment config changes).
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
| `service-gateway/AGENTS.md` | gateway policy tests | no direct production mutation |
| `docs/context/domains/identity-access.md` | routed context | auth owns sessions |
| `docs/engineering/domains/identity-access.md` | design | minimal, expiring credentials |
| `docs/context/tasks/TASK-TEMPLATE.md` | task contract | this record |
| `docs/context/tasks/CHECKPOINT-TEMPLATE.md` | checkpoint contract | handoff |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md` | nearest auth UI neighbor | inspected frontend/vitest.config.ts and existing authorization tests; reuse authorization page |
| `.agents/context/change-impact.json` | design impact | update identity design |

## evidence
- Production start response clears native return_to; source only accepts allowed HTTP(S) targets.

## risks
- Production code store must be shared MySQL. Native session adapter may consume only the registered native OIDC client grants; native JWT redemption is rejected.

## validation
- Latest auth and service-gateway full Go tests and vet pass with cached Go 1.25.4, GOWORK=off.
- Auth covers unified authorize page without Google, unauthenticated denial, exact native callback, wrong verifier, expiry, eight concurrent consumers/one success, foreign-client isolation, disabled/unregistered native capability, and provider-error return preservation.
- Expo native tests 8/8 pass; typecheck passes. Includes retired-owner cleanup and stale-callback saved-session restoration.
- Frontend focused tests 37/37 pass; typecheck has 0 new diagnostics against the existing baseline (191 current, 276 baseline); full production build passes.
- Chromium mobile geometry/click fixtures pass 320x568, 390x844, 844x390 and 390x280. Real authorization components/CSS, mocked account context and inactive login modal; not live provider authentication or an iOS keyboard test.
- Logs: /tmp/native-oidc-{auth-all,auth-vet,gateway-all,gateway-vet,ui-tests,ui-types,ui-build,mobile-browser}.log; screenshots /tmp/native-oidc-browser.l10V2u/.
- No frontend lint script exists. Generated font/next-env build changes restored; no unrelated generated files retained.
- Previous simulator build was Google-only; this follow-up has NOT been rebuilt/installed on the Mac.

## decisions
- Reuse OIDC authorization page, provider, registry and code store. A registered first-party session adapter is the only native redemption path; no new login page.

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
OIDC follow-up implemented and tested; preparing user-authorized local commits after staged checks.

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
