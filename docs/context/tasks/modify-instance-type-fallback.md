## goal

让同 SP 升配在原 CVM 上按目标逻辑规格动态选择腾讯云允许且在售的机型；某个候选因单机型库存、配额或兼容性被拒绝时，持久化进度并尝试下一候选，而不是永久绑定 `SA5.LARGE8`。

## non_goals

- 不开放跨 SP、降配、跨地域或跨可用区变配。
- 不删除 `SANDBOX_POOL_INSTANCE_TYPE` / `TENCENT_INSTANCE_TYPE`；它们继续作为创建资源和旧环境兼容默认值。
- 不在本任务中直接修改生产配置、数据库、运行中账本或发布生产。
- 不承诺账号总配额耗尽时一定存在可成功候选。

## requirement_ids / requirement_refs / requirement_excerpt

- TAPD `1010132091137784162`：同 SP 升配保持原地修改、磁盘只增不减和前滚幂等。
- 2026-09-17 线上证据：`SA2.MEDIUM4` 原实例升到逻辑 `4C8G80G` 时，固定目标 `SA5.LARGE8` 返回 `LimitExceeded.InstanceQuota`；同实例 `DescribeInstancesModification` 同时返回多个 `4C8G` 且 `SELL` 的候选。
- 用户要求：升配不依赖预创建库存；一个机型不可用时尝试其他可变配机型，保留旧环境变量但不作为升配唯一目标。

## interface_refs / data_structure_refs

- `sandbox/internal/provider/provider.go`：`InstanceSpecResizer`。
- `sandbox/internal/provider/tencent_modify.go`：`DescribeInstances` / `ResetInstancesType`。
- `sandbox/internal/core/types.go`：`ModifyOperation` 单向续跑账本。
- `sandbox/internal/store/mysql_modify.go`：`modify_operations` 持久化。
- `sandbox/internal/service/modify.go`：停机、改计算规格、扩盘、开机、重绑顺序。
- `ctl/pkg/instance/async.go`：目标逻辑规格到 Sandbox Pool/SKU 的解析；Pool 不代表升配时消费预创建库存。

必须保持：同一个 `operation_id` 幂等；计算规格成功后不得回退；磁盘扩容不得重复；进程重启后继续候选进度；CloudID/IP 不变。

## history_context

- `current_design_refs`：`docs/engineering/domains/subscription-entitlements.md`、`docs/context/project/services/ctl.md`、`sandbox/internal/service/modify.go`。
- `relevant_evolution`：提交 `67d90ecf73` 把 sgprod `spec-4c8g80g` 映射到逻辑 4C8G Pool；提交 `ac1c9a60c6` 增加同 SP 升配。
- `superseded_refs`：把 `Pool.InstanceType=SA5.LARGE8` 当作升配唯一云机型的旧实现。

## acceptance

- 从腾讯云可变配列表中只选择与目标逻辑 CPU/内存一致且 `SELL` 的候选。
- 优先保留既有目标机型；候选被明确拒绝时推进并持久化到下一候选。
- 网络、限频和实例忙等暂态错误不跳过当前候选。
- 云调用成功但进程在落库前中断时，下一轮通过真实实例规格回读收敛。
- 老 `modify_operations` 行无需人工迁移数据即可继续运行。
- 现有环境变量和固定目标行为保留为 provider 不支持候选发现时的兼容路径。

## affected_paths

- `sandbox/internal/provider/`
- `sandbox/internal/service/modify.go`
- `sandbox/internal/core/types.go`
- `sandbox/internal/store/`
- `sandbox/migrations/`
- 对应测试与 Sandbox 设计文档

## required_context

- `subscription-entitlements`
- `site-environment-routing`
- `commerce-trade-ops`
- `control-plane-ops`

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@9185fcf0f` | 仓库安全与 Task Pack 门禁 | 限定不直接变更生产、要求真实验证 |
| `ctl/AGENTS.md@9185fcf0f` | CTL 编排边界 | 保持实例归属和状态机权威 |
| `sandbox/AGENTS.md@9185fcf0f` | Sandbox 状态机与发布边界 | 保持云操作只由 worker 推进 |
| `docs/context/domains/subscription-entitlements.md@9185fcf0f` | Pass/支付/权益边界 | 不改变支付和套餐状态机 |
| `docs/context/domains/site-environment-routing.md@9185fcf0f` | 国内/国际环境隔离 | 不从单区域推断另一地区 |
| `docs/context/project/services/trade.md@9185fcf0f` | Trade 与计费边界 | 本轮不修改计费协议 |
| `docs/context/project/services/ctl.md@9185fcf0f` | CTL 服务边界 | 目标规格继续由 CTL 权威解析 |

## evidence

- 2026-09-17 新加坡生产只读查询：实例 `SA2.MEDIUM4`，目标 `SA5.LARGE8` 在可变配列表但执行被 `LimitExceeded.InstanceQuota` 拒绝。
- 同一实例精确 `4C8G` 候选包含 `SA2/BF1/SA5/SA4/S8/SA9.LARGE8`（`SELL`），`S5/S9e.LARGE8`（`SOLD_OUT`）。
- 基线：`GOWORK=off go test ./internal/provider ./internal/service ./internal/store` 通过。
- CTL 聚焦基线中 `pkg/pass/worker` 通过；`pkg/instance` 因本机无 rootless Docker 的既有 testcontainers 前置失败，非本任务代码失败。

## risks

- 错误分类过宽会在云侧暂态错误时错误切换机型；只允许明确的候选拒绝错误推进。
- 候选全部失败时实例仍可能停机；本任务至少避免单一机型永久重试，并保留后续恢复策略扩展点。
- Pool 的 `InstanceType` 继续是新建容量默认值，而原地升配后的已分配实例可能属于同逻辑规格的其他机型族；不得把该字段继续当作现存 CVM 的绝对事实。
- 腾讯云候选结果会随库存与账号状态变化；候选计划必须在单次 operation 内冻结并持久化。

## validation

- TDD 覆盖候选筛选、顺序、候选拒绝推进、暂态错误不推进、回读幂等、旧账本兼容。
- `cd sandbox && GOWORK=off go test ./...`
- `cd sandbox && GOWORK=off go vet ./...`
- `git diff --check`
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`（提交前）。

## decisions

- 动态候选在 Sandbox provider/service 内完成；Trade、前端和计费协议不变。
- `Pool.InstanceType` 作为期望逻辑规格的首选/创建默认，不再作为升配唯一候选。
- 候选必须与首选目标机型的 CPU/内存完全一致，避免套餐资源漂移。
- 不删除旧环境变量，兼容不支持候选发现的 provider 和旧环境。

## scan_scope

- `sandbox/internal/{provider,service,store,core}`
- `sandbox/migrations`
- `ctl/pkg/instance`

## scan_output

- 有界源码检索和线上只读 API 摘要记录在本 Task Pack `evidence`。

## handoff

- 状态：已完成候选发现、错误分类、持久化游标、真实规格回读收敛和内部 API 可观测字段的本地实现；尚未提交、推送、创建 MR 或发布。
- 已验证 RED：新增测试最初因缺少 `ResolveInstanceTypeCandidates`、候选账本字段和 resize plan store 接口而失败。
- 已验证 GREEN：`GOWORK=off go test ./...`、`GOWORK=off go vet ./...`、provider/service/store race 测试通过；MySQL resize plan 使用 sqlmock 验证 JSON 往返。
- 文档门禁：change-impact 与全仓文档校验通过；正式设计已更新 `docs/engineering/domains/agent-gateway-runtime.md`。
- 代码审查：初审发现 family-change 错误码不含 `InstanceType` 的分类缺口；已按 Tencent CVM SDK `ResetInstancesType` 错误列表改为显式 allowlist、补 provider/service 回归，复审无 Critical/Important，结论 Ready to merge。
- 下一步：获得 Git 操作授权后再 commit、push、创建 MR；发布和在途订单恢复仍需单独授权及环境门禁。
- 阻塞：无；生产修复和旧订单恢复需要代码验证完成后的另行发布授权。
