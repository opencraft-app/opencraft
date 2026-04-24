# Beijing Sandbox Apps

这个目录放北京测试环境的子 `Application` 清单。

约束：

- 每个服务一个清晰入口
- 只引用已经达到 Argo-ready 条件的 deploy artifact
- 不允许指向必须依赖本地 `.secret/*`、`generated/*` 或本地脚本上下文的路径

当前已接入的服务：

- `nextgen-dashboard`
  - live Application：`nextgen-dashboard.yaml`
  - cutover runbook：`docs/runbooks/nextgen-dashboard-argocd-cutover.md`
- `gateway-dashboard`
  - live Application：`gateway-dashboard.yaml`
  - cutover runbook：`docs/runbooks/gateway-dashboard-argocd-cutover.md`
- `admin-gateway`
  - live Application：`admin-gateway.yaml`
  - cutover runbook：`docs/runbooks/admin-gateway-argocd-cutover.md`
- `subscription`
  - live Application：`subscription.yaml`
  - cutover runbook：`docs/runbooks/subscription-argocd-cutover.md`
- `service-gateway`
  - live Application：`service-gateway.yaml`
  - cutover runbook：`docs/runbooks/service-gateway-argocd-cutover.md`
- `lightclaw-auth`
  - live Application：`lightclaw-auth.yaml`
  - cutover runbook：`docs/runbooks/lightclaw-auth-argocd-cutover.md`
- `payment`
  - live Application：`payment.yaml`
  - cutover runbook：`docs/runbooks/payment-argocd-phase1.md`
- `ai-gateway`
  - live Application：`ai-gateway.yaml`
  - cutover runbook：`docs/runbooks/ai-gateway-argocd-cutover.md`
- `ctl`
  - live Application：`ctl.yaml`
- `sandbox`
  - live Application：`sandbox.yaml`
- `session`
  - live Application：`session.yaml`
  - cutover runbook：`docs/runbooks/session-argocd-cutover.md`

当前 blocker：

- 只有已经把 source-facing `k8s/base` 一起补进 `root/mono` 的服务，才能被 root app 真正同步
- 所以后续新增组件时，不能只提交 `argocd/` 下的 deploy-facing 文件

注意：

- `apps/beijing-sandbox/` 是 root app 会直接扫描的 live 路径
- 不要再把 `*.example.yaml` 放回这个目录
