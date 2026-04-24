// Package metric ...
package metric

import "github.com/prometheus/client_golang/prometheus"

var (
	CgwAPIPanicCounter = prometheus.NewCounter(
		prometheus.CounterOpts{
			Name: "cgw_api_panic_total",
			Help: "cgw api panic total count",
		})
	CgwAPIErrorCounterVec = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "cgw_api_error_total",
			Help: "cgw api error count.",
		},
		[]string{"action", "code"})
	CgwAPILatencyHistogramVec = prometheus.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "cgw_api_latency_seconds",
			Help:    "cgw api latency seconds.",
			Buckets: []float64{0, 500, 1000, 5000},
		},
		[]string{"action"})
)
