## goal
修复上海生产 Credit 与用户模型流量连接不同 LLMGateway 控制面，导致积分包已到账但无法用于对话的问题。

## non_goals
- 不改变积分包额度、价格或计费订单协议。
- 不直接滚动修改生产 Deployment；环境配置通过 master/CI/GitOps 发布。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户现场反馈：积分包下单后页面没有反应；要求核对实际请求日志并继续分析原因。

## interface_refs / data_structure_refs
- `POST /v1/credit/packages/order`
- `GET /v1/credit/packages`
- `frontend/src/lib/use-credit-checkout.ts` 的到账轮询状态机。
- `credit_package`、`trade_order`、`trade_flow`。

## history_context
- `current_design_refs`：`credit/AGENTS.md`、`docs/context/project/services/credit.md`。
- `relevant_evolution`：Credit 前端通过购买前快照与后续积分包列表差集判断到账。
- `superseded_refs`：无。

## acceptance
- 对齐下单、计费回调、资源创建和前端查询的时间线。
- 确认上海线上前端实际版本与轮询实现。
- 上海现有 active 积分包迁移到本地域 LLMGateway，问题用户真实模型请求恢复。
- 上海、新加坡 Credit 的 URL、token 与商品 Plan 均属于各自地域，并由发布契约防止回退。

## affected_paths
- `argocd/services/credit/shprod/credit-platform.env`
- `argocd/services/credit/sgprod/credit-platform.env`
- `argocd/secrets/shprod/credit-runtime-secrets.sops.yaml`
- `argocd/secrets/sgprod/credit-runtime-secrets.sops.yaml`
- `.ci/runtime/tests/contract_tests/test_release_bundle_contracts.py`
- `credit/AGENTS.md`
- `credit/docs/README.md`
- `docs/engineering/domains/release-gitops.md`

## required_context
- `agent-gateway-runtime`
- `site-environment-routing`
- `release-gitops`
- `trade-service-detail`
- `credit-service-detail`
- `service-gateway-service-context`

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/domains/agent-gateway-runtime.md` | 公共请求经 Service Gateway | 区分公共路径与服务直连证据 |
| `docs/context/domains/site-environment-routing.md` | 现场为上海生产环境 | 约束环境判断 |
| `docs/context/domains/release-gitops.md` | 需要核对线上前端版本 | 区分源码与实际发布版本 |
| `docs/context/project/services/trade.md` | 下单和计费回调归 Trade | 判断订单与发货边界 |
| `docs/context/project/services/credit.md` | Credit 持有积分包 | 判断资源创建与查询边界 |
| `docs/context/project/services/service-gateway.md` | 查询公共入口日志 | 明确网关日志能力 |
| `frontend/AGENTS.md` | 前端局部约束 | 定位状态机与验证命令 |
| `credit/AGENTS.md` | 积分包设计真源 | 核对查询和创建语义 |

## evidence
- 上海 Service Gateway 日志显示下单及积分包查询均返回 HTTP 200。
- `trade_flow` 的 `create_resource` 于 2026-09-24 10:28:38（北京时间）完成。
- live `credit_package` 为 active，当前同用户查询返回 1000 可用积分。
- 网关与 Credit 当前均未记录历史响应体。
- `lightvela.com` 实际 release 为 `20260923235255-fc1cd61192d7-cn`，对应提交
  `fc1cd61192d729c8e293363f1d18ee7809bdee77`；该版本包含 120 秒轮询和订单代际隔离修复。
- 上海两个 Credit API Pod 当前对该用户均返回同一个 1000 积分包；排除 Pod 数据不一致。
- LLMGateway 当前存在 active subscription `credit-package:cpkg-3c1rm7bo`，周期从
  2026-09-24 10:28:38（北京时间）开始。
- CTL 当前返回该用户 Pass `pass-d2sh00xq` 为 active；账号页不会因无有效套餐提前返回。
- Credit 前端到账判断仅依赖内存中的购买前快照与 `GET /v1/credit/packages` 差集；状态不持久化，
  查询结果也不含 package_id/deal_name，页面刷新或跳转后无法按订单恢复。
- Credit `createResource` 完成后未回写 `trade_order`；现场订单仍为 `pending_pay` 且 resource_id 为空。
- 上海用户模型 key 绑定在本地 `token-admin.lightvela.com` 的 `set-auto-000007`；原 Pass 订阅余额为 0。
- 上海 Credit 配置却指向北京共享管理面 `llmgw-control.lightvela.com`，积分包订阅被创建在
  `set-auto-000125`，与用户流量面隔离。
- 上海本地已有五个地域 Plan；`credit_product` 在 2026-09-18 被改成北京共享控制面的五个 Plan ID。
- 上海共有 3 个 active 积分包，全部是 `credit_1000`。已使用固定幂等键在各用户上海本地 set
  创建同名 `credit-package:{package_id}` 订阅，并回查精确订阅额度均为 1000 积分。
- 上海 Credit 当前 internal token 调本地控制面返回 401，证明 URL、token、商品映射必须协同切换。
- 上海 Credit SOPS 与 SSM 已同步为本地 LLMGateway internal token，指纹/回读验证一致。
- 上海三个 active package 已在原用户本地 set 幂等创建精确订阅；live package 快照已备份到
  `credit_package_llmgw_backup_20260924_1317`，并事务更新 3 行本地 plan/subscription ID。
- 问题用户实例使用现有 LightVela key 对 `token.lightvela.com` 发起 1-token 最小请求，返回
  `HTTP 200` 且 `success=true`，证明用户数据面已恢复。
- 新加坡 Credit 也使用了北京共享 URL/token；其商品 Plan 已是新加坡本地 Plan，且当前没有
  active package。新加坡 Credit SOPS/SSM token 已经用户授权同步为本地 token。
- 用户授权后已直接热修上海、新加坡生产 `credit-config` 与 `credit-runtime-secrets`，并滚动重启
  API、生命周期 Worker 和用量 Worker；六个 Deployment 均成功完成 rollout。
- 上海五个商品旧映射已备份到 `credit_product_plan_backup_20260924_hotfix`，随后事务更新五行到
  上海本地域 Plan；五个商品保持 `ONLINE`。新加坡商品映射原本正确，未修改数据库。
- 热修后从两地域 Credit Pod 分别访问五个本地域 Plan，十个检查全部成功；启动日志无鉴权错误。
- 上海问题用户再次查询得到 `credit_available=999.9996`，相较初始 1000 已产生真实消耗，证明
  积分包额度已进入用户实际模型流量路径。

## risks
- 仅凭 HTTP 200 不能直接还原历史响应 JSON；需要结合线上版本、数据提交时间与查询实现判断。
- 当前 master 源码不一定等于上海线上静态资源版本。

## validation
- `cd credit && GOCACHE=/tmp/codex-go-cache go test ./... && go vet ./...`：通过。
- Release bundle contract：101 项通过；新增上海、新加坡地域管理面 URL 断言。
- 上海、新加坡 KSOPS 渲染：各 9 个资源，地域 URL 正确，Secret 未输出。
- 两份 Credit SOPS Secret 扫描：通过。
- `validate_change_impact.py --repo . --staged`：通过，命中 `release-gitops` owner review。
- `validate_documentation.py --repo . --format json`：通过，无错误和告警。
- `.agents/context/tests`：26 项中 22 项通过；4 项因仓库既有 Task Pack 缺字段和既有敏感字面量检查失败，
  失败路径均不属于本次变更。
- `git diff --check`：通过。
- 上海、新加坡生产共六个 Credit Deployment rollout：通过。
- 上海、新加坡地域 Plan 在线检查：各五个均通过。
- 上海 `credit_product` 更新：备份完成，事务更新五行，回查映射及状态正确。

## decisions
- 上海和新加坡 Credit 必须分别连接地域本地控制面，CI contract 固定域名，禁止再次回退共享北京入口。
- 先为上海 3 个存量包幂等补建本地订阅恢复模型额度；发布时再切换 token/URL，并事务更新商品及 package 快照。
- 生产环境已按用户授权先执行 Pod 热修再更新上海商品 Plan；MR 合并后由 GitOps 收敛并固化当前配置。
- 新加坡商品无需 remap；热修 URL/token 后五个 Plan 均已验证。

## scan_scope
- `frontend/src/lib/use-credit-checkout.ts`
- `frontend/next-site/credit-pack-section.tsx`
- `credit/internal/service/`
- 上海生产环境相关 frontend/GitOps 配置。

## scan_output
- 精确定位上海用户 Pass 额度耗尽、Credit 包落在北京共享控制面的问题。
- 邻接检查覆盖 Credit 商品映射、地域 Secret、LLMGateway 管理面和真实模型数据面。

## handoff
- 根因已确认，上海 3 个 active package 已补建本地订阅并修正快照，问题用户真实模型请求恢复。
  上海/新加坡生产 Pod 已热修到地域控制面，上海五个商品 Plan 已同步完成；SOPS 与 SSM 也已同步地域 token。
  仓库已修改地域 URL、CI contract 和正式文档，待 MR 合并后由 GitOps 固化线上状态。
  Go test/vet、101 项 release contract、两地域 KSOPS render、Secret 扫描和 diff check 均通过。
