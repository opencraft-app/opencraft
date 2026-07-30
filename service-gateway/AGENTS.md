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

<!-- retrigger 2026-06-16: MR !1591 (4365404cf28a) 触发的 promote-beijing-sandbox-service-gateway-service-gateway-4365404cf28a -> gitops MR !1593 因 service-gateway-platform.env 与 vibebase promote (fb6ea4434) 冲突 cannot_be_merged，build #716 stage-3 FAILED；本 commit 无业务改动，仅命中 .ci/service-gateway.yml paths 触发流水线基于最新 gitops 重新生成 promote 分支 + MR，让 trade-jifei-callback public route 真正落到 beijing-sandbox -->

<!-- retrigger 2026-07-08: shprod service-gateway release after billing dependency rollout. -->
