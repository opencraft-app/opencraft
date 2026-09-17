---
id: personal-devcloud-testing-release
type: task
scope: 北京与韩国 testing 的个人 DevCloud 动态注册、精确发布和真实端到端验收。
triggers:
  - personal DevCloud testing release
  - developer route registry rollout
  - 北京韩国个人环境闭环
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - docs/context/tasks/2026-09-17-personal-devcloud-testing-release.md
  - docs/context/tasks/devcloud-personal-environment-self-service.md
  - docs/engineering/domains/release-gitops.md
  - .agents/skills/personal-devcloud-environment/SKILL.md
status: active
reviewed_at: 2026-09-17
review_due: 2026-10-17
revision: 0.2.0
precedence: task
derived: false
---

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

不变量：UIN 由 testing 登录会话和 active shadow binding 派生；Auth testing MySQL registry 只存 capability SHA-256；注销或过期必须 fail closed。

## history_context

- `current_design_refs`：`docs/engineering/domains/release-gitops.md`、`docs/engineering/domains/identity-access.md`、`docs/engineering/domains/subscription-entitlements.md`。
- `relevant_evolution`：`master@7837706e3` 已合入个人环境主体，`master@dd2fbbc20` 修复 namespaced Argo scope，`master@f058774e8` 已把 CloudLadder 自动镜像 pin 收敛为 testing-only；当前 Registry 方案 rebase 于该版本。
- `superseded_refs`：独立 `cloudladdergateway-devroute-testing` Namespace 和 workload namespace Lease/RBAC 方案均被真实 TKEx discovery/权限边界否决；当前使用 Auth testing MySQL + HMAC HTTP store。

## acceptance

- CloudLadder App 可正常比较，精确 testing 资源 `Synced/Healthy`，prod/staging 镜像不变。
- 北京、韩国 Auth 注册接口可用；韩国 Service Gateway 信任测试入口代理链。
- 国际 registration、Auth registry、devtunnel poll/reply、回调、注销/过期 fail-closed 有同请求证据。
- 国内 registration、9.x 来源地址、18084 端口限制、回调及 dynamic/static/shared 优先级有证据。
- 从清理状态按 Skill 一条命令重新启动成功，浏览器使用一次性 nonce 登录。

## affected_paths

- `argocd/services/cloudladdergateway/tkexgz/`
- `argocd/services/cloudladdergateway/tkexsg/`
- `.ci/cloudladdergateway.yml`
- `.ci/runtime/gitops/image_pin.py`
- `.ci/runtime/pin_image_to_gitops.sh`
- `.ci/templates/service-release.yml`
- `argocd/services/service-gateway/{sandbox-bj-7,sandbox-kr-1}/config.yaml`
- `user/auth/internal/devroute/`
- `user/auth/internal/httpapi/developer_route_registry.go`
- `user/auth/migrations/000020_add_developer_route_registrations.*.sql`
- `cloudladdergateway/internal/devroute/http_store.go`
- `.ci/runtime/tests/gitops_tests/test_clgateway_developer_routes.py`
- `docs/engineering/domains/release-gitops.md`

## required_context

- `release-gitops`

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@3165aca5a` | 仓库发布与验证硬边界 | 约束 GitOps、生产和完成声明 |
| `.ci/AGENTS.md@3165aca5a` | 流水线发布边界 | 区分镜像构建与发布完成 |
| `docs/context/domains/release-gitops.md@3165aca5a` | 发布领域摘要 | 要求 Argo revision、镜像和健康证据 |
| `docs/engineering/domains/release-gitops.md@3165aca5a` | 正式发布设计 | 维护 testing-only 精确同步门禁 |
| `docs/engineering/domains/identity-access.md@3165aca5a` | 内部鉴权和身份边界 | 约束 HMAC、UIN 和可信来源 |
| `.agents/skills/personal-devcloud-environment/SKILL.md@3165aca5a` | 最终一键启动与验收契约 | 约束真实 testing 与浏览器闭环 |

## evidence

- `cloudladdergateway-tkexgz` 与 `cloudladdergateway-tkexsg` 在 `gitops@b426d882` 均报：namespaced mode 不能管理 cluster-level Namespace。
- 发布前 TKEx prod/staging/testing 都仍运行旧 digest `sha256:52ce3503...`，尚未发生同步。
- CloudLadder 自动投影曾把 primary/staging image pin 一并改为 testing 新镜像；MR `!4147` 已在
  Argo Sync 前恢复 3 个生产期望态文件，最新 GitOps 相对发布前基线只剩 testing 文件差异。
- MR `!4149` 已合入 `master@f058774e8`，源码发布链增加 `IMAGE_PIN_VARIANT=testing`，后续 CloudLadder master 构建只更新 testing platform
  env，避免再次污染 production/staging 期望态。
- 真实 TKEx Argo adaptor 无法 discovery `rbac.authorization.k8s.io/v1`，发布账号也不能管理 Role、RoleBinding、Lease 或 ServiceAccount；因此发布面不具备 Lease/RBAC 方案的前提。
- Registry 方案已 rebase 到 `origin/master@f058774e8`，并通过 Auth、CloudLadderGateway、Service Gateway 全量 Go 测试以及 testing GitOps 路由测试；尚未发生 testing 运行态发布。
- production/staging manifest 不在 Registry 变更路径中；CloudLadder testing-only image-pin 保护已由 MR `!4149` 合入。

## risks

- CloudLadder App 同时包含生产与 testing 资源：只允许 resource-scoped dry-run/sync，出现非 testing 资源立即停止。
- CloudLadder 发布目录同时包含 primary/staging/testing platform env：流水线必须显式选择 testing
  variant；默认 `all` 只保留给其他需要完整变体晋级的服务。
- Registry：复用各区域 Auth testing MySQL 与既有 Shadow HMAC；不新增 Secret、ServiceAccount、Role、RoleBinding 或 Lease。Registry 不可用、记录非法或 migration 缺失时 readiness/路由均 fail closed。
- 回滚：精确恢复 testing Auth、Service Gateway、`lightvela-proxy-testing` 与 `devtunnel-testing` 到发布前 revision；不触碰生产对象。

## validation

- GitOps developer-route tests、CI runtime tests、Kustomize render、secret scan、`git diff --check`。
- Argo resource diff/dry-run、目标 revision、资源状态与 live image。
- Skill contract、`status`、`browser-login`、`verify-order-no-pay` 及真实 callback audit。

## decisions

- 使用各区域 Auth testing MySQL 的 `developer_route_registrations` 作为持久化真源；CloudLadder 与 devtunnel 通过既有 Shadow HMAC 读取，同步二次校验 UIN、CIDR、端口、delivery mode、TunnelHost 与 capability digest。

## scan_scope

- 上述 affected paths、CloudLadder testing live resources、北京/韩国 playground Auth/Service Gateway。

## scan_output

- 只记录脱敏命令摘要、revision、资源名和镜像 digest。

## handoff

- MR `!4149` 已合入；Registry 源码已在独立 worktree rebase 到 `origin/master@f058774e8`。重跑门禁并合入 Registry MR 后，按 migration → Auth/Service Gateway → CloudLadder testing 精确资源的顺序发布，再执行国内、国际真实 E2E 并回填证据。
