// Package metric 提供 Bypass 相关的 Prometheus 指标定义
package metric

import (
	"github.com/prometheus/client_golang/prometheus"
)

var (
	// BypassExecutionTotalCounterVec 记录 Bypass 执行次数，按 bypass_name 和 result 分类
	// result 枚举：executed / lock_failed / error
	BypassExecutionTotalCounterVec = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "bypass_execution_total",
			Help: "Total bypass execution attempts by name and result",
		},
		[]string{"bypass_name", "result"},
	)

	// BypassCompensatedTasksTotalCounterVec 记录 Bypass 每轮补偿（重新投递到 MQ）的任务数
	BypassCompensatedTasksTotalCounterVec = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "bypass_compensated_tasks_total",
			Help: "Total tasks compensated (re-enqueued) by bypass",
		},
		[]string{"bypass_name"},
	)

	// BypassExecutionDurationHistogramVec 记录 Bypass 每轮执行耗时（秒）
	BypassExecutionDurationHistogramVec = prometheus.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "bypass_execution_duration_seconds",
			Help:    "Bypass execution duration in seconds",
			Buckets: []float64{0.1, 0.5, 1, 2, 5, 10, 30, 60},
		},
		[]string{"bypass_name"},
	)
)
