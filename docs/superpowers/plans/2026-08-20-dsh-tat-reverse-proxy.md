# DSH Federation TAT Reverse Proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reuse LightVela federation and `site-gateway` to expose each Bot's DeepSeek Harness HTTP/WebSocket WebUI at `<bot_id>-dsh.lightvela.site` through TAT.

**Architecture:** `site-gateway` derives the Bot ID from the public Host, completes the shared federation authorize/ticket/exchange flow, stores the opaque delegated session in a Host-only Cookie, calls Auth's signed federation TAT endpoint, and feeds the returned TAT WebSocket into `httputil.ReverseProxy` as a `net.Conn` transport.

**Tech Stack:** Go 1.25, `net/http/httputil`, HMAC-SHA256, Gorilla WebSocket, MongoDB BSON v2, Tencent TAT, Kustomize.

## Global Constraints

- Preserve all existing cloud-site OIDC, COS, custom-domain, and usage behavior.
- Do not implement a second OIDC-to-TAT bridge in `site-gateway`.
- Derive the DSH route from `<bot_id>-dsh.lightvela.*` and bind the federation login state to that exact Host.
- Treat delegated sessions as opaque secrets; never log or forward them to DSH.
- Keep the only DSH destination fixed at `127.0.0.1:3080`.
- Do not add Tencent Cloud credentials or CTL internal tokens to `site-gateway`.
- Keep checked-in DSH domains empty until skip's latest federation contract and matching Secret material are available.
- Enable only `dsh.lightvela.site` in the first production release; `.tech` is deferred.
- Per user direction, implement directly and run tests afterward; do not require a TDD red/green cycle.

---

### Task 1: Freeze The Federation Adapter Boundary

**Files:**
- Modify: `site-gateway/internal/tatproxy/bootstrap.go`
- Test: `site-gateway/internal/tatproxy/bootstrap_test.go`

**Interfaces:**
- Consumes: `Target{BotID, DelegatedSession string}`.
- Produces: `Starter.Start(context.Context, Target) (Bootstrap, error)`.

- [ ] Keep Auth federation details inside `FederationStarter`; no other package constructs HMAC headers or parses Auth responses.
- [ ] Sign the exact method, escaped path, sorted query, RFC3339 timestamp, request ID, and SHA-256 body hash required by Auth.
- [ ] Reject redirects, oversized/malformed responses, incomplete bootstrap fields, and untrusted TAT WebSocket URLs.
- [ ] Map Auth `401`, `404`, `409`, and `504` to stable typed errors without including delegated-session contents.
- [ ] Run `go test ./internal/tatproxy -run 'TestFederationStarter|TestManager|TestTatConn' -count=1` from `site-gateway`.

### Task 2: Bind Bot Host To Federation Session

**Files:**
- Modify: `site-gateway/internal/httpapi/dispatcher.go`
- Modify: `site-gateway/internal/dshproxy/route.go`
- Modify: `site-gateway/internal/dshproxy/target.go`
- Modify: `site-gateway/internal/dshproxy/handler.go`
- Modify: `site-gateway/internal/dshproxy/pool.go`
- Test: corresponding `*_test.go` files

**Interfaces:**
- Consumes: Bot ID from Host and the gateway's Host-only delegated-session Cookie.
- Produces: DSH routing only for `<bot_id>-<configured dsh domain>`.

- [ ] Accept only lowercase DNS-safe Bot IDs up to 59 bytes and reject lookalike, multi-label, empty, ambiguous, or mismatched Hosts.
- [ ] Ignore and strip legacy context headers plus the gateway Cookie before upstream; preserve DSH application credentials.
- [ ] Key proxy and TAT session reuse by an irreversible digest of Bot ID plus delegated session.
- [ ] Preserve HTTP bodies, streaming, keep-alive, WebSocket upgrades, and validated forwarded protocol metadata.
- [ ] On proxy eviction, close idle HTTP connections and the matching TAT session, including pending session creation.
- [ ] Run `go test ./internal/httpapi ./internal/dshproxy ./internal/tatproxy -count=1` and `go test -race ./internal/httpapi ./internal/dshproxy ./internal/tatproxy -count=1`.

### Task 3: Keep Production Federation Configuration Disabled By Default

**Files:**
- Modify: `site-gateway/internal/config/config.go`
- Modify: `site-gateway/k8s/base/manifests.yaml`
- Modify: `site-gateway/k8s/overlays/sgprod/generated/platform.env.example`
- Modify: `argocd/services/site-gateway/sgprod/site-gateway-platform.env`
- Modify: matching Kustomize replacements and release-contract tests

**Interfaces:**
- Produces: a fail-closed DSH configuration that requires domains, federation base URL, client ID, key ID, and Secret HMAC key together.

- [ ] Keep `SITE_GATEWAY_DSH_DOMAINS` and federation platform values empty in checked-in sgprod configuration.
- [ ] Keep the HMAC key only in `site-gateway-secrets`; do not add plaintext or Tencent credentials.
- [ ] Render base and sgprod manifests and verify the `.site` wildcard Ingress/TLS contract without enabling DSH.
- [ ] Run the focused release-contract suite and `scripts/scan_secrets.py` on changed Secret declarations.

### Task 4: Adapt To Skip's Latest Federation Contract And Release

**Files:**
- Modify: only the adapter/config files required by the pushed federation contract
- Test: integration and release tests

**Interfaces:**
- Consumes: skip's pushed Auth/access-proxy federation implementation.
- Produces: an explicitly reviewed contract diff and production enablement checklist.

- [ ] Compare endpoint path, HMAC canonicalization and headers, delegated-session exchange/cookie ownership, callback allowlist, bootstrap response fields, and status codes against Task 1.
- [ ] Verify the public DSH Host completes authorize/ticket/exchange and cannot inject federation context through headers.
- [ ] Run `go test ./...`, `go test -race ./...`, `go vet ./...`, and `go build ./cmd/site-gateway` from `site-gateway`.
- [ ] Run focused Auth, CTL, sandbox, service-gateway, release-contract, Kustomize, secret-scan, and `git diff --check` verification.
- [ ] Before commit/push/MR, present the exact staged diff summary and commit message for approval.
- [ ] After source merge and image build, enable Auth federation first, then set `SITE_GATEWAY_DSH_DOMAINS=dsh.lightvela.site`; verify Argo revision/image/Synced/Healthy, live HTTPS, WebSocket, source-session invalidation, real Bot ownership, real DSH port 3080, and rollback by clearing the domain.
