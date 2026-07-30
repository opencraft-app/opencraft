# Singapore Production Apps

这个目录放新加坡正式环境的子 `Application` 清单。

当前 live 入口：

- root app:
  - `root-sgprod`
- Git repo:
  - `git@git.woa.com:wisp/mono2.git`
- revision:
  - `gitops`

额外约束：

- 只允许已经在北京验证过的服务进入
- secret 变更必须经过受保护流水线和受保护变更路径
- bot PR 不能自动合并，必须有人审批准入
- 这里的 leaf app 由 `root-sgprod` 统一扫描和接管
- 当前新加坡先沿用按服务拆分的 cutover project 模式，而不是统一 `sgprod` project
- 新加坡正式环境不启用 `syncPolicy.automated`
- GitOps MR 合入 `gitops` 只代表发布批准；实际下发必须由人工或发布系统在发布窗口执行 Argo sync

当前已切 live deploy-facing 入口的服务：

- `admin-gateway`
- `ai-gateway`
- `ctl`
- `frontend`
- `gateway-dashboard`
- `lightclaw-auth`
- `payment`
- `sandbox`
- `service-gateway`
- `subscription`
- `velagw`（部署在独立的 `johorbahru-llmgateway-prod` 目标集群）
- `vibebase`

当前新加坡项目模型：

- root project:
  - `sgprod-root`
- leaf projects:
  - `sgprod-admin-gateway`
  - `sgprod-ai-gateway`
  - `sgprod-ctl`
  - `sgprod-frontend`
  - `sgprod-gateway-dashboard`
  - `sgprod-lightclaw-auth`
  - `sgprod-nextgen-dashboard`（项目已预置；尚无 leaf app）
  - `sgprod-payment`
  - `sgprod-sandbox`
  - `sgprod-service-gateway`
  - `sgprod-subscription`
  - `sgprod-velagw`
  - `sgprod-vibebase`

当前已有 deploy-facing 目录但尚未接入 live leaf app：

- `nextgen-dashboard`

新增/修改新加坡 leaf app 时，至少要同时确认：

- `spec.source.repoURL` 指向 `git@git.woa.com:wisp/mono2.git`
- `spec.source.targetRevision` 指向 `gitops`
- 普通业务服务的 `spec.destination.name` 继续使用 `sgprod`
- `velagw` 使用独立目标集群 `johorbahru-llmgateway-prod`
- `spec.project` 与服务对应的 cutover project 一致
- 不要为 sgprod root app 或 leaf app 添加 `syncPolicy.automated`
- 对应 deploy-facing 目录已经在新 Argo 的 `ksops` 运行时下验证通过

当前仍保持 skeleton / 待后续纳管：

- `session`
- `frontend-ds`

注意：

- `apps/sgprod/` 是 `root-sgprod` 会直接扫描的 live 路径
- 如果后续要把新加坡收敛成单一 project 模型，需要成组调整：
  - `argocd/apps/sgprod/*.yaml`
  - `argocd/projects/sgprod*.yaml`
  - `argocd/root/sgprod.yaml`
