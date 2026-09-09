# Native Expo login callback

## goal
Complete the Expo → Google OAuth → native callback → session exchange contract.

## non_goals
- Production/GitOps changes, OIDC registry changes, TAT device registration.

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
- superseded_refs: none.

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
| `user/auth/AGENTS.md` | service rules | Argo-only release |
| `service-gateway/AGENTS.md` | gateway policy tests | no direct production mutation |
| `docs/context/domains/identity-access.md` | routed context | auth owns sessions |
| `docs/engineering/domains/identity-access.md` | design | minimal, expiring credentials |
| `docs/context/tasks/TASK-TEMPLATE.md` | task contract | this record |
| `docs/context/tasks/CHECKPOINT-TEMPLATE.md` | checkpoint contract | handoff |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md` | nearest auth UI neighbor | inspected frontend/vitest.config.ts; no frontend changes planned |
| `.agents/context/change-impact.json` | design impact | update identity design |

## evidence
- Production start response clears native return_to; source only accepts allowed HTTP(S) targets.

## risks
- Production code store must be shared MySQL, never per-process memory. Native namespace cannot consume OIDC codes.

## validation
- `GOWORK=off go test ./...` and `go vet ./...` in user/auth and service-gateway passed with cached Go 1.25.4 (system Go 1.24.4 is too old).
- Auth tests cover real stub-provider OAuth round trip, exact callback, S256 failure, expiry, namespace isolation, eight concurrent consumers/one success, provider error callback and OpenAPI validity.
- Gateway tests prove only GET start and POST token bypass existing-session checks; wrong methods and /auth/session stay protected.
- Expo PKCE unit tests 5/5, typecheck and native Release simulator build passed. Build is installed on iPhone 17 Pro; no claim of live login success before backend deployment.
- Documentation validation passed; staged design-impact check is required before commit.

## decisions
- Reuse the existing authorization-code storage primitive; isolate native-login client identity and exchange endpoint from OIDC token issuance.

## scan_scope
- auth HTTP, code store, bootstrap; Expo native account/routes.

## scan_output
- No credential values retained.

## handoff
- User authorized a backend MR. Prepare source MR to master; do not merge or change production/GitOps.
- Deployment must expose GET /auth/native/start and POST /auth/native/token in the /auth public_allow policy and deploy the auth image. Current live 404 is expected until then.
- Existing migration 000018 owns the reused authorization-code table; verify it exists in the target environment, do not auto-run migrations.
- App source changes reside in /vela; backend MR does not include that separate repository.

## stage
Implementation verified; preparing backend source MR.

## verified
- Native credentials are issued only by the PKCE exchange; generic web return_to still rejects custom schemes.
- Source checkout began clean; all modifications in this MR belong to this task.

## unverified
- Production rollout, real Google login through the updated public gateway, and live MySQL integration are not claimed.

## discard
- Do not widen the domain allowlist or reuse TAT device-bind tokens for app login.

## restore
- Mac build: /Users/skipzhang/Developer/opencraft-expo-build; source app: /vela.

## next_action
- Submit backend branch/MR, report release prerequisites without performing rollout.
