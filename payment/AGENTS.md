# Payment Agent Guide

`payment` 的正式发布模型已经改成：

- source-facing:
  - `payment/k8s/base/`
  - `payment/k8s/overlays/<env>/`
- deploy-facing:
  - `argocd/services/payment/<env>/`
  - `argocd/apps/<env>/payment.yaml`

正式发布只认 `Argo CD`。  
服务目录不再承担正式 `apply / release`。

## 保留能力

- 镜像构建：
  - `python3 scripts/build-release-image.py --service payment --env <env> --tag <tag>`
- DB migration：
  - `scripts/run_gitops_db_job.py`
  - `.gitlab/ci/gitops-db-job.yml`

## 约束

- `generated/` 一律不提交 Git
- `payment` 的 deployable import 边界由 [scripts/release-bundles.yaml](../scripts/release-bundles.yaml) 管
- 不要把 migration / seed 塞回应用启动路径
- 不要把 service-local 脚本重新当成正式发布入口
