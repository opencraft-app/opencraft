# Domestic Site Authentication Implementation Plan

> For agentic workers: use executing-plans to implement this plan task-by-task.

**Goal:** Add a stateless LightVela domestic-site access protocol and enforce it in site-gateway for *.lightvela.tech, while preserving anonymous access for *.lightvela.site.

**Architecture:** A trusted LightVela login integration signs a short-lived Ed25519 JWS access ticket after validating the existing lc_session. site-gateway verifies the ticket locally using configured public keys, binds it to the requested domestic Host and browser state, and stores the same signed value in a host-only lv_site_session cookie. No Redis/session database is used; the international deployment remains public.

**Tech Stack:** Go 1.25, github.com/golang-jwt/jwt/v5, crypto/ed25519, httptest, Kustomize/Argo configuration.

## Global Constraints

- Never accept lc_session directly on *.lightvela.tech; it remains owned by the existing login/Auth origin.
- Never allow browser JavaScript to mint access tickets; only a trusted backend signs them.
- Only accept JWT algorithm EdDSA with Ed25519 keys and an explicit kid; reject algorithm substitution.
- Validate iss, aud, exp, iat, target Host, and browser state before COS lookup.
- Use host-only, HttpOnly, Secure, SameSite=Lax cookies for lv_site_session and the bootstrap state.
- Required-mode failures fail closed and return private, no-store plus X-Robots-Tag: noindex, nofollow, noarchive.
- International site-gateway remains public unless explicitly configured otherwise.
- Do not add login UI, change user/auth session storage, or create production secrets/keys in Git.

---

### Task 1: Add the signed site-access protocol verifier

Files:
- Create: site-gateway/internal/siteauth/token.go
- Test: site-gateway/internal/siteauth/token_test.go
- Modify: site-gateway/go.mod
- Modify: site-gateway/go.sum

Interfaces:
- siteauth.Config{Issuer, Audience string, PublicKeys map[string]ed25519.PublicKey, Clock func() time.Time}
- siteauth.Verifier.Verify(rawToken, expectedHost, expectedState string) (*Claims, error)
- siteauth.Claims contains Subject, SiteHost, State, and registered iat/exp/jti claims.
- Token header is typ=LV-Site-Access, alg=EdDSA, and kid=<configured key id>.

Steps:
- Write failing tests for valid tokens and rejection of bad signature, unknown kid, wrong algorithm, wrong issuer/audience, expired token, wrong Host, and wrong state.
- Run: cd site-gateway && go test ./internal/siteauth -run TestVerifier -count=1. Expected: failure because the package does not exist.
- Implement minimal Ed25519/JWS verification using jwt/v5 parser options and an explicit EdDSA method.
- Reject missing/unknown kid, wrong typ, invalid time claims, and mismatched Host/state. Normalize Host by removing an optional port and lowercasing.
- Run: cd site-gateway && go test ./internal/siteauth -count=1. Expected: PASS.

### Task 2: Add gateway auth configuration and stateless bootstrap middleware

Files:
- Modify: site-gateway/internal/config/config.go
- Test: site-gateway/internal/config/config_test.go
- Modify: site-gateway/internal/httpapi/server.go
- Create: site-gateway/internal/httpapi/siteauth.go
- Test: site-gateway/internal/httpapi/siteauth_test.go
- Modify: site-gateway/cmd/site-gateway/main.go

Interfaces:
- Config fields: AuthMode (public or required, default public), AuthIssuer, AuthAudience, AuthStartURL, AuthPublicKeys, AuthSessionTTL.
- Reserved paths: /__lightvela/auth/start and /__lightvela/auth/callback.
- SiteHandler receives a siteauth.Verifier and auth options.
- lv_site_session is the signed token stored as a host-only cookie; __Host-lv_site_state binds the callback to the browser.

Steps:
- Write failing config tests: public mode needs no auth values; required mode needs issuer, audience, auth start URL, and valid kid=base64url-ed25519-public-key entries; session TTL is positive and defaults to five minutes.
- Write failing HTTP tests: required mode without lv_site_session sets __Host-lv_site_state and redirects to AuthStartURL without site/COS lookup; valid callback sets lv_site_session, clears state, and redirects to /; invalid/expired/wrong-host/wrong-state callback returns 403 without COS; valid session serves private, no-store content with X-Robots-Tag; public mode preserves anonymous behavior; write methods remain 405.
- Run focused tests and verify failure: cd site-gateway && go test ./internal/config ./internal/httpapi -run 'Test(Auth|Required|Public|SiteSession)' -count=1.
- Implement middleware: intercept auth paths before Host-to-site resolution, generate 32 random bytes for state, validate same-host relative return paths, redirect to AuthStartURL with redirect_uri and state, verify callback token/state, set lv_site_session with configured TTL, clear state, and redirect to /.
- Verify lv_site_session before site metadata/COS lookup in required mode. Return 403, Cache-Control private, no-store, and X-Robots-Tag on auth failures; do not redirect write methods.
- Run: cd site-gateway && go test ./internal/config ./internal/httpapi -count=1. Expected: PASS.

### Task 3: Publish the protocol contract for the Auth integration

Files:
- Create: site-gateway/docs/site-access-protocol.md
- Test: site-gateway/internal/siteauth/protocol_doc_test.go

Contract:
- Document issuer/verifier responsibilities, exact JWS header/claims, base64url key format, callback query parameters, cookie attributes, status codes, and key rotation.
- The issuer validates lc_session on its own Auth origin and never exposes it to the domestic site.
- Stateless tokens cannot provide strict one-time consumption or immediate logout revocation. The issuer must set exp no later than five minutes, and the gateway site-session Cookie is capped at five minutes.
- Document public/international versus required/domestic configuration.
- The doc test checks EdDSA, kid, site_host, state, lv_site_session, __Host-lv_site_state, lightvela.tech, and lightvela.site.

Steps:
- Write the failing document test and run: cd site-gateway && go test ./internal/siteauth -run TestProtocolDocument -count=1.
- Write the protocol document with placeholder values only; never include real keys, tokens, certificate IDs, or secrets.
- Run the document test again. Expected: PASS.

### Task 4: Wire non-secret configuration contracts without enabling production

Files:
- Modify: site-gateway/k8s/base/manifests.yaml
- Modify: site-gateway/k8s/overlays/sgprod/generated/platform.env.example
- Modify: argocd/services/site-gateway/sgprod/site-gateway-platform.env
- Modify: argocd/services/site-gateway/sgprod/README.md
- Modify: .ci/runtime/bundles/site-gateway.bundle
- Test: .ci/runtime/tests/contract_tests/test_release_bundle_contracts.py

Contract:
- Base manifests expose auth mode/verifier settings.
- Singapore production explicitly sets SITE_GATEWAY_AUTH_MODE=public; no domestic domain or production issuer is enabled by this task.
- Public-key material is non-secret platform configuration; private signing keys remain external to GitOps.
- Release bundle includes the protocol document and source files.

Steps:
- Add failing contract assertions for auth config keys, explicit sgprod public mode, and the protocol document in the bundle.
- Run: python3 .ci/runtime/tests/contract_tests/test_release_bundle_contracts.py. Expected: failure if the contract is not wired.
- Implement non-secret wiring and keep sgprod public. Do not create SOPS plaintext, signing keys, certificates, or a domestic Application until Auth integration values are provided.
- Run contract tests. Render site-gateway/k8s/base with kubectl kustomize; the source sgprod overlay requires the generated platform.env produced by the release pipeline. Expected: PASS and public base/sgprod configuration.

### Task 5: Full verification and handoff

Steps:
- Run: cd site-gateway && go test ./...
- Run: cd service-gateway && go test ./internal/gateway -count=1.
- Run: cd user/auth && go test ./internal/httpapi -count=1.
- Run: python3 .ci/runtime/tests/contract_tests/test_release_bundle_contracts.py.
- Run: git diff --check.
- Confirm no frontend files, secret values, certificate IDs, production domestic Application, or user/auth login/session changes; confirm international public behavior remains green.
