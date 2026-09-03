# 管理面网关

`admin-gateway` 是管理控制台的独立公网入口，代理 `gateway-dashboard`；它与面向客户流量的 `service-gateway` 具有独立镜像、流水线和 GitOps pin。

## 权威入口

- [服务说明](../README.md)、[Agent 约束](../AGENTS.md)、[目录记录](../catalog-info.yaml)
- source-facing 清单：`../k8s/`
- deploy-facing 清单：`../../argocd/services/admin-gateway/`

## 关键边界

当前构建临时复用 `service-gateway` 的 Dockerfile/build context，这只是实现复用，不表示两个网关共用发布或运行责任。运行时 Secret 由 GitOps Secret 主线管理，`platform.env` 与 `generated/` 不作为手工真源。

## 验证

网关变更需验证管理入口、对 `gateway-dashboard` 的代理路径、鉴权失败路径以及独立 Argo 应用的 revision、`Synced` 与 `Healthy`。
