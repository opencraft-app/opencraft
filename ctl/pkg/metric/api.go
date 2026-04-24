// Package metric ...
package metric

import (
	"github.com/prometheus/client_golang/prometheus"
)

var (
	APIRequestTotalCounterVec = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "api_request_total",
		},
		[]string{"action"})

	APIRequestErrorTotalCounterVec = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "api_request_error_total",
		},
		[]string{"action", "code"})

	APILatencyHistogramVec = prometheus.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "api_latency_milliseconds",
			Buckets: []float64{0, 100, 500, 1000, 5000},
		},
		[]string{"action"})
)
