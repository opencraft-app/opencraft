# Deployment List

更新时间：2026-03-26

## Public Entrypoints

### `lightclaw-gateway`

- Ingress `lightclaw-public`
  - Host: `lightclaw.tech`
  - CLB: `lb-bc9yxbwn-3p1wtima8cfzjl9e.clb.bj-tencentclb.com`
  - 端口: `80,443`
- Ingress `admin-lightclaw-public`
  - Host: `admin.lightclaw.tech`
  - CLB: `lb-9g4lslup-w2ty19su8pnjx5rg.clb.bj-tencentclb.com`
  - 端口: `80,443`

### `ai-gateway`

- Service `gateway`
  - 类型: `LoadBalancer`
  - CLB: `lb-a885sn2l-bs459xiehz3uvpwd.clb.bj-tencentclb.com`
- Service `gateway-dashboard-public`
  - 类型: `LoadBalancer`
  - CLB: `lb-qjath5gv-72hskqgpxoac3bl5.clb.bj-tencentclb.com`

### `sandbox`

- Service `ingressproxy-router`
  - 类型: `LoadBalancer`
  - CLB: `lb-mdt0e8sh-przmbk7gxn82yd3c.clb.bj-tencentclb.com`
- Service `sandbox-api-internal`
  - 类型: `LoadBalancer`
  - 内网地址: `10.15.224.71`

### `ctl`

- Service `ctl-api-internal`
  - 类型: `LoadBalancer`
  - 内网地址: `10.15.232.7`

## Deployments

### Namespace `lightclaw-gateway`

- `admin-gateway` `2/2`
- `service-gateway` `2/2`

### Namespace `user-auth`

- `lightclaw-auth` `3/3`
- `nextgen-dashboard` `2/2`
- `payment` `2/2`
- `subscription` `2/2`

### Namespace `ai-gateway`

- `gateway-backend` `1/1`
- `gateway-dashboard` `1/1`
- `gateway-dashboard-ingressproxy` `2/2`

### Namespace `ctl`

- `ctl-api` `1/1`
- `ctl-bypass` `1/1`
- `ctl-service` `1/1`

### Namespace `sandbox`

- `ingressproxy-router` `2/2`
- `ingressproxy-g0` `2/2`
- `ingressproxy-g1` `2/2`
- `ingressproxy-g2` `2/2`
- `ingressproxy-g3` `2/2`
- `sandbox-api` `10/10`
- `sandbox-worker` `0/0`

## Internal / NodePort Services

### Namespace `lightclaw-gateway`

- `admin-gateway-ingress`
  - 类型: `NodePort`
  - 端口: `80:32331`
- `service-gateway-ingress`
  - 类型: `NodePort`
  - 端口: `80:30671`

### Namespace `user-auth`

- `nextgen-dashboard-ingress`
  - 类型: `NodePort`
  - 端口: `80:32310`
- `lightclaw-auth-internal`
  - 类型: `LoadBalancer`
  - 内网地址: `10.15.224.196`

## Current Routing Notes

- `lightclaw.tech` 现在只走 `service-gateway`
- `admin.lightclaw.tech` 现在只走 `admin-gateway`
- 旧的 `user-auth` 下 `admin-gateway` 残留已经删除
- 旧的 `lightclaw-auth-public` ingress 已于 2026-03-26 删除，避免继续和新入口冲突
- `sandbox-clientproxy` 已删除，`sandbox` 现在只保留 ingressproxy 路径
- `ai-gateway` 历史残留 `portkey`、旧 `gateway-dashboard` LoadBalancer、`tdsqlc-db`、`netshoot` 已删除
- 当前仍待继续排障的是：
  - `admin.lightclaw.tech` 虽然已经独立到 `admin-gateway`，但公网 7 层入口仍返回 `502/504`
  - 集群内应用、Service、NodePort 路径已验证可用，剩余问题更像是 CLB / ingress 云侧放流

## Source of Truth

- 本清单基于 2026-03-26 的线上查询结果整理
- 查询来源：
  - `kubectl get deploy -A`
  - `kubectl get ingress -A -o wide`
  - `kubectl get svc -A`
