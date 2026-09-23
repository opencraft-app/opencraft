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

把个人 DevCloud 自助注册与 testing 账号短期租约发布到北京、韩国共享 testing，使新同学从全空 state
直接执行一条 `up`，并完成国内、国际真实浏览器和计费回调闭环。

## non_goals

- 不修改或同步 production、staging workload、Service、ConfigMap 或 Secret。
- 不向 DevCloud 下发共享 HMAC、SOPS 或 `DEVTUNNEL_TOKEN`。
- 不把 testing 账号密码、admin token 或云 Secret 写入 Skill/Git。
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
- 不提供账号凭据时，`up` 分别从北京/韩国账号池领取当前站点合格、active binding 的短期 session；北京
  候选必须完成实名，韩国候选必须完成国际开户映射；并发占用、
  需要当前租约 session 的幂等续租、池满 409、TTL、unregister 后释放及旧 developer-lease session 撤销均有证据。
- `status` 的 billing readiness 同时校验 HTTP 200 与精确 JSON `code=OK,message=ready`，不能把任意 200
  页面误报为中央 Auth/Trade 计费链路就绪。

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
- `user/auth/migrations/000021_add_developer_test_account_leases.*.sql`
- `user/auth/internal/service/*developer_test_account*`
- `user/auth/internal/httpapi/developer_test_account.go`
- `argocd/services/lightclaw-auth/{sandbox-bj-7,sandbox-kr-1}/`
- `argocd/services/service-gateway/{sandbox-bj-7,sandbox-kr-1}/config.yaml`
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
- 使用各区域 Auth testing MySQL 的 `developer_test_account_leases` 作为账号池并发真源；pool 配置只写 Auth
  user ID。默认关闭，sandbox host/environment 双校验后才启用。同一 DevCloud 幂等续租，不同 DevCloud
  互斥；已有有效租约的续租必须携带当前 `developer_lease` session，释放时撤销该用户全部
  `developer_lease` session。租约和 session 都过期后，客户端收到服务端明确的 `session_expired/unauthorized`
  才允许退回匿名首次领取路径，避免网络失败时丢弃仍有效的续租凭证。
- 当前账号领取的组织信任边界是公司 DevCloud 9/8、21/8 与 sandbox-only 配置，不宣称具备 WOA 员工级 OAuth 证明。

## scan_scope

- 上述 affected paths、CloudLadder testing live resources、北京/韩国 playground Auth/Service Gateway。

## scan_output

- 只记录脱敏命令摘要、revision、资源名和镜像 digest。

## handoff

- MR `!4149` 已合入；Registry 源码已在独立 worktree rebase 到 `origin/master@f058774e8`。重跑门禁并合入 Registry MR 后，按 migration → Auth/Service Gateway → CloudLadder testing 精确资源的顺序发布，再执行国内、国际真实 E2E 并回填证据。

## checkpoint_2026_09_22_account_pool_verification

- 当前隔离分支为 `codex/personal-devcloud-account-lease`，基线 `c1875f2f166a66924330a8f8e3f1cfb278366819`；尚未 commit、push、发布或修改生产。
- 韩国共享 Auth 数据库已只读确认：`usr_6f227841b2a1564273a779c9` 持有 UIN `450860000023`、OwnerUIN
  `450860000023`、AppID `1374222817` 的 active binding；`usr_b3496462bba969391ebc2976` 仅是历史个人
  localstack 用户，不存在于共享 Auth。韩国账号池 manifest 已改用中央用户。
- 同一查询确认该国际中央用户没有国内 `realname_verified_at`。账号资格已按站点收敛为：北京要求实名 +
  active binding，韩国要求国际开户映射的 active binding；两站都校验 UIN、OwnerUIN、AppID。
- 已确认韩国 testing 独立 kubeconfig `/etc/lightclaw-ci/kubeconfig_sandbox_kr_1`、Auth Pod 与 MySQL Pod运行正常。Auth 数据库不在 namespace 内 MySQL；跳板机缺少 `mysql` 客户端，本地 SSH 隧道探测未返回，因此下一步改用现有 `mysql-0` 容器内客户端连接 Auth 配置的数据库，只执行脱敏 SELECT。
- 脚本续租失败已改为返回错误：现有 session 仍有效时继续使用到 TTL；服务端明确拒绝过期 session 后才
  匿名重领；release 收到异常 200 时保留租约到 TTL，但 `down` 继续关闭 localstack。
- 本地 GitOps render 首次验证命令因包含临时文件 `rm -f` 被执行策略拒绝，未运行任何删除或外部变更；后续改为 `kustomize build | python3` 管道内存解析，不再创建临时渲染文件。
- 管道渲染进一步被本机缺少 SOPS 解密身份挡住；Auth/Gateway overlays 的 KSOPS generator 均 fail closed，未输出 Secret。后续使用仓库 GitOps 测试自带的脱密渲染方式，并在受控 DevCloud/CI 环境核对完整 render；不把 age identity 复制进仓库或 Skill。
- 北京共享 Auth 数据库已只读确认：账号池用户 `usr_a91666c074db49d452e19c26` 为 `phone_3fa` 实名，binding 为 active，UIN/OwnerUIN/AppID 完整。

## checkpoint_2026_09_22_final_local_validation

- 账号租约服务、HTTP contract、Skill 合约、GitOps 路由测试、Skill validator、Auth 全量 Go 测试、
  Service Gateway 全量 Go 测试和 Auth `-race` 均通过。
- 独立前向验证发现已有租约只凭伪造 `targetIp` 即可匿名续租并获得新 session；现已要求续租携带当前
  `developer_lease` bearer session，并校验 session 用户与租约用户一致。首次领取仍只允许受控 DevCloud
  网络；普通登录 session 不能释放租约。
- 临时 MySQL 8 真实并发测试首次稳定复现 `Error 1213 (40001)`：三台 DevCloud 并发领取时，租约行初始化
  可能死锁并返回 500。实现已对 MySQL `1205`、`1213` 和 SQLSTATE `40001` 重跑完整事务；修复后连续
  20 轮均满足两个候选账号仅两个 owner 成功、第三个明确 busy，且续租保持原账号、释放事务撤销新旧全部
  `developer_lease` session。
- migration 21、OpenAPI optional bearer、sandbox host/environment 双校验和北京/韩国精确公开路由均已纳入
  测试。下一步是 staged context 门禁、MR/CI 合入和 migration → Auth → Service Gateway 的 testing 发布；
  在国内、国际真实 `up`、支付/变配、回调及终态证据完成前，不宣称一键闭环已上线。
