# CTL CreateInstance Follow-up Guide

本文件记录当前 `ctl` 本地/联调环境下，`CreateInstance` 可能长期停在 `Creating` 或最终失败的已知问题、证据、排障路径与后续修复方向。

本文件不是实例生命周期总设计文档，只关注当前遗留问题。

## 0. 当前结论先看这个

截至 `2026-03-28`，这条链路有两段需要分开看：

1. “失败 task 被 `checkTasks` 重放，实例像诈尸一样反复执行” 这一类控制面 bug 已经修复，并已在测试环境验证生效
2. 当前 `CreateInstance` 仍可能失败，但主阻塞已经切到实例内 `openclaw onboard` 本体 OOM，而不是 task replay

也就是说：

- 如果你看到实例在 `Creating` 和 `Running/Failed` 之间反复鬼打墙，先排查 task finalize / bypass replay
- 如果你看到实例稳定落成 `Failed`，且 `ctl-service` 日志里卡在 `configure onboard`，优先排查 `openclaw onboard` 的 Node heap，而不是继续怀疑 replay

## 1. 当前现象

已确认存在以下现象：

1. API 侧 `POST /v1/instances` 返回成功，实例进入 `Creating`
2. `service` 已消费 `CreateInstance` 任务
3. `sandbox-adapter` 已成功调用 `POST /sandboxes`，返回 `201`
4. 但实例状态没有推进到 `Running`
5. 同一个 `task_id` 可能被再次补偿投递
6. 重入执行后在 `LockTask` 处报错：

```text
LockLogic.LockTask failed
```

结果是：

- sandbox 实际可能已经创建成功
- 但 `instances.status` 仍停留在 `Creating`
- 用户看到的是“创建卡住”

## 2. 已确认的根因判断

当前最可疑的链路是：

1. `processor` 消费 Redis Stream 消息后，先 `ack`
2. 然后异步执行 `taskflow.RunTask(...)`
3. `CreateInstance` 执行时间超过补偿判断窗口
4. `bypass/checkTasks` 扫描到未完成 task，又重新投递同一个 `task_id`
5. 第二次执行抢不到 Redis 锁，于是 `LockTask` 失败
6. 任务收尾语义不完整，实例状态没有被正确收口

一句话总结：

当前问题不是“sandbox 一定没创建成功”，而是“任务可能已部分成功，但 task runtime 没有把状态完整推进到终态”。

## 3. 关键代码位置

### 3.1 先 ack 再执行

- [processor.go](../../ctl/pkg/taskruntime/processor/processor.go)

关注点：

- `Process()` 中，消息解析完成后会调用 `runTask(...)`
- `runTask(...)` 又是一个 goroutine
- 从日志看，Redis Stream 的 `ack` 早于业务任务真正执行完成

### 3.2 CreateInstance 真实业务执行

- [async.go](../../ctl/pkg/instance/async.go)

关注点：

- `RunCreateInstanceTask(...)`
- 实际会调用 `createSandboxWithFallback(...)`
- `POST /sandboxes` 成功后，才会继续更新实例状态为 `Running`

### 3.3 task lock / unlock

- [base.go](../../ctl/pkg/taskruntime/base.go)
- [logic.go](../../ctl/pkg/logic/lock/logic.go)

关注点：

- `LockTask(...)`
- `UnlockTask(...)`
- 当前锁值使用 `ctx.GetRequestId()`
- 同一个 task 被重投时，新的 request_id 与旧锁值不一致

### 3.4 CreateInstance task 的步骤图

- [task.go](../../ctl/pkg/instance/worker/task.go)

当前步骤：

```text
LockTask -> CheckTask -> UpdateTaskExecute -> Execute -> UnlockTask
```

当前风险：

- `LockTask failure` 会直接走 `UnlockTask`
- 没有把“这是同一个 task 的重复投递”识别成幂等场景

### 3.5 bypass 补偿重投

- [check_tasks.go](../../ctl/pkg/bypass/check_tasks.go)

关注点：

- 会扫描 `CREATED` / `RUNNING` 状态任务
- 根据 `LastExecuteTime + ExecuteInterval` 判断是否需要补偿重投

## 4. 当前已有证据

本地联调日志里已经看到：

1. `CreateInstance` 消息被正常消费
2. `sandbox request completed {"method":"POST","path":"/sandboxes","status":201}`
3. 同一个 `task_id` 再次被消费
4. 重入执行时报：

```text
LockLogic.LockTask failed
```

这说明：

- 不是简单的 sandbox 创建失败
- 而是任务执行与补偿重投之间存在时序冲突

## 5. 推荐修复优先级

### 方案 A：给 CreateInstance 增加幂等成功短路

推荐优先级：最高

思路：

- 如果 `RunCreateInstanceTask(...)` 再次进入时，实例已经是：
  - `Running`
  - 且 `sandbox_id` 已落库
- 则直接把 task 收口为成功

优点：

- 对当前用户问题最直接
- 不依赖立刻重构整个 task runtime

### 方案 B：调整 LockTask failure 的语义

思路：

- 对“同一个 task_id 的重入”不要直接按失败处理
- 可视为“已有执行在跑”，由当前重入任务安全退出

风险：

- 需要明确这是否会掩盖真正的死锁/僵尸任务

### 方案 C：收紧 bypass 的补偿触发条件

思路：

- 对 `RUNNING` 任务增加更保守的补偿窗口
- 避免业务执行尚未收尾时就重投

风险：

- 只能缓解，不能替代幂等

## 6. 下一步建议

建议顺序：

1. 若怀疑 replay，先确认测试环境是否已部署包含 `FinalizeFailure` 的新 worker
2. 再看失败点是否已经切到 `openclaw onboard`
3. 如果 `onboard` 已成为主阻塞，直接转到镜像/运行时侧排查 heap 与实例规格，不要再在 replay 路径上空转

## 7. 运行时主阻塞补充

`2026-03-28` 的 fresh sandbox 实测已确认：

- `ctl` 创建链路里真正执行大模型配置的是 `openclaw onboard`
- 该命令当前走 `ingressproxy-router -> envd process`
- 在小规格实例上，`openclaw onboard` 本身可能直接报：

```text
FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
```

因此：

- `CreateInstance` 最终落成 `Failed` 时，不要只看 sandbox 是否创建成功
- 必须继续检查 `ctl-service` 日志里 `configure onboard` 的 stdout/stderr
- 如果这里已经是 OOM，就该转去看镜像 heap 策略和实例规格

## 8. 回归标准

修复完成后，至少应验证：

1. `POST /v1/instances` 后实例能稳定进入 `Running`
2. 即使同一个 `task_id` 被重复投递，也不会让实例长期停在 `Creating`
3. 已成功创建 sandbox 的场景下，不会重复创建第二个 sandbox
4. 本地脚本：

```bash
python3 ctl/scripts/tests/smoke_local_api.py
```

以及：

```bash
python3 ctl/scripts/tests/regression_local_api.py
```

至少基础实例链路通过
