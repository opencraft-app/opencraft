## goal

把个人 DevCloud 自助注册能力发布到北京、韩国共享 testing，并完成国内、国际真实浏览器和计费回调闭环。

## non_goals

- 不修改或同步 production、staging workload、Service、ConfigMap 或 Secret。
- 不向 DevCloud 下发共享 HMAC、SOPS 或 `DEVTUNNEL_TOKEN`。
- 不执行 App 级 CloudLadder Argo Sync。

## requirement_ids / requirement_refs / requirement_excerpt

- MR `!3725`：个人 DevCloud 自助环境源码与 testing-only manifests。
- 用户验收：全新 DevCloud 一条命令启动、浏览器可点测、国内直连和国际 devtunnel 真实 testing 回调。

## interface_refs / data_structure_refs

- `.agents/skills/personal-devcloud-environment/scripts/personal-devcloud.sh`
- `user/auth/internal/httpapi/developer_routes.go`
- `cloudladdergateway/internal/devroute/`
- `argocd/services/cloudladdergateway/{tkexgz,tkexsg}/`

不变量：UIN 由 testing 登录会话和 active shadow binding 派生；Lease 只存 capability SHA-256；注销或过期必须 fail closed。

## history_context

- `current_design_refs`：`docs/engineering/domains/release-gitops.md`、`docs/engineering/domains/identity-access.md`、`docs/engineering/domains/subscription-entitlements.md`。
- `relevant_evolution`：`master@7837706e313e2944cab62db75087789723a8915a` 已合入；`gitops@b426d882c5cd6b95c627272a8ed290f8cdfb9d88` 已只保留 testing 期望态。
- `superseded_refs`：独立 `cloudladdergateway-devroute-testing` Namespace 方案被 live Argo namespaced-mode ComparisonError 否决。

## acceptance

- CloudLadder App 可正常比较，精确 testing 资源 `Synced/Healthy`，prod/staging 镜像不变。
- 北京、韩国 Auth 注册接口可用；韩国 Service Gateway 信任测试入口代理链。
- 国际 registration、Lease、devtunnel poll/reply、回调、注销/过期 fail-closed 有同请求证据。
- 国内 registration、9.x 来源地址、18084 端口限制、回调及 dynamic/static/shared 优先级有证据。
- 从清理状态按 Skill 一条命令重新启动成功，浏览器使用一次性 nonce 登录。

## affected_paths

- `argocd/services/cloudladdergateway/tkexgz/`
- `argocd/services/cloudladdergateway/tkexsg/`
- `.ci/runtime/tests/gitops_tests/test_clgateway_developer_routes.py`
- `docs/engineering/domains/release-gitops.md`

## required_context

- `release-gitops`

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@7837706e` | 仓库发布与验证硬边界 | 约束 GitOps、生产和完成声明 |
| `.ci/AGENTS.md@7837706e` | 流水线发布边界 | 区分镜像构建与发布完成 |
| `docs/context/domains/release-gitops.md@7837706e` | 发布领域摘要 | 要求 Argo revision、镜像和健康证据 |
| `docs/engineering/domains/release-gitops.md@7837706e` | 正式发布设计 | 维护 testing-only 精确同步门禁 |
| `.agents/skills/personal-devcloud-environment/SKILL.md@7837706e` | 最终一键启动与验收契约 | 约束真实 testing 与浏览器闭环 |

## evidence

- `cloudladdergateway-tkexgz` 与 `cloudladdergateway-tkexsg` 在 `gitops@b426d882` 均报：namespaced mode 不能管理 cluster-level Namespace。
- 发布前 TKEx prod/staging/testing 都仍运行旧 digest `sha256:52ce3503...`，尚未发生同步。

## risks

- CloudLadder App 同时包含生产与 testing 资源：只允许 resource-scoped dry-run/sync，出现非 testing 资源立即停止。
- Lease 改存 workload namespace：使用 testing 专用 ServiceAccount、仅 `leases` 的 `get/create/update` 权限和专用 name prefix 保持隔离。
- 回滚：精确把 testing StatefulSetPlus 和 RBAC 恢复到发布前 revision；不触碰生产对象。

## validation

- GitOps developer-route tests、CI runtime tests、Kustomize render、secret scan、`git diff --check`。
- Argo resource diff/dry-run、目标 revision、资源状态与 live image。
- Skill contract、`status`、`browser-login`、`verify-order-no-pay` 及真实 callback audit。

## decisions

- 使用既有 `ns-prjqt8dd-867795-production` 作为 Lease namespace，避免 namespaced-mode Argo 的 cluster/cross-namespace 管理；隔离由 testing 专用 ServiceAccount、Role 与 Lease prefix 提供。

## scan_scope

- 上述 affected paths、CloudLadder testing live resources、北京/韩国 playground Auth/Service Gateway。

## scan_output

- 只记录脱敏命令摘要、revision、资源名和镜像 digest。

## handoff

- 当前正在修复 live Argo ComparisonError；修复、GitOps 发布和真实 E2E 完成后更新本文件 evidence 与 handoff。
