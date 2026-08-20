# DSH TAT Reverse Proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reuse `site-gateway` for exact DSH Host routing and proxy DSH HTTP/WebSocket traffic to `127.0.0.1:3080` through Tencent TAT.

**Architecture:** A top-level dispatcher preserves the existing COS handler and selects a new DSH handler only for configured exact hosts. An upstream access proxy derives an opaque `Key` from login state; the DSH handler resolves it to a Tencent target, then uses a per-target `httputil.ReverseProxy` whose `http.Transport.DialContext` returns a multiplexed TAT-backed `net.Conn`.

**Tech Stack:** Go 1.25, `net/http/httputil`, Tencent Cloud common SDK, Gorilla WebSocket, MongoDB BSON v2, `httptest`.

## Global Constraints

- Do not implement user authentication, DSH installation, Pass checks, or CTL changes; the upstream access proxy owns login-state validation and Key injection.
- Preserve existing COS and domestic-site authentication behavior for non-DSH Hosts.
- Treat `Key` as opaque, require exactly one value, strip every copy before upstream, and never log it.
- Fix the TAT proxy destination to `127.0.0.1:3080`.
- Keep DSH disabled unless explicit domains and a target resolver URL are configured.
- Do not enable DSH until both public DSH hosts route only through `access_proxy/user-auth`, which must overwrite any client-supplied `Key`.
- Read Tencent credentials only from runtime Secret environment variables.
- Do not modify DNS, CLB, Argo live state, or production resources.

---

### Task 1: Host dispatcher and configuration

**Files:**
- Create: `site-gateway/internal/httpapi/dispatcher.go`
- Test: `site-gateway/internal/httpapi/dispatcher_test.go`
- Modify: `site-gateway/internal/config/config.go`
- Test: `site-gateway/internal/config/config_test.go`

**Interfaces:**
- Produces: `httpapi.NewDispatcher(site http.Handler, dsh http.Handler, dshDomains []string) http.Handler`
- Produces: config fields `DSHDomains []string`, `DSHTargetURL string`, and TAT timeout/limit values.

- [ ] Write tests proving only exact DSH Hosts dispatch to DSH, optional ports and case normalize, subdomains/lookalike hosts preserve the existing site handler, and empty DSH configuration disables dispatch.
- [ ] Run `go test ./internal/httpapi ./internal/config -run 'TestDispatcher|TestFromEnvDSH' -count=1` and verify failure because the API is absent.
- [ ] Implement the minimal dispatcher and configuration validation.
- [ ] Run the focused tests and verify PASS.

### Task 2: Opaque Key target resolver

**Files:**
- Create: `site-gateway/internal/dshproxy/target.go`
- Test: `site-gateway/internal/dshproxy/target_test.go`

**Interfaces:**
- Produces: `Target{Region, InstanceID string}`.
- Produces: `Resolver.Resolve(context.Context, string) (Target, error)`.
- Produces: `HTTPResolver` using `GET <configured-url>` and the `Key` header.

- [ ] Write tests for successful envelope decoding, missing key, 404, upstream failure, invalid region, missing instance ID, cancellation, and absence of key material in returned errors.
- [ ] Run `go test ./internal/dshproxy -run TestHTTPResolver -count=1` and verify failure because the package is absent.
- [ ] Implement the HTTP resolver with a bounded client timeout and response body.
- [ ] Run focused tests and verify PASS.

### Task 3: TAT StartSession bootstrap

**Files:**
- Create: `site-gateway/internal/tatproxy/bootstrap.go`
- Test: `site-gateway/internal/tatproxy/bootstrap_test.go`
- Modify: `site-gateway/go.mod`
- Modify: `site-gateway/go.sum`

**Interfaces:**
- Produces: `Bootstrap{SessionID, Region, InstanceID, OwnerUIN, AppID, WSURL string/int64}`.
- Produces: `Starter.Start(context.Context, Target) (Bootstrap, error)`.
- Consumes: Tencent Cloud common API caller with `DescribeAccountInfo` and `TAT StartSession` actions.

- [ ] Add pinned WebSocket, BSON, and Tencent common SDK dependencies.
- [ ] Write tests that capture the StartSession instance parameter, cache account metadata, build the regional forwarding URL, and reject incomplete cloud responses.
- [ ] Run `go test ./internal/tatproxy -run TestCloudStarter -count=1` and verify failure.
- [ ] Implement the minimum cloud starter and SDK caller.
- [ ] Run focused tests and verify PASS.

### Task 4: Multiplexed TAT session and net.Conn

**Files:**
- Create: `site-gateway/internal/tatproxy/protocol.go`
- Create: `site-gateway/internal/tatproxy/session.go`
- Create: `site-gateway/internal/tatproxy/conn.go`
- Test: `site-gateway/internal/tatproxy/session_test.go`
- Test: `site-gateway/internal/tatproxy/conn_test.go`

**Interfaces:**
- Produces: `Manager.DialContext(context.Context, Target) (net.Conn, error)`.
- Produces: one shared authenticated TAT WebSocket per target and one `TatConn` per `ProxyId`.

- [ ] Write a fake TAT WebSocket test server and assert `SessionAuth`, `PtyProxyNew`, `PtyProxyData`, demultiplexing, `PtyProxyClose`, and one bootstrap per shared session.
- [ ] Run `go test ./internal/tatproxy -run 'TestManager|TestTatConn' -count=1` and verify failure.
- [ ] Implement BSON protocol structs, serialized writes, the reader loop, bounded queues, deadlines, and idempotent cleanup.
- [ ] Run focused tests including `-race` and verify PASS.

### Task 5: httputil reverse proxy integration

**Files:**
- Create: `site-gateway/internal/dshproxy/handler.go`
- Create: `site-gateway/internal/dshproxy/pool.go`
- Test: `site-gateway/internal/dshproxy/handler_test.go`
- Modify: `site-gateway/cmd/site-gateway/main.go`

**Interfaces:**
- Consumes: `Resolver` and `TunnelDialer.DialContext(context.Context, tatproxy.Target)`.
- Produces: `dshproxy.Handler` implementing `http.Handler`.

- [ ] Write end-to-end handler tests using a real local upstream for POST bodies, header stripping, Host/Origin rewrite, streaming flush, keep-alive reuse, and WebSocket echo.
- [ ] Run `go test ./internal/dshproxy -run TestHandler -count=1` and verify failure.
- [ ] Implement a bounded per-target reverse-proxy pool and wire it behind the dispatcher in `main.go` only when DSH is enabled.
- [ ] Run focused tests and verify PASS.

### Task 6: Deployment contract and full verification

**Files:**
- Modify: `site-gateway/k8s/base/manifests.yaml`
- Modify: `site-gateway/k8s/overlays/sgprod/generated/platform.env.example`
- Modify: `.ci/runtime/bundles/site-gateway.bundle`
- Modify: `.ci/runtime/tests/contract_tests/test_release_bundle_contracts.py`

**Interfaces:**
- DSH configuration remains disabled in checked-in production values.
- Runtime Tencent credentials are optional Secret refs until DSH domains are enabled.

- [ ] Add failing release-contract assertions for new source files, configuration keys, and absence of plaintext credentials.
- [ ] Run `python3 .ci/runtime/tests/contract_tests/test_release_bundle_contracts.py` and verify the new assertions fail.
- [ ] Add non-secret base configuration and optional Secret references without enabling a live DSH Host.
- [ ] Run `gofmt`, `go test ./...`, `go test -race ./internal/tatproxy ./internal/dshproxy ./internal/httpapi`, `go vet ./...`, `go build ./cmd/site-gateway`, the release-contract suite, base Kustomize rendering, and `git diff --check`.
- [ ] Merge the latest `origin/master` into the integration branch, resolve only genuine overlap, and repeat all verification before presenting commit/push/MR content for approval.
