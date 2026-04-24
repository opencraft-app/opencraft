# GitOps Ingress Governance

这份文档定义北京环境下 `service-gateway` / `admin-gateway` 的长期入口治理规则。

目标不是描述某次临时操作，而是明确：

- 哪个服务拥有什么入口
- 哪些入口资源允许被哪个 app 管
- 哪些变更必须视为高风险入口变更

## Ownership

### `service-gateway`

`service-gateway` 拥有：

- `Ingress/lightclaw-public`
- `TkeServiceConfig/lightclaw-public-config`
- `Service/service-gateway`
- `Service/service-gateway-ingress`
- `ConfigMap/service-gateway-config`
- `ConfigMap/service-gateway-platform-values`
- `Secret/service-gateway-runtime-secrets`

它是公网主入口，负责：

- `lightclaw.tech`
- `/auth`
- `/sandboxes`
- `/v1/chatclaw/runtime`
- `/`
- `/healthz`

### `admin-gateway`

`admin-gateway` 拥有：

- `Ingress/admin-lightclaw-public`
- `TkeServiceConfig/admin-lightclaw-public-config`
- `Service/admin-gateway`
- `Service/admin-gateway-ingress`
- `ConfigMap/admin-gateway-config`
- `ConfigMap/admin-gateway-platform-values`
- `Secret/admin-gateway-runtime-secrets`

它是管理面公网入口，负责：

- `admin.lightclaw.tech`
- `/admin/ops`
- `/admin/gateway`
- `/admin/api`
- `/healthz`

## Long-term Rules

1. 公网 host 单一归属

- `lightclaw.tech` 只允许 `service-gateway` 持有
- `admin.lightclaw.tech` 只允许 `admin-gateway` 持有
- 不允许两个 app 同时管理同一个公网 host 的 `Ingress` / `TkeServiceConfig`

2. 入口配置以 deploy-facing 为准

- 入口 host、TLS secret、listener 规则最终都要在 `argocd/services/<service>/<env>/` 下显式可见
- 不允许继续把这类公网入口事实仅仅藏在本地 `generated/` 或历史集群对象里

3. 首轮纳管可以保守直贴，后续必须收敛

- phase 1 可按现网 host / TLS / path 直接对齐
- 但 phase 2 之后，route/config 结构必须回到长期 source-facing 真源

4. 共享 namespace，不共享入口

- `lightclaw-gateway` namespace 可以继续由多个 app 复用
- 但 `Ingress` / `TkeServiceConfig` / 入口 Service 的 ownership 必须严格单归属

## High-risk Changes

下面这些都应视为高风险入口变更：

- 修改公网 host
- 修改 TLS secret
- 修改 `TkeServiceConfig` listener / health check / path rule
- 修改 `Ingress` path 路由归属
- 修改公网 CLB 绑定关系

这些改动在长期规则里应满足：

- 必须有 runbook 更新
- 必须有 rollout 后公网验证
- 不应与不相关业务逻辑改动混在同一次 cutover

## Verification

入口治理收敛后，至少验证：

```bash
kubectl --kubeconfig .secret/cls-8gnhos9p-config -n lightclaw-gateway get ingress
kubectl --kubeconfig .secret/cls-8gnhos9p-config -n lightclaw-gateway get tkeserviceconfig
```

以及：

- `https://lightclaw.tech/healthz`
- `https://admin.lightclaw.tech/healthz`

都能返回当前预期结果。
