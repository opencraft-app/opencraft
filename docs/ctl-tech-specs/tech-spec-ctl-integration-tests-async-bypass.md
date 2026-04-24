---
title: 'CTL 集成测试补全 — 异步任务与 Bypass 补偿'
slug: 'ctl-integration-tests-async-bypass'
created: '2026-03-24'
status: 'implementation-complete'
stepsCompleted: [1, 2, 3, 4]
tech_stack:
  - Go 1.24
  - testcontainers-go v0.41 (MySQL 8.0.36 + Redis 7)
  - testify v1.11
  - gorm.io/gorm
  - github.com/redis/go-redis/v9
  - taskflow (ctl/pkg/taskflow)
files_to_modify:
  - ctl/test/testutil/redis.go (新增)
  - ctl/test/integration/async_task_test.go (新增)
  - ctl/test/integration/bypass_check_tasks_test.go (新增)
  - ctl/test/integration/task_inline_test.go (新增)
  - ctl/test/integration/helpers_test.go (新增)
  - ctl/pkg/bypass/check_tasks.go (导出 run 用于测试)
code_patterns:
  - testcontainers 共享容器模式
  - migration-based schema 初始化
  - 全局单例注入 (resource.GormDB / resource.RedisMainClient / resource.RedisMQClient)
  - 表格驱动子测试
  - //go:build integration 标签
test_patterns:
  - Given/When/Then 行为验证
  - 验证 DB 中的 task 状态流转
  - 验证 Redis Stream 中消息的写入与消费
  - 验证 Redis 分布式锁的获取与释放
---

# Tech-Spec: CTL 集成测试补全 — 异步任务与 Bypass 补偿

**Created:** 2026-03-24

## Overview

### Problem Statement

当前 `ctl` 的异步任务链路（enqueue → consume → execute → 状态流转）和 bypass 补偿（扫描滞留任务 → 重投）完全没有集成测试。这两块是系统可靠性的核心保障，一旦未来重构或变更引入回归，没有测试可以捕获。

### Solution

编写行为驱动的集成测试，使用 testcontainers MySQL + testcontainers Redis，验证：
1. 异步任务从入队到完成的全链路行为
2. Bypass 对滞留/超时任务的补偿重投行为
3. 任务失败、超限、幂等等边界场景的状态流转

### Scope

**In Scope:**
- 异步任务入队行为（task 记录写 DB + 消息发 Redis Stream）
- Worker 消费行为（processor 从 Redis Stream 消费 → dispatch → 执行 → 状态更新）
- Bypass checkTasks 行为（扫描滞留任务 → 判断是否重投 → 实际重投）
- 任务超时/失败后的状态流转与回调（FinalizeXxxTaskFailure）
- 幂等检查行为（lock contention 场景下的 idempotentCheck）
- 测试基础设施：testcontainers Redis 工具函数

**Out of Scope:**
- API 层的 HTTP 端到端测试
- sandbox adapter 的真实调用（用 stub 替代）
- 微信登录、AI Gateway 等外围功能
- 性能/压力测试

## Context for Development

### Codebase Patterns

**全局依赖注入模式：**
- `resource.GormDB` — 全局 GORM DB 连接，所有 DAO 通过此访问数据库
- `resource.RedisMainClient` — 全局 Redis 客户端（锁），lock.Logic 通过此操作分布式锁
- `resource.RedisMQClient` — 全局 Redis 客户端（MQ），MQ Factory 通过此创建 Producer/Consumer
- 测试中直接赋值 `resource.GormDB = gdb` 注入

**异步任务流水线：**
```
enqueueTask → 写 tasks 表 (CREATED) → Producer.Send (XADD)
processor.Process → XREADGROUP → pfMap dispatch → taskflow.Runner.RunTask
  步骤流: LockTask → CheckTask → UpdateTaskExecute → Execute → UnlockTask
  失败分支: LockTask fail → IdempotentCheck
```

**Bypass 补偿：**
```
checkTasks.run → 扫描 state IN (CREATED,RUNNING) 且 last_execute_time 超过 interval
  → execute_count >= max: 检查锁 → 锁在跳过，锁不在重投
  → execute_count < max: 直接重投 MQ
```

### Files to Reference

| File | Purpose |
| ---- | ------- |
| `ctl/pkg/instance/async.go` | enqueueTask、RunCreateInstanceTask、RunDestroyInstanceTask、inline 执行 |
| `ctl/pkg/instance/logic.go` | logic struct、NewLogic / NewLogicForTest |
| `ctl/pkg/instance/worker/task.go` | 步骤流定义、execute、idempotentCheck、markSuccess、failTask |
| `ctl/pkg/taskruntime/base.go` | BaseTask 通用步骤 |
| `ctl/pkg/taskruntime/processor/processor.go` | 消息处理器 |
| `ctl/pkg/taskruntime/processor/factory.go` | pfMap 注册表 |
| `ctl/pkg/taskruntime/common/common.go` | TaskMessage、GenerateMessageData/GenerateMessageDataByTaskEntity |
| `ctl/pkg/taskflow/runner.go` | 步骤流引擎 |
| `ctl/pkg/bypass/base.go` | Bypass 框架 |
| `ctl/pkg/bypass/check_tasks.go` | checkTasks bypass |
| `ctl/pkg/logic/lock/logic.go` | 分布式锁（SetNX + Lua unlock） |
| `ctl/pkg/mq/redis/producer.go` | Redis Stream Producer |
| `ctl/pkg/mq/redis/consumer.go` | Redis Stream Consumer |
| `ctl/pkg/mq/factory/factory.go` | MQ 工厂 |
| `ctl/pkg/model/task/entity.go` | Task Entity + 状态常量 |
| `ctl/pkg/resource/redis.go` | 全局 Redis 客户端 |
| `ctl/test/testutil/mysql.go` | testcontainers MySQL |
| `ctl/test/testutil/mysql_gorm.go` | 共享 MySQL 容器 + GORM 初始化 |

### Technical Decisions

1. **testcontainers Redis**：miniredis 不完整支持 XREADGROUP consumer group，用真实 Redis 容器，共享容器模式。
2. **行为验证**：断言 DB task 状态 + Redis Stream 消息，不 mock 内部调用。
3. **stub 外部适配器**：sandbox/aigateway adapter 用 stub 控制响应。
4. **全局 resource 注入**：赋值 `resource.GormDB`、`resource.RedisMainClient`、`resource.RedisMQClient`。
5. **导出 bypass run**：`checkTasks.run` 是私有方法，需在 `check_tasks.go` 中添加 `RunCheckTasksOnce` 导出函数（或通过 `_test.go` 同包测试）来支持单次调用测试。
6. **MQ config 覆写**：测试 setup 中设置 `config.ServerConf.MQConfig` 为测试专用 stream key。

## Implementation Plan

### Tasks

- [x] **Task 1: 新增 testcontainers Redis 工具**
  - File: `ctl/test/testutil/redis.go` (新增)
  - Action: 参照 `mysql.go` 模式，创建 `RedisContainer` 结构体和 `StartRedisContainer(t)` 函数
    - 使用 `redis:7` 镜像
    - 暴露 6379 端口
    - 返回 `*RedisContainer`（包含 `Container` 和 `Addr` 字段）
    - 添加 `Close(t)` 方法
    - 添加 `acquireSharedRedisContainer(t)` 共享容器函数（sync.Once 模式）
    - 添加 `NewRedisClient(t) *redis.Client` 工具函数：获取共享容器 → 创建 go-redis Client → 注入 `resource.RedisMainClient` 和 `resource.RedisMQClient`
  - Notes: 与 mysql.go 保持一致的代码风格和错误处理模式

- [x] **Task 2: 新增集成测试 helpers**
  - File: `ctl/test/integration/helpers_test.go` (新增)
  - Action: 创建测试通用 helper 函数（`//go:build integration`，package `integration`）
    - `setupTestEnv(t)`: 一站式初始化 MySQL（migration）+ Redis + config 覆写 + logger
    - `insertTaskEntity(t, db, entity)`: 向 tasks 表插入测试数据
    - `getTaskByID(t, db, taskID) *task.Entity`: 查询 task 记录
    - `readStreamMessages(t, client, streamKey, count) []redis.XMessage`: 从 Redis Stream 读取消息
    - `drainStream(t, client, streamKey)`: 清空 stream 确保测试隔离
    - `newTestMQConfig(streamKey string) *config.MQConfig`: 构造测试 MQ 配置
  - Notes: 每个测试函数应使用独立的 stream key（如 `test-stream-<timestamp>`）保证隔离

- [x] **Task 3: 导出 bypass checkTasks 的单次运行函数**
  - File: `ctl/pkg/bypass/check_tasks.go`
  - Action: 在文件末尾添加导出函数：
    ```go
    // RunCheckTasksOnce 暴露给集成测试调用，执行一次 checkTasks 扫描逻辑。
    func RunCheckTasksOnce(ctx pctx.Context) {
        c := &checkTasks{baseBypass: newBaseBypass(bypassCheckTasks, checkTasksLockSeconds)}
        c.run(ctx)
    }
    ```
  - Notes: 不调用 `baseBypass.runPeriod`（避免获取 bypass 锁），直接调用 `c.run(ctx)` 来测试纯扫描逻辑

- [x] **Task 4: 异步任务入队行为测试**
  - File: `ctl/test/integration/async_task_test.go` (新增)
  - Action: 编写以下测试用例（`//go:build integration`）

    **4a. TestEnqueueTask_CreateInstance_WritesDBAndStream**
    - 构造 logic（使用 NewLogicForTest，`executeTasksInline=false` 需要额外处理，因为 NewLogicForTest 默认 inline=true）
    - 注意：需要一个不启用 inline 的构造方式。方案：直接构造 logic struct 并注入依赖，或为 NewLogicForTest 添加 option。推荐通过直接调用 `enqueueTask` 验证入队行为（enqueueTask 是 logic 的方法，inline 不影响入队本身）。
    - 替代方案：直接测试 `enqueueTask` 的行为——给定一个 task name 和 payload，验证 tasks 表新增一条 CREATED 记录，且 Redis Stream 有对应消息。
    - 实现：创建一个最小化 logic（注入真实 taskDao + 真实 producer，其他用 nil/stub），调用私有方法不可行。
    - **最终方案**：在同包 `ctl/pkg/instance` 下新建 `async_integration_test.go`（`//go:build integration`），直接访问 `logic.enqueueTask`。

    **⚠️ 调整文件位置**：鉴于 `enqueueTask` 是私有方法，将入队行为测试放在 `ctl/pkg/instance/async_integration_test.go`。

    测试用例：
    1. `TestEnqueueTask_Success`: 调用 enqueueTask → 验证 DB 中 task 记录（state=CREATED, taskName, params, traceId）→ 验证 Redis Stream 消息内容（TaskMessage JSON）
    2. `TestEnqueueTask_ProducerFail_TaskMarkedFailed`: 注入一个 Send 失败的 producer → 验证 task state=FAILED
    3. `TestEnqueueTask_MarshalFail`: 传入不可序列化的 payload → 验证返回 error

  - Notes: 需要在 `ctl/pkg/instance` 包内测试才能访问私有方法

- [x] **Task 5: 调整入队测试文件位置 & 新增 integration test 在 instance 包**
  - File: `ctl/pkg/instance/async_integration_test.go` (新增，替代原 Task 4 的文件路径)
  - Action: 实现 Task 4 中描述的 3 个测试用例
  - Notes: 使用 `//go:build integration`，setup 中初始化 MySQL + Redis + resource 注入

- [x] **Task 6: Worker 消费 + 任务执行全链路测试**
  - File: `ctl/test/integration/async_task_test.go` (新增)
  - Action: 编写以下测试用例（`//go:build integration`，package `integration`）

    1. `TestProcessorConsume_CreateInstance_Success`:
       - Setup: MySQL migration + Redis + stub sandbox adapter（返回成功 sandbox）
       - 预置 instances 表一条 Creating 状态记录 + user_resource_quota 已分配
       - 构造 TaskMessage JSON → Producer.Send 写入 Redis Stream
       - 创建 processor → processor.Process(message)
       - processor.Wait() 等待完成
       - 验证: tasks 表 state=SUCCESS, instances 表 status=Running, sandbox_id 已填充

    2. `TestProcessorConsume_CreateInstance_SandboxFail`:
       - 同上，但 stub sandbox adapter 返回 error
       - 验证: tasks 表 state 仍为 RUNNING（单次失败不终结），task_message 记录错误信息

    3. `TestProcessorConsume_DestroyInstance_Success`:
       - 预置 instances 表一条 Deleting 状态记录
       - 发送 DestroyInstance 消息
       - 验证: tasks 表 state=SUCCESS, instances 表 status=Deleted

    4. `TestProcessorConsume_UnknownTaskName_ReturnsError`:
       - 发送 taskName="Unknown" 的消息
       - 验证: processor.Process 返回 error

    5. `TestWorkerStepFlow_ExceedMaxExecuteCount`:
       - 预置 tasks 表 execute_count=20, max_execute_count=20
       - 发送消息触发 processor
       - 验证: tasks 表 state=FAILED, task_message 包含 "MaxExecuteCount"

    6. `TestWorkerStepFlow_IdempotentCheck_InstanceAlreadyRunning`:
       - 预置 instances 表 status=Running + sandbox_id 有效
       - 在 Redis 中预设 task 锁（模拟 LockTask 会失败）
       - 发送 CreateInstance 消息
       - 验证: tasks 表 state=SUCCESS（幂等检查跳过执行）

  - Notes: processor.Process 是同步的（内部 goroutine 异步），需要调用 processor.Wait() 等待完成

- [x] **Task 7: Inline 任务执行测试**
  - File: `ctl/pkg/instance/async_integration_test.go` (追加)
  - Action: 编写以下测试用例

    1. `TestInlineCreateTask_Success`:
       - 使用 NewLogicForTest（默认 inline=true）
       - 预置 instances 表 Creating + quota 已分配 + stub sandbox 返回成功
       - 调用 CreateInstance
       - 验证: tasks 表 state=SUCCESS, instances 表 status=Running

    2. `TestInlineCreateTask_SandboxFail`:
       - stub sandbox 返回 error
       - 验证: tasks 表 state=FAILED, instances 表 status=Failed, quota 已回收

    3. `TestInlineDestroyTask_Success`:
       - 预置 instances 表 Deleting + stub sandbox delete 成功
       - 调用 DestroyInstance（内部走 inline）
       - 验证: tasks 表 state=SUCCESS, instances 表 status=Deleted

  - Notes: 这些测试利用现有 NewLogicForTest 的 inline 模式

- [x] **Task 8: Bypass checkTasks 行为测试**
  - File: `ctl/test/integration/bypass_check_tasks_test.go` (新增)
  - Action: 编写以下测试用例（`//go:build integration`）

    1. `TestCheckTasks_ResendStaleTask`:
       - Given: tasks 表一条记录，state=CREATED, last_execute_time 早于 execute_interval
       - When: 调用 `bypass.RunCheckTasksOnce(ctx)`
       - Then: Redis Stream 中新增一条消息，消息内容与 task 记录匹配

    2. `TestCheckTasks_SkipRecentTask`:
       - Given: tasks 表一条记录，state=CREATED, last_execute_time 刚刚更新（未超过 interval）
       - When: 调用 `bypass.RunCheckTasksOnce(ctx)`
       - Then: Redis Stream 无新消息

    3. `TestCheckTasks_SkipCompletedTask`:
       - Given: tasks 表一条记录，state=SUCCESS
       - When: 调用 `bypass.RunCheckTasksOnce(ctx)`
       - Then: Redis Stream 无新消息

    4. `TestCheckTasks_ExceedMaxCount_LockHeld_Skip`:
       - Given: tasks 表一条记录，execute_count=20, max_execute_count=20
       - 在 Redis 中设置该 task 的锁 key（`lock-task-{taskId}`）
       - When: 调用 `bypass.RunCheckTasksOnce(ctx)`
       - Then: Redis Stream 无新消息（锁在，跳过）

    5. `TestCheckTasks_ExceedMaxCount_LockReleased_Resend`:
       - Given: 同上但不设置锁 key
       - When: 调用 `bypass.RunCheckTasksOnce(ctx)`
       - Then: Redis Stream 新增消息（锁不在，重投）

    6. `TestCheckTasks_SkipOldTask`:
       - Given: tasks 表一条记录，created_time 早于 7 天前
       - When: 调用 `bypass.RunCheckTasksOnce(ctx)`
       - Then: Redis Stream 无新消息（超出 lookback 范围）

    7. `TestCheckTasks_BatchPagination`:
       - Given: 插入 250 条未完成任务（超过 batch 200）
       - When: 调用 `bypass.RunCheckTasksOnce(ctx)`
       - Then: Redis Stream 消息数=250（验证分页扫描覆盖所有记录）

  - Notes: 每个测试用独立 stream key + 每次调用前清空 stream

- [x] **Task 9: 验证所有测试通过**
  - Action: 运行 `cd ctl && go test -tags integration -v -count=1 ./pkg/instance/... ./test/integration/...`
  - Notes: 确保所有新增测试在 CI 环境（有 Docker）下绿色通过

### Acceptance Criteria

**异步入队：**
- [x] AC 1: Given 一个有效的 task payload，when 调用 enqueueTask，then tasks 表新增一条 state=CREATED 的记录，且 Redis Stream 包含对应的 TaskMessage 消息（含 taskName、taskId、traceId、payload）
- [x] AC 2: Given Producer.Send 失败，when 调用 enqueueTask，then tasks 表 task state 被更新为 FAILED，task_message 记录错误原因

**Worker 消费执行：**
- [x] AC 3: Given Redis Stream 中有一条 CreateInstance 消息且 instances 表中有对应 Creating 记录，when processor 消费该消息，then tasks 表 state 最终为 SUCCESS，instances 表 status 为 Running，sandbox_id 已填充
- [x] AC 4: Given sandbox adapter 返回错误，when processor 消费 CreateInstance 消息，then tasks 表 state 仍为 RUNNING（等待重试），task_message 记录错误原因
- [x] AC 5: Given Redis Stream 中有一条 DestroyInstance 消息且 instances 表中有对应 Deleting 记录，when processor 消费该消息，then tasks 表 state 为 SUCCESS，instances 表 status 为 Deleted
- [x] AC 6: Given task 的 execute_count 已达 max_execute_count，when processor 消费该消息，then tasks 表 state 为 FAILED，task_message 包含 "MaxExecuteCount"

**幂等检查：**
- [x] AC 7: Given instances 表 status=Running 且 sandbox_id 有效，且该 task 的 Redis 锁已被占用（LockTask 会失败），when processor 消费 CreateInstance 消息，then tasks 表 state 被更新为 SUCCESS（幂等短路）

**Inline 执行：**
- [x] AC 8: Given executeTasksInline=true 且 sandbox adapter 成功，when 调用 CreateInstance，then tasks 表 state=SUCCESS，instances 表 status=Running
- [x] AC 9: Given executeTasksInline=true 且 sandbox adapter 失败，when 调用 CreateInstance，then tasks 表 state=FAILED，instances 表 status=Failed，quota 已回收

**Bypass 补偿：**
- [x] AC 10: Given tasks 表有一条 state=CREATED 且 last_execute_time 超过 execute_interval 的记录，when bypass checkTasks 执行一次，then Redis Stream 新增一条与该 task 匹配的重投消息
- [x] AC 11: Given tasks 表有一条 state=CREATED 且 last_execute_time 未超过 execute_interval 的记录，when bypass checkTasks 执行一次，then Redis Stream 无新消息
- [x] AC 12: Given tasks 表有一条 state=SUCCESS 的记录，when bypass checkTasks 执行一次，then 该任务不被重投
- [x] AC 13: Given tasks 表有一条 execute_count >= max_execute_count 的记录且 Redis 锁存在，when bypass checkTasks 执行一次，then 该任务不被重投
- [x] AC 14: Given 同上但 Redis 锁不存在，when bypass checkTasks 执行一次，then 该任务被重投
- [x] AC 15: Given tasks 表有 250 条未完成任务，when bypass checkTasks 执行一次，then 所有 250 条都被重投（分页正确）

## Additional Context

### Dependencies

- `github.com/testcontainers/testcontainers-go` (已有)
- `github.com/redis/go-redis/v9` (已有)
- Docker daemon（运行测试时需要 MySQL + Redis 容器）

### Testing Strategy

- 所有新增测试使用 `//go:build integration` 标签
- 运行方式：`cd ctl && go test -tags integration -v -count=1 ./pkg/instance/... ./test/integration/...`
- 入队测试放 `ctl/pkg/instance/` 包内（访问私有方法 enqueueTask）
- Worker 消费和 Bypass 测试放 `ctl/test/integration/` 包（通过公开 API 和导出函数测试）
- 每个测试用独立 stream key 和独立 database 保证隔离

### Notes

- **风险点 1**: `checkTasks.run` 内部直接使用 `daoFactory.DefaultDaoFactory` 和 `mqfactory.DefaultMQFactory`，这依赖全局 resource 变量。测试 setup 必须确保 `config.ServerConf.MQConfig` 已正确设置测试 stream key。
- **风险点 2**: processor.runTask 在 goroutine 中异步执行，需通过 `processor.Wait()` 同步等待完成再断言。
- **风险点 3**: Worker 步骤流中 `LockTask` 依赖 Redis SetNX，多个并发测试可能产生锁冲突。通过独立 task ID 隔离。
- **未来扩展**: 本轮不覆盖 API→Logic 端到端、operation_history 行为、graceful shutdown。可在后续 sprint 补充。
