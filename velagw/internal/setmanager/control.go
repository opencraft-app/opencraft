package setmanager

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type ControlClient struct {
	BaseURL       string
	AdminToken    string
	InternalToken string
	HTTPClient    *http.Client
}

type controlResponse[T any] struct {
	Success bool   `json:"success"`
	Message string `json:"message"`
	Data    T      `json:"data"`
}

type controlHTTPError struct {
	Method     string
	Path       string
	StatusCode int
	Body       string
}

func (e *controlHTTPError) Error() string {
	return fmt.Sprintf("%s %s status=%d body=%s", e.Method, e.Path, e.StatusCode, e.Body)
}

type SetFact struct {
	SetID                        string `json:"set_id"`
	Name                         string `json:"name"`
	BaseURL                      string `json:"base_url"`
	TrafficBaseURL               string `json:"traffic_base_url,omitempty"`
	RuntimeGeneration            int64  `json:"runtime_generation,omitempty"`
	RuntimeImage                 string `json:"runtime_image,omitempty"`
	ShardRef                     string `json:"shard_ref,omitempty"`
	DatabaseName                 string `json:"database_name,omitempty"`
	RedisDB                      string `json:"redis_db,omitempty"`
	SQLMaxOpenConns              int    `json:"sql_max_open_conns,omitempty"`
	SQLMaxIdleConns              int    `json:"sql_max_idle_conns,omitempty"`
	SQLMaxLifetimeSeconds        int    `json:"sql_max_lifetime_seconds,omitempty"`
	TrafficSQLMaxOpenConns       int    `json:"traffic_sql_max_open_conns,omitempty"`
	TrafficSQLMaxIdleConns       int    `json:"traffic_sql_max_idle_conns,omitempty"`
	TrafficSQLMaxLifetimeSeconds int    `json:"traffic_sql_max_lifetime_seconds,omitempty"`
	SubscriptionWriteConcurrency int    `json:"subscription_write_concurrency,omitempty"`
}

type ShardProjection struct {
	ID                           string `json:"id"`
	Name                         string `json:"name"`
	Kind                         string `json:"kind"`
	Endpoint                     string `json:"endpoint,omitempty"`
	RedisEndpoint                string `json:"redis_endpoint,omitempty"`
	SecretName                   string `json:"secret_name,omitempty"`
	RedisDBStart                 int    `json:"redis_db_start,omitempty"`
	RedisDBLimit                 int    `json:"redis_db_limit,omitempty"`
	Status                       string `json:"status"`
	MaxSets                      int    `json:"max_sets,omitempty"`
	AdminSQLMaxOpenConns         int    `json:"admin_sql_max_open_conns,omitempty"`
	AdminSQLMaxIdleConns         int    `json:"admin_sql_max_idle_conns,omitempty"`
	AdminSQLMaxLifetimeSeconds   int    `json:"admin_sql_max_lifetime_seconds,omitempty"`
	TrafficSQLMaxOpenConns       int    `json:"traffic_sql_max_open_conns,omitempty"`
	TrafficSQLMaxIdleConns       int    `json:"traffic_sql_max_idle_conns,omitempty"`
	TrafficSQLMaxLifetimeSeconds int    `json:"traffic_sql_max_lifetime_seconds,omitempty"`
	SubscriptionWriteConcurrency int    `json:"subscription_write_concurrency,omitempty"`
}

type SetDecommissionJob struct {
	ID              string    `json:"id"`
	SetID           string    `json:"set_id"`
	Status          string    `json:"status"`
	Attempt         int       `json:"attempt"`
	ClaimLeaseUntil time.Time `json:"claim_lease_until,omitempty"`
}

type SetDecommissionClaimResult struct {
	Job     SetDecommissionJob    `json:"job"`
	Cleanup RuntimeCleanupPayload `json:"cleanup"`
}

type SetUpgradeRun struct {
	ID                        string        `json:"id"`
	BatchID                   string        `json:"batch_id"`
	SetID                     string        `json:"set_id"`
	Source                    string        `json:"source"`
	Namespace                 string        `json:"namespace"`
	Fleet                     string        `json:"fleet"`
	TargetImage               string        `json:"target_image"`
	FromGeneration            int64         `json:"from_generation"`
	ToGeneration              int64         `json:"to_generation"`
	Status                    string        `json:"status"`
	DrainTimeout              time.Duration `json:"drain_timeout"`
	RollbackWindow            time.Duration `json:"rollback_window"`
	LeaseOwner                string        `json:"lease_owner,omitempty"`
	LeaseUntil                time.Time     `json:"lease_until,omitempty"`
	SwitchedAt                time.Time     `json:"switched_at,omitempty"`
	DrainDeadline             time.Time     `json:"drain_deadline,omitempty"`
	RollbackDeadline          time.Time     `json:"rollback_deadline,omitempty"`
	RollbackRequested         bool          `json:"rollback_requested,omitempty"`
	RollbackReason            string        `json:"rollback_reason,omitempty"`
	MasterUpgradedAt          time.Time     `json:"master_upgraded_at,omitempty"`
	CompatibilityCheckedAt    time.Time     `json:"compatibility_checked_at,omitempty"`
	ConsecutiveProbeSuccesses int           `json:"consecutive_probe_successes"`
	ConsecutiveProbeFailures  int           `json:"consecutive_probe_failures"`
	LastError                 string        `json:"last_error,omitempty"`
}

type SetUpgradeProbeCredential struct {
	SetID       string `json:"set_id"`
	UpstreamKey string `json:"upstream_key"`
}

func (c ControlClient) SetUpgradeRuns(ctx context.Context, limit int) ([]SetUpgradeRun, error) {
	query := url.Values{}
	query.Set("limit", strconv.Itoa(limit))
	var runs []SetUpgradeRun
	err := c.doInternal(ctx, http.MethodGet, "/api/internal/set-manager/set-upgrade-runs", query, nil, &runs)
	return runs, err
}

func (c ControlClient) ClaimSetUpgradeRun(ctx context.Context, id, owner string, leaseSeconds int) (SetUpgradeRun, bool, error) {
	var run SetUpgradeRun
	err := c.doInternal(ctx, http.MethodPost, "/api/internal/set-manager/set-upgrade-runs/"+url.PathEscape(id)+"/claim", nil,
		map[string]any{"owner": owner, "lease_seconds": leaseSeconds}, &run)
	if httpErr, ok := err.(*controlHTTPError); ok && httpErr.StatusCode == http.StatusConflict {
		return SetUpgradeRun{}, false, nil
	}
	return run, err == nil, err
}

func (c ControlClient) PrepareSetUpgradeCandidate(ctx context.Context, id, owner, trafficBaseURL string) (SetUpgradeRun, error) {
	var run SetUpgradeRun
	err := c.doInternal(ctx, http.MethodPost, "/api/internal/set-manager/set-upgrade-runs/"+url.PathEscape(id)+"/candidate", nil,
		map[string]any{"owner": owner, "traffic_base_url": trafficBaseURL}, &run)
	return run, err
}

func (c ControlClient) CompleteSetUpgradeCompatibility(ctx context.Context, id, owner string, success bool, lastError string) (SetUpgradeRun, error) {
	var run SetUpgradeRun
	err := c.doInternal(ctx, http.MethodPost, "/api/internal/set-manager/set-upgrade-runs/"+url.PathEscape(id)+"/compatibility-complete", nil,
		map[string]any{"owner": owner, "success": success, "last_error": lastError}, &run)
	return run, err
}

func (c ControlClient) SetUpgradeProbeCredential(ctx context.Context, id, owner string) (SetUpgradeProbeCredential, error) {
	var result SetUpgradeProbeCredential
	err := c.doInternal(ctx, http.MethodPost, "/api/internal/set-manager/set-upgrade-runs/"+url.PathEscape(id)+"/probe-credential", nil,
		map[string]any{"owner": owner}, &result)
	return result, err
}

func (c ControlClient) RecordSetUpgradeProbe(ctx context.Context, id, owner string, success bool, lastError string) (SetUpgradeRun, error) {
	var run SetUpgradeRun
	err := c.doInternal(ctx, http.MethodPost, "/api/internal/set-manager/set-upgrade-runs/"+url.PathEscape(id)+"/probe", nil,
		map[string]any{"owner": owner, "success": success, "last_error": lastError}, &run)
	return run, err
}

func (c ControlClient) SetUpgradeAction(ctx context.Context, id, action, owner string, success bool, lastError, reason string) (SetUpgradeRun, error) {
	var run SetUpgradeRun
	err := c.doInternal(ctx, http.MethodPost, "/api/internal/set-manager/set-upgrade-runs/"+url.PathEscape(id)+"/"+url.PathEscape(action), nil,
		map[string]any{"owner": owner, "success": success, "last_error": lastError, "reason": reason}, &run)
	return run, err
}

func (c ControlClient) SetDecommissions(ctx context.Context, limit int) ([]SetDecommissionJob, error) {
	query := url.Values{}
	query.Set("phase", "non_terminal")
	query.Set("limit", strconv.Itoa(limit))
	var jobs []SetDecommissionJob
	err := c.doInternal(ctx, http.MethodGet, "/api/internal/set-manager/set-decommissions", query, nil, &jobs)
	return jobs, err
}

func (c ControlClient) ClaimSetDecommission(ctx context.Context, jobID, owner string, leaseSeconds int) (SetDecommissionClaimResult, error) {
	var result SetDecommissionClaimResult
	err := c.doInternal(ctx, http.MethodPost, "/api/internal/set-manager/set-decommissions/"+url.PathEscape(jobID)+"/claim", nil,
		map[string]any{"owner": owner, "lease_seconds": leaseSeconds}, &result)
	return result, err
}

func (c ControlClient) FinalizeSetDecommission(ctx context.Context, cleanup LLMFleetCleanup, status LLMFleetCleanupStatus) error {
	body := map[string]any{
		"attempt": cleanup.Attempt, "claim_token": cleanup.ClaimToken,
		"lease_fingerprint": cleanup.LeaseFingerprint, "job_uid": status.JobUID,
	}
	return c.doInternal(ctx, http.MethodPost, "/api/internal/set-manager/set-decommissions/"+url.PathEscape(cleanup.CleanupID)+"/finalize", nil, body, nil)
}

func (c ControlClient) FailSetDecommission(ctx context.Context, cleanup LLMFleetCleanup, status LLMFleetCleanupStatus, lastError string) error {
	body := map[string]any{
		"attempt": cleanup.Attempt, "claim_token": cleanup.ClaimToken,
		"lease_fingerprint": cleanup.LeaseFingerprint, "job_uid": status.JobUID,
		"last_error": lastError,
	}
	return c.doInternal(ctx, http.MethodPost, "/api/internal/set-manager/set-decommissions/"+url.PathEscape(cleanup.CleanupID)+"/fail", nil, body, nil)
}

func (c ControlClient) AcknowledgeSetDecommission(ctx context.Context, cleanupID string, attempt int) error {
	return c.doInternal(ctx, http.MethodPost, "/api/internal/set-manager/set-decommissions/"+url.PathEscape(cleanupID)+"/ack", nil,
		map[string]any{"attempt": attempt}, nil)
}

func (c ControlClient) UpsertShard(ctx context.Context, shard ShardProjection) error {
	return c.doInternal(ctx, http.MethodPost, "/api/internal/set-manager/shards", nil, shard, nil)
}

func (c ControlClient) PendingRequests(ctx context.Context, cfg Config) ([]ProvisionRequest, error) {
	return c.ProvisionRequests(ctx, cfg, "pending")
}

func (c ControlClient) ConfiguredRequests(ctx context.Context, cfg Config) ([]ProvisionRequest, error) {
	return c.ProvisionRequests(ctx, cfg, "configured")
}

func (c ControlClient) ErroredRequests(ctx context.Context, cfg Config) ([]ProvisionRequest, error) {
	return c.ProvisionRequests(ctx, cfg, "error")
}

func (c ControlClient) ProvisionRequests(ctx context.Context, cfg Config, status string) ([]ProvisionRequest, error) {
	query := url.Values{}
	query.Set("source", cfg.Source)
	query.Set("namespace", cfg.Namespace)
	query.Set("fleet", cfg.Fleet)
	query.Set("status", status)
	query.Set("limit", strconv.Itoa(cfg.RequestLimit))
	var requests []ProvisionRequest
	err := c.doInternal(ctx, http.MethodGet, "/api/internal/set-manager/set-provision-requests", query, nil, &requests)
	return requests, err
}

func (c ControlClient) UpdateRequestStatus(ctx context.Context, id string, status string, lastError string) error {
	body := map[string]any{"status": status}
	if strings.TrimSpace(lastError) != "" {
		body["last_error"] = lastError
	}
	return c.doInternal(ctx, http.MethodPost, "/api/internal/set-manager/set-provision-requests/"+url.PathEscape(id)+"/status", nil, body, nil)
}

func (c ControlClient) RecordFact(ctx context.Context, cfg Config, fact SetFact) error {
	return c.RecordFacts(ctx, cfg, []SetFact{fact})
}

func (c ControlClient) RecordFacts(ctx context.Context, cfg Config, facts []SetFact) error {
	body := map[string]any{
		"source":    cfg.Source,
		"namespace": cfg.Namespace,
		"fleet":     cfg.Fleet,
		"sets":      facts,
	}
	return c.doInternal(ctx, http.MethodPost, "/api/internal/set-manager/set-reconcile-facts", nil, body, nil)
}

func (c ControlClient) ReconcileFacts(ctx context.Context, cfg Config) error {
	body := map[string]any{
		"source":    cfg.Source,
		"namespace": cfg.Namespace,
		"fleet":     cfg.Fleet,
		"limit":     cfg.RequestLimit,
	}
	return c.doInternal(ctx, http.MethodPost, "/api/internal/set-manager/set-reconcile-facts/reconcile", nil, body, nil)
}

func (c ControlClient) do(ctx context.Context, method string, path string, query url.Values, body any, out any) error {
	return c.doWithToken(ctx, method, path, query, body, out, c.AdminToken)
}

func (c ControlClient) doInternal(ctx context.Context, method string, path string, query url.Values, body any, out any) error {
	token := c.InternalToken
	if token == "" {
		token = c.AdminToken
	}
	return c.doWithToken(ctx, method, path, query, body, out, token)
}

func (c ControlClient) doWithToken(ctx context.Context, method string, path string, query url.Values, body any, out any, token string) error {
	base := strings.TrimRight(c.BaseURL, "/")
	if base == "" {
		return fmt.Errorf("control url is required")
	}
	target := base + path
	if len(query) > 0 {
		target += "?" + query.Encode()
	}
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, target, reader)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	client := c.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return &controlHTTPError{
			Method: method, Path: path, StatusCode: resp.StatusCode, Body: strings.TrimSpace(string(raw)),
		}
	}
	var wrapped controlResponse[json.RawMessage]
	if err := json.Unmarshal(raw, &wrapped); err == nil && (wrapped.Success || wrapped.Message != "" || len(wrapped.Data) > 0) {
		if !wrapped.Success {
			return fmt.Errorf("%s %s failed: %s", method, path, wrapped.Message)
		}
		if out == nil || len(wrapped.Data) == 0 || string(wrapped.Data) == "null" {
			return nil
		}
		return json.Unmarshal(wrapped.Data, out)
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(raw, out)
}
