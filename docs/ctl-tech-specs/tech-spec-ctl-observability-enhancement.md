---
title: 'CTL 全链路可观测性增强'
slug: 'ctl-observability-enhancement'
created: '2026-03-23'
status: 'completed'
stepsCompleted: [1, 2, 3, 4]
tech_stack: [go-1.26, prometheus, alertmanager, opentelemetry, grafana, zap, gorm, go-redis-v9, redis-streams]
files_to_modify:
  - ctl/pkg/metric/task.go
  - ctl/pkg/metric/instance.go
  - ctl/pkg/metric/bypass.go (new)
  - ctl/pkg/metric/infra.go (new)
  - ctl/pkg/log/fields.go (new)
  - ctl/pkg/bypass/base.go
  - ctl/pkg/bypass/check_tasks.go
  - ctl/pkg/taskruntime/base.go
  - ctl/pkg/taskruntime/processor/processor.go
  - ctl/pkg/resource/mysql.go
  - ctl/pkg/resource/redis.go
  - ctl/main/service/main.go
  - ctl/main/bypass/main.go
  - ctl/main/api/server.go
  - ctl/main/common/common.go
  - ctl/pkg/instance/async.go
  - ctl/pkg/adapter/sandbox/adapter.go
  - ctl/pkg/config/define.go
  - ctl/conf/server/common/server_conf.toml
  - deploy/prometheus/prometheus.yml
  - deploy/prometheus/alert_rules.yml (new)
  - deploy/alertmanager/alertmanager.yml (new)
  - deploy/docker-compose.monitoring.yml
  - deploy/grafana/dashboards/openclaw-overview.json
code_patterns:
  - 'metric 定义: pkg/metric/ 下按领域拆文件，全局 var 声明 prometheus.*Vec'
  - 'metric 注册: main/*/main.go 中调用 common.InitMonitor() 传入 []prometheus.Collector'
  - 'Collector 模式: InstanceGaugeCollector 实时查 DB，5s 超时'
  - 'bypass 框架: baseBypass + runPeriod() + 分布式锁，通过 init() 注册'
  - 'task 框架: LockTask → CheckTask → UpdateTaskExecute → Execute → UnlockTask'
  - 'tracing: tracing.StartTrace() 返回 (ctx, *Span)，defer span.EndWithError(err)'
  - 'logging: resource.ZapLogger 全局, ctx.Logger() 带字段'
  - '辅助函数封装: RecordSandboxAPICall/RecordInstanceCreate/RecordAPIRequest'
test_patterns:
  - '暂无专门的 metric 单测，主要通过集成测试和 regression 脚本验证'
  - '本次通过 /metrics 端点抓取验证 + Prometheus 表达式验证 + Grafana 面板渲染验证'
---

# Tech-Spec: CTL 全链路可观测性增强

**Created:** 2026-03-23

## Overview

### Problem Statement

CTL 三服务（API/Service/Bypass）已有基础可观测性框架（zap 日志、Prometheus 指标、OTel Tracing），但存在以下缺口：
1. **零告警规则** — 任务失败、API 错误率飙升、重试堆积等关键异常无人被通知
2. **Task 表维度监控缺失** — 重试次数逼近上限、失败堆积、超时未完成任务无指标；缺少 `task_success_total` 导致无法计算成功率
3. **Bypass 无独立指标** — 每轮补偿了多少任务、多少被标记 FAILED 无追踪；分布式锁竞争情况不可见
4. **基础设施盲区** — DB 连接池、Redis 连接池使用率未暴露
5. **日志格式不统一** — Service/Bypass 日志字段命名和使用方式不一致，缺少统一的字段常量定义
6. **Tracing 不完整** — 业务 logic 层缺少 Span，链路追踪断裂
7. **任务"卡在 RUNNING"无感知** — 任务既不是失败也不是成功，长时间停在 RUNNING（可能消费者挂了或锁未释放），无告警覆盖
8. **缺少系统健康总览** — 运维需要 Single Pane of Glass，30 秒内定位问题

### Solution

全面增强 CTL 可观测性，覆盖六个维度：
1. 补全 Prometheus 指标（Task 表维度、Bypass 维度、基础设施层）
2. 建立 **分层告警规则体系**（P0/P1/P2），走 Alertmanager，每条告警配 runbook_url
3. 规范化三服务日志格式，定义统一字段常量文件
4. 补全关键路径 Tracing Span（跨服务调用/DB 事务/任务生命周期），不过度埋点
5. 更新 Grafana Dashboard：新增系统健康总览面板（红黄绿状态灯）+ 趋势图
6. 从运维工程师视角设计端到端的监控体系

### Scope

**In Scope:**
- Prometheus 告警规则（走 Alertmanager），分层 P0/P1/P2 + runbook_url
- Task 表维度指标（重试逼近上限、失败堆积、超时未完成、成功计数、RUNNING 超时检测）
- Bypass checkTasks 指标（补偿数量、FAILED 标记数、锁竞争 `result=executed|lock_failed`）
- DB 连接池 / Redis 连接池指标暴露
- 日志字段规范化统一（三服务），新建 `pkg/log/fields.go` 常量文件
- Tracing Span 补全（关键路径：跨服务调用、DB 事务、任务生命周期）
- Grafana Dashboard 更新：系统健康总览 + 趋势图 + 所有新指标面板
- Task 指标 Collector 查询加超时保护 + 慢查询监控

**Out of Scope:**
- 其他告警通道（企微/蓝鲸/短信），先走 Alertmanager
- MQ 队列深度指标（以 Task 表为准）
- 业务逻辑变更

### Delivery Phases

分阶段独立交付，每个 Phase 可独立产出价值：

- **Phase 1：指标补全 + 告警规则**（Task 1-8）
- **Phase 2：日志规范化 + Tracing 补全**（Task 9-11）
- **Phase 3：Dashboard 更新 + 本地监控栈**（Task 12-14）

## Context for Development

### Codebase Patterns

**指标定义模式：**
- 在 `pkg/metric/` 下按领域拆文件（adapter.go、api.go、task.go、instance.go）
- 全局 `var` 声明 `prometheus.NewCounterVec` / `prometheus.NewHistogramVec` / `prometheus.NewGaugeVec`
- 辅助函数封装常用埋点：`RecordSandboxAPICall()`、`RecordInstanceCreate()`、`RecordAPIRequest()`
- 自定义 Collector 模式：`InstanceGaugeCollector` 实现 `prometheus.Collector` 接口，Prometheus 抓取时实时查 DB，5s 超时

**指标注册模式：**
- `main/*/main.go` 中调用 `common.InitMonitor(config, []prometheus.Collector{...})` 传入所有 Collector
- `InitMonitor()` 创建独立 `prometheus.Registry`（非 DefaultRegistry），注册所有 Collector
- API 端口 9591、Service 端口 9592，Bypass **当前无监控端口**

**Bypass 框架：**
- `baseBypass` + `runPeriod()` 循环：`for { runPeriod(ctx); sleep(interval) }`
- `runPeriod()` 内：获取分布式锁 → preRun → run → postRun → 释放锁
- 锁失败 = `logger.Warn()` 然后跳过本轮，**无指标记录**
- 通过 `init()` + `registerBypass()` 注册到全局 `bypassTable`

**Task 执行框架（TaskFlow）：**
- 步骤链：`LockTask → CheckTask → UpdateTaskExecute → Execute → UnlockTask`
- `CheckTask()` 检查 `execute_count >= max_execute_count`，超限 → 标记 FAILED
- `UpdateTaskExecute()` 原子 `execute_count + 1`，更新 `last_execute_time`
- `setTelemetry()` 在 `UnlockTask` 时记录：`TaskDurationHistogramVec`（任务完成时）+ `TaskFailedTotalCounterVec`（非 SUCCESS 时）
- **缺失**：无 `TaskSuccessTotalCounterVec`

**Tracing 模式：**
- `tracing.StartTrace(ctx, spanName)` → `(ctx, *Span)`
- `defer span.EndWithError(err)`
- 已覆盖：API 请求（via RequestID）、任务消费（processor.runTask）、bypass runPeriod
- **缺失**：沙箱适配器调用、业务 logic 层关键路径

**日志模式：**
- `resource.ZapLogger` 全局 logger，`ctx.Logger()` 带请求级字段
- API middleware 注入：`trace_id`、`user_id`、`action`、`latency`、`status_code`
- Service processor：`ctx.SetLogger(ctx.Logger().With(zap.String("tid", msg.TraceId)))`
- Bypass：`ctx.SetAction(b.name)`
- **不统一**：有些用 `"tid"` 有些用 `"trace_id"`，字段名无常量定义

### Files to Reference

| File | Purpose | 修改类型 |
| ---- | ------- | ------- |
| `ctl/pkg/metric/task.go` | 现有 Task 指标（duration/failed/running） | 修改 |
| `ctl/pkg/metric/instance.go` | OpenClaw 业务指标 + InstanceGaugeCollector | 修改 |
| `ctl/pkg/metric/bypass.go` | Bypass 指标 | **新建** |
| `ctl/pkg/metric/infra.go` | 基础设施指标（DB/Redis 连接池） | **新建** |
| `ctl/pkg/log/fields.go` | 统一日志字段常量 | **新建** |
| `ctl/pkg/bypass/base.go` | Bypass 基础框架（runPeriod + 锁） | 修改 |
| `ctl/pkg/bypass/check_tasks.go` | checkTasks 补偿逻辑 | 修改 |
| `ctl/pkg/taskruntime/base.go` | Task 执行引擎 | 修改 |
| `ctl/pkg/taskruntime/processor/processor.go` | MQ 消费处理 | 修改 |
| `ctl/pkg/resource/mysql.go` | GORM 初始化 | 修改 |
| `ctl/pkg/resource/redis.go` | Redis 初始化 | 修改 |
| `ctl/main/service/main.go` | Service 启动 + 指标注册 | 修改 |
| `ctl/main/bypass/main.go` | Bypass 启动 | 修改 |
| `ctl/main/api/server.go` | API 中间件 | 修改 |
| `ctl/main/common/common.go` | InitMonitor() | 参考 |
| `ctl/pkg/adapter/sandbox/adapter.go` | 沙箱适配器 | 修改 |
| `ctl/pkg/instance/async.go` | 异步任务创建 | 修改 |
| `ctl/pkg/config/define.go` | 配置定义 | 修改 |
| `ctl/conf/server/common/server_conf.toml` | 服务配置 | 修改 |
| `deploy/prometheus/prometheus.yml` | Prometheus 配置 | 修改 |
| `deploy/prometheus/alert_rules.yml` | 告警规则 | **新建** |
| `deploy/alertmanager/alertmanager.yml` | Alertmanager 配置 | **新建** |
| `deploy/docker-compose.monitoring.yml` | 监控栈 | 修改 |
| `deploy/grafana/dashboards/openclaw-overview.json` | Dashboard | 修改 |

### Technical Decisions

- 告警通道：Prometheus Alertmanager
- 告警分层：P0（立即响应）/ P1（30分钟内处理）/ P2（工作时间处理），每条告警 annotation 包含 `runbook_url`
- Task 监控维度：以数据库 tasks 表为准，MQ 仅作加速投递
- Task 重试上限检查在 TaskRunner.CheckTask() 中，Bypass 只负责无脑重投
- Task 指标标签控制：`task_name` 使用枚举白名单，未知类型归到 `other`，防止标签基数爆炸
- Task Collector 查 DB 的频率控制：加查询超时（5s） + 慢查询监控
- Tracing Span 边界：只在关键路径加 Span（沙箱适配器调用、异步任务关键步骤），不过度埋点
- 日志规范化策略：新建 `pkg/log/fields.go` 定义字段常量，逐步替换
- Bypass 指标采集：锁内（补偿数量）+ 锁外（锁竞争信号）都记录
- Bypass 需要新增 Monitor 端口（复用 MonitorConfig 结构，新增 `[monitor.bypass]`）
- DB 连接池指标通过 GORM 的 `db.DB()` → `*sql.DB` → `Stats()` 暴露
- Redis 连接池指标通过 go-redis 的 `PoolStats()` 暴露
- 新增 Collector 复用 `InstanceGaugeCollector` 模式

---

## Implementation Plan

### Tasks

#### Phase 1：指标补全 + 告警规则

- [x] **Task 1: 补全 Task 成功指标 + TaskGaugeCollector**
  - File: `ctl/pkg/metric/task.go`
    - Action: 新增 `TaskSuccessTotalCounterVec`（Counter，标签 `task`），与 `TaskFailedTotalCounterVec` 对称
  - File: `ctl/pkg/metric/instance.go`
    - Action: 新增 `TaskGaugeCollector`，复用 `InstanceGaugeCollector` 模式，实时查 tasks 表：
      - `openclaw_task_status_total{task_name, status}` — 按 task_name + status 聚合任务数量
      - `openclaw_task_retry_near_limit_total{task_name}` — `execute_count >= max_execute_count * 0.8` 且未完成的任务数
      - `openclaw_task_stuck_running_total{task_name}` — 状态为 RUNNING 且 `last_execute_time` 距今超过 10 分钟的任务数
    - Notes: 查询加 5s 超时（与 InstanceGaugeCollector 一致），SQL 限制只查 7 天内的任务（与 bypass lookback 一致）
  - File: `ctl/pkg/taskruntime/base.go`
    - Action: 在 `setTelemetry()` 中，当 `TaskState == StateSuccess` 时调用 `metric.TaskSuccessTotalCounterVec.WithLabelValues(taskName).Inc()`

- [x] **Task 2: 新建 Bypass 指标文件 + 埋点**
  - File: `ctl/pkg/metric/bypass.go`（**新建**）
    - Action: 定义以下指标：
      - `BypassExecutionTotalCounterVec` — Counter，标签 `{bypass_name, result}`，result 枚举：`executed`/`lock_failed`/`error`
      - `BypassCompensatedTasksTotalCounterVec` — Counter，标签 `{bypass_name}`，每轮重新投递到 MQ 的任务数
      - `BypassExecutionDurationHistogramVec` — Histogram，标签 `{bypass_name}`，Buckets: `{0.1, 0.5, 1, 2, 5, 10, 30, 60}`
    - Notes: 遵循现有模式，全局 var 声明
  - File: `ctl/pkg/bypass/base.go`
    - Action: 在 `runPeriod()` 中埋点：
      - 锁获取失败时：`metric.BypassExecutionTotalCounterVec.WithLabelValues(b.name, "lock_failed").Inc()` 然后 return
      - 锁获取成功、run 执行完毕后：`metric.BypassExecutionTotalCounterVec.WithLabelValues(b.name, "executed").Inc()` + 记录 duration
      - 出现 error 时：`metric.BypassExecutionTotalCounterVec.WithLabelValues(b.name, "error").Inc()`
  - File: `ctl/pkg/bypass/check_tasks.go`
    - Action: 在每次成功发送 MQ 后：`metric.BypassCompensatedTasksTotalCounterVec.WithLabelValues(bypassCheckTasks).Inc()`

- [x] **Task 3: 新建基础设施指标（DB + Redis 连接池）**
  - File: `ctl/pkg/metric/infra.go`（**新建**）
    - Action: 创建两个 Collector：
      - `DBPoolCollector` — 实现 `prometheus.Collector`，通过 `resource.GormDB` → `db.DB()` → `Stats()` 暴露：
        - `openclaw_db_pool_max_open` (Gauge)
        - `openclaw_db_pool_open` (Gauge)
        - `openclaw_db_pool_in_use` (Gauge)
        - `openclaw_db_pool_idle` (Gauge)
        - `openclaw_db_pool_wait_total` (Counter)
        - `openclaw_db_pool_wait_duration_seconds_total` (Counter)
      - `RedisPoolCollector` — 实现 `prometheus.Collector`，通过 `redis.Client` → `PoolStats()` 暴露：
        - `openclaw_redis_pool_hits_total` (Counter)，标签 `{client}`（main/mq）
        - `openclaw_redis_pool_misses_total` (Counter)
        - `openclaw_redis_pool_timeouts_total` (Counter)
        - `openclaw_redis_pool_total_conns` (Gauge)
        - `openclaw_redis_pool_idle_conns` (Gauge)
        - `openclaw_redis_pool_stale_conns` (Gauge)
    - Notes: `DBPoolCollector` 直接读 Go 运行时 Stats()，零 SQL 查询开销；`RedisPoolCollector` 需要传入两个 client（main + mq），用标签区分

- [x] **Task 4: 注册新 Collector 到三服务**
  - File: `ctl/main/bypass/main.go`
    - Action: 新增 `common.InitMonitor()` 调用，注册：`metric.TaskGaugeCollector`（传入 `resource.GormDB`）、bypass 指标 CounterVec/HistogramVec、`metric.DBPoolCollector`、`metric.RedisPoolCollector`
    - Notes: **TaskGaugeCollector 只注册在 Bypass 服务**，避免三服务重复查同一份 tasks 表数据。Bypass 负责任务补偿，逻辑上最相关
  - File: `ctl/main/service/main.go`
    - Action: 在 `common.InitMonitor()` 调用中追加：`metric.DBPoolCollector`、`metric.RedisPoolCollector`（不注册 TaskGaugeCollector）
  - File: `ctl/main/api/server.go`（或 `main/api/main.go`）
    - Action: 在现有 `InitMonitor()` 调用中追加 `metric.DBPoolCollector`、`metric.RedisPoolCollector`
  - File: `ctl/pkg/config/define.go`
    - Action: 在 `GlobalConfig` 中确认 `MonitorConfig` 有 bypass 段（如果 `LogConfig` 已按 api/service/bypass 拆分，monitor 也应对称）
  - File: `ctl/conf/server/common/server_conf.toml`
    - Action: 新增 `[monitor.bypass]` 段，port = 9593，enable_pprof = false

- [x] **Task 5: 新建 Alertmanager 配置**
  - File: `deploy/alertmanager/alertmanager.yml`（**新建**）
    - Action: 创建基础 Alertmanager 配置：
      ```yaml
      global:
        resolve_timeout: 5m
      route:
        group_by: ['alertname', 'severity']
        group_wait: 30s
        group_interval: 5m
        repeat_interval: 4h
        receiver: 'default'
        routes:
          - match:
              severity: P0
            repeat_interval: 15m
            receiver: 'default'
          - match:
              severity: P1
            repeat_interval: 1h
            receiver: 'default'
      receivers:
        - name: 'default'
      ```
    - Notes: receiver 先设为空（后续可接企微/webhook），重点是路由分层逻辑

- [x] **Task 6: 新建告警规则文件**
  - File: `deploy/prometheus/alert_rules.yml`（**新建**）
    - Action: 创建分层告警规则：

    **P0 — 立即响应：**
    - `TaskFailureRateHigh` — `rate(task_failed_total[5m]) > 0.1`，任务失败率突增
    - `APIErrorRateHigh` — `sum(rate(openclaw_api_request_total{status_code=~"5.."}[5m])) / sum(rate(openclaw_api_request_total[5m])) > 0.05`，API 5xx 错误率 > 5%
    - `TaskStuckRunning` — `openclaw_task_stuck_running_total > 0`，有任务卡在 RUNNING 超过 10 分钟

    **P1 — 30 分钟内处理：**
    - `TaskRetryNearLimit` — `openclaw_task_retry_near_limit_total > 0`，有任务重试次数逼近上限（80%）
    - `TaskFailedAccumulating` — `openclaw_task_status_total{status="FAILED"} > 10`，FAILED 任务堆积超过 10 个
    - `SandboxAPILatencyHigh` — `histogram_quantile(0.99, rate(openclaw_sandbox_api_duration_seconds_bucket[5m])) > 10`，沙箱 API P99 延迟 > 10s
    - `DBPoolExhaustion` — `openclaw_db_pool_in_use / openclaw_db_pool_max_open > 0.8`，DB 连接池使用率 > 80%

    **P2 — 工作时间处理：**
    - `APILatencyP99High` — `histogram_quantile(0.99, rate(openclaw_api_request_duration_seconds_bucket[5m])) > 1`，API P99 延迟 > 1s
    - `BypassLockFailureRate` — `rate(bypass_execution_total{result="lock_failed"}[1h]) > 0.5`，Bypass 锁竞争频繁
    - `RedisPoolMissRate` — `rate(openclaw_redis_pool_misses_total[5m]) / (rate(openclaw_redis_pool_hits_total[5m]) + rate(openclaw_redis_pool_misses_total[5m])) > 0.1`，Redis 连接池未命中率 > 10%

    - Notes: 每条规则包含 `annotations: { summary, description, runbook_url }`，runbook_url 先指向 `docs/runbooks/` 占位路径

- [x] **Task 7: 更新 Prometheus 配置**
  - File: `deploy/prometheus/prometheus.yml`
    - Action:
      - 新增 `rule_files: ['alert_rules.yml']`
      - 新增 `alerting` 段指向 Alertmanager 容器
      - 新增 bypass target（host.docker.internal:9593）
    - Notes: 保留现有 scrape_configs 不变

- [x] **Task 8: 更新 Docker Compose 监控栈**
  - File: `deploy/docker-compose.monitoring.yml`
    - Action:
      - 新增 `alertmanager` 服务（`prom/alertmanager:v0.27.0`，端口 9093）
      - 挂载 `./alertmanager/alertmanager.yml` 和 `./prometheus/alert_rules.yml`
      - prometheus 服务 depends_on 加 alertmanager
    - Notes: 本地开发用，生产环境使用云服务

#### Phase 2：日志规范化 + Tracing 补全

- [x] **Task 9: 新建日志字段常量 + 规范化三服务**
  - File: `ctl/pkg/log/fields.go`（**新建**）
    - Action: 定义统一字段常量：
      ```go
      package log

      const (
          FieldTraceID    = "trace_id"
          FieldUserID     = "user_id"
          FieldAction     = "action"
          FieldTaskID     = "task_id"
          FieldTaskName   = "task_name"
          FieldTaskState  = "task_state"
          FieldBypassName = "bypass_name"
          FieldLatencyMs  = "latency_ms"
          FieldStatusCode = "status_code"
          FieldInstanceID = "instance_id"
          FieldSandboxID  = "sandbox_id"
          FieldMethod     = "method"
          FieldPath       = "path"
          FieldError      = "error"
      )
      ```
  - File: `ctl/pkg/taskruntime/processor/processor.go`
    - Action: 将 `zap.String("tid", msg.TraceId)` 改为 `zap.String(log.FieldTraceID, msg.TraceId)`
    - Action: 新增 `zap.String(log.FieldTaskName, msg.TaskName)` 和 `zap.String(log.FieldTaskID, msg.TaskId)`
  - File: `ctl/pkg/bypass/base.go`
    - Action: 将 `logger.Info(fmt.Sprintf("run bypass %s", b.name))` 改为 `logger.Info("bypass run started", zap.String(log.FieldBypassName, b.name))`
    - Action: 锁失败日志也统一格式
  - File: `ctl/main/api/server.go`
    - Action: requestLoggingMiddleware 中的日志字段引用 `log.Field*` 常量
  - Notes: 逐步替换，不改变日志内容语义，只统一字段名

- [x] **Task 10: Tracing Span 补全 — 沙箱适配器**
  - File: `ctl/pkg/adapter/sandbox/adapter.go`
    - Action: 在每个公开方法（CreateSandbox、GetSandbox、DeleteSandbox、PauseSandbox、ResumeSandbox、SetTimeout、Refresh、GetLogs）入口添加 Span：
      ```go
      ctx, span := tracing.StartTrace(ctx, "SandboxAdapter.CreateSandbox")
      defer func() { span.EndWithError(err) }()
      ```
    - Notes: 这些方法内部已有 `RecordSandboxAPICall()` 指标埋点，Span 是补充链路追踪维度。不在 HTTP client 层加 Span（避免双重 Span），只在适配器方法层

- [x] **Task 11: Tracing Span 补全 — 异步任务关键路径**
  - File: `ctl/pkg/instance/async.go`
    - Action: 在 `enqueueTask()` 入口添加 Span：`tracing.StartTrace(ctx, "Instance.EnqueueTask")`
    - Action: 在 `runCreateTaskInline()` 入口添加 Span：`tracing.StartTrace(ctx, "Instance.RunCreateTaskInline")`
  - File: `ctl/pkg/taskruntime/base.go`
    - Action: 在 `CheckTask()` 中，当 `execute_count >= max_execute_count` 时，在 Span 上记录事件：
      ```go
      span := trace.SpanFromContext(ctx)
      span.AddEvent("task_exceeded_max_execute_count", trace.WithAttributes(
          attribute.Int("execute_count", t.TaskEntity.ExecuteCount),
          attribute.Int("max_execute_count", t.TaskEntity.MaxExecuteCount),
      ))
      ```
    - Notes: 不在 LockTask/UnlockTask 加 Span（这些是框架步骤，TaskFlow Runner 已有 StartTraceForFramework），只在业务关键决策点加

#### Phase 3：Dashboard 更新 + 本地监控栈

- [x] **Task 12: Grafana Dashboard — 新增系统健康总览面板**
  - File: `deploy/grafana/dashboards/openclaw-overview.json`
    - Action: 在 Dashboard 顶部新增 "系统健康总览" Row（Row 0），包含以下 stat 面板：
      - **任务成功率** — `sum(rate(task_success_total[1h])) / (sum(rate(task_success_total[1h])) + sum(rate(task_failed_total[1h])))` — 红(<95%) / 黄(95-99%) / 绿(>99%)
      - **RUNNING 卡住任务数** — `sum(openclaw_task_stuck_running_total)` — 红(>0) / 绿(0)
      - **重试逼近上限** — `sum(openclaw_task_retry_near_limit_total)` — 红(>5) / 黄(1-5) / 绿(0)
      - **DB 连接池使用率** — `openclaw_db_pool_in_use / openclaw_db_pool_max_open` — 红(>80%) / 黄(60-80%) / 绿(<60%)
    - Notes: 使用 Grafana threshold 配置实现红黄绿

- [x] **Task 13: Grafana Dashboard — 新增 Task/Bypass/Infra 面板**
  - File: `deploy/grafana/dashboards/openclaw-overview.json`
    - Action: 新增 "异步任务" Row：
      - 任务成功/失败趋势（timeseries）— `rate(task_success_total[5m])` vs `rate(task_failed_total[5m])`
      - 任务状态分布（pie/bar）— `openclaw_task_status_total` by status
      - 任务执行耗时 P50/P90/P99（timeseries）— `histogram_quantile` on `task_duration_seconds`
    - Action: 新增 "Bypass 补偿" Row：
      - Bypass 执行趋势（timeseries）— `rate(bypass_execution_total[5m])` by result
      - 补偿任务数趋势（timeseries）— `rate(bypass_compensated_tasks_total[5m])`
      - Bypass 执行耗时（timeseries）— `histogram_quantile` on `bypass_execution_duration_seconds`
    - Action: 新增 "基础设施" Row（替换或增强现有 Row 40）：
      - DB 连接池使用情况（timeseries）— open/in_use/idle 叠加
      - Redis 连接池状态（timeseries）— total/idle/stale by client
      - Redis 命中率（timeseries）— hits / (hits + misses) by client

- [x] **Task 14: 更新 Prometheus 抓取 target**
  - File: `deploy/prometheus/prometheus.yml`
    - Action: 新增 bypass target 和标签：
      ```yaml
      scrape_configs:
        - job_name: 'openclaw-api'
          static_configs:
            - targets: ['host.docker.internal:9591']
        - job_name: 'openclaw-service'
          static_configs:
            - targets: ['host.docker.internal:9592']
        - job_name: 'openclaw-bypass'
          static_configs:
            - targets: ['host.docker.internal:9593']
      ```
    - Notes: 拆分为三个 job 方便按服务维度筛选

---

### Acceptance Criteria

#### Phase 1

- [ ] **AC1:** Given Service 和 Bypass 服务运行中，When 访问各自 /metrics 端点，Then 能看到以下新增指标：`task_success_total`、`openclaw_task_status_total`、`openclaw_task_retry_near_limit_total`、`openclaw_task_stuck_running_total`、`bypass_execution_total`、`bypass_compensated_tasks_total`、`bypass_execution_duration_seconds`、`openclaw_db_pool_*`（6 个）、`openclaw_redis_pool_*`（6 个）

- [ ] **AC2:** Given 一个任务执行成功，When 检查 /metrics，Then `task_success_total{task="CreateInstance"}` 计数 +1

- [ ] **AC3:** Given 一个任务的 execute_count 达到 max_execute_count 的 80%，When Prometheus 抓取 TaskGaugeCollector，Then `openclaw_task_retry_near_limit_total{task_name="CreateInstance"}` > 0

- [ ] **AC4:** Given 一个任务状态为 RUNNING 且 last_execute_time 距今超过 10 分钟，When Prometheus 抓取，Then `openclaw_task_stuck_running_total{task_name="CreateInstance"}` > 0

- [ ] **AC5:** Given Bypass checkTasks 成功获取锁并执行，When 检查 /metrics，Then `bypass_execution_total{bypass_name="checkTasks", result="executed"}` 计数 +1

- [ ] **AC6:** Given Bypass checkTasks 未能获取锁，When 检查 /metrics，Then `bypass_execution_total{bypass_name="checkTasks", result="lock_failed"}` 计数 +1

- [ ] **AC7:** Given Bypass checkTasks 重新投递了 3 个任务到 MQ，When 检查 /metrics，Then `bypass_compensated_tasks_total{bypass_name="checkTasks"}` 计数 +3

- [ ] **AC8:** Given DB 连接池有活跃连接，When 访问 /metrics，Then `openclaw_db_pool_open` > 0 且 `openclaw_db_pool_in_use` ≥ 0 且 `openclaw_db_pool_max_open` = 100（配置值）

- [ ] **AC9:** Given 本地监控栈启动（docker-compose），When Prometheus 加载 alert_rules.yml，Then 所有告警规则状态为 inactive（无触发），且规则列表显示 P0/P1/P2 共 10 条规则

- [ ] **AC10:** Given 告警规则已加载，When 检查任意告警规则，Then annotations 中包含 `runbook_url` 字段

#### Phase 2

- [ ] **AC11:** Given `pkg/log/fields.go` 已创建，When grep 搜索 `"tid"` 字符串，Then 在 processor.go 中不再出现，已替换为 `log.FieldTraceID`

- [ ] **AC12:** Given 沙箱适配器调用 CreateSandbox，When 查看 trace，Then 能看到 `SandboxAdapter.CreateSandbox` Span，且包含在父 Span（如 RunTask CreateInstance）的子链中

- [ ] **AC13:** Given 任务 execute_count 达到 max_execute_count，When 查看 trace，Then Span 上有 `task_exceeded_max_execute_count` 事件，含 execute_count 和 max_execute_count 属性

#### Phase 3

- [ ] **AC14:** Given Grafana Dashboard 加载后，When 查看顶部 Row 0，Then 显示 4 个 stat 面板（任务成功率、RUNNING 卡住数、重试逼近上限、DB 连接池使用率），各有红黄绿阈值

- [ ] **AC15:** Given 有任务失败数据，When 查看"异步任务" Row 的趋势图，Then `rate(task_failed_total[5m])` 趋势可见

- [ ] **AC16:** Given Prometheus 配置已更新，When 查看 Prometheus targets 页面，Then 显示 3 个 job（openclaw-api / openclaw-service / openclaw-bypass），状态均为 UP

---

## Additional Context

### Dependencies

- **Alertmanager Docker 镜像**: `prom/alertmanager:v0.27.0`
- **GORM DB Stats**: `gorm.DB` → `db.DB()` → `*sql.DB` → `Stats()` 返回 `sql.DBStats`（MaxOpenConnections, OpenConnections, InUse, Idle, WaitCount, WaitDuration）
- **go-redis PoolStats**: `redis.Client` → `PoolStats()` 返回 `*redis.PoolStats`（Hits, Misses, Timeouts, TotalConns, IdleConns, StaleConns）
- 无需新增外部 Go 依赖，所有功能基于现有库

### Testing Strategy

**自动化验证：**
- 启动本地监控栈：`cd deploy && docker-compose -f docker-compose.monitoring.yml up -d`
- 启动 CTL 三服务（API + Service + Bypass）
- 通过 `curl localhost:9591/metrics | grep openclaw_` 验证 API 服务指标
- 通过 `curl localhost:9592/metrics | grep openclaw_` 验证 Service 服务指标
- 通过 `curl localhost:9593/metrics | grep bypass_` 验证 Bypass 服务指标
- 访问 Prometheus UI (localhost:9090) 验证告警规则加载和 target 状态
- 访问 Grafana (localhost:3000) 验证 Dashboard 面板渲染

**手动验证：**
- 创建一个实例（触发 CreateInstance 任务），验证 task_success_total 增长
- 模拟任务失败（如关闭沙箱服务），验证 task_failed_total 增长 + P0 告警触发
- 检查天机阁 trace 链路，确认新增 Span 可见

**回归验证：**
- 运行现有 regression 脚本 `ctl/tools/regression_local_api.sh`，确认不影响现有功能
- 编译检查：`cd ctl && go build ./...`

### Notes

- CTL 三服务架构：API (port 9591) / Service (port 9592) / Bypass (新增 port 9593)
- 现有指标体系：8 个 OpenClaw 业务指标 + 3 个 Task 指标 + API middleware 指标 + 适配器指标
- OTel 集成天机阁，协议 gRPC/HTTP，AlwaysSample
- Prometheus 抓取间隔 15s
- Bypass 当前只有 checkTasks 一个定时任务，但框架支持注册多个
- Task 执行使用 Redis 分布式锁（`LockLogic.LockTask`），Bypass 也使用分布式锁（`LockLogic.LockBypass`）
- **风险项**：TaskGaugeCollector 的 SQL 查询可能在 tasks 表数据量大时变慢 → 已通过 5s 超时 + 7 天窗口限制缓解
- **未来扩展**：告警通道接入企微/蓝鲸 webhook、Runbook 文档编写、SLO/SLI 仪表板
