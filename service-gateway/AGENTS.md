# Service Gateway Agent Notes

- `service-gateway` 的正式发布只认 `Argo CD`
- source-facing 真源保留：
  - `service-gateway/k8s/base`
  - `service-gateway/k8s/overlays/<env>`
- deploy-facing 真源保留：
  - `argocd/services/service-gateway/<env>`
  - `argocd/apps/<env>/service-gateway.yaml`
- 镜像构建统一走：
  - `python3 .ci/runtime/commands/build_release_image.py --service service-gateway --env <env> --tag <tag>`
- `service-gateway` 与 `admin-gateway` 发布边界已经拆开：
  - `service-gateway.yml` 只构建 / promote / pin `service-gateway`
  - `admin-gateway.yml` 只构建 / promote / pin `admin-gateway`
  - 不要再通过 `service-gateway` 流水线夹带更新 `admin-gateway`
- `platform.env` 来自 `infra_pulumi`，不手改、不提交
- `generated/` 是本地生成物，不提交 Git
