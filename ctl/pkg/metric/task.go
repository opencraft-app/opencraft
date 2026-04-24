// Package metric ...
package metric

import (
	"github.com/prometheus/client_golang/prometheus"
)

var (
	TaskDurationHistogramVec = prometheus.NewHistogramVec(
		prometheus.HistogramOpts{
			Name: "task_duration_seconds",
			Buckets: []float64{0, 30, 60, 120, 300, 600, 1200,
				1800, 2400, 3600, 7200, 14400},
		},
		[]string{"task"})

	TaskFailedTotalCounterVec = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "task_failed_total",
		},
		[]string{"task"})

	TaskSuccessTotalCounterVec = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "task_success_total",
			Help: "Total count of successfully completed tasks",
		},
		[]string{"task"})

	TaskRunningCountGaugeVec = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "task_running_count",
		},
		[]string{"task"})
)
