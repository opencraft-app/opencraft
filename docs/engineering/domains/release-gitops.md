# 发布与 GitOps 领域

本领域覆盖源码构建、镜像/制品、环境输入、GitOps 期望、Argo 收敛和业务验收。任何一层成功都不能代替下一层。

## 交付链

```text
master 源码
  → .ci 构建与制品可见性
  → promote 分支/MR 更新 gitops
  → argocd 应用消费目标 revision/image
  → Argo Synced + Healthy
  → 服务健康、路由和业务 E2E
```

## 权威分工

- `.ci`：流水线与可复用构建/晋级命令。
- `infra_pulumi`：云资源和环境 inventory；`platform.env` 是派生输出，可能含敏感值。
- 服务 `k8s/base` 与 `k8s/overlays/<env>`：source-facing Kustomize。
- `argocd/services/<service>/<env>` 与 `argocd/apps/<env>`：deploy-facing 期望。
- Argo/集群/线上 E2E：真实运行态。

## 不变量

- 正式发布只认 Argo CD；service-local apply/release 脚本不是主线。
- Secret 值不进 Git、日志、渲染输出或文档。
- DB migration/seed 不塞进应用启动；使用受控 GitOps job 与明确回滚。
- 未经用户明确授权，不构建付费制品、不更新 GitOps、不 apply、不发布。
- 修改 `.ci/runtime/`、`argocd/`、`infra_pulumi/` 或 `codesign/` 时，先定位当前交付设计并同步更新映射的正式设计文档；`docs-impact` 只验证同一变更集含设计更新，不能代替平台 Owner 审阅。

相关 Journey：[源码到生产](../journeys/source-to-production.md)。Agent 摘要：[release-gitops Context](../../context/domains/release-gitops.md)。
