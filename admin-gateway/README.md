# admin-gateway

Narrow public gateway for Lightclaw admin traffic.

Responsibilities:
- own the public `admin.lightclaw.tech` entrypoint
- proxy `/admin/ops` to `nextgen-dashboard`
- proxy `/admin/gateway` to `gateway-dashboard`
- proxy `/admin/api/*` to the `gateway-dashboard` BFF module routes
- terminate and proxy websocket upgrades for admin workloads
- enforce HTTP Basic Auth for admin traffic at the edge
- issue a stateless bridge cookie after successful Basic Auth so browsers do not need to re-prompt on every request
- keep admin traffic isolated from the user-facing `service-gateway`

Bridge-cookie contract:
- the bridge cookie is only for bypassing repeated HTTP Basic Auth challenges
- it is not the application login state
- upstream `Set-Cookie` headers still pass through; `admin-gateway` appends its own cookie rather than replacing upstream cookies
- if the bridge cookie is invalid or expired, the gateway returns to the normal `401 + WWW-Authenticate` flow

This deployment intentionally reuses the same gateway binary as `service-gateway`,
but runs as an independent workload with its own config, service, and ingress target.

Current upstreams:
- `/admin/ops/*` -> `nextgen-dashboard.user-auth.svc.cluster.local` with `rewrite_prefix: /admin`
- `/admin/gateway/*` -> `gateway-dashboard-internal.ai-gateway.svc.cluster.local`
- `/admin/api/ai-gateway/*` -> `gateway-dashboard-internal.ai-gateway.svc.cluster.local` with `rewrite_prefix: /admin/gateway/api/ai-gateway`
- `/admin/api/auth/*` -> `gateway-dashboard-internal.ai-gateway.svc.cluster.local` with `rewrite_prefix: /admin/gateway/api/auth`
- `/admin/api/subscription/*` -> `gateway-dashboard-internal.ai-gateway.svc.cluster.local` with `rewrite_prefix: /admin/gateway/api/subscription`
- `/admin/api/sandbox/*` -> `gateway-dashboard-internal.ai-gateway.svc.cluster.local` with `rewrite_prefix: /admin/gateway/api/sandbox`
- `/admin/api/ctl/bundles/*` -> `ctl-api.ctl.svc.cluster.local` (direct, no rewrite)
- `/admin/api/ctl/passes/*` -> `ctl-api.ctl.svc.cluster.local` (direct, no rewrite)
- `/admin/api/ctl/*` -> `gateway-dashboard-internal.ai-gateway.svc.cluster.local` with `rewrite_prefix: /admin/gateway/api/ctl`

There is no `/` or `/admin` catch-all route in the standard public admin entrypoint.

Current production namespace:
- `lightclaw-gateway`

Current public host:
- `admin.lightclaw.tech`

Kubernetes manifests now live in:

- [k8s/base](k8s/base)
- [k8s/overlays/beijing-sandbox](k8s/overlays/beijing-sandbox)
- [k8s/overlays/shprod](k8s/overlays/shprod)

正式发布已经改为 `Argo CD` 主线。

`admin-gateway` 没有独立 Docker build 入口。  
它复用 `service-gateway` 的共享 gateway 二进制镜像，只保留独立的 deploy-facing config / route / ingress 组合层。
