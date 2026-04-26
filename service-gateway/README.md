# service-gateway

Lightweight edge gateway for `lightclaw.tech`.

Responsibilities:
- single public entrypoint for north-south HTTP traffic
- path routing to in-cluster services
- own the public `lightclaw.tech` ingress and keep upstream services private
- configurable public allow-list
- session introspection via `user-auth`
- inject `X-Lightclaw-User-ID` and `X-Lightclaw-User-Email`
- inject compatibility headers `X-User-Id` and `X-Uin` for legacy upstreams such as `ctl`

The first version is intentionally small:
- no Envoy
- no custom DSL
- no service-to-service proxying
- no catch-all public `/` route; unmatched paths return `404`

Access levels currently in use:
- `public`
- `admin`
- `authenticated`
- `internal-only`

Admin traffic is split by purpose:
- `/admin/ops/*` UI and terminal traffic is handled by `admin-gateway`
- `/admin/gateway/*` dashboard traffic is handled by `admin-gateway`
- `/admin/api/*` management API traffic is handled by `admin-gateway`
- `service-gateway` no longer exposes `/api/admin/*`; unmatched admin management paths return `404`

Admin bridge cookie:
- admin routes can optionally issue a stateless bridge cookie after a successful Basic Auth challenge
- this cookie only suppresses repeated browser Basic Auth prompts on `admin.lightclaw.tech`
- deployment wiring can override eligible hosts via `SERVICE_GATEWAY_ADMIN_BRIDGE_COOKIE_HOSTS`
- it does not replace upstream business/session cookies
- cookie-authorized admin requests do not synthesize a Basic `Authorization` header upstream; route-level bearer injection still works as configured
- deployment wiring uses `SERVICE_GATEWAY_ADMIN_BRIDGE_COOKIE_SECRET`

For downstreams that still require their own admin bearer token, `service-gateway`
can inject a route-specific upstream `Authorization` header via
`upstream_bearer_token_env`.

Route configs can set `rewrite_prefix` to rewrite the matched public prefix
before proxying to an upstream. Existing routes without `rewrite_prefix` keep
the original request path.

Logging:
- access logs are emitted as one JSON line per request to container `stdout`
- CLB healthcheck noise is skipped
- shipping to Tencent CLS is handled by TKE `tke-log-agent` plus the cluster `LogConfig`
- the application itself does not hold CLS write credentials
- 正式发布只认 `Argo CD`
- 现在的正式结构是 `k8s/base + k8s/overlays/<env>`
- 部署脚本会先校验 workload 与 `k8s/base/cls-logconfig.yaml` 是否一致，再 apply Kustomize overlay 与 CLS 配置

Routing gotchas:
- `lightclaw.tech` 的公网 `/v1/instances` 请求先进入 `service-gateway`，再转发到 `ctl` upstream；不要拿直连 `ctl-api` 的结果替代公网结论
- 如果测试环境 `ctl` namespace 或 service 名发生变化，必须同步更新 `k8s/base/manifests.yaml`、对应 overlay 和现网 `service-gateway-config`
- 现场典型症状是：直连 `ctl-api` 返回 `200`，但 `https://lightclaw.tech/v1/instances/...` 返回 `500`
- 遇到这种分叉时，先看 `service-gateway` access log 是否记录了该请求，以及它当前配置的 `ctl` upstream 是否仍指向旧 namespace
- 2026-03-26 实测踩坑：`service-gateway` 仍指向 `http://ctl-api.lightclaw.svc.cluster.local`，而测试环境真实 `ctl` 已迁到 `http://ctl-api.ctl.svc.cluster.local`；结果是公网 `/channels/config` 直接 `500 CHANNEL_CONFIG_FAILED`，但直连测试环境 `ctl-api` 正常

Validation rule:
- 修改 `service-gateway` 的 `ctl` 路由后，至少做两组验证：
- 1. 直连目标 upstream（例如 `ctl-api` Service / port-forward）确认业务接口本身可用
- 2. 通过公网域名 `https://lightclaw.tech/...` 再打一遍同一请求，确认入口层没有转发到旧 upstream
- 对外 API 出错时，优先要求响应里保留 `X-Request-Id` / `request_id`，避免入口层把排障上下文吃掉

Metrics:
- Prometheus metrics are exposed on `/metrics`
- request count and request latency are exported with `method`, `route`, `endpoint`, and `status` labels
- `endpoint` is normalized so dynamic IDs become stable labels such as `/sandboxes/:id`
- in this Tencent TMP setup, the scrape target must follow the same pattern as the working `sandbox` services:
  - the `Service` in the app namespace (`lightclaw-gateway`) is labeled `metrics-target: "true"`
  - the `ServiceMonitor` lives in `kube-system`, not in the app namespace
  - the `ServiceMonitor` uses `namespaceSelector.matchNames` to point back to `lightclaw-gateway`
- if `/metrics` has samples locally but Grafana stays empty, check the `ServiceMonitor` namespace first

CI note:
- changes under `service-gateway/**` should trigger `.ci/service-gateway.yml` on `master`
- 2026-04-25 retry trigger: README-only change to re-run Stream after TCR settings update
- 2026-04-25 retry trigger 2: README-only change to collect the new safe registry diagnostics
- 2026-04-26 trigger: README-only change to exercise the MR-based gitops promotion flow
- 2026-04-26 trigger 2: README-only change to rerun after Python compatibility fix on promote checks
- 2026-04-26 trigger 3: README-only change to rerun after bootstrapping update_image_pin.py into promote branches
- 2026-04-26 trigger 4: README-only change to rerun Beijing service-gateway after MR-flow bootstrap fixes
