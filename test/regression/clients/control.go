package clients

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"git.woa.com/wisp/mono2/llmgateway/test/regression/framework"
)

type ControlClient struct {
	admin        *JSONClient
	internal     *JSONClient
	pollInterval time.Duration
}

type ManagedSet struct {
	ID                      string `json:"id"`
	Name                    string `json:"name"`
	Status                  string `json:"status"`
	Setup                   bool   `json:"setup"`
	AdminUserID             int64  `json:"admin_user_id"`
	AdmissionStatus         string `json:"admission_status"`
	AdmissionError          string `json:"admission_error"`
	ProvisionStatus         string `json:"provision_status"`
	ObservedUserCount       int64  `json:"observed_user_count"`
	ReleaseRingID           string `json:"release_ring_id"`
	CurrentReleaseID        string `json:"current_release_id"`
	TargetReleaseID         string `json:"target_release_id"`
	ActiveRuntimeGeneration int64  `json:"active_runtime_generation"`
	RouteRevision           int64  `json:"route_revision"`
}

type SetUpgradeBatch struct {
	ID              string          `json:"id"`
	RolloutID       string          `json:"rollout_id"`
	RingID          string          `json:"ring_id"`
	TargetReleaseID string          `json:"target_release_id"`
	Status          string          `json:"status"`
	Runs            []SetUpgradeRun `json:"runs"`
}

type SetUpgradeRun struct {
	ID                        string    `json:"id"`
	SetID                     string    `json:"set_id"`
	Status                    string    `json:"status"`
	FromGeneration            int64     `json:"from_generation"`
	ToGeneration              int64     `json:"to_generation"`
	ConsecutiveProbeSuccesses int       `json:"consecutive_probe_successes"`
	ConsecutiveProbeFailures  int       `json:"consecutive_probe_failures"`
	LeaseOwner                string    `json:"lease_owner"`
	LeaseUntil                time.Time `json:"lease_until"`
	SwitchedAt                time.Time `json:"switched_at"`
	DrainDeadline             time.Time `json:"drain_deadline"`
	RollbackDeadline          time.Time `json:"rollback_deadline"`
	LastError                 string    `json:"last_error"`
}

type SetUpgradeInput struct {
	SetID          string
	TargetImage    string
	Source         string
	Namespace      string
	Fleet          string
	DrainTimeout   time.Duration
	RollbackWindow time.Duration
}

type ReleaseRollout struct {
	ID               string          `json:"id"`
	RingID           string          `json:"ring_id"`
	TargetReleaseID  string          `json:"target_release_id"`
	Status           string          `json:"status"`
	TotalSets        int             `json:"total_sets"`
	CompletedSets    int             `json:"completed_sets"`
	FailedSets       int             `json:"failed_sets"`
	CurrentSetID     string          `json:"current_set_id"`
	CampaignID       string          `json:"campaign_id"`
	CampaignSequence int             `json:"campaign_sequence"`
	LastGateError    string          `json:"last_gate_error"`
	Batch            SetUpgradeBatch `json:"batch"`
}

type ReleaseCampaign struct {
	ID               string                `json:"id"`
	TargetReleaseID  string                `json:"target_release_id"`
	Status           string                `json:"status"`
	CurrentRingID    string                `json:"current_ring_id"`
	CurrentRolloutID string                `json:"current_rollout_id"`
	TotalRings       int                   `json:"total_rings"`
	CompletedRings   int                   `json:"completed_rings"`
	LastError        string                `json:"last_error"`
	Rings            []ReleaseCampaignRing `json:"rings"`
}

type ReleaseCampaignRing struct {
	Sequence  int    `json:"sequence"`
	RingID    string `json:"ring_id"`
	Status    string `json:"status"`
	RolloutID string `json:"rollout_id"`
	LastError string `json:"last_error"`
}

type ReleaseRing struct {
	ID                  string         `json:"id"`
	Ordinal             int            `json:"ordinal"`
	ServingReleaseID    string         `json:"serving_release_id"`
	TargetReleaseID     string         `json:"target_release_id"`
	Status              string         `json:"status"`
	SetCount            int            `json:"set_count"`
	ReleaseDistribution map[string]int `json:"release_distribution"`
}

type ChannelBundle struct {
	ID          string            `json:"id"`
	Name        string            `json:"name"`
	Fingerprint string            `json:"fingerprint"`
	Spec        ChannelBundleSpec `json:"spec"`
}

type ChannelBundleSpec struct {
	Version  int                    `json:"version"`
	Kind     string                 `json:"kind"`
	Options  []ChannelBundleOption  `json:"options"`
	Channels []ChannelBundleChannel `json:"channels"`
}

type ChannelBundleOption struct {
	Key   string `json:"key"`
	Value any    `json:"value"`
}

type ChannelBundleChannel struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Type         int    `json:"type"`
	BaseURL      string `json:"base_url"`
	Models       string `json:"models"`
	Group        string `json:"group"`
	ModelMapping string `json:"model_mapping"`
	Status       string `json:"status"`
	KeyHash      string `json:"key_hash"`
}

type ChannelSyncState struct {
	BundleID           string `json:"bundle_id"`
	SetID              string `json:"set_id"`
	Status             string `json:"status"`
	AppliedFingerprint string `json:"applied_fingerprint"`
	LastError          string `json:"last_error"`
}

type ChannelDeliveryStatus struct {
	BundleID     string                     `json:"bundle_id"`
	Status       string                     `json:"status"`
	EligibleSets int                        `json:"eligible_sets"`
	CheckedSets  int                        `json:"checked_sets"`
	Sets         []ChannelDeliverySetStatus `json:"sets"`
}

type ChannelDeliverySetStatus struct {
	SetID     string `json:"set_id"`
	Status    string `json:"status"`
	LastError string `json:"last_error"`
}

type PlanSetState struct {
	PlanID         string `json:"plan_id"`
	SetID          string `json:"set_id"`
	Status         string `json:"status"`
	UpstreamPlanID int    `json:"upstream_plan_id"`
	LastError      string `json:"last_error"`
}

type Subscription struct {
	ID           string `json:"id"`
	UserID       string `json:"user_id"`
	PlanID       string `json:"plan_id"`
	Status       string `json:"status"`
	SetID        string `json:"set_id"`
	TokenBalance int64  `json:"token_balance"`
	PeriodStart  string `json:"period_start"`
	PeriodEnd    string `json:"period_end"`
}

type TenantDetail struct {
	Tenant struct {
		ExternalUserID string `json:"external_user_id"`
		Status         string `json:"status"`
	} `json:"tenant"`
	Binding struct {
		SetID           string `json:"set_id"`
		UpstreamUserID  int64  `json:"upstream_user_id"`
		ProvisionStatus string `json:"provision_status"`
	} `json:"binding"`
	Assignment struct {
		Backend string `json:"backend"`
		SetID   string `json:"set_id"`
	} `json:"assignment"`
	Subscription *Subscription `json:"subscription,omitempty"`
}

type APIKey struct {
	ExternalKey     string `json:"external_key"`
	ExternalKeyID   string `json:"external_key_id"`
	ExternalKeyHash string `json:"external_key_hash"`
	SetID           string `json:"set_id"`
	UpstreamUserID  int64  `json:"upstream_user_id"`
}

type TenantDeletionJob struct {
	ID           string    `json:"id"`
	Status       string    `json:"status"`
	TargetCount  int       `json:"target_count"`
	TargetDigest string    `json:"target_digest"`
	SuccessCount int       `json:"success_count"`
	FailureCount int       `json:"failure_count"`
	LastError    string    `json:"last_error"`
	UpdatedAt    time.Time `json:"updated_at"`
}

type WorkerJob struct {
	Name          string    `json:"name"`
	Status        string    `json:"status"`
	LeaseOwner    string    `json:"lease_owner"`
	LeaseUntil    time.Time `json:"lease_until"`
	LastSuccessAt time.Time `json:"last_success_at"`
	NextRunAt     time.Time `json:"next_run_at"`
}

type WorkerJobRun struct {
	ID         string    `json:"id"`
	JobName    string    `json:"job_name"`
	Owner      string    `json:"owner"`
	Status     string    `json:"status"`
	StartedAt  time.Time `json:"started_at"`
	FinishedAt time.Time `json:"finished_at"`
	Error      string    `json:"error"`
}

func NewControlClient(baseURL string, adminToken, internalToken framework.Secret, client *http.Client, sanitizer *framework.Sanitizer) *ControlClient {
	return &ControlClient{
		admin:        NewJSONClient(baseURL, adminToken, client, sanitizer),
		internal:     NewJSONClient(baseURL, internalToken, client, sanitizer),
		pollInterval: 2 * time.Second,
	}
}

func (c *ControlClient) ListSets(ctx context.Context) ([]ManagedSet, error) {
	var result []ManagedSet
	err := c.admin.Do(ctx, http.MethodGet, "/api/sets", nil, &result)
	return result, err
}

func (c *ControlClient) QueueWorkerJob(ctx context.Context, name string) (WorkerJobRun, error) {
	var result WorkerJobRun
	path := "/api/admin/jobs/" + url.PathEscape(strings.TrimSpace(name)) + "/run"
	err := c.admin.Do(ctx, http.MethodPost, path, nil, &result)
	return result, err
}

func (c *ControlClient) WorkerJob(ctx context.Context, name string) (WorkerJob, error) {
	var jobs []WorkerJob
	if err := c.admin.Do(ctx, http.MethodGet, "/api/admin/jobs", nil, &jobs); err != nil {
		return WorkerJob{}, err
	}
	for _, job := range jobs {
		if job.Name == name {
			return job, nil
		}
	}
	return WorkerJob{}, &HTTPError{Method: http.MethodGet, Path: "/api/admin/jobs", Status: http.StatusNotFound, Message: "worker job not found"}
}

func (c *ControlClient) WorkerJobRuns(ctx context.Context, name string, after time.Time, limit int) ([]WorkerJobRun, error) {
	query := url.Values{}
	if !after.IsZero() {
		query.Set("after", after.UTC().Format(time.RFC3339Nano))
	}
	if limit > 0 {
		query.Set("limit", strconv.Itoa(limit))
	}
	path := "/api/admin/jobs/" + url.PathEscape(strings.TrimSpace(name)) + "/runs"
	if encoded := query.Encode(); encoded != "" {
		path += "?" + encoded
	}
	var result []WorkerJobRun
	err := c.admin.Do(ctx, http.MethodGet, path, nil, &result)
	return result, err
}

func (c *ControlClient) ListCampaignSets(ctx context.Context) ([]ManagedSet, error) {
	return c.ListSets(ctx)
}

func (c *ControlClient) CreateReleaseCampaign(ctx context.Context, targetReleaseID string) (ReleaseCampaign, error) {
	var result ReleaseCampaign
	err := c.admin.Do(ctx, http.MethodPost, "/api/admin/release-campaigns", map[string]string{"target_release_id": targetReleaseID}, &result)
	return result, err
}

func (c *ControlClient) ReleaseCampaign(ctx context.Context, campaignID string) (ReleaseCampaign, error) {
	var result ReleaseCampaign
	err := c.admin.Do(ctx, http.MethodGet, "/api/admin/release-campaigns/"+url.PathEscape(campaignID), nil, &result)
	return result, err
}

func (c *ControlClient) ReleaseRollout(ctx context.Context, rolloutID string) (ReleaseRollout, error) {
	var result ReleaseRollout
	err := c.admin.Do(ctx, http.MethodGet, "/api/admin/release-rollouts/"+url.PathEscape(rolloutID), nil, &result)
	return result, err
}

func (c *ControlClient) ListReleaseRings(ctx context.Context) ([]ReleaseRing, error) {
	var result []ReleaseRing
	err := c.admin.Do(ctx, http.MethodGet, "/api/admin/release-rings", nil, &result)
	return result, err
}

func (c *ControlClient) CreateSetUpgrade(ctx context.Context, input SetUpgradeInput) (SetUpgradeBatch, error) {
	var result SetUpgradeBatch
	err := c.admin.Do(ctx, http.MethodPost, "/api/admin/set-upgrades", map[string]any{
		"set_ids": []string{input.SetID}, "target_image": input.TargetImage,
		"source": input.Source, "namespace": input.Namespace, "fleet": input.Fleet,
		"max_parallel": 1, "stop_on_failure": true,
		"drain_timeout_seconds":   int(input.DrainTimeout.Seconds()),
		"rollback_window_seconds": int(input.RollbackWindow.Seconds()),
	}, &result)
	return result, err
}

func (c *ControlClient) SetUpgrade(ctx context.Context, batchID string) (SetUpgradeBatch, error) {
	var result SetUpgradeBatch
	err := c.admin.Do(ctx, http.MethodGet, "/api/admin/set-upgrades/"+url.PathEscape(batchID), nil, &result)
	return result, err
}

func (c *ControlClient) RetrySetUpgradeRun(ctx context.Context, runID string) (SetUpgradeRun, error) {
	var result SetUpgradeRun
	err := c.admin.Do(ctx, http.MethodPost, "/api/admin/set-upgrade-runs/"+url.PathEscape(runID)+"/retry", nil, &result)
	return result, err
}

func (c *ControlClient) ChannelBundle(ctx context.Context, bundleID string) (ChannelBundle, error) {
	var bundles []ChannelBundle
	if err := c.admin.Do(ctx, http.MethodGet, "/api/channel-bundles", nil, &bundles); err != nil {
		return ChannelBundle{}, err
	}
	for _, bundle := range bundles {
		if bundle.ID == bundleID {
			return bundle, nil
		}
	}
	return ChannelBundle{}, &HTTPError{Method: http.MethodGet, Path: "/api/channel-bundles", Status: http.StatusNotFound, Message: "channel bundle not found"}
}

func (c *ControlClient) ApplyChannelBundle(ctx context.Context, bundleID, setID string) (ChannelSyncState, error) {
	var result ChannelSyncState
	path := "/api/channel-bundles/" + url.PathEscape(bundleID) + "/apply"
	err := c.admin.Do(ctx, http.MethodPost, path, map[string]string{"set_id": setID}, &result)
	return result, err
}

func (c *ControlClient) ChannelDeliveryStatus(ctx context.Context, bundleID string) (ChannelDeliveryStatus, error) {
	var result ChannelDeliveryStatus
	path := "/api/channel-bundles/" + url.PathEscape(bundleID) + "/delivery-status"
	err := c.admin.Do(ctx, http.MethodGet, path, nil, &result)
	return result, err
}

func (c *ControlClient) PlanSetStates(ctx context.Context, planID string) ([]PlanSetState, error) {
	var result []PlanSetState
	err := c.admin.Do(ctx, http.MethodGet, "/api/plans/"+url.PathEscape(planID)+"/sets", nil, &result)
	return result, err
}

func (c *ControlClient) AssignTenant(ctx context.Context, userID, setID string) error {
	path := "/api/internal/users/" + url.PathEscape(userID) + "/assignment"
	return c.internal.Do(ctx, http.MethodPost, path, map[string]string{"backend": "new", "set_id": setID}, nil)
}

func (c *ControlClient) EnsureTenant(ctx context.Context, userID string) error {
	return c.internal.Do(ctx, http.MethodPost, "/api/internal/users/ensure", map[string]string{"user_id": userID}, nil)
}

func (c *ControlClient) ApplySubscription(ctx context.Context, userID, planID, idempotencyKey string) (Subscription, error) {
	var result Subscription
	body := map[string]string{"user_id": userID, "plan_id": planID}
	if strings.TrimSpace(idempotencyKey) != "" {
		body["idempotency_key"] = idempotencyKey
	}
	err := c.internal.Do(ctx, http.MethodPost, "/api/internal/subscriptions/apply", body, &result)
	return result, err
}

func (c *ControlClient) TenantDetail(ctx context.Context, userID string) (TenantDetail, error) {
	var result TenantDetail
	err := c.admin.Do(ctx, http.MethodGet, "/api/admin/tenants/"+url.PathEscape(userID), nil, &result)
	return result, err
}

func (c *ControlClient) CreateKey(ctx context.Context, userID string) (APIKey, error) {
	var result APIKey
	err := c.admin.Do(ctx, http.MethodPost, "/api/users/"+url.PathEscape(userID)+"/keys", nil, &result)
	return result, err
}

func (c *ControlClient) PreviewTenantDeletion(ctx context.Context, userID string) (TenantDeletionJob, error) {
	var result TenantDeletionJob
	err := c.admin.Do(ctx, http.MethodPost, "/api/admin/tenant-deletions/preview", map[string]any{"user_ids": []string{userID}}, &result)
	return result, err
}

func (c *ControlClient) StartTenantDeletion(ctx context.Context, job TenantDeletionJob, idempotencyKey string) (TenantDeletionJob, error) {
	var result TenantDeletionJob
	body := map[string]any{
		"expected_target_count": job.TargetCount, "expected_target_digest": job.TargetDigest,
		"idempotency_key": idempotencyKey,
	}
	err := c.admin.Do(ctx, http.MethodPost, "/api/admin/tenant-deletions/"+url.PathEscape(job.ID)+"/start", body, &result)
	return result, err
}

func (c *ControlClient) TenantDeletion(ctx context.Context, jobID string) (TenantDeletionJob, error) {
	var result TenantDeletionJob
	err := c.admin.Do(ctx, http.MethodGet, "/api/admin/tenant-deletions/"+url.PathEscape(jobID), nil, &result)
	return result, err
}

func (c *ControlClient) DeleteTenant(ctx context.Context, userID, idempotencyKey string, timeout time.Duration) error {
	deleteCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	job, err := c.PreviewTenantDeletion(deleteCtx, userID)
	if err != nil {
		return err
	}
	for job.Status != "previewed" {
		if isDeletionFailure(job.Status) {
			return fmt.Errorf("tenant deletion preview %s ended in %s", job.ID, job.Status)
		}
		if err := waitClient(deleteCtx, c.pollInterval); err != nil {
			return err
		}
		job, err = c.TenantDeletion(deleteCtx, job.ID)
		if err != nil {
			return err
		}
	}
	job, err = c.StartTenantDeletion(deleteCtx, job, idempotencyKey)
	if err != nil {
		return err
	}
	for {
		switch job.Status {
		case "succeeded":
			if job.FailureCount != 0 || job.SuccessCount != job.TargetCount {
				return fmt.Errorf("tenant deletion %s completed with success=%d failure=%d target=%d", job.ID, job.SuccessCount, job.FailureCount, job.TargetCount)
			}
			return nil
		case "partial", "error", "paused":
			return fmt.Errorf("tenant deletion %s ended in %s", job.ID, job.Status)
		}
		if err := waitClient(deleteCtx, c.pollInterval); err != nil {
			return err
		}
		job, err = c.TenantDeletion(deleteCtx, job.ID)
		if err != nil {
			return err
		}
	}
}

func isDeletionFailure(status string) bool {
	switch status {
	case "partial", "error", "paused":
		return true
	default:
		return false
	}
}

func waitClient(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
