# Payment Agent 指引

`payment` 的正式发布模型已经改成：

- 源码侧：
  - `payment/k8s/base/`
  - `payment/k8s/overlays/<env>/`
- 部署侧：
  - `argocd/services/payment/<env>/`
  - `argocd/apps/<env>/payment.yaml`

正式发布只认 `Argo CD`。  
服务目录不再承担正式 `apply / release`。

## 保留能力

- 镜像构建：
  - `python3 .ci/runtime/commands/build_release_image.py --service payment --env <env> --tag <tag>`（从仓库根执行）
- DB migration：
  - `python3 .ci/runtime/commands/run_gitops_db_job.py`（从仓库根执行）
  - 历史 DB job 模板已退役；当前以脚本和 runbook 为准

## 约束

- `generated/` 一律不提交 Git
- `payment` 的 deployable import 边界由 [`.ci/runtime/bundles/payment.bundle`](../.ci/runtime/bundles/payment.bundle) 管
- 不要把 migration / seed 塞回应用启动路径
- 不要把 service-local 脚本重新当成正式发布入口
