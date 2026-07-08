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
- `admin-gateway` 有独立 CI / 镜像 / release bundle：
  - CI 入口：`.ci/admin-gateway.yml`
  - 镜像 repo：`lightclaw-*/lightclaw/admin-gateway`
  - GitOps pin：`argocd/services/admin-gateway/<env>/admin-gateway-platform.env`
- 当前构建实现仍临时复用 `service-gateway/Dockerfile` 和 `service-gateway` build context；这是构建实现复用，不再是发布镜像共享

<!-- retrigger 2026-07-08: shprod admin-gateway release after billing dependency rollout. -->
