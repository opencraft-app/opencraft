# Code Review: 异步化改造（D12 / D13）

> **审查范围**: `git diff HEAD -- ctl/`（+171 / -164 行，9 个文件）
> **审查模式**: full（spec = tech-debt-backlog D12/D13）
> **审查时间**: 2026-03-22

---

## 审查方法

| Layer | 职责 |
|---|---|
| Blind Hunter | 仅看 diff，不看 spec/项目上下文 |
| Edge Case Hunter | diff + 项目完整源码 |
| Acceptance Auditor | diff + D12/D13 spec 要求 |

---

## 发现项

### F1 `[patch]` — [truncateTaskMessage](file:///root/code/mono/ctl/pkg/tasks/service/processor/instance_task.go#231-241) 重复定义

- **来源**: blind
- **位置**: [async.go:54-63](file:///root/code/mono/ctl/pkg/logic/instance/async.go#L54-L63) 与 [instance_task.go:231-240](file:///root/code/mono/ctl/pkg/tasks/service/processor/instance_task.go#L231-L240)
- **描述**: 两个包各有一份完全相同的 [truncateTaskMessage(err error) string](file:///root/code/mono/ctl/pkg/tasks/service/processor/instance_task.go#231-241)。虽然不同包不会编译冲突，但属于不必要的代码重复，日后修改一处时易遗漏另一处。
- **建议**: 提取到公共位置(例如 `pkg/model/task` 或 `pkg/tasks/common`)，或让 [processor](file:///root/code/mono/ctl/pkg/tasks/service/processor/processor.go#22-26) 调用 `instancelogic` 中已有的版本。

---

### F2 `[patch]` — `async.go:102` taskID 生成复用 [generateInstanceID()](file:///root/code/mono/ctl/pkg/logic/instance/logic.go#639-642)

- **来源**: blind + edge
- **位置**: [async.go:102](file:///root/code/mono/ctl/pkg/logic/instance/async.go#L102)
- **描述**: `taskID := "task-" + l.generateInstanceID()` 实际会产生 `task-ins-<uuid>` 格式的 ID。[generateInstanceID()](file:///root/code/mono/ctl/pkg/logic/instance/logic.go#639-642) 的语义是生成 instance ID（前缀 `ins-`），被复用于 task ID 会造成 ID 规范混乱。
- **建议**: 改为直接 `"task-" + uuid.NewString()`，或新增独立的 `generateTaskID()` 方法。

---

### F3 `[patch]` — [CreateInstance](file:///root/code/mono/ctl/pkg/logic/instance/logic.go#108-172) 失败路径：[enqueueCreateInstanceTask](file:///root/code/mono/ctl/pkg/logic/instance/async.go#153-168) 失败时只 `UpdateStatus → Failed` 但不 revert `Deleting` 状态

- **来源**: edge + auditor
- **位置**: [logic.go:151-161](file:///root/code/mono/ctl/pkg/logic/instance/logic.go#L151-L161)
- **描述**: [enqueueCreateInstanceTask](file:///root/code/mono/ctl/pkg/logic/instance/async.go#153-168) 失败的非 inline 路径中：
  ```go
  if updateErr := l.instanceDao.UpdateStatus(ctx, entity.Id, modelinstance.InstanceStatusFailed); ...
  ```
  直接标记 Failed → 然后 [rollbackQuota](file:///root/code/mono/ctl/pkg/logic/instance/logic.go#623-638)。但如果 DB 插入 tasks 记录已成功、仅 MQ Send 失败，此时 `tasks` 表中已存在一条 `FAILED` 状态任务记录，配额也被释放。后续 bypass `checkTasks` 可能仍会捞到残留任务记录并尝试执行，此时 instance 已 Failed + 配额已释放，导致行为不一致。
- **建议**: 需确认 [enqueueTask](file:///root/code/mono/ctl/pkg/logic/instance/async.go#89-140) 内部在 Send 失败时已将 task 标记为 `FAILED`（当前代码 L131-134 确实做了），因此 bypass 不会重投。**当前实现安全，但建议在 [enqueueTask](file:///root/code/mono/ctl/pkg/logic/instance/async.go#89-140) 内 MQ 发送失败处增加注释说明**，说明为何将 task 设为 FAILED 而不是留待补偿。

---

### F4 `[patch]` — [DestroyInstance](file:///root/code/mono/ctl/pkg/logic/instance/logic.go#49-50) 操作记录的 [completeOperation](file:///root/code/mono/ctl/pkg/logic/instance/logic.go#768-796) 在多个路径中被遗漏

- **来源**: auditor
- **位置**: [logic.go:299-358](file:///root/code/mono/ctl/pkg/logic/instance/logic.go#L299-L358)
- **描述**: 对比 old CreateInstance 使用 `defer func() {...}()` 统一 completeOperation，新的 [DestroyInstance](file:///root/code/mono/ctl/pkg/logic/instance/logic.go#49-50) 在成功路径（入队成功、非 inline 模式）**没有调用 [completeOperation](file:///root/code/mono/ctl/pkg/logic/instance/logic.go#768-796)**。操作记录将永远停留在 `CREATED` 状态，直到 worker 中的 [markSuccess](file:///root/code/mono/ctl/pkg/tasks/service/processor/instance_task.go#149-161) 调用 [CompleteAsyncOperation](file:///root/code/mono/ctl/pkg/logic/instance/async.go#81-84)。
  - ✅ 异步成功路径：由 worker [markSuccess](file:///root/code/mono/ctl/pkg/tasks/service/processor/instance_task.go#149-161) → [CompleteAsyncOperation](file:///root/code/mono/ctl/pkg/logic/instance/async.go#81-84) 补全 — **OK**
  - ✅ 异步失败路径（入队失败）：L347 `l.completeOperation(ctx, operationID, err)` — **OK**
  - ✅ 状态非法路径：L332 `l.completeOperation(ctx, operationID, errcode.ErrInstanceStatusInvalid)` — **OK**
  
  **实际结论**: 成功异步入队时 operation 保持 `CREATED` 状态是合理设计（worker 执行后更新），无实际问题。但建议在 `operationID` 创建后加注释说明生命周期管理方式。

---

### F5 `[defer]` — [ExecuteCreateInstanceTask](file:///root/code/mono/ctl/pkg/logic/instance/async.go#65-68) / [ExecuteDestroyInstanceTask](file:///root/code/mono/ctl/pkg/logic/instance/async.go#69-72) 每次创建全新 [NewLogic()](file:///root/code/mono/ctl/pkg/logic/instance/logic.go#71-89)

- **来源**: edge
- **位置**: [async.go:65-71](file:///root/code/mono/ctl/pkg/logic/instance/async.go#L65-L71)
- **描述**: Worker 执行异步任务时通过 [NewLogic().(*logic).RunXxxTask()](file:///root/code/mono/ctl/pkg/logic/instance/logic.go#71-89) 每次重新构建完整的 logic 实例，包括：
  - 从全局 config 读取 template 配置（✅ 安全）
  - 重新获取 DAO factory singletons（✅ 安全）
  - 重新获取 MQ producer（✅ 安全，但多余）
  - `executeTasksInline: false`（✅ 正确）

  当前实现无 bug，但性能上属于不必要的对象分配。如果 worker 并发量大，频繁创建 logic 实例可能增加 GC 压力。
- **优先级**: 低，非当前改造范围

---

### F6 `[patch]` — [runDestroyTaskInline](file:///root/code/mono/ctl/pkg/logic/instance/async.go#318-348) 仅在 `ErrSandboxServiceError` 时回滚状态

- **来源**: edge
- **位置**: [async.go:326-331](file:///root/code/mono/ctl/pkg/logic/instance/async.go#L326-L331)
- **描述**:
  ```go
  if errors.Is(err, errcode.ErrSandboxServiceError) {
      if entity, getErr := l.instanceDao.GetByInstanceID(...); getErr == nil && entity.Status == modelinstance.InstanceStatusDeleting {
          _ = l.instanceDao.UpdateStatus(ctx, entity.Id, modelinstance.InstanceStatusFailed)
      }
  }
  ```
  inline 模式下 [RunDestroyInstanceTask](file:///root/code/mono/ctl/pkg/logic/instance/async.go#255-284) 返回的错误可能是非 `ErrSandboxServiceError` 类型（例如 `ErrInstanceStatusInvalid`、DB 错误），这些非 sandbox 类错误将导致实例停留在 `Deleting` 状态而不被标记为 [Failed](file:///root/code/mono/ctl/pkg/tasks/service/processor/instance_task.go#175-178)。
  
  注意 [RunDestroyInstanceTask](file:///root/code/mono/ctl/pkg/logic/instance/async.go#255-284) 内部：如果 `entity.Status != modelinstance.InstanceStatusDeleting` 直接返回 `ErrInstanceStatusInvalid`（不是 `ErrSandboxServiceError`），所以这种情况不需要回写。但 [finalizeInstanceDeletion](file:///root/code/mono/ctl/pkg/logic/instance/logic.go#553-604) 失败返回的也不是 `ErrSandboxServiceError`，此时实例可能卡在 `Deleting`。
- **建议**: 对 inline 模式考虑将判断放宽为 `err != nil`（sandbox 已删除但 DB 操作失败时，重试比卡住更好）。

---

### F7 `[patch]` — Entity GORM tag `type:text` 与 migration `VARCHAR(2048)` / `JSON` 不一致

- **来源**: blind + auditor
- **位置**: [entity.go:42-44](file:///root/code/mono/ctl/pkg/model/task/entity.go#L42-L44) vs [000006_create_async_tasks.up.sql:9-11](file:///root/code/mono/ctl/migrations/000006_create_async_tasks.up.sql#L9-L11)
- **描述**:
  | 字段 | GORM tag | Migration |
  |---|---|---|
  | TaskParams | `type:text` | `JSON` |
  | TaskMessage | `type:text` | `VARCHAR(2048)` |
  
  `TaskParams` migration 用 `JSON` 类型，但 GORM tag 标注 `type:text`。虽然在 MySQL 中 `AutoMigrate` 不会干活（migration 优先），但不一致会误导后续开发者。[TaskMessage](file:///root/code/mono/ctl/pkg/tasks/service/processor/instance_task.go#231-241) 同理：migration 是 `VARCHAR(2048)` 但 tag 是 `type:text`。
- **建议**: 将 GORM tag 与 migration 保持一致：`TaskParams` 改为 `type:json`，[TaskMessage](file:///root/code/mono/ctl/pkg/tasks/service/processor/instance_task.go#231-241) 改为 `type:varchar(2048)` 或移除 type 标注（已有 migration 管控）。

---

### F8 `[patch]` — migration `execute_interval DEFAULT 60` vs 代码 `defaultTaskExecuteIntervalSeconds = 30`

- **来源**: auditor
- **位置**: [000006_create_async_tasks.up.sql:13](file:///root/code/mono/ctl/migrations/000006_create_async_tasks.up.sql#L13) vs [async.go:27](file:///root/code/mono/ctl/pkg/logic/instance/async.go#L27)
- **描述**: Migration 定义 `execute_interval BIGINT NOT NULL DEFAULT 60`，但代码 async.go 中 `defaultTaskExecuteIntervalSeconds = 30`。Insert 时代码写入 30，所以 DB 默认值 60 永远不会生效。不影响正确性但造成困惑。
- **建议**: 统一为一致的值（30 或 60），migration DEFAULT 应与代码常量匹配。

---

### F9 `[patch]` — migration `max_execute_count DEFAULT 10` vs 代码 `defaultTaskMaxExecuteCount = 20`

- **来源**: auditor
- **位置**: [000006_create_async_tasks.up.sql:15](file:///root/code/mono/ctl/migrations/000006_create_async_tasks.up.sql#L15) vs [async.go:28](file:///root/code/mono/ctl/pkg/logic/instance/async.go#L28)
- **描述**: 同 F8，migration DEFAULT `10` vs 代码常量 `20`。代码 Insert 显式写入 20，所以 DB 默认值 10 永远不生效。
- **建议**: 统一为一致的值。

---

### F10 `[reject]` — ~~[noopProducer](file:///root/code/mono/ctl/pkg/logic/instance/async.go#43-44) 在没有 Redis 时吞掉消息~~

- **来源**: blind
- **描述**: `noopProducer.Send()` 返回 nil，如果 Redis 未配置，任务看似入队成功实际未发送。
- **分析**: 这是有意设计 — inline 模式（测试场景）不需要 MQ；生产环境 Redis 必配。**误报，不算 finding。**

---

## 汇总

| 分类 | 数量 | IDs |
|---|---|---|
| **patch** (可直接修复) | 7 | F1, F2, F3, F6, F7, F8, F9 |
| **defer** (已知不急) | 1 | F5 |
| **reject** (误报/已处理) | 1 | F10 |

### 按优先级排序

| 优先级 | ID | 标题 | 建议 |
|---|---|---|---|
| 🔴 推荐修 | **F6** | inline Destroy 只在 `ErrSandboxServiceError` 时回滚 | 放宽条件或增加 [finalizeInstanceDeletion](file:///root/code/mono/ctl/pkg/logic/instance/logic.go#553-604) 失败处理 |
| 🟡 建议修 | **F7** | GORM tag 与 migration 类型不一致 | 对齐 `type:json` / `varchar(2048)` |
| 🟡 建议修 | **F8, F9** | migration DEFAULT 与代码常量不一致 | 统一值 |
| 🟢 Nice to have | **F1** | [truncateTaskMessage](file:///root/code/mono/ctl/pkg/tasks/service/processor/instance_task.go#231-241) 重复 | 提取公共方法 |
| 🟢 Nice to have | **F2** | taskID 包含 `ins-` 前缀 | 独立 ID 生成 |
| 🟢 Nice to have | **F3** | [enqueueTask](file:///root/code/mono/ctl/pkg/logic/instance/async.go#89-140) 失败语义注释 | 加注释 |
| ⚪ 延后 | **F5** | 每次 [NewLogic()](file:///root/code/mono/ctl/pkg/logic/instance/logic.go#71-89) 分配 | 后续优化 |

---

## Acceptance Auditor 验收

### 对照 D12 spec

| 要求 | 状态 |
|---|---|
| API 快速返回 `201 {status: "Creating"}` | ✅ [CreateInstance](file:///root/code/mono/ctl/pkg/logic/instance/logic.go#108-172) 写 DB → 投 MQ → 返回 |
| Worker 执行沙箱创建 + 更新 DB | ✅ [RunCreateInstanceTask](file:///root/code/mono/ctl/pkg/logic/instance/async.go#185-224) + [instance_task.go](file:///root/code/mono/ctl/pkg/tasks/service/processor/instance_task.go) |
| 失败自动重试（MaxExecuteCount + 指数退避） | ✅ [CheckTask](file:///root/code/mono/ctl/pkg/tasks/service/base.go#96-117) 检查计数，bypass `checkTasks` 补偿 |
| 用户通过 GET 轮询状态 | ✅ [GetInstance](file:///root/code/mono/ctl/pkg/logic/instance/logic.go#252-266) + [toInstanceResponse](file:///root/code/mono/ctl/pkg/logic/instance/logic.go#647-664) 过滤 pending SandboxID |
| `pending-{instance_id}` 占位 | ✅ [toInstanceResponse](file:///root/code/mono/ctl/pkg/logic/instance/logic.go#647-664) 中 [isPendingSandboxID](file:///root/code/mono/ctl/pkg/logic/instance/async.go#85-88) 过滤 |
| 独立 tasks 表 | ✅ migration [000006_create_async_tasks.up.sql](file:///root/code/mono/ctl/migrations/000006_create_async_tasks.up.sql) |

### 对照 D13 spec

| 要求 | 状态 |
|---|---|
| 状态转 Deleting → 投 MQ → 立即返回 | ✅ [DestroyInstance](file:///root/code/mono/ctl/pkg/logic/instance/logic.go#49-50) 重构 |
| Worker 执行沙箱删除 + 配额释放 + 软删除 | ✅ [RunDestroyInstanceTask](file:///root/code/mono/ctl/pkg/logic/instance/async.go#255-284) + [finalizeInstanceDeletion](file:///root/code/mono/ctl/pkg/logic/instance/logic.go#553-604) |
| sandbox 404 继续视为成功 | ✅ `!isSandboxNotFound(err)` guard |
| bypass 补偿重投 | ✅ `checkTasks` |
| 测试构造器 inline 执行路径保留 | ✅ [NewLogicForTest](file:///root/code/mono/ctl/pkg/logic/instance/logic.go#90-107) + `executeTasksInline` |

> **整体评价**: 改造完整、架构清晰，D12/D13 所有 spec 要求均已满足。主要改进项集中在数据一致性（F7-F9）和 inline Destroy 错误处理（F6）。
