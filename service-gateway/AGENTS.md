# Service Gateway Agent Notes

- `service-gateway` 的正式发布只认 `Argo CD`
- source-facing 真源保留：
  - `service-gateway/k8s/base`
  - `service-gateway/k8s/overlays/<env>`
- deploy-facing 真源保留：
  - `argocd/services/service-gateway/<env>`
  - `argocd/apps/<env>/service-gateway.yaml`
- 镜像构建统一走：
  - `python3 scripts/build-release-image.py --service service-gateway --env <env> --tag <tag>`
- `platform.env` 来自 `infra_pulumi`，不手改、不提交
- `generated/` 是本地生成物，不提交 Git
