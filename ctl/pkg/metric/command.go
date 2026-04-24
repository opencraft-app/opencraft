package metric

import (
	"strings"

	"github.com/prometheus/client_golang/prometheus"
)

var (
	RemoteCommandTotalCounterVec = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "openclaw_remote_command_total",
			Help: "Total remote command executions by command kind and result",
		},
		[]string{"command_kind", "result"},
	)

	RemoteCommandDurationHistogramVec = prometheus.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "openclaw_remote_command_duration_seconds",
			Help:    "Remote command execution duration in seconds by command kind and result",
			Buckets: []float64{0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300},
		},
		[]string{"command_kind", "result"},
	)

	RemoteCommandInflightGaugeVec = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "openclaw_remote_command_inflight",
			Help: "Current in-flight remote commands by command kind",
		},
		[]string{"command_kind"},
	)
)

func RecordRemoteCommand(commandKind, result string, durationSeconds float64) {
	commandKind = normalizeMetricLabel(commandKind)
	result = normalizeMetricLabel(result)

	RemoteCommandTotalCounterVec.WithLabelValues(commandKind, result).Inc()
	RemoteCommandDurationHistogramVec.WithLabelValues(commandKind, result).Observe(durationSeconds)
}

func normalizeMetricLabel(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return "unknown"
	}
	return value
}
