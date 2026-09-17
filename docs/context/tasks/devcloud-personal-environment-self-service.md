---
id: devcloud-personal-environment-self-service
type: task
scope: DevCloud 个人测试环境的一键搭建、testing 计费回调动态注册与浏览器点测入口。
triggers:
  - DevCloud 个人测试环境
  - jifei callback self service
  - developer route registration
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - docs/context/tasks/devcloud-personal-environment-self-service.md
  - .agents/skills/personal-devcloud-environment/SKILL.md
  - cloudladdergateway/internal/devroute
  - deploy/localstack/localstack.sh
status: active
reviewed_at: 2026-09-08
review_due: 2026-12-07
revision: 0.2.0
precedence: task
derived: false
---

# Task Pack：DevCloud 个人测试环境自助化

## goal

让开发者或 coding agent 从零在自己的 DevCloud 上启动完整 LightVela localstack，通过测试站登录会话自动取得专属影子账号 UIN，并经 testing Auth 把 `UIN -> DevCloud IP:trade port` 动态注册到国内或国际 cloudladdergateway testing 工作负载；完成后可直接通过 DevCloud IP 打开前端并验证询价、下单不支付和真实 `checkCreate` 回调。

## non_goals

- 不修改、发布或同步任何生产/staging 工作负载。
- 不把动态注册数据写回 Git、GitOps 或 Argo CD desired state。
- 不允许客户端任意指定 UIN、URL 或任意内网端口。
- 不默认触发真实支付、`place-and-pay` 或发货闭环。
- 不在本轮替代“一需求一共享集群环境”的 playground 克隆能力。

## requirement_ids / requirement_refs / requirement_excerpt

- 用户要求：落地一个 Skill，使 vibecoding agent 能从 0 自动搭建 DevCloud 个人测试环境，动态注册国内/国际 testing 计费回调，并提供可点测的完整前端入口。
- TAPD `1010132091137784162`：LightVela SV 内变配设计；本任务只提供其个人环境联调底座，不修改变配业务协议。
- `docs/context/tasks/personal-test-environment-automation.md`：已有静态 UIN 路由和个人计费联调的历史证据；其中手改 GitOps/MR/Sync 的登记方式由本任务替代。

## interface_refs / data_structure_refs

- Auth `POST /auth/dev-environments/registration`：浏览器/Skill 的唯一注册入口。Auth 始终从当前 session 的 active shadow binding 派生 UIN；国际站目标 IP 继续来自可信代理链，国内 sandbox 可在独立开关开启时接收 Skill 自动探测的 `targetIp`，并只允许 `9.0.0.0/8:18084`。生产、staging 和默认配置不接受显式目标 IP。
- Auth `GET /auth/dev-environments/registration`：返回当前 session 对应 UIN 的注册状态。
- Auth `DELETE /auth/dev-environments/registration`：把当前 session 对应 UIN 标记为 disabled；保留 tombstone，避免旧订单回调误落共享环境。
- CloudLadderGateway `/v1/dev-environments/registration`：只允许 `lightclaw-auth` 通过服务间 HMAC 调用的内部控制面；DevCloud 和浏览器不得直接访问，也不能提交 session 代替 HMAC。
- Auth testing `developer_route_registrations`：国内、国际各自在本区域 Auth MySQL 持久化动态状态；只保存 capability SHA-256，`renewed_at + ttl_seconds` 决定 active/expired。
- `cloudladdergateway/internal/server.NewGinRouterWithDeveloperRoutes`：静态 UIN 表继续作为迁移兜底；动态状态优先，expired/disabled 必须 fail closed。
- `deploy/localstack/localstack.sh`：DevCloud Linux 暴露 frontend、service-gateway、trade callback 的入口。

## history_context

- `current_design_refs`：`docs/context/domains/subscription-entitlements.md`、`docs/context/domains/site-environment-routing.md`、`cloudladdergateway/AGENTS.md`。
- `relevant_evolution`：现有 `CLOUDLADDERGATEWAY_ROUTE_<ID>_UIN_ROUTES` 在进程启动时加载；可直接配置地址但仍需改 GitOps、合 master、手工 Sync，且两个 testing replica 无共享热状态。
- `superseded_refs`：广州 testing 使用 DevCloud 直连；新加坡 testing 必须保留 `origin/master` 已验证的 devtunnel delivery。动态注册替代的是手工 UIN 槽位登记，不得擅自删除或迁移现有 devtunnel testing 工作负载。

## acceptance

- 未登录请求不能创建、查询或停用注册。
- 客户端不能提交任意 UIN、host 或 URL；非 DevCloud CIDR、非允许端口被拒绝。
- 两副本通过 Auth HMAC registry 读取同一注册；Pod 重启后注册仍存在，registry 不可用时 fail closed。
- active 动态注册优先于静态表；expired/disabled 注册返回明确错误且不落共享环境；未知 UIN 保持现有兜底语义。
- tkexgz/tkexsg 仅 testing 工作负载启用 HTTP registry；不新增 ServiceAccount/RBAC/Lease，prod/staging manifest 无变化。
- DevCloud Linux 执行 Skill 脚本后可从 `http://<DevCloud-IP>:5173` 打开前端，API 指向 `http://<DevCloud-IP>:8085`，trade callback 监听 `0.0.0.0:18084`。
- Skill 覆盖 doctor/bootstrap/up/register/status/heartbeat/unregister/down，以及真实询价、下单不支付和个人 DB 不变量验收。

## affected_paths

- `cloudladdergateway/`
- `argocd/services/cloudladdergateway/tkexgz/`
- `argocd/services/cloudladdergateway/tkexsg/`
- `deploy/localstack/`
- `deploy/envs/localstack/`
- `.agents/skills/personal-devcloud-environment/`
- `.ci/runtime/tests/gitops_tests/`

## required_context

- `devcloud-personal-environment-self-service`
- `cloudladdergateway/AGENTS.md`
- `docs/context/domains/subscription-entitlements.md`
- `docs/context/domains/site-environment-routing.md`

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@working-tree` | 仓库安全、Task Pack 与验证门禁 | 限制 testing-only、保护 dirty worktree、禁止未授权发布 |
| `cloudladdergateway/AGENTS.md@working-tree` | 网关服务边界与测试命令 | 约束注册 API、路由与审计实现 |
| `docs/context/domains/subscription-entitlements.md@working-tree` | 计费/Pass 不变量 | 保持下单不支付和回调无污染验收 |
| `docs/context/domains/site-environment-routing.md@working-tree` | 国内/国际站环境边界 | 国内与国际 registration/Auth registry 配置隔离 |
| `docs/context/tasks/personal-test-environment-automation.md@working-tree` | 既有个人环境证据与静态方案 | 兼容迁移现有 UIN 路由，不盲信旧 SOP |
| `.agents/skills/personal-devcloud-environment/SKILL.md@working-tree` | 当前人工联调流程 | 作为 Skill RED 基线，替换手改 GitOps 步骤 |
| `docs/engineering/domains/subscription-entitlements.md@working-tree` | 计费与 Pass 正式设计真源 | 记录无支付验收、动态回调和不发货不变量 |
| `docs/engineering/domains/release-gitops.md@working-tree` | 发布正式设计真源 | 记录 testing-only Auth registry 与精确发布边界 |
| `docs/engineering/domains/site-environment-routing.md@working-tree` | 双站正式设计真源 | 记录 DevCloud 页面、站点配置与回调入口边界 |

## evidence

- 2026-09-17：真实 TKEx Argo adaptor 无法 discovery `rbac.authorization.k8s.io/v1`，且发布账号不能管理 Role/RoleBinding/Lease；因此废弃 Lease/RBAC 设计，改用 Auth testing MySQL + HMAC HTTP store。
- 2026-09-08：使用 Node 24 运行 `bash deploy/localstack/tests/validate.sh` 通过；覆盖 mock 计费/账号边界、Kustomize 渲染、双站 seed、Linux 暴露逻辑和个人 Skill contract。
- 2026-09-08：两套 GitOps Python 测试共 6 个用例通过；确认动态注册只启用在 tkexgz/tkexsg testing manifest，生产/staging 未启用。
- 2026-09-08：Skill `quick_validate.py`、Bash 语法、行为 contract、`git diff --check`、文档结构检查和 docs-impact 均通过。
- 2026-09-17：Registry 方案已 rebase 到 `origin/master@3165aca5a`；Auth、CloudLadderGateway、Service Gateway 全量 Go 测试与 testing GitOps 路由测试通过。Registry readiness 已改为检查目标表，避免 migration 未执行时出现假 Ready。

## risks

- SSRF：服务端只从可信请求链取 IP，仅允许配置的 DevCloud CIDR 与端口；请求体不接受 UIN/host/URL。
- 跨环境污染：已认领 UIN 的 expired/disabled 状态 fail closed；静态路由保留到动态迁移真实验证完成。
- GitOps 误同步生产：TKEx 构建固定使用 `testing` image-pin variant，只允许修改 testing platform env；发布时仅精确同步 testing 资源，禁止 app 级 Sync。
- callback 晚到：unregister 写 tombstone 而不是物理删除。
- Session 泄露：Skill 只在本机内存中用一次性 nonce 把 session 交给浏览器，不写状态文件、shell argv、仓库或日志。
- 探针重定向：健康探针禁止跟随 3xx，避免允许的 DevCloud 第一跳扩展为任意内网 SSRF。
- Registry：复用 testing Auth MySQL 和既有 Shadow HMAC，不新增 SOPS key；CloudLadder 读取后仍二次校验 UIN、CIDR、端口、delivery mode、TunnelHost 和 capability digest。
- 国际站 delivery：保留 `origin/master` 的 devtunnel workload、secret generator、静态 UIN 兜底和 testing 镜像 replacement；动态注册命中时同样经 devtunnel delivery，不能回退为 Pod 直连 DevCloud。

## validation

- `cd cloudladdergateway && go test ./...`
- `PATH="<node24>/bin:$PATH" bash deploy/localstack/tests/validate.sh`
- `/usr/bin/python3 .ci/runtime/tests/gitops_tests/test_clgateway_developer_routes.py`
- `/usr/bin/python3 .ci/runtime/tests/gitops_tests/test_clgateway_sg_testing_callback.py`
- `/usr/bin/python3 <skill-creator>/scripts/quick_validate.py .agents/skills/personal-devcloud-environment`
- `bash .agents/skills/personal-devcloud-environment/tests/contract_test.sh`
- 仓库 docs/change-impact 门禁按实际变更运行；未能运行的 live testing 验证明确标注。

## decisions

- 选 Auth testing MySQL registry：双副本一致、重启保留、无需新增中间件；真实 TKEx 发布面不支持本方案所需的 RBAC discovery/管理，因此不再依赖 Lease。
- UIN 由测试站 session 的公开 `/auth/shadow/binding` 派生，不接受客户端提交。
- 动态路由仅覆盖 jifei callback；账号注册与出站计费仍复用各测试站现有能力。
- 现有静态 `700003135209 -> 9.134.214.121:18084` 在动态路径真实验证前保留。

## scan_scope

- `cloudladdergateway/**`
- `deploy/localstack/**`
- `argocd/services/cloudladdergateway/{tkexgz,tkexsg}/**`
- `user/auth/**`（只读接口确认）
- `service-gateway/**`（只读 session 语义确认）

## scan_output

- 有界扫描结论记录在本 Pack；不生成全仓扫描产物。

## handoff

- 当前状态：源码、Skill、localstack、testing GitOps manifest 和正式设计文档已在独立 worktree 实现，并 rebase 到 `origin/master@3165aca5a`；正在完成合入前全量门禁，尚未构建测试镜像或发布。
- 未完成证据：尚未在北京/韩国 Auth testing 执行 migration、发布目标镜像并从 DevCloud 完成真实询价/`GenerateDeals`/回调/个人 DB/共享环境无污染验收。
- 集成风险：CloudLadder testing-only image-pin 保护 MR `!4149` 仍需代码 Owner 批准；该保护合入前不得触发 CloudLadder master 构建。加密 secret 继续复用既有 key，不在本分支修改。
- 发布权限边界：用户已明确授权 commit、push、MR、满足工蜂门禁后的合入，以及北京/韩国 testing migration、镜像和精确资源发布；仍禁止绕过评审、App 级 Argo Sync、production/staging 变更或生产业务请求。
