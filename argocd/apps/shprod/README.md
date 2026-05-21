# Shanghai Production Apps

这个目录放上海正式环境的子 `Application` 清单。

当前 live 入口：

- root app:
  - `root-shprod`
- Git repo:
  - `git@git.woa.com:wisp/mono2.git`
- revision:
  - `gitops`

额外约束：

- 只允许已经在北京验证过的服务进入
- secret 变更必须经过受保护流水线和受保护变更路径
- bot PR 不能自动合并，必须有人审批准入
- 这里的 leaf app 由 `root-shprod` 统一扫描和接管
- 当前上海先沿用按服务拆分的 cutover project 模式，而不是统一 `shprod` project
- 上海正式环境不启用 `syncPolicy.automated`
- GitOps MR 合入 `gitops` 只代表发布批准；实际下发必须由人工或发布系统在发布窗口执行 Argo sync

当前已切 live deploy-facing 入口的服务：

- `admin-gateway`
- `ai-gateway`
- `cloudagent-gateway`
- `ctl`
- `frontend`
- `gateway-dashboard`
- `lightclaw-auth`
- `vibebase`
- `nextgen-dashboard`
- `payment`
- `sandbox`
- `service-gateway`
- `subscription`

当前上海项目模型：

- root project:
  - `shprod-root`
- leaf projects:
  - `shprod-admin-gateway`
  - `shprod-ai-gateway`
  - `shprod-cloudagent-gateway`
  - `shprod-ctl`
  - `shprod-frontend`
  - `shprod-gateway-dashboard`
  - `shprod-lightclaw-auth`
  - `shprod-vibebase`
  - `shprod-payment`
  - `shprod-sandbox`
  - `shprod-service-gateway`
  - `shprod-subscription`

新增/修改上海 leaf app 时，至少要同时确认：

- `spec.source.repoURL` 指向 `git@git.woa.com:wisp/mono2.git`
- `spec.source.targetRevision` 指向 `gitops`
- `spec.destination.name` 继续使用 `shprod`
- `spec.project` 与服务对应的 cutover project 一致
- 不要为 shprod root app 或 leaf app 添加 `syncPolicy.automated`
- 对应 deploy-facing 目录已经在新 Argo 的 `ksops` 运行时下验证通过

当前仍保持 skeleton / 待后续纳管：

- `session`
- `frontend-ds`

注意：

- `apps/shprod/` 是 `root-shprod` 会直接扫描的 live 路径
- 如果后续要把上海收敛成单一 project 模型，需要成组调整：
  - `argocd/apps/shprod/*.yaml`
  - `argocd/projects/shprod*.yaml`
  - `argocd/root/shprod.yaml`
