# Gateway Dashboard

`gateway-dashboard` 是 `ai-gateway` 管理后台，公网挂载在 `/admin/gateway`。

Trigger note:

- 2026-05-15: README-only no-op change to rerun gateway-dashboard after moving production check-in gates off PIPELINE_MODE.
- 2026-05-15: README-only no-op change to rerun gateway-dashboard after DB gate visibility landed.
- 2026-05-15: README-only no-op change to rerun gateway-dashboard after switching check-in conditions to BK-CI envs.
- 2026-05-15: README-only no-op change to rerun gateway-dashboard after check-in condition syntax probe.
- 2026-05-08: README-only change to rerun gateway-dashboard release after GitOps gate stdout and promote lease fixes.
- 2026-05-15: README-only no-op change to exercise the gateway-dashboard release trigger path.
- 2026-05-15: README-only no-op change to rerun gateway-dashboard after service-release production promote check-in landed.
- 2026-05-15: README-only no-op change to verify environment-aware release hints in gateway-dashboard CI.

公网 `CVM -> dashboard -> ai-gateway` 专用模式下，当前保证可用的页面收敛为：

- 用户
- 密钥
- 开通
- 套餐
- 供应商
- 路由
- 缓存
- playground

## Run

```bash
cd gateway-dashboard
npm run dev
npm run build
```

默认端口是 `13000`。

## Runtime Env

| Variable | Required | Purpose |
|---|---|---|
| `GATEWAY_API_URL` | Yes | 指向 `ai-gateway` 管理 API 的 BFF 上游 |
| `AUTH_ADMIN_API_URL` | No | 指向 `user-auth` 管理 API 的 BFF 上游；仅认证侧页面使用，公网 AI Gateway 专用模式下可不配置 |
| `SANDBOX_API_URL` | No | 指向 `sandbox-api` 的内部管理上游；仅 sandbox 页面使用，公网 AI Gateway 专用模式下可不配置 |
| `CTL_API_URL` | No | 指向 `ctl-api` 的内部管理上游；仅 CTL 页面使用，公网 AI Gateway 专用模式下可不配置 |
| `ADMIN_TOKEN` | Yes | Dashboard 登录所用的管理员 token |
| `ADMIN_SESSION_SECRET` | Recommended | Dashboard 无状态服务端 session cookie 的加密/签名密钥；未设置时回退到 `ADMIN_TOKEN` |
| `AUTH_ADMIN_TOKEN` | No | `user-auth /admin/*` 专用 token；未设置时回退到 `ADMIN_TOKEN` |
| `SUBSCRIPTION_ADMIN_TOKEN` | No | `subscription /admin/*` 专用 token；未设置时回退到 `AUTH_ADMIN_TOKEN` 或 `ADMIN_TOKEN` |

## BFF Routes

- `/admin/api/ai-gateway/[...path]`
  - 经 `admin-gateway` 改写到 Dashboard BFF 的 `/admin/gateway/api/ai-gateway/[...path]`
  - 代理 `ai-gateway` 的 `/api/admin/*` 管理接口
- `/admin/api/auth/[...path]`
  - 经 `admin-gateway` 改写到 Dashboard BFF 的 `/admin/gateway/api/auth/[...path]`
  - 代理 `user-auth` 的 `/admin/*` 接口
- `/admin/api/subscription/[...path]`
  - 经 `admin-gateway` 改写到 Dashboard BFF 的 `/admin/gateway/api/subscription/[...path]`
  - 代理 `subscription` 的 `/admin/*` 接口
- `/admin/api/sandbox/[...path]`
  - 经 `admin-gateway` 改写到 Dashboard BFF 的 `/admin/gateway/api/sandbox/[...path]`
  - 代理 `sandbox-api` 的 `/internal/*` 接口
- `/admin/api/ctl/[...path]`
  - 经 `admin-gateway` 改写到 Dashboard BFF 的 `/admin/gateway/api/ctl/[...path]`
  - 代理 `ctl-api` 的 `/internal/*` 接口

浏览器不再长期持有裸管理员 token；登录成功后由服务端签发 `HttpOnly` 的无状态 session cookie，真正的上游地址和可选的专用管理 token 通过 Next.js route handler 在服务端转发。旧的 `/api/[...path]`、`/api/auth-admin/*`、`/api/subscription-admin/*`、`/api/sandbox-admin/*`、`/api/ctl-admin/*` 不再是标准入口。

## Deploy

正式发布链路已经收敛到 `Argo CD` 主线：

- [k8s/base](k8s/base)
- [k8s/overlays/beijing-sandbox](k8s/overlays/beijing-sandbox)
- [k8s/overlays/shprod](k8s/overlays/shprod)
- deploy-facing app / service paths in `argocd/`

镜像构建统一入口：

```bash
python3 scripts/build-release-image.py --service gateway-dashboard --env shprod --tag <tag>
```

本地敏感输入来自：

- `.secret/gateway-dashboard/test.env`

历史上生成的 `gateway-dashboard/k8s/overlays/<env>/generated/` 只作为 source-facing 参考，不再是正式发布入口。

运行日志默认通过容器 `stdout` 采集到 CLS：

- `gateway-dashboard/k8s/base/cls-logconfig.yaml`
- CLS 约束应通过 source-facing manifests 与 deploy-facing review 维护
- `topicId` 默认复用 `platform.env` 中的 `SERVICE_GATEWAY_CLS_TOPIC_ID`
- 如需单独 topic，可显式提供 `GATEWAY_DASHBOARD_CLS_TOPIC_ID`

历史 `direct-access` 直连清单已经移除，不再属于正式主线。

当前标准部署形态：

- Dashboard Pod 运行在 `ai-gateway` namespace
- `GATEWAY_API_URL=http://gateway.ai-gateway.svc.cluster.local`
- `AUTH_ADMIN_API_URL=http://lightclaw-auth.user-auth.svc.cluster.local`
- `SANDBOX_API_URL=http://sandbox-api.sandbox.svc.cluster.local`
- `CTL_API_URL=http://ctl-api.ctl.svc.cluster.local`

建议的内部访问方式：

```bash
# 在仓库根目录下执行
source deploy/envs/beijing-sandbox/platform.env
KUBECONFIG="${DEPLOY_KUBECONFIG}" kubectl -n ai-gateway port-forward svc/gateway-dashboard-internal 31300:80
```

然后打开：

```text
http://127.0.0.1:31300/admin/gateway/login
```
