# Beijing Sandbox Apps

这个目录放北京测试环境的子 `Application` 清单。

当前 live 入口：

- root app:
  - `root-beijing-sandbox`
- Git repo:
  - `git@git.woa.com:wisp/mono2.git`
- revision:
  - `master`

约束：

- 每个服务一个清晰入口
- 只引用已经达到 Argo-ready 条件的 deploy artifact
- 不允许指向必须依赖本地 `.secret/*`、`generated/*` 或本地脚本上下文的路径
- 这里的 leaf app 由 `root-beijing-sandbox` 统一扫描和接管
- `argocd-runtime-beijing-sandbox` 也作为北京 root app 的子应用放在这里

当前已接入的服务：

- `argocd-runtime`
  - live Application：`argocd-runtime.yaml`
  - deploy-facing runtime patch：`argocd/runtime/beijing-sandbox/`
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

当前北京项目模型：

- root project:
  - `beijing-root`
- leaf project:
  - `beijing-sandbox`
- runtime project:
  - `beijing-argocd-runtime`

新增/修改北京 leaf app 时，至少要同时确认：

- `spec.project` 使用当前项目模型，不再回到 `beijing-root-mono` / `beijing-sandbox-mono`
- `spec.source.repoURL` 指向 `git@git.woa.com:wisp/mono2.git`
- 目标 `destination.name` 继续使用 `beijing-sandbox`
- 对应 deploy-facing 目录已经做到 Argo-ready，而不是依赖本地上下文

注意：

- `apps/beijing-sandbox/` 是 root app 会直接扫描的 live 路径
- 不要再把 `*.example.yaml` 放回这个目录
- 改这里的同时，通常还要同步看：
  - `argocd/projects/`
  - `argocd/root/beijing-sandbox.yaml`
  - `argocd/runtime/beijing-sandbox/`
