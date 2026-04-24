# Tech Debt Backlog

> 来源：Story 1.3–2.5 代码审查，2026-03-19 ~ 2026-03-21
> 维护方式：新增条目追加到对应分类末尾，处理后标记 `[RESOLVED]` + Story/PR 链接

---

## Controller 层模式问题

### D-1: sandbox 运行时能力过度依赖预制镜像契约 [RESOLVED - 2026-03-21]

- **来源**: Story 2.4 sandbox 镜像排障，2026-03-21
- **文件**: `sandbox/internal/provider/tencent.go`、`sandbox/cmd/worker/main.go`、`sandbox/BACKEND.md`
- **描述**: 当前 sandbox 在腾讯云实例创建成功后，仅等待 IP 并直接探测 `:49983/health`。代码假设镜像内已预装并自启动 `envd` 和 TAT，但仓库内没有对应的基础镜像构建/bootstrapping 流程。结果是更换 `base_image` 时，只要新镜像不满足该隐式契约，实例就会在 `VerifyInstance` 阶段持续失败并被 worker 自动清理。
- **影响**: 中高 — sandbox 对镜像来源高度敏感，知识主要散落在文档和经验中，不利于后续扩展镜像、跨团队协作和问题定位
- **处理结果**: 已通过文档化方式解决。创建了 `docs/sandbox-image-contract.md`，明确了合格镜像必须满足的运行时要求（TAT、envd、`127.0.0.1:49983/health`），健康检查链路图，以及验证新镜像的推荐步骤。

### D-2: `ctl` 当前更适合做 pool/template 兼容适配，而不是直接改 sandbox 调度设计 [RESOLVED - 2026-03-21]

- **来源**: Story 2.4 联调与控制台排障，2026-03-21
- **文件**: `ctl/pkg/logic/instance/*`、`ctl/pkg/config/*`、`docs/ctl-dev-setup/README.md`
- **描述**: 当前已确认 sandbox 的 pool/template 本质上是固定的 `vpc_id + subnet_id + zone + base_image` 组合。腾讯云侧可用区与子网的可购买性会随账号和资源状态变化，导致单个 pool 可能随时间失效。虽然理论上可以改 sandbox 侧调度或 pool 设计，但当前 sandbox 并非本任务主要责任边界，且其设计约束仍在摸清阶段，贸然修改存在较高风险。
- **影响**: 中 — 继续依赖单一 `default_template_id` 时，ctl 在某个 pool 失效后会直接暴露创建失败
- **处理结果**: 已在 `ctl` 中实现多 Template Fallback 机制。新增 `candidate_template_ids` 配置项，`CreateInstance` 按顺序尝试候选 template，首个成功即返回，所有候选均失败时返回 `ErrSandboxServiceError` 并在日志中记录每个 template 的失败原因。详见 Story 2.5。

### D0: `mx-core` 框架与当前 REST API 形态不匹配 [RESOLVED - 2026-03-21]

- **来源**: Story 2.4 联调验证，2026-03-21
- **文件**: `ctl/main/api/*`、`ctl/pkg/controller/*`、`ctl/pkg/context/*`、`ctl/pkg/errcode/mxcompat.go`
- **描述**: `ctl` 过去基于 TAT 内部 `mx-core` 控制器框架，带来了 Action 风格路由、特殊请求绑定规则、字段名受限、错误模型耦合等问题。
- **处理结果**: 已完成剥离。`ctl` 现已改为标准 REST + `net/http`，旧 `POST /?Action=...` 路径和 `firewall` 示例代码已移除。
- **验证结果**: `cd /root/code/mono/ctl && go test ./...` 通过；本地回归脚本可通过 `ctl/tools/regression_local_api.sh --app-id 1001` 复跑完整实例生命周期。

### D1: authResources 在 InstanceID 为空时返回通配符授权 [RESOLVED - 2026-03-21]

- **来源**: Review R1 — Blind Hunter
- **文件**: `ctl/pkg/controller/instance/destroyinstance/handler.go:45-48`（所有 instance controller 共用模式）
- **描述**: 旧 controller 体系下，`authResources()` 在 `InstanceID` 为空时返回 `AuthAllResources()`（通配符），存在授权窗口风险。
- **处理结果**: 随 `mx-core` / controller 体系整体移除而一并消失。当前 `ctl` 已改为标准 REST handler，不再存在该类 controller 授权实现。

### D2: Controller response 赋值模式易出错 [RESOLVED - 2026-03-21]

- **来源**: Review R1 — Blind Hunter
- **文件**: `ctl/pkg/controller/instance/*/handler.go`（所有 instance controller）
- **描述**: 旧 controller 体系中每个分支都需要 `c.response = ...; c.SetResponse(c.response)` 两步，遗漏会返回过期数据。
- **处理结果**: 随 `mx-core` / controller 体系整体移除而消失。当前 REST handler 直接写 JSON 响应，不再有该模式。

---

## 数据模型 / DAO 层问题（Story 1.2 遗留）

### D3: `uk_sandbox_id` 唯一索引在 `SandboxId=""` 时阻塞并发创建 [RESOLVED - 2026-03-20]

- **来源**: Review R2 — Edge Case Hunter (E1)
- **文件**: `ctl/migrations/000002_create_instances.up.sql` + `ctl/pkg/model/instance/entity.go:34`
- **描述**: `Entity.SandboxId` 初始为空字符串，`Create` 时插入空值。`uk_sandbox_id` 唯一索引导致并发创建可能因空字符串冲突失败。
- **处理结果**: 已通过两层修复解决：
  1. migration 改为对生成列 `sandbox_id_key = NULLIF(sandbox_id, '')` 建唯一索引
  2. 创建阶段先写入 `pending-<instance_id>` 占位 sandbox_id
- **验证结果**: 集成测试 `ctl/test/logic/instance/tech_debt_integration_test.go` 已覆盖并发创建场景。

### D4: `AllocQuota` / `FreeQuota` 未校验 `cnt <= 0` [RESOLVED - 2026-03-20]

- **来源**: Review R2 — Edge Case Hunter (E2)
- **文件**: `ctl/pkg/model/userresourcequota/dao.go` — `AllocQuota` / `FreeQuota`
- **描述**: `cnt` 参数无下界校验。`cnt=0` 导致空操作但返回成功；`cnt<0` 导致配额反向操作。
- **处理结果**: `AllocQuota` / `FreeQuota` 已增加 `cnt <= 0` 参数校验并返回错误。

---

## 实例生命周期问题（Story 1.4 遗留）

### D5: `CreateInstance` 中 `UpdateSandboxAndStatus` 失败后实例卡在 Creating [RESOLVED - 2026-03-20]

- **来源**: Review R2 — Edge Case Hunter (E3)
- **文件**: `ctl/pkg/logic/instance/logic.go:126-136`
- **描述**: 沙箱创建成功但 `UpdateSandboxAndStatus` 失败时，实例可能卡在 `Creating` 且配额泄漏。
- **处理结果**: 已改为失败即回滚：删除已创建沙箱、回写失败状态、释放配额，并向上返回错误。

### D6: `rollbackQuota` 忽略 `FreeQuota` 的 bool 返回值 [RESOLVED - 2026-03-20]

- **来源**: Review R2 — Edge Case Hunter (E5)
- **文件**: `ctl/pkg/logic/instance/logic.go:330-334`
- **描述**: `rollbackQuota` 只检查 `err != nil`，不检查 `freed` 布尔值。
- **处理结果**: 已补全 `freed` 检查；`freed=false` 且无 error 时会记录 warning，避免静默失败。

---

## 通用问题

### D7: `ListByUserID` count-then-fetch 无事务 [RESOLVED - 2026-03-20]

- **来源**: Review R2 — Edge Case Hunter (E7)
- **文件**: `ctl/pkg/model/instance/dao.go:84-102`
- **描述**: `Count` 和 `Find` 之间无事务保护。
- **处理结果**: `ListByUserID` 已将 `Count + Find` 包裹进同一事务快照中。
- **补充**: 2026-03-21 又额外修复了一处独立问题：软删除实例不应计入 `total`。

### D8: `NewErrorResponse` 吞掉非 `*errcode.Error` 的错误上下文 [RESOLVED - 2026-03-21]

- **来源**: Review R2 — Blind Hunter (R9)
- **文件**: `ctl/pkg/controller/instance/common.go:27-39`
- **描述**: 旧 controller 体系下，`NewErrorResponse` 对非 `*errcode.Error` 会丢失原始错误上下文。
- **处理结果**: 随 controller 体系移除而消失。当前 REST handler 直接在服务内返回/记录错误，不再依赖该 helper。

---

## 测试基础设施问题

### D9: Logic 层单元测试使用 SQLite 而非 MySQL Testcontainers [RESOLVED - 2026-03-20]

- **来源**: Story 2.1 Review 后人工发现，2026-03-19
- **文件**: `ctl/pkg/logic/instance/logic_test.go`（全部 20+ 个测试函数）
- **描述**: 生产数据库为 MySQL，但部分 logic/DAO 测试仍跑在 SQLite 上。
- **处理结果**: 按 Story 2.3 允许的方案 B 处理：保留轻量 SQLite 测试，同时在 `ctl/test/logic/instance`、`ctl/test/model/instance` 新增 MySQL Testcontainers 集成测试，覆盖关键并发与迁移场景。
- **补充**: 这不是"所有 SQLite 测试都消失"式重构，而是"关键正确性由 MySQL 集成测试兜底"。

---

## Story 2.2 审查发现项（2026-03-20）

### D10: authResources 通配符授权 — Story 2.2 新增 controller [RESOLVED - 2026-03-21]

- **来源**: Story 2.2 Code Review — Blind Hunter + Edge Case Hunter, 2026-03-20
- **文件**: `ctl/pkg/controller/instance/pauseinstance/handler.go`、`resumeinstance/handler.go`、`settimeout/handler.go`
- **描述**: 与 D1 同源问题，发生在新增 instance controller 中。
- **处理结果**: 随 controller 体系移除而消失。

### D11: time.Now() 时钟偏差 [RESOLVED - 2026-03-20]

- **来源**: Story 2.2 Code Review — Edge Case Hunter + Blind Hunter, 2026-03-20
- **文件**: `ctl/pkg/logic/instance/logic.go` — PauseInstance/ResumeInstance/SetInstanceTimeout
- **描述**: `ResumeInstance` / `SetInstanceTimeout` 里 `timeout_at` 计算时机偏后。
- **处理结果**: `time.Now().Add(...)` 已提前到沙箱 RPC 之前计算，降低延迟偏差。

---

## 异步化改造（2026-03-21 梳理）

> 来源：Story 3.2 上下文分析，系统性梳理 `logic.go` 中所有同步阻塞沙箱 HTTP 调用。
> 现有异步框架：`pkg/tasks/` + `pkg/taskflow/` + `main/service/`（MQ 消费者 Worker），支持锁 + 重试 + 指标。

### D12: CreateInstance 全同步阻塞 — 最坏情况 30s+ 占住 HTTP goroutine [RESOLVED - 2026-03-22]

- **来源**: logic.go CreateInstance 方法分析
- **文件**: `ctl/pkg/logic/instance/logic.go` L97-236
- **描述**: 当前 `CreateInstance` 在 HTTP 请求中同步完成全部流程：配额分配 → DB 创建记录 → `createSandboxWithFallback`（最多 N 个模板 × 3次重试 × 指数退避）→ 唯一性校验 → 更新状态。其中沙箱创建是主要耗时来源（NFR2 要求 P95 ≤ 30s），fallback 场景可能更长。
- **影响**: 高 — HTTP 连接被长时间占用，上层 Coding Plan 平台侧也被阻塞等待；并发创建时 goroutine 积压风险
- **现有条件**: 已有 `Creating` 中间状态、已有 `pending-{instance_id}` 占位 sandbox_id，天然适合拆分
- **建议改造方案**:
  1. API 同步部分（快速返回）：参数校验 → 配额分配 → 创建 DB 记录（status=Creating）→ 投递 MQ 消息 → 返回 `201 {status: "Creating"}`
  2. 异步 Worker 部分（MQ 消费者）：锁 → 调用沙箱创建（含 fallback + 重试）→ 更新 DB（Running/Failed）→ 释放锁
  3. 失败自动重试：复用 `pkg/tasks/service/base.go` 的 `MaxExecuteCount` + 指数退避机制
  4. 用户通过 `GET /v1/instances/{id}` 轮询状态，或后续提供 webhook 回调
- **优先级**: P0 — 直接影响用户体验和系统稳定性
- **处理结果**:
  1. 新增独立 `tasks` 表（`ctl/migrations/000006_create_async_tasks.*.sql`），不复用 `operation_histories`
  2. `CreateInstance` 改为：分配配额 → 写 `instances(status=Creating)` → 写 `tasks` → Redis Stream 快速投递
  3. `main/service` 已注册 `CreateInstance` TaskProcessor，实际沙箱创建在 worker 中执行
  4. `main/bypass` 新增 `checkTasks`，按 `tasks` 表中的 `execute_interval` 补偿重投未完成任务
  5. 对外 `operation_histories` 继续只承载用户可见的操作记录，不再与内部 task 队列混用

### D13: DestroyInstance 同步删除沙箱 — 失败后实例卡 Failed 需手动重试 [RESOLVED - 2026-03-22]

- **来源**: logic.go DestroyInstance 方法分析
- **文件**: `ctl/pkg/logic/instance/logic.go` L364-433
- **描述**: `DestroyInstance` 同步调用 `DeleteSandbox` HTTP API，失败后将实例标为 Failed。用户必须再次手动调用销毁。同步调用还意味着沙箱服务超时（30s）会直接阻塞 HTTP 响应。
- **影响**: 中高 — 沙箱服务不稳定时，销毁操作积压；失败后缺乏自动恢复
- **现有条件**: 已有 `Deleting` 中间状态，天然适合异步
- **建议改造方案**:
  1. API 同步部分：状态校验 → 转 Deleting → 投递 MQ → 返回 `200 {status: "Deleting"}`
  2. 异步 Worker：锁 → 调用沙箱删除 → 释放配额 → 软删除记录（status=Deleted）
  3. 失败自动重试：沙箱删除幂等（404 视为成功），适合多次重试
- **优先级**: P1 — 影响资源释放可靠性
- **处理结果**:
  1. `DestroyInstance` 改为：状态转 `Deleting` → 写 `tasks` → Redis Stream 投递 → 立即返回
  2. Worker 中执行沙箱删除与最终配额释放/软删除；`sandbox 404` 继续视为成功
  3. 若 worker 执行失败，任务保持未完成态，由 bypass `checkTasks` 后续补偿重投
  4. 测试构造器 `NewLogicForTest` 保留内联执行路径，避免既有同步语义测试全部失效；生产 `NewLogic()` 仍然走真实异步链路

### D14: PauseInstance / ResumeInstance 同步调用沙箱 — 可考虑异步化

- **来源**: logic.go PauseInstance / ResumeInstance 方法分析
- **文件**: `ctl/pkg/logic/instance/logic.go` L435-613
- **描述**: Pause 和 Resume 均同步调用沙箱 HTTP API（单次调用，无 fallback）。沙箱 API 通常 1-5s 响应，比创建/销毁快得多，但在沙箱服务抖动时仍会阻塞 HTTP 连接。
- **影响**: 中 — 正常情况可接受，但缺乏中间状态（无 `Pausing`/`Resuming`），异步化需先扩展状态机
- **前置条件**: 需引入 `Pausing` 和 `Resuming` 中间状态（DB 迁移 + 状态机扩展）
- **建议改造方案**:
  1. 新增中间状态：`Pausing`、`Resuming`
  2. API 快速转状态 + 投递 MQ
  3. Worker 执行沙箱调用 + 更新最终状态
- **优先级**: P2 — 优先做 Create/Destroy，Pause/Resume 在沙箱服务稳定后可延后

### 整体异步化改造依赖关系

```
D12 (CreateInstance 异步化) ← 最高优先，收益最大
  ↓
D13 (DestroyInstance 异步化) ← 次高优先，提升资源释放可靠性
  ↓
D14 (Pause/Resume 异步化) ← 可延后，需先扩展状态机
```

**共同前置工作**:
- 确认 `main/service/` MQ 消费者在当前部署中是否已启用（Redis MQ 配置）
- 梳理 `pkg/tasks/service/processor/factory.go` 注册新 TaskProcessor 的方式
- 确认 MQ 消息格式（`pkg/tasks/common/common.go` TaskMessage）是否满足需求

---

## Sandbox 服务代码缺陷（2026-03-21 运维排查发现）

> 来源：排查 sandbox 集群孤儿 CVM 实例时发现，对比数据库记录与腾讯云 CVM 实例列表

### D15: CVM 创建与数据库写入非原子操作，导致孤儿实例

- **来源**: sandbox 集群运维排查，2026-03-21
- **文件**: `sandbox/cmd/worker/main.go`（refill 流程）、`sandbox/internal/service/pool.go`
- **描述**: Worker refill 流程中，先通过腾讯云 API 创建 CVM，再将 cloud_id/address 写回数据库。如果 CVM 创建成功但写 DB 失败（网络抖动、Worker 重启等），CVM 就变成"孤儿"——在腾讯云持续运行计费，但 sandbox 数据库无记录，永远不会被分配或清理。
- **实际影响**: 高 — 2026-03-21 排查发现 **26 台孤儿 CVM** 在空转计费，分布在 pool-bj8（8台）、pool-c2（8台）、pool-c4（8台）、pool-c5（1台）等
- **建议处理方式**:
  1. **短期**: 补充孤儿检测 Worker，定期对比腾讯云 CVM 列表与数据库记录，发现孤儿后告警或自动清理
  2. **中期**: 将 CVM 创建改为"先写 DB 占位（CREATING + cloud_id），再确认 CVM 状态"的模式，确保 DB 始终有记录
  3. **长期**: 引入事务日志或幂等补偿机制，确保创建失败时能自动回滚腾讯云资源

### D16: 缺少删除 Pool / Instance 的 API

- **来源**: sandbox 集群运维排查，2026-03-21
- **文件**: `sandbox/internal/api/router.go`
- **描述**: sandbox API 只提供 `POST /pools`（创建）和 `GET /pools`（列出），没有 `DELETE /pools/{id}` 和 `DELETE /instances/{id}` 接口。清理错误创建的 Pool 或失效实例只能直接操作数据库，风险高且不利于自动化运维。
- **影响**: 中 — 运维操作依赖直接 SQL，容易出错，且无法通过 API 自动化清理
- **建议处理方式**:
  1. 新增 `DELETE /pools/{id}`：先销毁所有关联 CVM，再清理 DB 记录
  2. 新增 `DELETE /instances/{id}`：先销毁对应 CVM，再删除 DB 记录
  3. 增加安全检查：不允许删除有 ALLOCATED 实例的 Pool

### D17: 缺少孤儿 CVM 对账机制

- **来源**: sandbox 集群运维排查，2026-03-21
- **文件**: `sandbox/cmd/worker/main.go`
- **描述**: Worker 只有 Refill（补货）、Reset（重装）、Cleanup（清理 FAILED）、WaterLevel（水位检查）四类任务，没有"对比腾讯云 CVM 列表与数据库记录"的对账任务。孤儿 CVM 会一直空转计费直到人工发现。
- **影响**: 高 — 直接造成资金浪费，且无法自动发现
- **建议处理方式**:
  1. 新增 `ReconcileOrphans` Worker 任务，定期调用 `DescribeInstances` 对比数据库
  2. 发现孤儿后：记录日志 + 告警，可选自动销毁（需确认安全策略）
  3. CVM 实例命名规则 `pool-{pool_id}-{timestamp}` 可作为归属判断依据

### D18: 缺少 Pool 镜像更换 API，运维只能直接操作数据库

- **来源**: sandbox 集群运维操作，2026-03-21
- **文件**: `sandbox/internal/api/router.go`、`sandbox/internal/service/pool.go`
- **描述**: sandbox 没有提供更换 Pool 镜像的 API。当前更换镜像流程需要：① 直接 SQL 修改 `pools.base_image` ② 直接 SQL 将 CLEAN 实例改为 DRY ③ 依赖 Worker 自动重装。整个流程需要 DBA 权限操作数据库，无法通过 API 自动化，不利于运维安全和审计。
- **影响**: 中高 — 镜像更换是高频运维操作（安全补丁、环境更新等），每次都人工 SQL 操作风险高
- **建议处理方式**:
  1. 新增 `PATCH /pools/{id}` 或 `PUT /pools/{id}/image` 接口，支持更新 `base_image`
  2. 接口内部自动将对应 Pool 的 CLEAN 实例状态改为 DRY，触发 Worker 重装
  3. ALLOCATED 实例不受影响，释放后 Worker 自动用新镜像处理
  4. 返回受影响实例数量，便于运维确认
  5. 可选：支持灰度更换（指定百分比或数量的实例先更换，验证后再全量）

### D19: pool-c0/c1 可用区 (ap-beijing-4/5) 持续创建失败

- **来源**: sandbox 集群运维排查，2026-03-21
- **文件**: `sandbox/cmd/worker/main.go`（refill 流程）
- **描述**: pool-c0 (`ap-beijing-4`) 和 pool-c1 (`ap-beijing-5`) 的 CVM 实例持续创建失败（全部 FAILED，cloud_id 为空），而同一 VPC 下的 pool-c2~c5（`ap-beijing-6/7/8`）工作正常。原因可能是这两个可用区对当前账号/机型不可购买。Worker 会不断尝试 refill 到 `desired_capacity`（24）但持续失败，产生大量 FAILED 记录。
- **影响**: 中 — Worker 空转消耗 API 配额，FAILED 记录不断堆积
- **建议处理方式**:
  1. **短期**: 将 pool-c0/c1 的 `desired_capacity` 设为 0 或删除这两个 Pool，停止无效重试
  2. **中期**: Worker refill 增加连续失败计数器，达到阈值后自动暂停该 Pool 的 refill 并告警
  3. **长期**: 创建 CVM 前调用 `DescribeZoneInstanceConfigInfos` 校验可用区可购买性，不可购买时跳过并告警
