## goal
让 CTL 单用户网关额度重置在 Pass 基础订阅与独立积分包并存时正确选择基础订阅，且不修改叠加额度。

## non_goals
- 不改 new-api 的按用户加 Plan 重置契约，不实现严格的单订阅原子重置。
- 不发布服务，不执行生产非 dry-run 重置，不扩大批量脚本目标范围。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户会话 2026-09-29："对所有uid 解堵，但是不需要严格限制 newapi 就不用改了？"，随后 "搞起来"；外部需求编号 unknown。

## interface_refs / data_structure_refs
- CTL `POST /internal/users/{user_id}/gateway/quota/reset`；VelaGW `GET /api/internal/users/{user_id}/subscriptions/active` 提供订阅 ID 对应的外部 Plan ID；new-api `POST /api/subscription/admin/users/{id}/subscriptions/reset` 仍按用户加 Plan 重置。
- 有效的 Pass 基础订阅可为 `package:` 或无名称旧订阅；`credit-package:`、`free-credit:` 是叠加额度。执行前要求唯一基础订阅、正的下一次重置时间、目标 upstream Plan 下唯一有效订阅，以及 ready Set 映射。

## history_context
- current_design_refs: `docs/engineering/domains/agent-gateway-runtime.md` 的人工额度重置约束。
- relevant_evolution: VelaGW 的 `ApplySubscription` 对非唯一叠加订阅也更新 `UserBinding.LastPlanID`，因此该字段不能代表 Pass 基础订阅。
- superseded_refs: none。

## acceptance
- 基础订阅与不同 Plan 的积分包及赠送额度共存时，dry-run 和执行都只选择基础订阅。
- 同 Plan 叠加订阅、多个基础订阅、仅有积分包或未知订阅名在发出真实重置请求前失败。
- CTL adapter 聚焦测试及服务测试通过；不将源码测试误报为生产部署。

## affected_paths
- `ctl/pkg/adapter/llmgateway/quota_reset.go`、`ctl/pkg/adapter/llmgateway/quota_reset_test.go`、`docs/engineering/domains/agent-gateway-runtime.md`、本文。

## required_context
- `control-plane-ops`、`service-ctl`、`agent-gateway-runtime`、`subscription-entitlements`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md` | 生产与变更边界 | 本轮不发布或写生产额度 |
| `ctl/AGENTS.md` | 服务约束 | CTL 测试门禁 |
| `docs/context/project/services/ctl.md` | 路由必读 | CTL 责任边界 |
| `docs/context/domains/agent-gateway-runtime.md` | 路由必读 | 网关运行时归属 |
| `docs/context/domains/subscription-entitlements.md` | 路由必读 | 权益与额度边界 |
| `docs/context/project/adjacency/README.md` | 邻接索引 | 当前没有适用的邻接卡，直接核对 adapter 邻近测试 |
| `docs/engineering/domains/agent-gateway-runtime.md` | 正式设计 | 同步持久不变量 |

## evidence
- 上海生产只读查询：目标用户同时有 NewAPI 订阅 163（入门型，Plan 13，月度）和 1071（`credit-package:`，Plan 14，never reset）；VelaGW 的活跃订阅投影可由订阅 ID 得到基础订阅外部 Plan ID。此前 CTL dry-run 因要求全用户仅一条 active 订阅而返回 500，未执行额度写入。
- 源码：`velagw/internal/gateway/service.go` 的 `ApplySubscription` 无论 `IsUnique` 与否都会更新 `LastPlanID`；`new-api/model/subscription.go` 的重置事务会更新同用户同 Plan 所有有效订阅。

## risks
- CTL 预检与 new-api 事务之间仍有并发窗口；同 Plan 新订阅在预检后出现时可能被一同重置。要求严格保证时改为 new-api 精确订阅 ID 的事务更新。
- 无法唯一确认基础订阅或反向映射时拒绝重置，保留人工排查路径；不得回退到 `last_plan_id`。

## validation
- `/data/go/bin/go test ./pkg/adapter/llmgateway -count=1`、`/data/go/bin/go test ./...`、`/data/go/bin/go vet ./pkg/adapter/llmgateway` 与批量脚本的 6 个 Python 单元测试通过。
- 文档检查无错误、断链或警告；显式变更集的 change-impact 检查通过，提示高风险边界需 `wisp/mono2-maintainers` 审阅。

## decisions
- 仅修改 CTL adapter：复用 VelaGW 现有活跃订阅投影解析基础订阅的外部 Plan ID，保留现有 new-api 用户加 Plan 写接口。
- 同 Plan 下多个有效订阅一律拒绝，因为 new-api 现接口不能指定单条订阅；此类用户不属于本轮“可安全解堵”范围。

## scan_scope
- `ctl/pkg/adapter/llmgateway/`、`velagw/internal/gateway/`、`new-api/model/subscription.go`、`credit/internal/service/`。

## scan_output
- 有界源码检索与上海生产只读查询结果见本会话；没有复制原始凭据或全量响应。

## handoff
- CTL 代码、聚焦测试和正式设计已更新；尚未提交或发布，生产 CTL 仍运行旧逻辑。发布后须先对目标 UID 做 dry-run 并核对目标订阅 ID、Plan ID 与额度，再决定是否进行真实重置。

## checkpoint
- stage: 本地代码和门禁完成，等待 owner 审阅及另行授权的发布。
- verified: 基础套餐与不同 Plan 的叠加额度共存时选中基础套餐；同 Plan 共享、多个基础套餐和未知类型在写前拒绝；全量 CTL 测试通过。
- unverified: 新代码尚未在上海或新加坡运行，真实目标 UID 的发布后 dry-run 尚未执行。
- discard: 用绑定 `last_plan_id` 推断基础套餐的旧策略。
- restore: 从本 Task Pack、`quota_reset.go` 和相邻测试恢复。
- next_action: owner 审阅代码与并发窗口；获发布授权后再部署并做单用户 dry-run。
