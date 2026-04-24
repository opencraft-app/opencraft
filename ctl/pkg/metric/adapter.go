// Package metric ...
package metric

import (
	"github.com/prometheus/client_golang/prometheus"
)

var (
	AdapterRequestTotalCounterVec = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "adapter_request_total",
		},
		[]string{"service", "action"})

	AdapterRequestErrorTotalCounterVec = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "adapter_request_error_total",
		},
		[]string{"service", "action", "code"})

	AdapterLatencyHistogramVec = prometheus.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "adapter_latency_milliseconds",
			Buckets: []float64{0, 100, 500, 1000, 5000},
		},
		[]string{"service", "action"})
)
