package cellreporter

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type FDBCapacityEvidence struct {
	HeadroomBytes           int64
	LogicalBytes            int64
	HeadroomSamples         int64
	ETASeconds              int64
	ETAKnown                bool
	WriteUtilizationPercent int64
	DataMovementBytes       int64
}

// CollectFDBCapacity reads one Cell's capacity evidence from the shared
// cluster Prometheus. Every query is bound to Config.CellName and fails closed
// unless Prometheus returns exactly one sample.
func (r *Reporter) CollectFDBCapacity(ctx context.Context) (FDBCapacityEvidence, error) {
	return r.prometheusCapacity(ctx)
}

func (r *Reporter) prometheusCapacity(ctx context.Context) (FDBCapacityEvidence, error) {
	cell := strconv.Quote(r.Config.CellName)
	query := func(metric string) (float64, error) {
		return r.prometheusScalar(ctx, metric+"{cell="+cell+"}")
	}
	headroom, err := query("actor:fdb_storage_headroom_bytes")
	if err != nil {
		return FDBCapacityEvidence{}, err
	}
	logicalBytes, err := query("actor_fleet:cell_fdb_logical_bytes")
	if err != nil {
		return FDBCapacityEvidence{}, err
	}
	samples, err := query("actor:fdb_storage_headroom_samples:6h")
	if err != nil {
		return FDBCapacityEvidence{}, err
	}
	writeUtilization, err := query("actor:fdb_write_utilization:ratio")
	if err != nil {
		return FDBCapacityEvidence{}, err
	}
	dataMovement, err := query("actor:fdb_data_movement_bytes")
	if err != nil {
		return FDBCapacityEvidence{}, err
	}
	eta, etaErr := query("actor:fdb_storage_headroom_eta_seconds")
	if headroom < 0 || logicalBytes < 0 || samples < 0 || writeUtilization < 0 || writeUtilization > 1 || dataMovement < 0 {
		return FDBCapacityEvidence{}, fmt.Errorf("Prometheus capacity evidence is outside its valid range")
	}
	evidence := FDBCapacityEvidence{
		HeadroomBytes:           int64(headroom),
		LogicalBytes:            int64(logicalBytes),
		HeadroomSamples:         int64(samples),
		WriteUtilizationPercent: int64(math.Ceil(writeUtilization * 100)),
		DataMovementBytes:       int64(dataMovement),
	}
	if etaErr == nil && !math.IsInf(eta, 0) && !math.IsNaN(eta) && eta >= 0 {
		evidence.ETAKnown = true
		evidence.ETASeconds = int64(eta)
	}
	return evidence, nil
}

func (r *Reporter) prometheusBackupRestorable(ctx context.Context) (bool, error) {
	cell := strconv.Quote(r.Config.CellName)
	collection, err := r.prometheusScalar(ctx, "actor_fdb_backup_collection_success{cell="+cell+"}")
	if err != nil {
		return false, fmt.Errorf("collect exact backup status: %w", err)
	}
	restorable, err := r.prometheusScalar(ctx, "actor_fdb_backup_container_restorable{cell="+cell+"}")
	if err != nil {
		return false, fmt.Errorf("collect backup restorable status: %w", err)
	}
	if collection != 1 || restorable != 1 {
		return false, nil
	}
	return true, nil
}

func (r *Reporter) prometheusScalar(ctx context.Context, expression string) (float64, error) {
	endpoint := strings.TrimRight(r.Config.PrometheusURL, "/") + "/api/v1/query"
	parsed, err := url.Parse(endpoint)
	if err != nil {
		return 0, fmt.Errorf("parse Prometheus URL: %w", err)
	}
	values := parsed.Query()
	values.Set("query", expression)
	parsed.RawQuery = values.Encode()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, parsed.String(), nil)
	if err != nil {
		return 0, err
	}
	client := r.HTTP
	if client == nil {
		client = &http.Client{Timeout: 5 * time.Second}
	}
	response, err := client.Do(request)
	if err != nil {
		return 0, fmt.Errorf("query Prometheus: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("Prometheus query returned HTTP %d", response.StatusCode)
	}
	var payload struct {
		Status string `json:"status"`
		Data   struct {
			Result []struct {
				Metric map[string]string `json:"metric"`
				Value  []any             `json:"value"`
			} `json:"result"`
		} `json:"data"`
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		return 0, err
	}
	if payload.Status != "success" || len(payload.Data.Result) != 1 || len(payload.Data.Result[0].Value) != 2 {
		return 0, fmt.Errorf("Prometheus query %q did not return exactly one vector sample", expression)
	}
	result := payload.Data.Result[0]
	if result.Metric["cell"] != r.Config.CellName {
		return 0, fmt.Errorf("Prometheus query %q returned Cell %q, want %q", expression, result.Metric["cell"], r.Config.CellName)
	}
	timestamp, ok := result.Value[0].(float64)
	if !ok || math.IsNaN(timestamp) || math.IsInf(timestamp, 0) {
		return 0, fmt.Errorf("Prometheus query %q returned an invalid sample timestamp", expression)
	}
	now := time.Now().UTC()
	if r.Now != nil {
		now = r.Now().UTC()
	}
	sampleTime := time.Unix(0, int64(timestamp*float64(time.Second))).UTC()
	freshness := r.Config.PrometheusSampleFreshness
	if freshness <= 0 {
		freshness = 2 * time.Minute
	}
	if sampleTime.After(now.Add(30*time.Second)) || now.Sub(sampleTime) > freshness {
		return 0, fmt.Errorf("Prometheus query %q returned a stale or future sample at %s", expression, sampleTime.Format(time.RFC3339Nano))
	}
	raw, ok := result.Value[1].(string)
	if !ok {
		return 0, fmt.Errorf("Prometheus query %q returned a non-string value", expression)
	}
	value, err := strconv.ParseFloat(strings.TrimPrefix(raw, "+"), 64)
	if err != nil {
		return 0, fmt.Errorf("parse Prometheus value %q: %w", raw, err)
	}
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return 0, fmt.Errorf("Prometheus query %q returned non-finite value %q", expression, raw)
	}
	return value, nil
}
