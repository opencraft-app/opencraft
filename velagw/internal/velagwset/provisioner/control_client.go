package provisioner

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

	"git.woa.com/wisp/mono2/llmgateway/internal/gateway"
)

type ProvisionControl interface {
	Control
	ListRequests(context.Context, string, string, string, string, int) ([]gateway.SetProvisionRequest, error)
	Claim(context.Context, gateway.SetProvisionRequest, string, time.Duration) (gateway.SetProvisionRequest, bool, error)
	Release(context.Context, gateway.SetProvisionRequest) error
}

type HTTPControlClient struct {
	baseURL       string
	internalToken string
	httpClient    *http.Client
}

type controlResponse[T any] struct {
	Success bool   `json:"success"`
	Message string `json:"message"`
	Data    T      `json:"data"`
}

func NewHTTPControlClient(baseURL, internalToken string, httpClient *http.Client) *HTTPControlClient {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 30 * time.Second}
	}
	return &HTTPControlClient{baseURL: strings.TrimRight(strings.TrimSpace(baseURL), "/"), internalToken: strings.TrimSpace(internalToken), httpClient: httpClient}
}

func (c *HTTPControlClient) ListRequests(ctx context.Context, source, namespace, fleet, status string, limit int) ([]gateway.SetProvisionRequest, error) {
	query := url.Values{}
	query.Set("source", source)
	query.Set("namespace", namespace)
	query.Set("fleet", fleet)
	if status != "" {
		query.Set("status", status)
	}
	query.Set("limit", strconv.Itoa(limit))
	var requests []gateway.SetProvisionRequest
	if err := c.do(ctx, http.MethodGet, "/api/internal/velagwset-provisioner/set-provision-requests?"+query.Encode(), nil, &requests); err != nil {
		return nil, err
	}
	return requests, nil
}

func (c *HTTPControlClient) Claim(ctx context.Context, request gateway.SetProvisionRequest, owner string, ttl time.Duration) (gateway.SetProvisionRequest, bool, error) {
	var claimed gateway.SetProvisionRequest
	err := c.do(ctx, http.MethodPost, provisionRequestPath(request.ID, "claim"), map[string]any{
		"writer_epoch": request.WriterEpoch, "lifecycle_revision": request.LifecycleRevision,
		"owner": owner, "lease_seconds": int(ttl.Seconds()),
	}, &claimed)
	if httpErrorStatus(err) == http.StatusConflict {
		return gateway.SetProvisionRequest{}, false, nil
	}
	return claimed, err == nil, err
}

func (c *HTTPControlClient) Release(ctx context.Context, request gateway.SetProvisionRequest) error {
	return c.do(ctx, http.MethodPost, provisionRequestPath(request.ID, "release"), map[string]any{
		"writer_epoch": request.WriterEpoch, "lifecycle_revision": request.LifecycleRevision,
		"expected_version": request.Version, "claim_token": request.ClaimToken,
	}, nil)
}

func (c *HTTPControlClient) ListUpgradeRuns(ctx context.Context, limit int) ([]gateway.SetUpgradeRun, error) {
	query := url.Values{}
	query.Set("limit", strconv.Itoa(limit))
	var runs []gateway.SetUpgradeRun
	if err := c.do(ctx, http.MethodGet, "/api/internal/set-manager/set-upgrade-runs?"+query.Encode(), nil, &runs); err != nil {
		return nil, err
	}
	return runs, nil
}

func (c *HTTPControlClient) ClaimUpgradeRun(ctx context.Context, id, owner string, ttl time.Duration) (gateway.SetUpgradeRun, bool, error) {
	var run gateway.SetUpgradeRun
	err := c.do(ctx, http.MethodPost, upgradeRunPath(id, "claim"), map[string]any{
		"owner": owner, "lease_seconds": int(ttl.Seconds()),
	}, &run)
	if httpErrorStatus(err) == http.StatusConflict {
		return gateway.SetUpgradeRun{}, false, nil
	}
	return run, err == nil, err
}

func (c *HTTPControlClient) CompleteUpgradeMaster(ctx context.Context, id, owner string, success bool, lastError string) (gateway.SetUpgradeRun, error) {
	return c.upgradeAction(ctx, id, "master-complete", map[string]any{"owner": owner, "success": success, "last_error": lastError})
}

func (c *HTTPControlClient) CompleteUpgradeCompatibility(ctx context.Context, id, owner string, success bool, lastError string) (gateway.SetUpgradeRun, error) {
	return c.upgradeAction(ctx, id, "compatibility-complete", map[string]any{"owner": owner, "success": success, "last_error": lastError})
}

func (c *HTTPControlClient) UpgradeProbeCredential(ctx context.Context, id, owner string) (gateway.SetUpgradeProbeCredential, error) {
	var credential gateway.SetUpgradeProbeCredential
	err := c.do(ctx, http.MethodPost, upgradeRunPath(id, "probe-credential"), map[string]any{"owner": owner}, &credential)
	return credential, err
}

func (c *HTTPControlClient) PrepareUpgradeCandidate(ctx context.Context, id, owner, baseURL string) (gateway.SetUpgradeRun, error) {
	return c.upgradeAction(ctx, id, "candidate", map[string]any{"owner": owner, "traffic_base_url": baseURL})
}

func (c *HTTPControlClient) RecordUpgradeProbe(ctx context.Context, id, owner string, success bool, lastError string) (gateway.SetUpgradeRun, error) {
	return c.upgradeAction(ctx, id, "probe", map[string]any{"owner": owner, "success": success, "last_error": lastError})
}

func (c *HTTPControlClient) UpgradeAction(ctx context.Context, id, action, owner string, success bool, lastError, reason string) (gateway.SetUpgradeRun, error) {
	return c.upgradeAction(ctx, id, action, map[string]any{
		"owner": owner, "success": success, "last_error": lastError, "reason": reason,
	})
}

func (c *HTTPControlClient) upgradeAction(ctx context.Context, id, action string, body map[string]any) (gateway.SetUpgradeRun, error) {
	var run gateway.SetUpgradeRun
	err := c.do(ctx, http.MethodPost, upgradeRunPath(id, action), body, &run)
	return run, err
}

func upgradeRunPath(id, action string) string {
	return "/api/internal/set-manager/set-upgrade-runs/" + url.PathEscape(id) + "/" + action
}

func (c *HTTPControlClient) ListDecommissionJobs(ctx context.Context, limit int) ([]gateway.SetDecommissionJob, error) {
	query := url.Values{}
	query.Set("limit", strconv.Itoa(limit))
	var jobs []gateway.SetDecommissionJob
	if err := c.do(ctx, http.MethodGet, "/api/internal/set-manager/set-decommissions?"+query.Encode(), nil, &jobs); err != nil {
		return nil, err
	}
	return jobs, nil
}

func (c *HTTPControlClient) ClaimDecommission(ctx context.Context, id, owner string, ttl time.Duration) (DecommissionClaim, bool, error) {
	var claim DecommissionClaim
	err := c.do(ctx, http.MethodPost, decommissionPath(id, "claim"), map[string]any{
		"owner": owner, "lease_seconds": int(ttl.Seconds()),
	}, &claim)
	if httpErrorStatus(err) == http.StatusConflict {
		return DecommissionClaim{}, false, nil
	}
	return claim, err == nil, err
}

func (c *HTTPControlClient) FinalizeDecommission(ctx context.Context, payload gateway.SetRuntimeCleanupPayload, jobUID string) error {
	return c.do(ctx, http.MethodPost, decommissionPath(payload.CleanupID, "finalize"), map[string]any{
		"attempt": payload.Attempt, "claim_token": payload.ClaimToken,
		"lease_fingerprint": payload.LeaseFingerprint, "job_uid": jobUID,
	}, nil)
}

func (c *HTTPControlClient) FailDecommission(ctx context.Context, payload gateway.SetRuntimeCleanupPayload, jobUID, lastError string) error {
	return c.do(ctx, http.MethodPost, decommissionPath(payload.CleanupID, "fail"), map[string]any{
		"attempt": payload.Attempt, "claim_token": payload.ClaimToken,
		"lease_fingerprint": payload.LeaseFingerprint, "job_uid": jobUID, "last_error": lastError,
	}, nil)
}

func (c *HTTPControlClient) AcknowledgeDecommission(ctx context.Context, id string, attempt int) error {
	return c.do(ctx, http.MethodPost, decommissionPath(id, "ack"), map[string]any{"attempt": attempt}, nil)
}

func decommissionPath(id, action string) string {
	return "/api/internal/set-manager/set-decommissions/" + url.PathEscape(id) + "/" + action
}

func (c *HTTPControlClient) Materialized(ctx context.Context, input gateway.SetProvisionFactCommitInput) error {
	return c.do(ctx, http.MethodPost, provisionRequestPath(input.ID, "materialized"), input, nil)
}

func (c *HTTPControlClient) ServingReady(ctx context.Context, input gateway.SetProvisionFactCommitInput) error {
	return c.do(ctx, http.MethodPost, provisionRequestPath(input.ID, "serving-ready"), input, nil)
}

func provisionRequestPath(id, action string) string {
	return "/api/internal/velagwset-provisioner/set-provision-requests/" + url.PathEscape(id) + "/" + action
}

type controlHTTPError struct {
	status int
	body   string
}

func (e *controlHTTPError) Error() string {
	return fmt.Sprintf("control API status=%d body=%s", e.status, e.body)
}

func httpErrorStatus(err error) int {
	if typed, ok := err.(*controlHTTPError); ok {
		return typed.status
	}
	return 0
}

func (c *HTTPControlClient) do(ctx context.Context, method, path string, body, output any) error {
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, reader)
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+c.internalToken)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := c.httpClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 4<<20))
	if err != nil {
		return err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return &controlHTTPError{status: response.StatusCode, body: strings.TrimSpace(string(raw))}
	}
	if output == nil {
		return nil
	}
	var envelope controlResponse[json.RawMessage]
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return err
	}
	if !envelope.Success {
		return fmt.Errorf("control API: %s", envelope.Message)
	}
	return json.Unmarshal(envelope.Data, output)
}
