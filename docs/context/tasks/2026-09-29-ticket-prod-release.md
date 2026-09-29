## goal
将已经在北京共享测试环境验证的 MySQL 用户反馈功能，通过正式 CI + GitOps 分阶段交付到 shprod、sgprod，并分别验证真实登录提交、后台列表与附件下载。

## scope
- 为 ticket 恢复标准 release bundle、两地生产构建、显式审核的数据库迁移和 GitOps 晋级。
- 使用两地各自的独立 `lightvela_ticket` 库、专用 ticket 账号和 SOPS 加密的运行时 Secret；不复用后台 Basic Auth 密码作为服务密钥。
- 上线顺序：源码 MR 和镜像 -> DB version probe/migration -> ticket Application 和工作负载 -> 原有网关路由与 dashboard 内部代理身份 -> 双站前端真实请求。

## non_goals
- 不迁移旧 COS 反馈数据，不更改既有腾讯问卷入口。
- 不绕过生产审核、GitOps MR 或 Argo 人工同步；北京测试结果不能替代生产验证。

## requirement_refs
- 用户于 2026-09-29 明确要求生产上线，并确认后台沿用 Basic Auth，不提供额外 LightVela 用户 ID。
- 源码能力见 `docs/context/tasks/2026-09-28-support-feedback-mysql-redeploy.md`；MR !4737 已合入。

## interfaces_and_data
- `POST /support/feedback/submit`、`GET /support/feedback/list`、`GET /support/feedback/attachment/:id`。
- ticket migrations 最新版本为 2，目标生产库初始版本为 0；运行后要求 `version=2 dirty=false`。
- dashboard BFF 在已保护的后台入口注入固定内部代理身份 `admin`，ticket 白名单仅允许 `admin`；不以 Basic Auth 密码充当身份或 DB 密钥。

## affected_paths
- `.ci/ticket.yml`、`.ci/runtime/bundles/ticket.bundle`、`.ci/runtime/harness_ci/{db_job,prod_db_migration}.py`
- `ticket/cmd/ticket-migrate/`
- `argocd/services/ticket/{common,shprod,sgprod}/`、`argocd/apps/{shprod,sgprod}/ticket.yaml`、`argocd/projects/{shprod,sgprod}-ticket.yaml`
- `argocd/secrets/{shprod,sgprod}/ticket-runtime-secrets.sops.yaml`、`scripts/ssm_manifest.ticket.{shprod,sgprod}.yaml`

## required_context
- `docs/context/domains/release-gitops.md`、`docs/context/domains/site-environment-routing.md`
- `.ci/AGENTS.md`、`ticket/AGENTS.md`、`argocd/README.md`

## context_receipt
- 源码与 GitOps 分支分离；各生产环境独立 overlay、独立镜像和加密密钥。
- 生产迁移与镜像晋级分别需要流水线人工审核；GitOps 合入和 Argo `Synced/Healthy` 仍需实测。

## acceptance
1. CI 运行时与 ticket Go 测试、DB job 合同测试、GitOps 静态/渲染门禁通过；SOPS 文件不含明文。
2. 生产镜像两区 digest 明确；迁移先版本探测，再显式审批执行，之后核实版本/表/权限。
3. 两个 ticket Argo Application 的 revision、镜像、`Synced/Healthy` 和 Pod 均符合预期。
4. 两个站点分别登录后提交反馈；后台受 Basic Auth 保护的列表和附件下载真实可用，未授权请求被拒绝。

## rollback
- 首先停止新流量并回退网关/前端，再将 ticket GitOps 镜像 pin 回前一 digest；保留反馈库和数据，不自动回退 DDL。
