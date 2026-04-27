# Beijing Sandbox Apps

这个目录放北京 Argo 控制面的 live app 入口。

当前 live 入口：

- root app:
  - `root-beijing-sandbox`
- Git repo:
  - `git@git.woa.com:wisp/mono2.git`
- revision:
  - `gitops`

约束：

- 每个服务一个清晰入口
- 只引用已经达到 Argo-ready 条件的 deploy artifact
- 不允许指向必须依赖本地 `.secret/*`、`generated/*` 或本地脚本上下文的路径
- 这里由 `root-beijing-sandbox` 统一扫描和接管
- `argocd-runtime-beijing-sandbox` 继续作为显式子应用保留在这里
- sandbox 家族的业务 leaf app 现在由 `sandbox-family-appset.yaml` 统一生成

当前已接入的入口：

- `argocd-runtime`
  - live Application：`argocd-runtime.yaml`
  - deploy-facing runtime patch：`argocd/runtime/beijing-sandbox/`
- `sandbox-family`
  - live ApplicationSet：`sandbox-family-appset.yaml`
  - app descriptor catalog：`argocd/catalogs/sandbox/`

sandbox-family 当前统一生成：

- `admin-gateway`
- `ai-gateway`
- `ctl`
- `gateway-dashboard`
- `lightclaw-auth`
- `nextgen-dashboard`
- `payment`
- `sandbox`
- `service-gateway`
- `session`
- `subscription`

当前北京项目模型：

- root project:
  - `beijing-root`
- leaf projects:
  - `beijing-sandbox`
  - `beijing-sandbox-2`
- runtime project:
  - `beijing-argocd-runtime`

新增/修改北京 leaf app 时，至少要同时确认：

- `spec.project` 使用当前项目模型，不再回到 `beijing-root-mono` / `beijing-sandbox-mono`
- `spec.source.repoURL` 指向 `git@git.woa.com:wisp/mono2.git`
- `spec.source.targetRevision` 指向 `gitops`
- 目标 `destination.name` 继续使用 `beijing-sandbox`
- 对应 deploy-facing 目录已经做到 Argo-ready，而不是依赖本地上下文

注意：

- `apps/beijing-sandbox/` 仍是 root app 会直接扫描的 live 路径
- 除 runtime 外，不再往这里新增手写 leaf `Application`
- sandbox 业务 app 应通过 `argocd/catalogs/sandbox/<env>/<service>.yaml` 接入
- 改这里的同时，通常还要同步看：
  - `argocd/projects/`
  - `argocd/root/beijing-sandbox.yaml`
  - `argocd/runtime/beijing-sandbox/`
