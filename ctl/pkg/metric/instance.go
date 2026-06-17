// Package metric provides Prometheus metrics for OpenClaw.
package metric

import (
	"context"
	"strconv"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"gorm.io/gorm"
)

// OpenClaw 业务指标 - 用于监控 API 请求、实例创建和沙箱调用

var (
	// API 请求指标
	// OpenClawAPIRequestTotal 记录 API 请求总数，按 method、path、status_code 分类
	OpenClawAPIRequestTotal = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "openclaw_api_request_total",
			Help: "Total API requests by method, path and status code",
		},
		[]string{"method", "path", "status_code"},
	)

	// OpenClawAPIRequestDuration 记录 API 延迟分布（秒）
	OpenClawAPIRequestDuration = prometheus.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "openclaw_api_request_duration_seconds",
			Help:    "API request duration in seconds",
			Buckets: []float64{0.01, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0},
		},
		[]string{"method", "path"},
	)

	// 实例创建指标
	// OpenClawInstanceCreateTotal 记录实例创建尝试次数，按结果、模板 ID 与实例规格 ID 分类
	// spec_id label：设计稿 Q-METRIC-1=a，未知/未解析时填 "unknown"
	OpenClawInstanceCreateTotal = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "openclaw_instance_create_total",
			Help: "Total instance creation attempts by result, template and instance spec",
		},
		[]string{"result", "template_id", "spec_id"},
	)

	// OpenClawInstanceCreateDuration 记录实例创建耗时（端到端，含沙箱调用）
	OpenClawInstanceCreateDuration = prometheus.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "openclaw_instance_create_duration_seconds",
			Help:    "Instance creation duration in seconds (end-to-end)",
			Buckets: []float64{1, 2, 5, 10, 15, 20, 30, 45, 60},
		},
		[]string{"result"},
	)

	// 沙箱 API 调用指标
	// OpenClawSandboxAPITotal 记录沙箱 API 调用次数，按 action 和结果分类
	OpenClawSandboxAPITotal = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "openclaw_sandbox_api_total",
			Help: "Total sandbox API calls by action and result",
		},
		[]string{"action", "result"},
	)

	// OpenClawSandboxAPIDuration 记录沙箱 API 调用延迟（秒）
	OpenClawSandboxAPIDuration = prometheus.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "openclaw_sandbox_api_duration_seconds",
			Help:    "Sandbox API call duration in seconds",
			Buckets: []float64{0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0},
		},
		[]string{"action"},
	)

	OpenClawInstanceCreateRejectionsTotal = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "openclaw_instance_create_rejections_total",
			Help: "Total rejected instance create requests by reason",
		},
		[]string{"reason"},
	)

	OpenClawInstanceChurnGuardEvalTotal = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "openclaw_instance_churn_guard_eval_total",
			Help: "Total churn guard evaluations by result",
		},
		[]string{"result"},
	)

	OpenClawInstanceChurnGuardRetryAfter = prometheus.NewGauge(
		prometheus.GaugeOpts{
			Name: "openclaw_instance_churn_guard_retry_after_seconds",
			Help: "Latest retry-after value emitted by the churn guard",
		},
	)

	OpenClawInstanceUserChurnEventsTotal = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "openclaw_instance_user_churn_events_total",
			Help: "Total churn-related user lifecycle events by event type",
		},
		[]string{"event_type"},
	)

	OpenClawInstanceUserAbuseGuardEvalTotal = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "openclaw_instance_user_abuse_guard_eval_total",
			Help: "Total per-user abuse guard evaluations by result",
		},
		[]string{"result"},
	)

	OpenClawInstanceUserAbuseCooldownsTotal = prometheus.NewCounter(
		prometheus.CounterOpts{
			Name: "openclaw_instance_user_abuse_cooldowns_total",
			Help: "Total per-user abuse cooldowns started",
		},
	)

	OpenClawInstanceUserAbuseActiveCooldowns = prometheus.NewGauge(
		prometheus.GaugeOpts{
			Name: "openclaw_instance_user_abuse_active_cooldowns",
			Help: "Current number of users under abuse cooldown",
		},
	)

	OpenClawInstancePoolPressureState = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "openclaw_instance_pool_pressure_state",
			Help: "Current global pool pressure state by state label (hot/cold)",
		},
		[]string{"state"},
	)

	OpenClawInstancePoolPressureClean = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "openclaw_instance_pool_pressure_clean",
			Help: "Current CLEAN inventory per pool tracked by churn guard",
		},
		[]string{"pool_id"},
	)

	OpenClawInstancePoolPressureCreating = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "openclaw_instance_pool_pressure_creating",
			Help: "Current CREATING inventory per pool tracked by churn guard",
		},
		[]string{"pool_id"},
	)

	OpenClawInstancePoolPressureAllocated = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "openclaw_instance_pool_pressure_allocated",
			Help: "Current ALLOCATED inventory per pool tracked by churn guard",
		},
		[]string{"pool_id"},
	)

	OpenClawInstancePoolPressureDry = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "openclaw_instance_pool_pressure_dry",
			Help: "Current DRY inventory per pool tracked by churn guard",
		},
		[]string{"pool_id"},
	)

	OpenClawInstancePoolPressureResetting = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "openclaw_instance_pool_pressure_resetting",
			Help: "Current RESETTING inventory per pool tracked by churn guard",
		},
		[]string{"pool_id"},
	)

	OpenClawInstancePoolPressureDesired = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "openclaw_instance_pool_pressure_desired",
			Help: "Configured desired_capacity per pool tracked by churn guard",
		},
		[]string{"pool_id"},
	)

	OpenClawInstancePoolPressureHotTransitionsTotal = prometheus.NewCounter(
		prometheus.CounterOpts{
			Name: "openclaw_instance_pool_pressure_hot_transitions_total",
			Help: "Total transitions from cold to hot pool pressure state",
		},
	)
)

// InstanceGaugeCollector 实现 prometheus.Collector，每次抓取时实时查询 DB 获取实例状态分布
type InstanceGaugeCollector struct {
	desc *prometheus.Desc
	db   *gorm.DB
}

// NewInstanceGaugeCollector 创建实例状态 Gauge Collector
// db 不能为 nil，否则会 panic
func NewInstanceGaugeCollector(db *gorm.DB) *InstanceGaugeCollector {
	if db == nil {
		panic("NewInstanceGaugeCollector: db cannot be nil")
	}
	return &InstanceGaugeCollector{
		desc: prometheus.NewDesc(
			"openclaw_instance_total",
			"Current instance count by status",
			[]string{"status"}, nil,
		),
		db: db,
	}
}

// Describe 实现 prometheus.Collector 接口
func (c *InstanceGaugeCollector) Describe(ch chan<- *prometheus.Desc) {
	ch <- c.desc
}

// Collect 实现 prometheus.Collector 接口，每次 Prometheus 抓取时实时查询 DB
// 使用 5 秒超时防止阻塞 Prometheus 抓取
func (c *InstanceGaugeCollector) Collect(ch chan<- prometheus.Metric) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	type statusCount struct {
		Status string
		Count  float64
	}
	var results []statusCount

	err := c.db.WithContext(ctx).
		Raw("SELECT status, COUNT(*) as count FROM instances WHERE deleted_at IS NULL GROUP BY status").
		Scan(&results).Error
	if err != nil {
		// 查询失败时发送无效指标，避免 Prometheus 抓取失败
		ch <- prometheus.NewInvalidMetric(c.desc, err)
		return
	}

	for _, r := range results {
		ch <- prometheus.MustNewConstMetric(c.desc, prometheus.GaugeValue, r.Count, r.Status)
	}
}

// TaskGaugeCollector 实现 prometheus.Collector，每次抓取时实时查询 DB 获取任务状态分布
type TaskGaugeCollector struct {
	statusDesc         *prometheus.Desc
	retryNearLimitDesc *prometheus.Desc
	stuckRunningDesc   *prometheus.Desc
	db                 *gorm.DB
}

// NewTaskGaugeCollector 创建任务状态 Gauge Collector
// db 不能为 nil，否则会 panic
func NewTaskGaugeCollector(db *gorm.DB) *TaskGaugeCollector {
	if db == nil {
		panic("NewTaskGaugeCollector: db cannot be nil")
	}
	return &TaskGaugeCollector{
		statusDesc: prometheus.NewDesc(
			"openclaw_task_status_total",
			"Current task count by task_name and status",
			[]string{"task_name", "status"}, nil,
		),
		retryNearLimitDesc: prometheus.NewDesc(
			"openclaw_task_retry_near_limit_total",
			"Tasks with execute_count >= 80% of max_execute_count and not completed",
			[]string{"task_name"}, nil,
		),
		stuckRunningDesc: prometheus.NewDesc(
			"openclaw_task_stuck_running_total",
			"Tasks stuck in RUNNING state for more than 10 minutes",
			[]string{"task_name"}, nil,
		),
		db: db,
	}
}

// Describe 实现 prometheus.Collector 接口
func (c *TaskGaugeCollector) Describe(ch chan<- *prometheus.Desc) {
	ch <- c.statusDesc
	ch <- c.retryNearLimitDesc
	ch <- c.stuckRunningDesc
}

// Collect 实现 prometheus.Collector 接口，每次 Prometheus 抓取时实时查询 DB
// 每条查询使用独立的 2s 超时防止级联超时，只查 7 天内的任务
func (c *TaskGaugeCollector) Collect(ch chan<- prometheus.Metric) {
	minTime := time.Now().AddDate(0, 0, -7)
	const queryTimeout = 2 * time.Second

	// Query 1: 按 task_name + status 聚合任务数量
	func() {
		ctx, cancel := context.WithTimeout(context.Background(), queryTimeout)
		defer cancel()
		type statusCount struct {
			TaskName string
			Status   string
			Count    float64
		}
		var results []statusCount
		err := c.db.WithContext(ctx).
			Raw("SELECT task_name, task_state AS status, COUNT(*) AS count FROM tasks WHERE created_time > ? GROUP BY task_name, task_state", minTime).
			Scan(&results).Error
		if err != nil {
			ch <- prometheus.NewInvalidMetric(c.statusDesc, err)
			return
		}
		for _, r := range results {
			ch <- prometheus.MustNewConstMetric(c.statusDesc, prometheus.GaugeValue, r.Count, r.TaskName, r.Status)
		}
	}()

	// Query 2: 重试次数逼近上限的任务（利用 task_state 索引先缩小范围）
	func() {
		ctx, cancel := context.WithTimeout(context.Background(), queryTimeout)
		defer cancel()
		type nameCount struct {
			TaskName string
			Count    float64
		}
		var results []nameCount
		err := c.db.WithContext(ctx).
			Raw("SELECT task_name, COUNT(*) AS count FROM tasks WHERE created_time > ? AND task_state IN ('CREATED','RUNNING') AND execute_count >= FLOOR(max_execute_count * 0.8) GROUP BY task_name", minTime).
			Scan(&results).Error
		if err != nil {
			ch <- prometheus.NewInvalidMetric(c.retryNearLimitDesc, err)
			return
		}
		for _, r := range results {
			ch <- prometheus.MustNewConstMetric(c.retryNearLimitDesc, prometheus.GaugeValue, r.Count, r.TaskName)
		}
	}()

	// Query 3: 卡在 RUNNING 超过 10 分钟的任务（利用 task_state + last_execute_time 索引）
	func() {
		ctx, cancel := context.WithTimeout(context.Background(), queryTimeout)
		defer cancel()
		type nameCount struct {
			TaskName string
			Count    float64
		}
		stuckThreshold := time.Now().Add(-10 * time.Minute)
		var results []nameCount
		err := c.db.WithContext(ctx).
			Raw("SELECT task_name, COUNT(*) AS count FROM tasks WHERE created_time > ? AND task_state = 'RUNNING' AND last_execute_time < ? GROUP BY task_name", minTime, stuckThreshold).
			Scan(&results).Error
		if err != nil {
			ch <- prometheus.NewInvalidMetric(c.stuckRunningDesc, err)
			return
		}
		for _, r := range results {
			ch <- prometheus.MustNewConstMetric(c.stuckRunningDesc, prometheus.GaugeValue, r.Count, r.TaskName)
		}
	}()
}

// 辅助函数 - 封装常用埋点模式

// RecordSandboxAPICall 记录沙箱 API 调用指标（计数 + 延迟）
func RecordSandboxAPICall(action string, durationSeconds float64, err error) {
	result := "success"
	if err != nil {
		result = "fail"
	}
	OpenClawSandboxAPITotal.WithLabelValues(action, result).Inc()
	OpenClawSandboxAPIDuration.WithLabelValues(action).Observe(durationSeconds)
}

// RecordInstanceCreate 记录实例创建指标（计数 + 延迟）
// templateID 为空时使用 "unknown" 防止高基数空标签
// RecordInstanceCreate 记录实例创建指标（计数 + 延迟）。
//
// specID 为本次创建请求对应的实例规格 ID（设计稿 Q-METRIC-1=a）。空字符串 / 未知
// 时会被折叠为 "unknown" 以表示「未从 bundle 反查到 spec」（例如 churn-guard 拦截、pass
// 状态拦截等与规格无关的拒绝路径）。
func RecordInstanceCreate(result string, templateID string, specID string, durationSeconds float64) {
	if templateID == "" {
		templateID = "unknown"
	}
	if specID == "" {
		specID = "unknown"
	}
	OpenClawInstanceCreateTotal.WithLabelValues(result, templateID, specID).Inc()
	if durationSeconds > 0 {
		OpenClawInstanceCreateDuration.WithLabelValues(result).Observe(durationSeconds)
	}
}

// RecordAPIRequest 记录 API 请求指标（计数 + 延迟）
func RecordAPIRequest(method string, normalizedPath string, statusCode int, durationSeconds float64) {
	OpenClawAPIRequestTotal.WithLabelValues(method, normalizedPath, strconv.Itoa(statusCode)).Inc()
	OpenClawAPIRequestDuration.WithLabelValues(method, normalizedPath).Observe(durationSeconds)
}
