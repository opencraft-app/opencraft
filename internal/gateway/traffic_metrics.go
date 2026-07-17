package gateway

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
	"sync"
)

type TrafficMetrics struct {
	mu       sync.Mutex
	traffic  map[trafficMetricLabels]trafficMetricValue
	keyRoute map[string]int64
}

type trafficMetricLabels struct {
	ExternalKeyID         string
	ExternalKeyHashPrefix string
	SetID                 string
	Status                int
	UpstreamStatus        int
	Streaming             bool
	ErrorType             string
}

type trafficMetricValue struct {
	RequestsTotal int64
	DurationMSSum int64
}

func NewTrafficMetrics() *TrafficMetrics {
	return &TrafficMetrics{
		traffic:  map[trafficMetricLabels]trafficMetricValue{},
		keyRoute: map[string]int64{},
	}
}

func (m *TrafficMetrics) Record(entry AccessLog) {
	if m == nil {
		return
	}
	labels := trafficMetricLabels{
		ExternalKeyID:         entry.ExternalKeyID,
		ExternalKeyHashPrefix: entry.ExternalKeyHashPrefix,
		SetID:                 entry.SetID,
		Status:                entry.Status,
		UpstreamStatus:        entry.UpstreamStatus,
		Streaming:             entry.Streaming,
		ErrorType:             entry.ErrorType,
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	value := m.traffic[labels]
	value.RequestsTotal++
	if entry.DurationMS > 0 {
		value.DurationMSSum += entry.DurationMS
	}
	m.traffic[labels] = value
}

func (m *TrafficMetrics) RecordKeyRouteLookup(result string) {
	if m == nil {
		return
	}
	if result == "" {
		result = "unknown"
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.keyRoute[result]++
}

func (m *TrafficMetrics) ErrorSummaries() []TrafficErrorSummary {
	if m == nil {
		return nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	summaries := make([]TrafficErrorSummary, 0)
	for labels, value := range m.traffic {
		if labels.ErrorType == "" && labels.Status < 500 && labels.UpstreamStatus < 500 {
			continue
		}
		summaries = append(summaries, TrafficErrorSummary{
			SetID:          labels.SetID,
			Status:         labels.Status,
			UpstreamStatus: labels.UpstreamStatus,
			ErrorType:      labels.ErrorType,
			Count:          value.RequestsTotal,
		})
	}
	sort.Slice(summaries, func(i, j int) bool {
		if summaries[i].Count != summaries[j].Count {
			return summaries[i].Count > summaries[j].Count
		}
		if summaries[i].SetID != summaries[j].SetID {
			return summaries[i].SetID < summaries[j].SetID
		}
		if summaries[i].Status != summaries[j].Status {
			return summaries[i].Status < summaries[j].Status
		}
		return summaries[i].ErrorType < summaries[j].ErrorType
	})
	return summaries
}

func (m *TrafficMetrics) PrometheusText() string {
	if m == nil {
		return ""
	}
	m.mu.Lock()
	snapshots := make([]struct {
		labels trafficMetricLabels
		value  trafficMetricValue
	}, 0, len(m.traffic))
	for labels, value := range m.traffic {
		snapshots = append(snapshots, struct {
			labels trafficMetricLabels
			value  trafficMetricValue
		}{labels: labels, value: value})
	}
	keyRoute := make(map[string]int64, len(m.keyRoute))
	for result, count := range m.keyRoute {
		keyRoute[result] = count
	}
	m.mu.Unlock()
	sort.Slice(snapshots, func(i, j int) bool {
		return prometheusTrafficLabels(snapshots[i].labels) < prometheusTrafficLabels(snapshots[j].labels)
	})

	var b strings.Builder
	b.WriteString("# HELP llmgateway_traffic_requests_total Total proxied traffic requests by routing and upstream result.\n")
	b.WriteString("# TYPE llmgateway_traffic_requests_total counter\n")
	for _, snapshot := range snapshots {
		fmt.Fprintf(&b, "llmgateway_traffic_requests_total{%s} %d\n", prometheusTrafficLabels(snapshot.labels), snapshot.value.RequestsTotal)
	}
	b.WriteString("# HELP llmgateway_traffic_duration_ms_sum Sum of proxied request durations in milliseconds.\n")
	b.WriteString("# TYPE llmgateway_traffic_duration_ms_sum counter\n")
	for _, snapshot := range snapshots {
		fmt.Fprintf(&b, "llmgateway_traffic_duration_ms_sum{%s} %d\n", prometheusTrafficLabels(snapshot.labels), snapshot.value.DurationMSSum)
	}
	b.WriteString("# HELP llmgateway_traffic_duration_ms_count Count of proxied request duration observations.\n")
	b.WriteString("# TYPE llmgateway_traffic_duration_ms_count counter\n")
	for _, snapshot := range snapshots {
		fmt.Fprintf(&b, "llmgateway_traffic_duration_ms_count{%s} %d\n", prometheusTrafficLabels(snapshot.labels), snapshot.value.RequestsTotal)
	}
	b.WriteString("# HELP llmgateway_key_route_cache_total Key route cache lookup results.\n")
	b.WriteString("# TYPE llmgateway_key_route_cache_total counter\n")
	keyRouteResults := make([]string, 0, len(keyRoute))
	for result := range keyRoute {
		keyRouteResults = append(keyRouteResults, result)
	}
	sort.Strings(keyRouteResults)
	for _, result := range keyRouteResults {
		fmt.Fprintf(&b, "llmgateway_key_route_cache_total{result=\"%s\"} %d\n", prometheusLabelValue(result), keyRoute[result])
	}
	return b.String()
}

func prometheusTrafficLabels(labels trafficMetricLabels) string {
	parts := []string{
		`external_key_id="` + prometheusLabelValue(labels.ExternalKeyID) + `"`,
		`external_key_hash_prefix="` + prometheusLabelValue(labels.ExternalKeyHashPrefix) + `"`,
		`set_id="` + prometheusLabelValue(labels.SetID) + `"`,
		`status="` + strconv.Itoa(labels.Status) + `"`,
		`upstream_status="` + strconv.Itoa(labels.UpstreamStatus) + `"`,
		`streaming="` + strconv.FormatBool(labels.Streaming) + `"`,
		`error_type="` + prometheusLabelValue(labels.ErrorType) + `"`,
	}
	return strings.Join(parts, ",")
}

func prometheusLabelValue(value string) string {
	value = strings.ReplaceAll(value, `\`, `\\`)
	value = strings.ReplaceAll(value, "\n", `\n`)
	value = strings.ReplaceAll(value, `"`, `\"`)
	return value
}
