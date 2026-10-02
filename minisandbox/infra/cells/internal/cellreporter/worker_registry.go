package cellreporter

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const placementCountSchema = "rivet-worker-cell-placement-count/v1"
const placementCountShards = 64

func validateWorkerRegistryURL(raw string) error {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return fmt.Errorf("Worker Registry URL must be an HTTP(S) URL without query or fragment")
	}
	return nil
}

func (r *Reporter) workerRegistryPlacementCount(ctx context.Context, cellName, cellUID string) (int64, error) {
	base, err := url.Parse(strings.TrimRight(r.Config.WorkerRegistryURL, "/"))
	if err != nil {
		return 0, err
	}
	base.Path = strings.TrimRight(base.Path, "/") + "/internal/v1/cells/" + url.PathEscape(cellName) + "/placement-count"
	query := base.Query()
	query.Set("cell_uid", cellUID)
	base.RawQuery = query.Encode()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, base.String(), nil)
	if err != nil {
		return 0, err
	}
	client := r.HTTP
	if client == nil {
		client = &http.Client{Timeout: 5 * time.Second}
	}
	response, err := client.Do(request)
	if err != nil {
		return 0, fmt.Errorf("query Worker Registry: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("Worker Registry returned HTTP %d", response.StatusCode)
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, 4097))
	decoder.DisallowUnknownFields()
	var payload struct {
		Schema   string `json:"schema"`
		CellName string `json:"cell_name"`
		CellUID  string `json:"cell_uid"`
		Count    int64  `json:"count"`
		Shards   int    `json:"shards"`
	}
	if err := decoder.Decode(&payload); err != nil {
		return 0, fmt.Errorf("decode Worker Registry placement count: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return 0, fmt.Errorf("Worker Registry placement count has trailing data")
	}
	if payload.Schema != placementCountSchema || payload.CellName != cellName || payload.CellUID != cellUID || payload.Shards != placementCountShards || payload.Count < 0 {
		return 0, fmt.Errorf("Worker Registry placement count identity or value is invalid")
	}
	return payload.Count, nil
}
