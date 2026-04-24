# CTL 可观测性开发指引

本文件约束 `ctl` 的可观测性（Metrics / Logging / Tracing）开发规范。新增或修改可观测性相关代码时，Agent 应先阅读本文件。

## 1. 整体架构

CTL 三服务（API / Service / Bypass）共享同一套可观测性框架：

| 维度 | 技术栈 | 关键入口 |
|------|--------|----------|
| Metrics | Prometheus client_golang | `pkg/metric/` 定义，`main/*/main.go` 注册 |
| Logging | zap → container stdout → TKE `tke-log-agent` / `LogConfig` → CLS | `resource.ZapLogger` 全局，`ctx.Logger()` 带请求字段 |
| Tracing | OpenTelemetry → 天机阁 | `pkg/tracing/` 封装 |

三服务的 Prometheus metrics 端口：

| 服务 | 端口 | 配置项 |
|------|------|--------|
| API | 9591 | `[monitor.api]` |
| Service | 9592 | `[monitor.service]` |
| Bypass | 9593 | `[monitor.bypass]` |

## 2. Metrics 开发规范

### 2.1 文件组织

指标定义放在 `pkg/metric/` 下，**按领域拆文件**，不按服务拆：

| 文件 | 领域 | 示例指标 |
|------|------|----------|
| `task.go` | 异步任务 | `task_duration_seconds`, `task_failed_total`, `task_success_total` |
| `bypass.go` | Bypass 补偿 | `bypass_execution_total`, `bypass_compensated_tasks_total` |
| `instance.go` | OpenClaw 业务 + Collector | `openclaw_api_request_total`, `InstanceGaugeCollector`, `TaskGaugeCollector` |
| `infra.go` | 基础设施 | `DBPoolCollector`, `RedisPoolCollector` |
| `adapter.go` | 第三方适配器 | `adapter_request_total` |
| `api.go` | API 通用 | `api_request_total` |
| `cgw.go` | CGW 兼容 | `cgw_api_panic_total` |

### 2.2 新增指标的步骤

1. **定义**：在 `pkg/metric/` 对应领域文件中，用全局 `var` 声明 `prometheus.New*Vec`
2. **注册**：在 `main/*/main.go` 的 `common.InitMonitor()` 调用中，把新指标加入 `[]prometheus.Collector` 切片
3. **埋点**：在业务代码中调用 `.WithLabelValues(...).Inc()` / `.Observe()` 等
4. **告警**（可选）：在 `deploy/prometheus/alert_rules.yml` 添加对应的告警规则

### 2.3 命名规范

```
# OpenClaw 业务指标统一前缀 openclaw_
openclaw_api_request_total
openclaw_instance_create_total
openclaw_sandbox_api_duration_seconds
openclaw_remote_command_total
openclaw_remote_command_duration_seconds
openclaw_db_pool_in_use
openclaw_redis_pool_hits_total
openclaw_task_status_total

# 框架指标不带前缀（历史原因，保持兼容）
task_duration_seconds
task_failed_total
task_success_total
bypass_execution_total
```

### 2.4 标签控制

- `task_name` 使用枚举白名单，未知类型归到 `other`，防止标签基数爆炸
- API path 标签必须做归一化（如 `/v1/instances/ins-xxx` → `/v1/instances/{id}`），见 `server.go` 的 `normalizePath()`
- 禁止把用户 ID、实例 ID 等高基数值作为标签

### 2.5 Collector 模式

对需要实时查询 DB 的 Gauge 指标，使用自定义 Collector 模式（而非在业务代码中 Set）：

```go
type TaskGaugeCollector struct {
    desc *prometheus.Desc
    db   *gorm.DB
}

func (c *TaskGaugeCollector) Collect(ch chan<- prometheus.Metric) {
    // 每条查询使用独立的 2s 超时
    ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
    defer cancel()
    // 只查 7 天内的数据
    // ...
}
```

**关键约束**：
- 每条 SQL 使用独立的 `context.WithTimeout`（2s），不共享——避免级联超时
- SQL 必须加 `created_time > ?` 时间窗口限制（7 天），防止全表扫描
- `NewXxxCollector(db)` 在 `db == nil` 时 panic（与 `InstanceGaugeCollector` 一致）
- `TaskGaugeCollector` **只注册在 Bypass 服务**，避免三服务重复查同一张表

### 2.6 指标注册分布

| 指标 | API | Service | Bypass |
|------|-----|---------|--------|
| OpenClaw 业务指标 (`openclaw_api_*`, `openclaw_instance_*`, `openclaw_sandbox_*`, `openclaw_remote_command_*`) | ✅ | ✅ | |
| `InstanceGaugeCollector` | ✅ | | |
| Task Counter/Histogram (`task_*`) | | ✅ | |
| `TaskGaugeCollector` | | | ✅ |
| Bypass 指标 (`bypass_*`) | | | ✅ |
| Churn Guard / 池压力指标 (`openclaw_instance_churn_guard_*`, `openclaw_instance_pool_pressure_*`) | ✅ | `user_churn_events` | ✅ |
| `DBPoolCollector` | ✅ | ✅ | ✅ |
| `RedisPoolCollector` | ✅ | ✅ | ✅ |
| Go runtime / Process collectors | ✅ | | |

## 3. Logging 开发规范

K8s 测试环境中的 `ctl` 日志默认通过容器 `stdout` 采集到 CLS，应用本身不持有 CLS 写入凭据。对应采集清单位于 `ctl/k8s/base/cls-logconfig.yaml`，环境发布通过 `ctl/k8s/overlays/<env>` 下发。

### 3.1 字段常量

所有日志字段名必须使用 `pkg/log/fields.go` 中定义的常量：

```go
import logfields "ctl/pkg/log"

logger.Info("http request",
    zap.String(logfields.FieldMethod, r.Method),
    zap.String(logfields.FieldPath, r.URL.Path),
    zap.Int(logfields.FieldStatusCode, statusCode),
)
```

**已定义的字段常量**：`FieldTraceID`, `FieldUserID`, `FieldAction`, `FieldTaskID`, `FieldTaskName`, `FieldTaskState`, `FieldBypassName`, `FieldLatencyMs`, `FieldStatusCode`, `FieldInstanceID`, `FieldSandboxID`, `FieldMethod`, `FieldPath`, `FieldError`

### 3.2 新增字段

新增日志字段时，先在 `pkg/log/fields.go` 定义常量，然后在代码中引用。禁止在业务代码中硬编码字段名字符串。

### 3.3 上下文日志

- API：`ctx.Logger()` 自动携带 `trace_id`, `user_id`, `action`
- Service：processor 在 `newContext()` 中注入 `trace_id`, `task_name`, `task_id`
- Bypass：`ctx.SetAction(b.name)` 注入 `bypass_name`

### 3.4 输出约束

- K8s 环境保持 JSON 日志输出，避免切回 console / color 格式
- K8s 环境保持日志路径为 `/dev/stdout`，不要改为只写容器内文件
- 若新增 `ctl` workload，需要同步补 `ctl/k8s/base/cls-logconfig.yaml`，否则不会进入 CLS

## 4. Tracing 开发规范

### 4.1 自定义 Context vs 标准 Context

CTL 有两套 tracing 入口：

| 场景 | 函数 | Context 类型 |
|------|------|-------------|
| 业务逻辑层（有自定义 ctx） | `tracing.StartTrace(ctx, spanName)` | `context.Context`（自定义包） |
| 适配器/外部调用层（标准 ctx） | `otel.Tracer("ctl/pkg/adapter/sandbox").Start(ctx, spanName)` | `context.Context`（标准库） |

### 4.2 Span 模式

使用命名返回值捕获 error，确保 Span 能正确反映成功/失败：

```go
// ✅ 正确：命名返回值 + defer
func (a *Adapter) DoSomething(ctx context.Context) (resp *Resp, err error) {
    ctx, span := otel.Tracer("ctl/pkg/adapter/xxx").Start(ctx, "Adapter.DoSomething")
    defer func() { endSpanWithError(span, err) }()
    // ...
}

// ❌ 错误：固定 nil → Span 永远标记为成功
defer func() { span.EndWithError(nil) }()
```

### 4.3 Span 边界原则

- 只在**关键路径**加 Span：跨服务调用、DB 事务、任务生命周期关键决策点
- 不在框架步骤（`LockTask`/`UnlockTask`）加 Span——`TaskFlow Runner` 已通过 `StartTraceForFramework` 覆盖
- 适配器方法层加 Span，HTTP client 层不加（避免双重 Span）

### 4.4 Span 属性

- 使用 `tracing.SpanAttributeKey*` 常量：`SpanAttributeKeyTaskName`, `SpanAttributeKeyTaskState`, `SpanAttributeKeyBypassName` 等
- 关键业务事件用 `span.AddEvent()`，例如任务超限：
  ```go
  span.AddEvent("task_exceeded_max_execute_count", trace.WithAttributes(
      attribute.Int("execute_count", t.TaskEntity.ExecuteCount),
  ))
  ```

## 5. Bypass 指标埋点规范

Bypass 框架（`baseBypass.runPeriod()`）的埋点位置：

```
runPeriod() 开始
  └── LockBypass
       ├── 失败 → BypassExecutionTotal{result="lock_failed"}.Inc()
       ├── 出错 → BypassExecutionTotal{result="error"}.Inc()
       └── 成功 → execStart = time.Now()  // lock 成功后才开始计时
            └── preRunFunc → runFunc (包裹在 recover 中) → postRunFunc
                 ├── panic → BypassExecutionTotal{result="error"}.Inc()
                 └── 正常 → BypassExecutionTotal{result="executed"}.Inc()
                            BypassExecutionDuration.Observe(since(execStart))
            └── UnlockBypass (错误用独立变量，不污染 Span err)
```

**关键约束**：
- `runFunc` 必须包裹在 `recover()` 中，防止 panic 导致 bypass goroutine 静默死亡
- duration 在 lock 成功后才开始计时，不包含等待锁时间
- UnlockBypass 的错误使用独立变量 `unlockErr`，不覆盖外层 `err`，避免误标 Span 状态

## 6. 告警规则开发规范

### 6.1 分层

| 级别 | 含义 | `repeat_interval` |
|------|------|-------------------|
| P0 | 立即响应 | 15m |
| P1 | 30 分钟内处理 | 1h |
| P2 | 工作时间处理 | 4h |

### 6.2 告警规则格式

每条规则必须包含：
- `severity` label（P0/P1/P2）
- `annotations.summary`
- `annotations.description`（含 `{{ $value }}` 模板）
- `annotations.runbook_url`

### 6.3 PromQL 注意事项

- 比率计算必须加除零保护：`sum(rate(xxx[5m])) / (sum(rate(yyy[5m])) > 0) > threshold`
- `rate()` 窗口至少是 scrape interval 的 4 倍（当前 scrape 15s，rate 窗口最小用 1m）

告警规则文件位置：`deploy/prometheus/alert_rules.yml`

## 7. 监控栈与 Dashboard

### 7.1 启动

本地开发**默认不要求**启动 Prometheus / Grafana。当前以测试环境托管 Prometheus + 托管 Grafana 为主，只有在本机手工调试面板或告警时，才需要拉起本地监控栈。

```bash
# 启动基础设施（MySQL + Redis + Prometheus + Grafana + Alertmanager）
cd ctl/conf/local && docker compose up -d

# 启动三服务
./conf/local/services.sh start

# 查看状态
./conf/local/services.sh status

# 停止
./conf/local/services.sh stop
```

### 7.2 访问地址

| 服务 | 地址 |
|------|------|
| Grafana | http://localhost:3000（免登录，Dashboard 在 OpenClaw 文件夹） |
| Prometheus | http://localhost:9090（查看 targets / 告警规则 / PromQL） |
| Alertmanager | http://localhost:9093 |

### 7.3 Dashboard 修改

测试环境主 Dashboard 在 `infra_pulumi/observability/beijing-sandbox/grafana/ctl-overview.json`。该文件是实际托管 Grafana 使用的版本，修改后应按 [infra-grafana-dashboard-guide.md](infra-grafana-dashboard-guide.md) 重新导入。

本地模板仍位于 `ctl/deploy/grafana/dashboards/openclaw-overview.json`（API/实例/沙箱）和 `deploy/grafana/dashboards/openclaw-overview.json`（任务/Bypass/连接池），但它们不再意味着本地必须运行 Grafana；只有在需要本地预览面板时，才需要同步更新 `ctl/conf/local/grafana/dashboards/openclaw-overview.json` 并重启本地 Grafana。

当前 `ctl-overview` 已新增 `Churn Guard / Pool Pressure` 分区，重点看三类信号：

- 创建保护是否在放量拒绝：`openclaw_instance_churn_guard_eval_total`、`openclaw_instance_create_rejections_total`
- 候选池库存是否在被打空：`openclaw_instance_pool_pressure_clean|creating|dry|resetting|desired`
- 当前是否处于全局热态：`openclaw_instance_pool_pressure_state`、`openclaw_instance_pool_pressure_hot_transitions_total`

开发或排障时要记住：

- `openclaw_instance_pool_pressure_*` 由 `ctl-bypass` 的 `checkPoolPressure` 周期任务刷新；如果这类面板全空，先查 bypass 是否在跑
- `openclaw_instance_user_churn_events_total` 只记录事件类型，不带 `user_id` 标签，避免高基数把 Prometheus 变成火药桶

## 8. Checklist — 新增可观测性时

- [ ] 指标定义在 `pkg/metric/` 对应领域文件
- [ ] 指标已在对应服务的 `main/*/main.go` 中注册
- [ ] 标签无高基数风险
- [ ] 日志字段使用 `pkg/log/fields.go` 常量
- [ ] Tracing Span 使用命名返回值 + `defer`
- [ ] Bypass 埋点在 `recover()` 保护内
- [ ] Collector 的 SQL 有独立超时 + 时间窗口限制
- [ ] 告警规则有 severity + summary + description + runbook_url
- [ ] PromQL 比率计算有除零保护
- [ ] 托管 Dashboard（`infra_pulumi/.../ctl-overview.json`）已同步更新并重新导入
- [ ] 若仍使用本地监控栈验证面板，再同步本地 Dashboard
- [ ] `ctl/conf/local/common/server_conf.toml` 和 `ctl/conf/server/common/server_conf.toml` 配置同步
