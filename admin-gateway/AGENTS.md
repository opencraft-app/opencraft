# Admin Gateway Agent Notes

- `admin-gateway` 的正式发布只认 `Argo CD`
- source-facing 真源保留：
  - `admin-gateway/k8s/base`
  - `admin-gateway/k8s/overlays/<env>`
- deploy-facing 真源保留：
  - `argocd/services/admin-gateway/<env>`
  - `argocd/apps/<env>/admin-gateway.yaml`
- `platform.env` 来自 `infra_pulumi`，不手改、不提交
- `generated/` 是本地生成物，不提交 Git
- 自己的 runtime secret 由 GitOps secret 主线管理，不再由服务脚本生成正式发布输入
- `admin-gateway` 不单独负责镜像构建；它复用 `service-gateway` 的共享 gateway 镜像
