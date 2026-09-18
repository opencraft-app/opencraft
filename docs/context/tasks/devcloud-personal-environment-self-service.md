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
reviewed_at: 2026-09-17
review_due: 2026-12-16
revision: 0.3.0
precedence: task
derived: false
---

# Task Pack：DevCloud 个人测试环境自助化

## goal

让开发者或 coding agent 从零在自己的 DevCloud 上启动完整 LightVela localstack，通过测试站登录会话自动取得专属影子账号 UIN，并经 testing Auth 把 `UIN -> DevCloud IP:trade port` 动态注册到国内或国际 cloudladdergateway testing 工作负载；完成后可直接通过 DevCloud IP 打开前端并验证登录、询价、下单，以及在明确授权的 testing mock 场景中完成 `order-and-pay -> checkCreate/createResource -> Pass/quota` 闭环。

## non_goals

- 不修改、发布或同步任何生产/staging 工作负载。
- 不把动态注册数据写回 Git、GitOps 或 Argo CD desired state。
- 不允许客户端任意指定 UIN、URL 或任意内网端口。
- 不默认触发支付或发货闭环；只有明确授权且询价确认 `real_total_cost=0` 的 testing mock 账号才能调用测试专用 `order-and-pay`。
- 不在本轮替代“一需求一共享集群环境”的 playground 克隆能力。

## requirement_ids / requirement_refs / requirement_excerpt

- 用户要求：落地一个 Skill，使 vibecoding agent 能从 0 自动搭建 DevCloud 个人测试环境，动态注册国内/国际 testing 计费回调，并提供可点测的完整前端入口。
- TAPD `1010132091137784162`：LightVela SV 内变配设计；本任务只提供其个人环境联调底座，不修改变配业务协议。
- `docs/context/tasks/personal-test-environment-automation.md`：已有静态 UIN 路由和个人计费联调的历史证据；其中手改 GitOps/MR/Sync 的登记方式由本任务替代。

## interface_refs / data_structure_refs

- Auth `POST /auth/dev-environments/registration`：浏览器/Skill 的唯一注册入口。Auth 始终从当前 session 的 active shadow binding 派生 UIN；国内、国际 sandbox 都在独立开关开启时接收 Skill 自动探测的 `targetIp`，以避开跨地域 testing 入口 NAT 后无法还原 DevCloud 9 网地址的问题，并只允许 `9.0.0.0/8:18084`。生产、staging 和默认配置不接受显式目标 IP。
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
- 2026-09-17（DevCloud 日志跨至 2026-09-18）：韩国国际站使用个人环境真实执行 `POST /v1/passes/order-and-pay`，HTTP 200、业务 `code=OK`；testing 计费随后真实回调 `checkCreate` 和 `createResource`。终态为 `trade_flow(create_resource)=completed`、CTL Pass `bundle_launch_01/active`、`OPENCLAW_INSTANCE=1/1`。本次异步发货响应没有落 `trade_order`，且套餐 `credit=0` 因而 subscription 为 0，均符合现有代码语义。
- 2026-09-17（DevCloud 日志跨至 2026-09-18）：韩国注册自然过期后，中央 Auth 返回 `expired`，generic callback 入口 `POST /v1/proxy/jifei-callback/trade/jifei/callback` 返回 HTTP 503 / `status=expired`，个人 Trade 无新增请求；`unregister` 后中央状态为 `disabled` 且保留目标、端口和 tunnel 信息的 tombstone，同一路径返回 HTTP 503 / `status=disabled`。随后标准 `down`，5173/8085/18084/19050/28084、后台 PID 和个人 kind 集群均释放。
- 2026-09-17（DevCloud 日志跨至 2026-09-18）：北京国内站 `up` 后 41 个 Pod 中 32 Running、9 个 migration Job Completed、0 异常；CTL/Trade/Auth/Subscription migration 分别为 `31/10/20/2` 且 `dirty=0`。运行时 hash 证明 Auth 的 `LIGHTCLAW_INTERNAL_SERVICE_TOKEN`、`SHADOW_BINDING_INTERNAL_TOKEN` 与 Trade token 一致，Trade Shadow resolver 指向 Auth service。
- 2026-09-17（DevCloud 日志跨至 2026-09-18）：北京实时询价返回 `bundle_launch_01`、CNY、`real_total_cost=0`；testing `order-and-pay` HTTP 200、业务 `code=OK`。真实回调后终态为 `trade_order=provisioned`、`trade_flow(create_resource)=completed`、Pass `bundle_launch_01/active`、quota `1/1`、subscription 0。浏览器一次性 nonce 被消费，`session_token` fragment 被清除，登录态写入 localStorage，浏览器 `GET /v1/passes` 返回 1 条 active Launch Pass。
- 浏览器可达性边界：当前办公网 Chrome 直接访问 DevCloud 5173/19050 会被终端代理返回 502；本轮通过 Codex 自动建立 SSH 本地转发完成真实 DOM、localStorage 和 API 验收。该证据证明 Skill 登录链路可用，但不证明所有办公网终端都能裸直连 `http://<DevCloud-IP>:<高位端口>`；Codex-managed tunnel 是必要 fallback。
- 2026-09-17（DevCloud 日志跨至 2026-09-18）：北京 60 秒 TTL 自然过期后，generic callback 返回 HTTP 503 / `status=expired` 且个人 Trade/代理计数保持 `2->2 / 4->4`；`unregister` 后返回 HTTP 503 / `status=disabled` 且计数仍不变。随后标准 `down`，远端和本机转发端口、后台 PID、临时浏览器登录态与个人 kind 集群全部释放。
- 双站原始请求/响应只保存在 DevCloud 私有状态目录中，权限为 0600；本 Pack 仅记录方法、路径、HTTP/业务状态和终态，不保存 session、capability、token、完整账号标识或 Deal/BigOrder 原值。

## risks

- SSRF：服务端只从可信请求链取 IP，仅允许配置的 DevCloud CIDR 与端口；请求体不接受 UIN/host/URL。
- 跨环境污染：已认领 UIN 的 expired/disabled 状态 fail closed；静态路由保留到动态迁移真实验证完成。
- GitOps 误同步生产：TKEx 构建固定使用 `testing` image-pin variant，只允许修改 testing platform env；发布时仅精确同步 testing 资源，禁止 app 级 Sync。
- callback 晚到：unregister 写 tombstone 而不是物理删除。
- Session 泄露：Skill 只在本机内存中用一次性 nonce 把 session 交给浏览器，不写状态文件、shell argv、仓库或日志。
- 浏览器网络：办公网代理或安全组可能阻止裸访问 DevCloud 高位端口；自动化验收和无直连终端应使用 agent-managed SSH local forwarding，且清理阶段必须停止转发。
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
- 双站 live testing：`up -> browser-login -> register -> inquiry -> testing order-and-pay -> callback/DB terminal state -> TTL expired 503 -> unregister disabled 503 -> down`。
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

- 当前状态：北京国内与韩国国际均已用同一套个人 DevCloud state 串行完成浏览器登录、动态注册、真实询价、testing mock 下单支付、计费回调、Pass/quota 终态、TTL fail-closed、disabled tombstone 和 `down` 清理。两站当前均为 `stack_status=down / registration_status=disabled`，没有遗留固定端口或个人 kind 集群。
- 本轮运行时暴露并修复三处 localstack 缺口：Trade Shadow binding resolver 改为真实 Auth 内部接口；共享内部 token 随机化覆盖 Auth 两个 token；CTL localstack migration 清单补齐 24-31。另同步更新 `validate.sh` 的 token patch-plan 精确期望和 migration 全覆盖断言。
- 集成状态：修复将更新到既有 MR `!4218` 并在最新门禁通过后合入 `master`；用户已明确授权 commit、push 和 merge。
- 发布权限边界：本轮只操作 testing 与个人 kind/localstack；没有修改 production/staging、GitOps desired state、Argo 或真实资金链路。后续仍禁止 App 级 Argo Sync、production/staging 变更或生产业务请求。
