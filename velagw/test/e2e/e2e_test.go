//go:build integration

package e2e

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"gopkg.in/yaml.v3"
)

type clusterConfig struct {
	LLMGateway struct {
		BaseURL        string `yaml:"base_url"`
		ControlBaseURL string `yaml:"control_base_url"`
		TrafficBaseURL string `yaml:"traffic_base_url"`
		AdminToken     string `yaml:"admin_token"`
		InternalToken  string `yaml:"internal_token"`
	} `yaml:"llmgateway"`
	NewAPIRoot struct {
		Username string `yaml:"username"`
		Password string `yaml:"password"`
	} `yaml:"newapi_root"`
	MockLLM  liveLLMConfig `yaml:"mock_llm"`
	Sets     []setConfig   `yaml:"sets"`
	Scenario struct {
		RunPrefix string `yaml:"run_prefix"`
		Plan      struct {
			ExternalID        string `yaml:"external_id"`
			Title             string `yaml:"title"`
			TotalAmount       int64  `yaml:"total_amount"`
			DurationUnit      string `yaml:"duration_unit"`
			DurationValue     int    `yaml:"duration_value"`
			GatewayPeriodUnit string `yaml:"gateway_period_unit"`
		} `yaml:"plan"`
	} `yaml:"scenario"`
}

type setConfig struct {
	ID      string `yaml:"id"`
	Name    string `yaml:"name"`
	BaseURL string `yaml:"base_url"`
}

type liveLLMConfig struct {
	APIKey  string `yaml:"api_key"`
	BaseURL string `yaml:"base_url"`
	Model   string `yaml:"model"`
}

func TestComposeClusterConfigDefinesLocalMockLLM(t *testing.T) {
	t.Setenv("LLMGATEWAY_E2E_CLUSTER", "cluster.compose.yaml")

	cfg := loadClusterConfig(t)
	if strings.TrimSpace(cfg.MockLLM.BaseURL) == "" {
		t.Fatal("cluster config must define mock_llm.base_url for reproducible local chat traffic")
	}
	if strings.TrimSpace(cfg.MockLLM.APIKey) == "" {
		t.Fatal("cluster config must define mock_llm.api_key")
	}
	if strings.TrimSpace(cfg.MockLLM.Model) == "" {
		t.Fatal("cluster config must define mock_llm.model")
	}
}

func TestComposeClusterConfigDefinesSplitControlTraffic(t *testing.T) {
	t.Setenv("LLMGATEWAY_E2E_CLUSTER", "cluster.compose.yaml")

	cfg := loadClusterConfig(t)
	if strings.TrimSpace(cfg.LLMGateway.ControlBaseURL) == "" {
		t.Fatal("cluster config must define llmgateway.control_base_url for split control-plane e2e")
	}
	if strings.TrimSpace(cfg.LLMGateway.TrafficBaseURL) == "" {
		t.Fatal("cluster config must define llmgateway.traffic_base_url for split traffic-plane e2e")
	}
	if cfg.LLMGateway.ControlBaseURL == cfg.LLMGateway.TrafficBaseURL {
		t.Fatalf("control_base_url and traffic_base_url must be different: %q", cfg.LLMGateway.ControlBaseURL)
	}
}

type apiResponse[T any] struct {
	Success bool   `json:"success"`
	Message string `json:"message"`
	Data    T      `json:"data"`
}

type subscriptionPayload struct {
	UserID       string `json:"user_id"`
	PlanID       string `json:"plan_id"`
	Status       string `json:"status"`
	TokenBalance int64  `json:"token_balance"`
	PeriodStart  string `json:"period_start"`
	PeriodEnd    string `json:"period_end"`
}

type creditPayload struct {
	UserID          string `json:"user_id"`
	Backend         string `json:"backend"`
	SetID           string `json:"set_id"`
	PlanID          string `json:"plan_id"`
	TokenBalance    int64  `json:"token_balance"`
	CreditAvailable int64  `json:"credit_available"`
	PeriodEnd       string `json:"period_end"`
	Source          string `json:"source"`
}

type userStatePayload struct {
	UserID                string `json:"user_id"`
	Backend               string `json:"backend"`
	SetID                 string `json:"set_id"`
	UpstreamUserID        int    `json:"upstream_user_id"`
	Username              string `json:"username"`
	CurrentPlanID         string `json:"current_plan_id"`
	LastAppliedPlanID     string `json:"last_applied_plan_id"`
	SubscriptionStatus    string `json:"subscription_status"`
	HasActiveSubscription bool   `json:"has_active_subscription"`
	TokenBalance          int64  `json:"token_balance"`
	CreditAvailable       int64  `json:"credit_available"`
	CreditStatus          string `json:"credit_status"`
	PeriodEnd             string `json:"period_end"`
	Source                string `json:"source"`
}

type tenantObservationPayload struct {
	UserID                string    `json:"user_id"`
	Backend               string    `json:"backend"`
	SetID                 string    `json:"set_id"`
	UpstreamUserID        int       `json:"upstream_user_id"`
	Username              string    `json:"username"`
	CurrentPlanID         string    `json:"current_plan_id"`
	LastAppliedPlanID     string    `json:"last_applied_plan_id"`
	SubscriptionStatus    string    `json:"subscription_status"`
	HasActiveSubscription bool      `json:"has_active_subscription"`
	TokenBalance          int64     `json:"token_balance"`
	CreditAvailable       int64     `json:"credit_available"`
	CreditStatus          string    `json:"credit_status"`
	PeriodStart           string    `json:"period_start"`
	PeriodEnd             string    `json:"period_end"`
	Source                string    `json:"source"`
	ObservedAt            time.Time `json:"observed_at"`
}

type keyPayload struct {
	APIKey    string `json:"api_key"`
	KeyID     string `json:"key_id"`
	KeyPrefix string `json:"key_prefix"`
	Name      string `json:"name"`
}

type tenantListPayload struct {
	Items []struct {
		UserID                     string `json:"user_id"`
		Backend                    string `json:"backend"`
		SetID                      string `json:"set_id"`
		ObservedPlanID             string `json:"observed_plan_id"`
		ObservedCreditAvailable    int64  `json:"observed_credit_available"`
		ObservedCreditStatus       string `json:"observed_credit_status"`
		ObservedSubscriptionStatus string `json:"observed_subscription_status"`
	} `json:"items"`
	Total int `json:"total"`
}

type resourceRowsPayload struct {
	Rows []resourceRowPayload `json:"rows"`
}

type resourceRowPayload struct {
	ID     string         `json:"id"`
	Values map[string]any `json:"values"`
}

type restartState struct {
	UserID             string `json:"user_id"`
	PlanID             string `json:"plan_id"`
	APIKey             string `json:"api_key"`
	RevokedAPIKey      string `json:"revoked_api_key"`
	PeriodEnd          string `json:"period_end"`
	TokenBalance       int64  `json:"token_balance"`
	CancelledUserID    string `json:"cancelled_user_id"`
	InactivePlanID     string `json:"inactive_plan_id"`
	InactivePlanTokens int64  `json:"inactive_plan_tokens"`
	DisabledSetID      string `json:"disabled_set_id"`
	FallbackSetID      string `json:"fallback_set_id"`
	SplitUserID        string `json:"split_user_id"`
	SplitAPIKey        string `json:"split_api_key"`
	SplitModel         string `json:"split_model"`
}

func TestReproducibleComposeClusterDropInScenario(t *testing.T) {
	if os.Getenv("LLMGATEWAY_E2E") != "1" {
		t.Skip("set LLMGATEWAY_E2E=1 or run test/e2e/run.sh")
	}
	cfg := loadClusterConfig(t)
	if len(cfg.Sets) < 2 {
		t.Fatalf("cluster config must define at least two sets")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	client := &http.Client{Timeout: 20 * time.Second}

	waitForOK(ctx, t, client, cfg.LLMGateway.BaseURL+"/healthz")
	for _, set := range cfg.Sets {
		waitForOK(ctx, t, client, set.BaseURL+"/api/status")
	}

	runID := uniqueID(cfg.Scenario.RunPrefix)
	externalPlanID := cfg.Scenario.Plan.ExternalID + "-" + runID
	upstreamPlanIDs := map[string]int{}
	dailyPlanID := "daily-" + externalPlanID
	dailyUpstreamPlanIDs := map[string]int{}
	singleSetPlanID := "single-set-" + externalPlanID
	splitPlanID := "split-" + externalPlanID
	splitUserID := ""
	splitAPIKey := ""
	splitModel := ""
	const dailyPlanTokens int64 = 25000
	const dailyPlanDurationValue = 3

	t.Run("freshly manage and bootstrap every set", func(t *testing.T) {
		for _, set := range cfg.Sets {
			adminPost(t, client, cfg, "/api/sets", map[string]any{
				"id":       set.ID,
				"name":     set.Name,
				"base_url": set.BaseURL,
				"status":   "active",
			}, nil)
			bootstrapManagedSet(t, client, cfg, set.ID)
		}
	})

	t.Run("operator overview jobs and metrics are available", func(t *testing.T) {
		var overview struct {
			Totals struct {
				Sets       int `json:"sets"`
				ReadySets  int `json:"ready_sets"`
				ActiveSets int `json:"active_sets"`
			} `json:"totals"`
			Sets []struct {
				ID    string `json:"id"`
				Ready bool   `json:"ready"`
			} `json:"sets"`
			Jobs []struct {
				Name string `json:"name"`
			} `json:"jobs"`
		}
		adminGet(t, client, cfg, "/api/admin/overview", &overview)
		if overview.Totals.Sets < len(cfg.Sets) || overview.Totals.ReadySets < len(cfg.Sets) || len(overview.Jobs) == 0 {
			t.Fatalf("unexpected operator overview: %+v", overview)
		}

		var run struct {
			JobName string `json:"job_name"`
			Status  string `json:"status"`
		}
		adminPost(t, client, cfg, "/api/admin/jobs/check_channel_drift/run", nil, &run)
		if run.JobName != "check_channel_drift" || run.Status == "" {
			t.Fatalf("unexpected manual job run: %+v", run)
		}

		req := newJSONRequest(t, http.MethodGet, cfg.LLMGateway.BaseURL+"/metrics", nil)
		resp := do(t, client, req)
		defer resp.Body.Close()
		raw, err := io.ReadAll(resp.Body)
		if err != nil {
			t.Fatal(err)
		}
		metrics := string(raw)
		for _, want := range []string{
			"llmgateway_set_ready",
			"llmgateway_set_users",
			"llmgateway_worker_job_failure_total",
			"llmgateway_byok_sync_tasks",
			"llmgateway_tenant_observation_tasks",
		} {
			if !strings.Contains(metrics, want) {
				t.Fatalf("metrics missing %s:\n%s", want, metrics)
			}
		}
	})

	t.Run("create real upstream subscription plans in each new-api set", func(t *testing.T) {
		for _, set := range cfg.Sets {
			session := loginNewAPI(t, cfg, set, cfg.NewAPIRoot.Username, cfg.NewAPIRoot.Password)
			confirmPaymentCompliance(t, session)
			disableNewAPIDiskPerformanceGate(t, session)
			planID := createUpstreamPlan(t, session, cfg.Scenario.Plan.Title+" "+runID, cfg.Scenario.Plan.TotalAmount, cfg.Scenario.Plan.DurationUnit, cfg.Scenario.Plan.DurationValue)
			upstreamPlanIDs[set.ID] = planID
			dailyID := createUpstreamPlan(t, session, "LLMGateway E2E Daily "+runID, dailyPlanTokens, "day", dailyPlanDurationValue)
			dailyUpstreamPlanIDs[set.ID] = dailyID
		}
		if len(upstreamPlanIDs) != len(cfg.Sets) {
			t.Fatalf("created upstream plan ids = %+v", upstreamPlanIDs)
		}
		if len(dailyUpstreamPlanIDs) != len(cfg.Sets) {
			t.Fatalf("created daily upstream plan ids = %+v", dailyUpstreamPlanIDs)
		}
	})

	t.Run("register llmgateway plans mapped to both sets", func(t *testing.T) {
		adminPost(t, client, cfg, "/api/plans", map[string]any{
			"id":                externalPlanID,
			"name":              cfg.Scenario.Plan.Title,
			"monthly_tokens":    cfg.Scenario.Plan.TotalAmount,
			"period_value":      cfg.Scenario.Plan.DurationValue,
			"period_unit":       cfg.Scenario.Plan.GatewayPeriodUnit,
			"is_active":         true,
			"upstream_plan_ids": upstreamPlanIDs,
		}, nil)
		adminPost(t, client, cfg, "/api/plans", map[string]any{
			"id":                dailyPlanID,
			"name":              "LLMGateway E2E Daily",
			"monthly_tokens":    dailyPlanTokens,
			"period_value":      dailyPlanDurationValue,
			"period_unit":       "days",
			"is_active":         true,
			"upstream_plan_ids": dailyUpstreamPlanIDs,
		}, nil)
		adminPost(t, client, cfg, "/api/plans", map[string]any{
			"id":                splitPlanID,
			"name":              "LLMGateway E2E Split",
			"monthly_tokens":    cfg.Scenario.Plan.TotalAmount,
			"period_value":      cfg.Scenario.Plan.DurationValue,
			"period_unit":       cfg.Scenario.Plan.GatewayPeriodUnit,
			"is_active":         true,
			"upstream_plan_ids": map[string]int{cfg.Sets[1].ID: upstreamPlanIDs[cfg.Sets[1].ID]},
		}, nil)
	})

	t.Run("control-plane auth separates admin and internal callers", func(t *testing.T) {
		req := newJSONRequest(t, http.MethodGet, cfg.LLMGateway.BaseURL+"/api/sets", nil)
		expectStatus(t, client, req, http.StatusUnauthorized)

		req = newJSONRequest(t, http.MethodGet, cfg.LLMGateway.BaseURL+"/api/internal/plans/"+url.PathEscape(externalPlanID), nil)
		expectStatus(t, client, req, http.StatusUnauthorized)

		req = newJSONRequest(t, http.MethodGet, cfg.LLMGateway.BaseURL+"/api/internal/plans/"+url.PathEscape(externalPlanID), nil)
		req.Header.Set("Authorization", "Bearer "+cfg.LLMGateway.AdminToken)
		expectStatus(t, client, req, http.StatusUnauthorized)

		req = newJSONRequest(t, http.MethodGet, cfg.LLMGateway.BaseURL+"/api/internal/plans/"+url.PathEscape(externalPlanID), nil)
		req.Header.Set("Authorization", "Bearer "+cfg.LLMGateway.InternalToken)
		resp := do(t, client, req)
		defer resp.Body.Close()
		var parsed apiResponse[struct {
			ID string `json:"id"`
		}]
		decodeSuccess(t, resp, &parsed)
		if parsed.Data.ID != externalPlanID {
			t.Fatalf("internal plan lookup returned %+v", parsed.Data)
		}
	})

	t.Run("ctl bundle validation sees the exact plan fields it compares", func(t *testing.T) {
		var plan struct {
			ID            string `json:"id"`
			Name          string `json:"name"`
			MonthlyTokens int64  `json:"monthly_tokens"`
			PeriodValue   int    `json:"period_value"`
			PeriodUnit    string `json:"period_unit"`
			IsActive      bool   `json:"is_active"`
		}
		internalGet(t, client, cfg, "/api/internal/plans/"+url.PathEscape(externalPlanID), &plan)
		if plan.ID != externalPlanID ||
			plan.MonthlyTokens != cfg.Scenario.Plan.TotalAmount ||
			plan.PeriodValue != cfg.Scenario.Plan.DurationValue ||
			plan.PeriodUnit != cfg.Scenario.Plan.GatewayPeriodUnit ||
			!plan.IsActive {
			t.Fatalf("plan fields do not match ctl bundle validation contract: %+v", plan)
		}

		req := newJSONRequest(t, http.MethodGet, cfg.LLMGateway.BaseURL+"/api/internal/plans/missing-"+url.PathEscape(externalPlanID), nil)
		req.Header.Set("Authorization", "Bearer "+cfg.LLMGateway.InternalToken)
		body := expectStatus(t, client, req, http.StatusNotFound)
		assertOpenAIError(t, body, "not_found_error", "not_found")
	})

	t.Run("internal ensure user is idempotent before provisioning", func(t *testing.T) {
		ensureUserID := "ensure-" + runID
		var first struct {
			Result string `json:"result"`
			UserID string `json:"user_id"`
		}
		internalPost(t, client, cfg, "/api/internal/users/ensure", map[string]any{"user_id": ensureUserID}, &first)
		if first.Result != "created" || first.UserID != ensureUserID {
			t.Fatalf("first ensure user returned %+v", first)
		}
		var second struct {
			Result string `json:"result"`
			UserID string `json:"user_id"`
		}
		internalPost(t, client, cfg, "/api/internal/users/ensure", map[string]any{"user_id": ensureUserID}, &second)
		if second.Result != "existing" || second.UserID != ensureUserID {
			t.Fatalf("second ensure user returned %+v", second)
		}

		internalPost(t, client, cfg, "/api/internal/subscriptions/cancel", map[string]any{"user_id": ensureUserID}, nil)
		req := newJSONRequest(t, http.MethodGet, cfg.LLMGateway.BaseURL+"/api/internal/users/"+url.PathEscape(ensureUserID)+"/subscriptions", nil)
		req.Header.Set("Authorization", "Bearer "+cfg.LLMGateway.InternalToken)
		body := expectStatus(t, client, req, http.StatusNotFound)
		assertOpenAIError(t, body, "not_found_error", "not_found")
	})

	t.Run("inactive plan cannot be applied through the trade-facing API", func(t *testing.T) {
		inactivePlanID := "inactive-" + externalPlanID
		adminPost(t, client, cfg, "/api/plans", map[string]any{
			"id":                inactivePlanID,
			"name":              "inactive " + cfg.Scenario.Plan.Title,
			"monthly_tokens":    cfg.Scenario.Plan.TotalAmount,
			"period_value":      cfg.Scenario.Plan.DurationValue,
			"period_unit":       cfg.Scenario.Plan.GatewayPeriodUnit,
			"is_active":         false,
			"upstream_plan_ids": upstreamPlanIDs,
		}, nil)
		req := newJSONRequest(t, http.MethodPost, cfg.LLMGateway.BaseURL+"/api/internal/subscriptions/apply", map[string]any{
			"user_id": "inactive-user-" + runID,
			"plan_id": inactivePlanID,
		})
		req.Header.Set("Authorization", "Bearer "+cfg.LLMGateway.InternalToken)
		body := expectStatus(t, client, req, http.StatusNotFound)
		assertOpenAIError(t, body, "not_found_error", "not_found")
	})

	t.Run("period start override is rejected and does not create a subscription", func(t *testing.T) {
		overrideUserID := "period-start-" + runID
		req := newJSONRequest(t, http.MethodPost, cfg.LLMGateway.BaseURL+"/api/internal/subscriptions/apply", map[string]any{
			"user_id":      overrideUserID,
			"plan_id":      externalPlanID,
			"period_start": time.Now().UTC().Add(-24 * time.Hour).Format(time.RFC3339Nano),
		})
		req.Header.Set("Authorization", "Bearer "+cfg.LLMGateway.InternalToken)
		body := expectStatus(t, client, req, http.StatusBadRequest)
		assertOpenAIError(t, body, "invalid_request_error", "bad_request")

		req = newJSONRequest(t, http.MethodGet, cfg.LLMGateway.BaseURL+"/api/internal/users/"+url.PathEscape(overrideUserID)+"/subscriptions", nil)
		req.Header.Set("Authorization", "Bearer "+cfg.LLMGateway.InternalToken)
		body = expectStatus(t, client, req, http.StatusNotFound)
		assertOpenAIError(t, body, "not_found_error", "not_found")
	})

	t.Run("plan mapped to one set assigns new users to that set", func(t *testing.T) {
		targetSet := cfg.Sets[1]
		adminPost(t, client, cfg, "/api/plans", map[string]any{
			"id":                singleSetPlanID,
			"name":              "single set " + cfg.Scenario.Plan.Title,
			"monthly_tokens":    cfg.Scenario.Plan.TotalAmount,
			"period_value":      cfg.Scenario.Plan.DurationValue,
			"period_unit":       cfg.Scenario.Plan.GatewayPeriodUnit,
			"is_active":         true,
			"upstream_plan_ids": map[string]int{targetSet.ID: upstreamPlanIDs[targetSet.ID]},
		}, nil)

		singleSetUserID := "single-set-user-" + runID
		var sub subscriptionPayload
		internalPost(t, client, cfg, "/api/internal/subscriptions/apply", map[string]any{
			"user_id": singleSetUserID,
			"plan_id": singleSetPlanID,
		}, &sub)
		assertActiveSubscription(t, sub, singleSetUserID, singleSetPlanID, cfg.Scenario.Plan.TotalAmount)

		var created struct {
			ExternalKey   string `json:"external_key"`
			ExternalKeyID string `json:"external_key_id"`
			SetID         string `json:"set_id"`
			UpstreamKeyID int    `json:"upstream_key_id"`
		}
		adminPost(t, client, cfg, "/api/users/"+url.PathEscape(singleSetUserID)+"/keys", nil, &created)
		if created.SetID != targetSet.ID || created.ExternalKey == "" || created.ExternalKeyID == "" || created.UpstreamKeyID <= 0 {
			t.Fatalf("single-set plan did not bind user to %q: %+v", targetSet.ID, created)
		}
		internalPost(t, client, cfg, "/api/internal/subscriptions/cancel", map[string]any{"user_id": singleSetUserID}, nil)
	})

	userID := "user-" + runID
	var apiKey string
	var keyID string
	var secondAPIKey string
	var currentSub subscriptionPayload
	var currentTokenBalance int64

	t.Run("usage endpoint keeps its top-level payload shape", func(t *testing.T) {
		req := newJSONRequest(t, http.MethodGet, cfg.LLMGateway.BaseURL+"/api/admin/users/"+url.PathEscape(userID)+"/usage?days=30", nil)
		req.Header.Set("Authorization", "Bearer "+cfg.LLMGateway.AdminToken)
		resp := do(t, client, req)
		defer resp.Body.Close()
		raw, err := io.ReadAll(resp.Body)
		if err != nil {
			t.Fatal(err)
		}
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("usage status=%d body=%s", resp.StatusCode, raw)
		}
		var usage map[string]json.RawMessage
		if err := json.Unmarshal(raw, &usage); err != nil {
			t.Fatalf("decode usage: %v body=%s", err, raw)
		}
		if _, wrapped := usage["success"]; wrapped {
			t.Fatalf("usage endpoint unexpectedly returned wrapped payload: %s", raw)
		}
		if string(usage["user_id"]) != fmt.Sprintf("%q", userID) || string(usage["days"]) != "30" {
			t.Fatalf("unexpected usage payload: %s", raw)
		}
	})

	t.Run("ctl instance automation can create a key for a never-seen user", func(t *testing.T) {
		keyOnlyUserID := "key-only-" + runID
		created := createAdminAPIKey(t, client, cfg, keyOnlyUserID, "default")
		status, body := gatewayTraffic(t, client, cfg, created.APIKey)
		if status == http.StatusUnauthorized || status == http.StatusServiceUnavailable {
			t.Fatalf("key-only user traffic failed: status=%d body=%s", status, body)
		}
		req := newJSONRequest(t, http.MethodDelete, cfg.LLMGateway.BaseURL+"/api/admin/api-keys/"+url.PathEscape(created.KeyID), nil)
		req.Header.Set("Authorization", "Bearer "+cfg.LLMGateway.AdminToken)
		expectStatus(t, client, req, http.StatusOK)
	})

	t.Run("migration cgi activates next entitlement on requested set", func(t *testing.T) {
		targetSet := cfg.Sets[len(cfg.Sets)-1]
		migrationUserID := "migrate-" + runID
		var dryRun struct {
			UserID         string `json:"user_id"`
			Backend        string `json:"backend"`
			SetID          string `json:"set_id"`
			PlanID         string `json:"plan_id"`
			UpstreamPlanID int    `json:"upstream_plan_id"`
			DryRun         bool   `json:"dry_run"`
			Migrated       bool   `json:"migrated"`
		}
		internalPost(t, client, cfg, "/api/internal/migrations/users/"+url.PathEscape(migrationUserID)+"/dry-run", map[string]any{
			"set_id":  targetSet.ID,
			"plan_id": externalPlanID,
		}, &dryRun)
		if !dryRun.DryRun || dryRun.Migrated || dryRun.UserID != migrationUserID || dryRun.SetID != targetSet.ID || dryRun.PlanID != externalPlanID {
			t.Fatalf("unexpected migration dry-run: %+v", dryRun)
		}

		var migrated struct {
			UserID    string `json:"user_id"`
			Backend   string `json:"backend"`
			SetID     string `json:"set_id"`
			PlanID    string `json:"plan_id"`
			Migrated  bool   `json:"migrated"`
			APIKey    string `json:"api_key"`
			KeyID     string `json:"key_id"`
			KeyPrefix string `json:"key_prefix"`
		}
		internalPost(t, client, cfg, "/api/internal/migrations/users/"+url.PathEscape(migrationUserID), map[string]any{
			"set_id":    targetSet.ID,
			"plan_id":   externalPlanID,
			"issue_key": true,
		}, &migrated)
		if !migrated.Migrated || migrated.Backend != "new" || migrated.SetID != targetSet.ID || migrated.PlanID != externalPlanID {
			t.Fatalf("unexpected migration commit: %+v", migrated)
		}
		if migrated.APIKey == "" || migrated.KeyID == "" || migrated.KeyPrefix == "" || !strings.HasPrefix(migrated.APIKey, migrated.KeyPrefix) {
			t.Fatalf("migration did not issue a usable key payload: %+v", migrated)
		}

		var assignment struct {
			UserID  string `json:"user_id"`
			Backend string `json:"backend"`
			SetID   string `json:"set_id"`
		}
		internalGet(t, client, cfg, "/api/internal/users/"+url.PathEscape(migrationUserID)+"/assignment", &assignment)
		if assignment.UserID != migrationUserID || assignment.Backend != "new" || assignment.SetID != targetSet.ID {
			t.Fatalf("migration assignment mismatch: %+v", assignment)
		}

		var migratedSub subscriptionPayload
		internalGet(t, client, cfg, "/api/internal/users/"+url.PathEscape(migrationUserID)+"/subscriptions", &migratedSub)
		assertActiveSubscription(t, migratedSub, migrationUserID, externalPlanID, cfg.Scenario.Plan.TotalAmount)

		var state userStatePayload
		adminGet(t, client, cfg, "/api/admin/users/"+url.PathEscape(migrationUserID)+"/state", &state)
		if state.UserID != migrationUserID ||
			state.Backend != "new" ||
			state.SetID != targetSet.ID ||
			state.CurrentPlanID != externalPlanID ||
			state.LastAppliedPlanID != externalPlanID ||
			state.SubscriptionStatus != "active" ||
			!state.HasActiveSubscription ||
			state.CreditStatus != "ok" ||
			state.CreditAvailable != cfg.Scenario.Plan.TotalAmount ||
			state.TokenBalance != cfg.Scenario.Plan.TotalAmount ||
			state.Source != "new-api" ||
			state.PeriodEnd != migratedSub.PeriodEnd ||
			state.UpstreamUserID <= 0 ||
			state.Username == "" {
			t.Fatalf("unexpected migrated user state: %+v sub=%+v", state, migratedSub)
		}

		var tenants struct {
			Total int `json:"total"`
			Items []struct {
				UserID           string `json:"user_id"`
				Backend          string `json:"backend"`
				SetID            string `json:"set_id"`
				LastPlanID       string `json:"last_plan_id"`
				KeyCount         int    `json:"key_count"`
				AssignmentStatus string `json:"assignment_status"`
			} `json:"items"`
		}
		adminGet(t, client, cfg, "/api/admin/tenants?keyword="+url.QueryEscape(migrationUserID), &tenants)
		if tenants.Total != 1 || len(tenants.Items) != 1 {
			t.Fatalf("migrated tenant missing from tenant list: %+v", tenants)
		}
		if tenants.Items[0].UserID != migrationUserID ||
			tenants.Items[0].Backend != "new" ||
			tenants.Items[0].SetID != targetSet.ID ||
			tenants.Items[0].LastPlanID != externalPlanID ||
			tenants.Items[0].KeyCount != 1 ||
			tenants.Items[0].AssignmentStatus != "explicit" {
			t.Fatalf("unexpected migrated tenant row: %+v", tenants.Items[0])
		}

		status, body := gatewayTraffic(t, client, cfg, migrated.APIKey)
		if status == http.StatusUnauthorized || status == http.StatusServiceUnavailable {
			t.Fatalf("migration-issued key traffic failed: status=%d body=%s", status, body)
		}
	})

	t.Run("unknown traffic key is rejected before any user setup", func(t *testing.T) {
		status, body := gatewayTraffic(t, client, cfg, "llmgw-missing-"+runID)
		if status != http.StatusUnauthorized {
			t.Fatalf("unknown key traffic status=%d body=%s", status, body)
		}
	})

	t.Run("ctl applies subscription and sees active balance", func(t *testing.T) {
		internalPost(t, client, cfg, "/api/internal/subscriptions/apply", map[string]any{
			"user_id":      userID,
			"plan_id":      externalPlanID,
			"period_value": cfg.Scenario.Plan.DurationValue,
			"period_unit":  "m",
		}, &currentSub)
		currentTokenBalance = cfg.Scenario.Plan.TotalAmount
		assertActiveSubscription(t, currentSub, userID, externalPlanID, currentTokenBalance)
	})

	t.Run("observer worker automatically persists active subscription projection", func(t *testing.T) {
		var observed tenantObservationPayload
		deadline := time.Now().Add(30 * time.Second)
		for {
			var detail struct {
				Observation tenantObservationPayload `json:"observation"`
			}
			adminGet(t, client, cfg, "/api/admin/tenants/"+url.PathEscape(userID), &detail)
			observed = detail.Observation
			if observed.CurrentPlanID == externalPlanID && observed.CreditStatus == "ok" && observed.PeriodEnd == currentSub.PeriodEnd {
				break
			}
			if time.Now().After(deadline) {
				t.Fatalf("observer worker did not refresh tenant projection: %+v", observed)
			}
			time.Sleep(200 * time.Millisecond)
		}
		if observed.UserID != userID ||
			observed.Backend != "new" ||
			observed.SetID == "" ||
			observed.UpstreamUserID == 0 ||
			observed.CurrentPlanID != externalPlanID ||
			observed.LastAppliedPlanID != externalPlanID ||
			observed.SubscriptionStatus != "active" ||
			!observed.HasActiveSubscription ||
			observed.TokenBalance != cfg.Scenario.Plan.TotalAmount ||
			observed.CreditAvailable != cfg.Scenario.Plan.TotalAmount ||
			observed.CreditStatus != "ok" ||
			observed.PeriodEnd != currentSub.PeriodEnd ||
			observed.Source != "new-api" ||
			observed.ObservedAt.IsZero() {
			t.Fatalf("unexpected tenant observation projection: %+v currentSub=%+v", observed, currentSub)
		}

		var rows resourceRowsPayload
		adminGet(t, client, cfg, "/api/admin/resources/tenant_observations/rows?limit=200", &rows)
		row := requireResourceRow(t, rows.Rows, userID)
		if resourceString(row, "current_plan_id") != externalPlanID ||
			resourceString(row, "last_applied_plan_id") != externalPlanID ||
			resourceString(row, "subscription_status") != "active" ||
			!resourceBool(row, "has_active_subscription") ||
			resourceInt64(row, "credit_available") != cfg.Scenario.Plan.TotalAmount ||
			resourceString(row, "credit_status") != "ok" ||
			resourceString(row, "period_end") != currentSub.PeriodEnd ||
			resourceString(row, "source") != "new-api" {
			t.Fatalf("tenant observation resource row mismatch: %+v observed=%+v", row, observed)
		}

		var tenants tenantListPayload
		adminGet(t, client, cfg, "/api/admin/tenants?keyword="+url.QueryEscape(userID)+"&limit=20", &tenants)
		if len(tenants.Items) == 0 ||
			tenants.Items[0].UserID != userID ||
			tenants.Items[0].ObservedPlanID != externalPlanID ||
			tenants.Items[0].ObservedCreditAvailable != cfg.Scenario.Plan.TotalAmount ||
			tenants.Items[0].ObservedCreditStatus != "ok" ||
			tenants.Items[0].ObservedSubscriptionStatus != "active" {
			t.Fatalf("tenant list did not expose latest observation: %+v", tenants)
		}
	})

	t.Run("ctl can apply a day-based bundle period alias", func(t *testing.T) {
		dailyUserID := "daily-user-" + runID
		var sub subscriptionPayload
		internalPost(t, client, cfg, "/api/internal/subscriptions/apply", map[string]any{
			"user_id":      dailyUserID,
			"plan_id":      dailyPlanID,
			"period_value": dailyPlanDurationValue,
			"period_unit":  "d",
		}, &sub)
		assertActiveSubscription(t, sub, dailyUserID, dailyPlanID, dailyPlanTokens)
		start, err := time.Parse(time.RFC3339Nano, sub.PeriodStart)
		if err != nil {
			t.Fatalf("parse daily period_start %q: %v", sub.PeriodStart, err)
		}
		wantEnd := start.AddDate(0, 0, dailyPlanDurationValue)
		assertSubscriptionPeriodEnd(t, sub, wantEnd)
		internalPost(t, client, cfg, "/api/internal/subscriptions/cancel", map[string]any{"user_id": dailyUserID}, nil)
	})

	t.Run("subscription service legacy client can apply and cancel without internal auth", func(t *testing.T) {
		legacyUserID := "subscription-service-" + runID
		req := legacyJSONRequest(t, http.MethodPost, cfg.LLMGateway.BaseURL+"/api/internal/subscriptions/apply", map[string]any{
			"user_id":  legacyUserID,
			"plan_id":  externalPlanID,
			"nickname": legacyUserID,
			"phone":    "13000000000",
		})
		resp := do(t, client, req)
		raw, err := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		if err != nil {
			t.Fatal(err)
		}
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("legacy subscription apply status=%d body=%s", resp.StatusCode, raw)
		}
		var maybeWrapped map[string]json.RawMessage
		if err := json.Unmarshal(raw, &maybeWrapped); err != nil {
			t.Fatalf("decode legacy apply response: %v body=%s", err, raw)
		}
		if _, wrapped := maybeWrapped["success"]; wrapped {
			t.Fatalf("subscription service expects a naked subscription, got wrapped response: %s", raw)
		}
		var sub subscriptionPayload
		if err := json.Unmarshal(raw, &sub); err != nil {
			t.Fatalf("decode naked legacy subscription: %v body=%s", err, raw)
		}
		assertActiveSubscription(t, sub, legacyUserID, externalPlanID, cfg.Scenario.Plan.TotalAmount)

		cancelReq := legacyJSONRequest(t, http.MethodPost, cfg.LLMGateway.BaseURL+"/api/internal/subscriptions/cancel", map[string]any{
			"user_id": legacyUserID,
		})
		cancelResp := do(t, client, cancelReq)
		cancelBody, _ := io.ReadAll(cancelResp.Body)
		_ = cancelResp.Body.Close()
		if cancelResp.StatusCode != http.StatusOK {
			t.Fatalf("legacy subscription cancel status=%d body=%s", cancelResp.StatusCode, cancelBody)
		}
		req = newJSONRequest(t, http.MethodGet, cfg.LLMGateway.BaseURL+"/api/internal/users/"+url.PathEscape(legacyUserID)+"/subscriptions", nil)
		req.Header.Set("Authorization", "Bearer "+cfg.LLMGateway.InternalToken)
		body := expectStatus(t, client, req, http.StatusNotFound)
		assertOpenAIError(t, body, "not_found_error", "not_found")
	})

	t.Run("live OpenAI-compatible chat traffic is proxied through a managed set", func(t *testing.T) {
		liveCfg, ok := loadLiveLLMConfig()
		if !ok {
			t.Skip("set LLMGATEWAY_LIVE_API_KEY to run live TokenHub traffic e2e")
		}
		targetSet := cfg.Sets[0]
		livePlanID := "live-" + externalPlanID

		session := loginNewAPI(t, cfg, targetSet, cfg.NewAPIRoot.Username, cfg.NewAPIRoot.Password)
		confirmPaymentCompliance(t, session)
		disableNewAPIDiskPerformanceGate(t, session)
		configureLiveModelPricing(t, session, liveCfg.Model)
		createLiveOpenAIChannel(t, session, liveCfg, runID)

		adminPost(t, client, cfg, "/api/plans", map[string]any{
			"id":                livePlanID,
			"name":              "LLMGateway Live TokenHub " + runID,
			"monthly_tokens":    cfg.Scenario.Plan.TotalAmount,
			"period_value":      cfg.Scenario.Plan.DurationValue,
			"period_unit":       cfg.Scenario.Plan.GatewayPeriodUnit,
			"is_active":         true,
			"upstream_plan_ids": map[string]int{targetSet.ID: upstreamPlanIDs[targetSet.ID]},
		}, nil)

		userID := "live-traffic-" + runID
		var sub subscriptionPayload
		internalPost(t, client, cfg, "/api/internal/subscriptions/apply", map[string]any{
			"user_id": userID,
			"plan_id": livePlanID,
		}, &sub)
		assertActiveSubscription(t, sub, userID, livePlanID, cfg.Scenario.Plan.TotalAmount)
		key := createAdminAPIKey(t, client, cfg, userID, "live-chat")

		liveClient := &http.Client{Timeout: 90 * time.Second}
		nonStreamBody := gatewayLiveChatCompletion(t, liveClient, cfg, key.APIKey, liveCfg.Model, false)
		assertLiveChatCompletion(t, nonStreamBody)

		streamBody := gatewayLiveChatCompletion(t, liveClient, cfg, key.APIKey, liveCfg.Model, true)
		if !bytes.Contains(streamBody, []byte("data:")) {
			t.Fatalf("live stream response did not look like SSE: %s", streamBody)
		}
	})

	t.Run("live channel desired state syncs to every set and serves traffic", func(t *testing.T) {
		liveCfg, ok := loadLiveLLMConfig()
		if !ok {
			t.Skip("set LLMGATEWAY_LIVE_API_KEY to run live TokenHub traffic e2e")
		}
		channelID := "managed-live-" + runID
		channelName := "Managed TokenHub " + runID
		remoteName := "llmgw:" + channelID + "-openai:" + channelName

		upsertOpenAIChannelBundle(t, client, cfg, channelID, channelName, liveCfg)
		for _, set := range cfg.Sets {
			session := loginNewAPI(t, cfg, set, cfg.NewAPIRoot.Username, cfg.NewAPIRoot.Password)
			confirmPaymentCompliance(t, session)
			disableNewAPIDiskPerformanceGate(t, session)
			state := applyChannelBundleToSet(t, client, cfg, channelID, set.ID)
			if state.BundleID != channelID || state.SetID != set.ID || state.Status != "synced" || state.AppliedFingerprint == "" {
				t.Fatalf("live bundle did not sync to set %s: %+v", set.ID, state)
			}
			if channel := findNewAPIChannel(t, session, remoteName); channel.ID <= 0 {
				t.Fatalf("set %s did not contain remote channel %q: %+v", set.ID, remoteName, channel)
			}
			assertNewAPIRatioOptionContains(t, session, "ModelRatio", liveCfg.Model)
			assertNewAPIRatioOptionContains(t, session, "CompletionRatio", liveCfg.Model)
		}

		userID := "managed-channel-traffic-" + runID
		var sub subscriptionPayload
		internalPost(t, client, cfg, "/api/internal/subscriptions/apply", map[string]any{
			"user_id": userID,
			"plan_id": externalPlanID,
		}, &sub)
		assertActiveSubscription(t, sub, userID, externalPlanID, cfg.Scenario.Plan.TotalAmount)
		key := createAdminAPIKey(t, client, cfg, userID, "managed-channel-chat")

		liveClient := &http.Client{Timeout: 90 * time.Second}
		nonStreamBody := gatewayLiveChatCompletion(t, liveClient, cfg, key.APIKey, liveCfg.Model, false)
		assertLiveChatCompletion(t, nonStreamBody)
	})

	t.Run("local mockllm channel bundle syncs to every set and serves chat traffic", func(t *testing.T) {
		mockCfg := requireMockLLMConfig(t, cfg)
		channelID := "managed-mockllm-" + runID
		channelName := "Managed MockLLM " + runID

		upsertOpenAIChannelBundle(t, client, cfg, channelID, channelName, mockCfg)
		for _, set := range cfg.Sets {
			state := applyChannelBundleToSet(t, client, cfg, channelID, set.ID)
			if state.BundleID != channelID || state.SetID != set.ID || state.Status != "synced" || state.AppliedFingerprint == "" {
				t.Fatalf("mockllm bundle did not sync to set %s: %+v", set.ID, state)
			}
			session := loginNewAPI(t, cfg, set, cfg.NewAPIRoot.Username, cfg.NewAPIRoot.Password)
			assertNewAPIRatioOptionContains(t, session, "ModelRatio", mockCfg.Model)
			assertNewAPIRatioOptionContains(t, session, "CompletionRatio", mockCfg.Model)
		}
		driftSet := cfg.Sets[0]
		driftSession := loginNewAPI(t, cfg, driftSet, cfg.NewAPIRoot.Username, cfg.NewAPIRoot.Password)
		remoteName := "llmgw:" + channelID + "-openai:" + channelName
		updateNewAPIChannelModels(t, driftSession, remoteName, "manual-drift-"+runID)

		driftPlan := planChannelBundleForSet(t, client, cfg, channelID, driftSet.ID, false)
		if driftPlan.Status != "drift" || len(driftPlan.Steps) != 1 || !driftPlan.Steps[0].RequiresForce {
			t.Fatalf("mockllm drift plan = %+v, want drift requiring force", driftPlan)
		}
		driftState := applyChannelBundleToSet(t, client, cfg, channelID, driftSet.ID)
		if driftState.Status != "drift" {
			t.Fatalf("normal apply should not overwrite manual drift: %+v", driftState)
		}
		if channel := findNewAPIChannel(t, driftSession, remoteName); channel.Models != "manual-drift-"+runID {
			t.Fatalf("normal apply overwrote manual drift, remote channel=%+v", channel)
		}
		forcedState := applyChannelBundleToSetWithForce(t, client, cfg, channelID, driftSet.ID)
		if forcedState.Status != "synced" {
			t.Fatalf("force apply did not resync drifted channel: %+v", forcedState)
		}
		if channel := findNewAPIChannel(t, driftSession, remoteName); channel.Models != mockCfg.Model {
			t.Fatalf("force apply did not restore desired model %q, remote channel=%+v", mockCfg.Model, channel)
		}

		userID := "mockllm-traffic-" + runID
		var sub subscriptionPayload
		internalPost(t, client, cfg, "/api/internal/subscriptions/apply", map[string]any{
			"user_id": userID,
			"plan_id": externalPlanID,
		}, &sub)
		assertActiveSubscription(t, sub, userID, externalPlanID, cfg.Scenario.Plan.TotalAmount)
		key := createAdminAPIKey(t, client, cfg, userID, "mockllm-chat")

		chatClient := &http.Client{Timeout: 30 * time.Second}
		runOpenAITransparentTrafficGoldenCases(t, chatClient, cfg, key.APIKey, mockCfg)
	})

	t.Run("BYOK user policy syncs private providers and switches between private and platform channels", func(t *testing.T) {
		if len(cfg.Sets) < 2 {
			t.Skip("needs at least two sets")
		}
		mockCfg := requireMockLLMConfig(t, cfg)
		targetSet := cfg.Sets[1]
		platformBundleID := "byok-platform-mockllm-" + runID
		platformBundleName := "BYOK Platform MockLLM " + runID
		upsertOpenAIChannelBundle(t, client, cfg, platformBundleID, platformBundleName, mockCfg)
		for _, set := range cfg.Sets {
			state := applyChannelBundleToSet(t, client, cfg, platformBundleID, set.ID)
			if state.BundleID != platformBundleID || state.SetID != set.ID || state.Status != "synced" {
				t.Fatalf("BYOK platform bundle did not sync to set %s: %+v", set.ID, state)
			}
		}

		byokUserID := "byok-user-" + runID
		var sub subscriptionPayload
		internalPost(t, client, cfg, "/api/internal/subscriptions/apply", map[string]any{
			"user_id": byokUserID,
			"plan_id": splitPlanID,
		}, &sub)
		assertActiveSubscription(t, sub, byokUserID, splitPlanID, cfg.Scenario.Plan.TotalAmount)
		key := createAdminAPIKey(t, client, cfg, byokUserID, "byok-policy")

		status, raw, err := gatewayRaw(client, cfg, http.MethodPut, "/api/internal/users/"+url.PathEscape(byokUserID)+"/llm-settings", cfg.LLMGateway.InternalToken, map[string]any{
			"routing": map[string]any{"mode": "byok_first"},
			"providers": []map[string]any{
				{
					"id":             "provider-a",
					"name":           "Mock BYOK A",
					"protocol":       "openai_compatible",
					"base_url":       mockCfg.BaseURL,
					"api_key":        "sk-mockllm-byok-a",
					"model_mappings": map[string]string{mockCfg.Model: mockCfg.Model},
					"enabled":        true,
				},
				{
					"id":             "provider-b",
					"name":           "Mock BYOK B",
					"protocol":       "openai_compatible",
					"base_url":       mockCfg.BaseURL,
					"api_key":        "sk-mockllm-byok-b",
					"model_mappings": map[string]string{mockCfg.Model: mockCfg.Model},
					"enabled":        true,
				},
			},
		})
		if err != nil {
			t.Fatal(err)
		}
		if status != http.StatusOK {
			t.Fatalf("save BYOK settings status=%d body=%s", status, raw)
		}
		if bytes.Contains(raw, []byte("sk-mockllm-byok")) {
			t.Fatalf("BYOK settings response leaked provider key: %s", raw)
		}

		status, raw, err = gatewayRaw(client, cfg, http.MethodPost, "/api/internal/users/"+url.PathEscape(byokUserID)+"/llm-settings/sync", cfg.LLMGateway.InternalToken, nil)
		if err != nil {
			t.Fatal(err)
		}
		if status != http.StatusOK {
			t.Fatalf("sync BYOK settings status=%d body=%s", status, raw)
		}
		var queuedResp apiResponse[struct {
			UserID           string `json:"user_id"`
			SetID            string `json:"set_id"`
			BYOKGroup        string `json:"byok_group"`
			Status           string `json:"status"`
			RequestedVersion int64  `json:"requested_version"`
			Providers        []struct {
				ID         string `json:"id"`
				SyncStatus string `json:"sync_status"`
			} `json:"providers"`
		}]
		if err := json.Unmarshal(raw, &queuedResp); err != nil || !queuedResp.Success {
			t.Fatalf("decode BYOK sync response err=%v body=%s", err, raw)
		}
		if queuedResp.Data.UserID != byokUserID || queuedResp.Data.SetID != targetSet.ID || queuedResp.Data.BYOKGroup == "" || queuedResp.Data.Status != "pending" || queuedResp.Data.RequestedVersion <= 0 {
			t.Fatalf("unexpected queued BYOK identity: %+v", queuedResp.Data)
		}
		if len(queuedResp.Data.Providers) != 2 {
			t.Fatalf("queued BYOK providers len=%d want=2: %+v", len(queuedResp.Data.Providers), queuedResp.Data.Providers)
		}
		for _, provider := range queuedResp.Data.Providers {
			if provider.SyncStatus != "pending" {
				t.Fatalf("BYOK provider was not queued: %+v", provider)
			}
		}

		var syncedSettings struct {
			BYOKGroup         string `json:"byok_group"`
			BYOKUpstreamKeyID int    `json:"byok_upstream_key_id"`
			LastSyncError     string `json:"last_sync_error"`
			Providers         []struct {
				ID              string `json:"id"`
				RemoteChannelID int    `json:"remote_channel_id"`
				SyncStatus      string `json:"sync_status"`
				LastSyncError   string `json:"last_sync_error"`
			} `json:"providers"`
		}
		deadline := time.Now().Add(30 * time.Second)
		for {
			status, raw, err = gatewayRaw(client, cfg, http.MethodGet, "/api/internal/users/"+url.PathEscape(byokUserID)+"/llm-settings", cfg.LLMGateway.InternalToken, nil)
			if err != nil {
				t.Fatal(err)
			}
			if status != http.StatusOK {
				t.Fatalf("get BYOK settings status=%d body=%s", status, raw)
			}
			var settingsResp apiResponse[json.RawMessage]
			if err := json.Unmarshal(raw, &settingsResp); err != nil || !settingsResp.Success {
				t.Fatalf("decode BYOK settings envelope err=%v body=%s", err, raw)
			}
			if err := json.Unmarshal(settingsResp.Data, &syncedSettings); err != nil {
				t.Fatalf("decode BYOK settings err=%v body=%s", err, raw)
			}
			allSynced := syncedSettings.BYOKUpstreamKeyID > 0 && len(syncedSettings.Providers) == 2
			for _, provider := range syncedSettings.Providers {
				allSynced = allSynced && provider.RemoteChannelID > 0 && provider.SyncStatus == "synced"
			}
			if allSynced {
				break
			}
			if syncedSettings.LastSyncError != "" {
				t.Fatalf("BYOK worker failed: %+v", syncedSettings)
			}
			if time.Now().After(deadline) {
				t.Fatalf("BYOK worker did not converge: %+v", syncedSettings)
			}
			time.Sleep(200 * time.Millisecond)
		}

		targetSession := loginNewAPI(t, cfg, targetSet, cfg.NewAPIRoot.Username, cfg.NewAPIRoot.Password)
		assertNewAPIGroupRatioZero(t, targetSession, syncedSettings.BYOKGroup)
		for _, provider := range syncedSettings.Providers {
			channel := findNewAPIChannelByID(t, targetSession, provider.RemoteChannelID)
			if channel.Group != syncedSettings.BYOKGroup || channel.Models != mockCfg.Model {
				t.Fatalf("unexpected BYOK channel for %s: %+v group=%s", provider.ID, channel, syncedSettings.BYOKGroup)
			}
		}

		var before creditPayload
		internalGet(t, client, cfg, "/api/internal/users/"+url.PathEscape(byokUserID)+"/credit", &before)
		chatClient := &http.Client{Timeout: 30 * time.Second}
		byokBody := gatewayLiveChatCompletion(t, chatClient, cfg, key.APIKey, mockCfg.Model, false)
		if !bytes.Contains(byokBody, []byte("mockllm byok-a answer")) {
			t.Fatalf("byok_first did not reach first private BYOK provider: %s", byokBody)
		}
		var after creditPayload
		internalGet(t, client, cfg, "/api/internal/users/"+url.PathEscape(byokUserID)+"/credit", &after)
		if after.CreditAvailable != before.CreditAvailable || after.TokenBalance != before.TokenBalance {
			t.Fatalf("BYOK zero-ratio request changed paid balance: before=%+v after=%+v", before, after)
		}

		status, raw, err = gatewayRaw(client, cfg, http.MethodPut, "/api/internal/users/"+url.PathEscape(byokUserID)+"/llm-settings", cfg.LLMGateway.InternalToken, map[string]any{
			"routing": map[string]any{"mode": "platform_first"},
			"providers": []map[string]any{
				{
					"id":             "provider-a",
					"name":           "Mock BYOK A",
					"protocol":       "openai_compatible",
					"base_url":       mockCfg.BaseURL,
					"model_mappings": map[string]string{mockCfg.Model: mockCfg.Model},
					"enabled":        true,
				},
				{
					"id":             "provider-b",
					"name":           "Mock BYOK B",
					"protocol":       "openai_compatible",
					"base_url":       mockCfg.BaseURL,
					"model_mappings": map[string]string{mockCfg.Model: mockCfg.Model},
					"enabled":        true,
				},
			},
		})
		if err != nil {
			t.Fatal(err)
		}
		if status != http.StatusOK {
			t.Fatalf("switch BYOK settings to platform_first status=%d body=%s", status, raw)
		}
		if bytes.Contains(raw, []byte("sk-mockllm-byok")) {
			t.Fatalf("platform_first settings response leaked provider key: %s", raw)
		}

		platformBody := gatewayLiveChatCompletion(t, chatClient, cfg, key.APIKey, mockCfg.Model, false)
		if !bytes.Contains(platformBody, []byte("mockllm platform answer")) {
			t.Fatalf("platform_first did not reach platform channel: %s", platformBody)
		}
	})

	t.Run("split control and traffic processes keep separate surfaces and share state", func(t *testing.T) {
		controlURL := strings.TrimRight(cfg.LLMGateway.ControlBaseURL, "/")
		trafficURL := strings.TrimRight(cfg.LLMGateway.TrafficBaseURL, "/")
		if controlURL == "" || trafficURL == "" {
			t.Fatal("split control/traffic URLs are required")
		}
		waitForOK(ctx, t, client, controlURL+"/healthz")
		waitForOK(ctx, t, client, trafficURL+"/healthz")

		status, body, err := gatewayRawTo(client, controlURL, http.MethodGet, "/v1/models", "missing-key", nil)
		if err != nil {
			t.Fatal(err)
		}
		if status != http.StatusNotFound {
			t.Fatalf("control process exposed /v1/models: status=%d body=%s", status, body)
		}
		status, body, err = gatewayRawTo(client, trafficURL, http.MethodGet, "/api/sets", cfg.LLMGateway.AdminToken, nil)
		if err != nil {
			t.Fatal(err)
		}
		if status != http.StatusNotFound {
			t.Fatalf("traffic process exposed /api/sets: status=%d body=%s", status, body)
		}

		controlCfg := cfg
		controlCfg.LLMGateway.BaseURL = controlURL
		trafficCfg := cfg
		trafficCfg.LLMGateway.BaseURL = trafficURL

		for _, set := range cfg.Sets {
			adminPost(t, client, controlCfg, "/api/sets", map[string]any{
				"id":       set.ID,
				"name":     set.Name,
				"base_url": set.BaseURL,
				"status":   "active",
			}, nil)
			bootstrapManagedSet(t, client, controlCfg, set.ID)
		}

		mockCfg := requireMockLLMConfig(t, cfg)
		channelID := "split-mockllm-" + runID
		channelName := "Split MockLLM " + runID
		upsertOpenAIChannelBundle(t, client, controlCfg, channelID, channelName, mockCfg)
		for _, set := range cfg.Sets {
			state := applyChannelBundleToSet(t, client, controlCfg, channelID, set.ID)
			if state.BundleID != channelID || state.SetID != set.ID || state.Status != "synced" || state.AppliedFingerprint == "" {
				t.Fatalf("split bundle did not sync to set %s: %+v", set.ID, state)
			}
		}

		userID := "split-traffic-" + runID
		var sub subscriptionPayload
		internalPost(t, client, controlCfg, "/api/internal/subscriptions/apply", map[string]any{
			"user_id": userID,
			"plan_id": splitPlanID,
		}, &sub)
		assertActiveSubscription(t, sub, userID, splitPlanID, cfg.Scenario.Plan.TotalAmount)
		key := createAdminAPIKey(t, client, controlCfg, userID, "split-traffic-chat")

		chatClient := &http.Client{Timeout: 30 * time.Second}
		bodyBytes := gatewayLiveChatCompletion(t, chatClient, trafficCfg, key.APIKey, mockCfg.Model, false)
		assertLiveChatCompletion(t, bodyBytes)
		if !bytes.Contains(bodyBytes, []byte("mockllm")) {
			t.Fatalf("split traffic chat did not reach mockllm: %s", bodyBytes)
		}

		splitUserID = userID
		splitAPIKey = key.APIKey
		splitModel = mockCfg.Model
	})

	t.Run("channel bundle skips disabled set in compose", func(t *testing.T) {
		mockCfg := requireMockLLMConfig(t, cfg)
		bundleID := "disabled-set-bundle-" + runID
		disabledSetID := "disabled-channel-set-" + runID
		upsertOpenAIChannelBundle(t, client, cfg, bundleID, "Disabled Set Bundle "+runID, mockCfg)
		adminPost(t, client, cfg, "/api/sets", map[string]any{
			"id":       disabledSetID,
			"name":     "Disabled Channel Set " + runID,
			"base_url": "http://127.0.0.1:1",
			"status":   "disabled",
		}, nil)

		plan := planChannelBundleForSet(t, client, cfg, bundleID, disabledSetID, false)
		if plan.Status != "skipped" {
			t.Fatalf("disabled set plan = %+v, want skipped", plan)
		}
		state := applyChannelBundleToSet(t, client, cfg, bundleID, disabledSetID)
		if state.Status != "skipped" {
			t.Fatalf("disabled set apply = %+v, want skipped", state)
		}

		// 渠道包是全局期望状态。跳过断言完成后仍要发布到真实 Set，避免给后续准入检查留下未同步 revision。
		for _, set := range cfg.Sets {
			synced := applyChannelBundleToSet(t, client, cfg, bundleID, set.ID)
			if synced.Status != "synced" {
				t.Fatalf("disabled-set test bundle did not sync to real set %s: %+v", set.ID, synced)
			}
		}
	})

	t.Run("channel bundle partial set failure keeps healthy set synced", func(t *testing.T) {
		if len(cfg.Sets) < 2 {
			t.Skip("needs at least two sets")
		}
		mockCfg := requireMockLLMConfig(t, cfg)
		bundleID := "partial-set-bundle-" + runID
		badSet := cfg.Sets[0]
		goodSet := cfg.Sets[1]
		upsertOpenAIChannelBundle(t, client, cfg, bundleID, "Partial Set Bundle "+runID, mockCfg)

		goodState := applyChannelBundleToSet(t, client, cfg, bundleID, goodSet.ID)
		if goodState.Status != "synced" {
			t.Fatalf("healthy set did not sync before partial failure: %+v", goodState)
		}

		adminPost(t, client, cfg, "/api/sets", map[string]any{
			"id":       badSet.ID,
			"name":     badSet.Name,
			"base_url": "http://127.0.0.1:1",
			"status":   "active",
		}, nil)
		restoreBadSet := func() {
			adminPost(t, client, cfg, "/api/sets", map[string]any{
				"id":       badSet.ID,
				"name":     badSet.Name,
				"base_url": badSet.BaseURL,
				"status":   "active",
			}, nil)
		}
		t.Cleanup(restoreBadSet)

		status, body, err := adminPostRaw(client, cfg, "/api/channel-bundles/"+url.PathEscape(bundleID)+"/apply", map[string]any{
			"set_id": badSet.ID,
		})
		if err != nil {
			t.Fatal(err)
		}
		if status != http.StatusBadRequest {
			t.Fatalf("bad set apply status=%d want=400 body=%s", status, body)
		}
		if !bytes.Contains(body, []byte("127.0.0.1:1")) && !bytes.Contains(body, []byte("connection")) {
			t.Fatalf("bad set apply error does not mention upstream failure: %s", body)
		}

		stillSynced := planChannelBundleForSet(t, client, cfg, bundleID, goodSet.ID, false)
		if stillSynced.Status != "synced" {
			t.Fatalf("healthy set drifted after bad set failure: %+v", stillSynced)
		}

		// 故障注入结束后补齐失败 Set 的稳定 revision，再重新执行准入检查，避免本场景污染后续容量选择。
		restoreBadSet()
		recovered := applyChannelBundleToSet(t, client, cfg, bundleID, badSet.ID)
		if recovered.Status != "synced" {
			t.Fatalf("recovered set did not converge: %+v", recovered)
		}
		adminPost(t, client, cfg, "/api/admin/jobs/check_set_admission/run", nil, nil)
	})

	t.Run("business FSM golden path mirrors paid order, renewal, key, and cancel states", func(t *testing.T) {
		// 这里不拉起 trade/ctl/subscription 真服务，只用一个行为桩表达它们对 llmgateway 的契约调用。
		// 这样 e2e 的失败面集中在 drop-in 适配语义，而不是其他服务自己的实现细节。
		fsm := newBusinessFSM(t, client, cfg, businessFSMConfig{
			UserID:       "biz-fsm-" + runID,
			PlanID:       externalPlanID,
			TokenBalance: cfg.Scenario.Plan.TotalAmount,
			PeriodValue:  cfg.Scenario.Plan.DurationValue,
			PeriodUnit:   cfg.Scenario.Plan.GatewayPeriodUnit,
		})

		fsm.CheckoutPaid("order-initial")
		fsm.AssertNoActiveSubscription()

		fsm.PaymentSucceeded("order-initial")
		firstEnd := fsm.PeriodEnd

		firstKey := fsm.CreateInstanceKey("instance-a")
		secondKey := fsm.CreateInstanceKey("instance-b")
		fsm.AssertTrafficAllowed(firstKey)
		fsm.AssertTrafficAllowed(secondKey)

		fsm.RenewalPaymentSucceeded("order-renew-1")
		fsm.AssertPeriodEndEquals(firstEnd)
		renewedEnd := fsm.PeriodEnd

		fsm.ReplayRenewalPayment("order-renew-1")
		fsm.AssertPeriodEndEquals(renewedEnd)

		fsm.RevokeInstanceKey("instance-a")
		fsm.AssertTrafficUnauthorized(firstKey)
		fsm.AssertTrafficAllowed(secondKey)

		fsm.Cancel()
		fsm.AssertNoActiveSubscription()
		fsm.ReplayCancel()
	})

	t.Run("business FSM keeps failed and cancelled payments from granting subscription", func(t *testing.T) {
		// 支付失败/取消是 trade 的终态；这些终态不能透传成 llmgateway apply。
		fsm := newBusinessFSM(t, client, cfg, businessFSMConfig{
			UserID:       "biz-fsm-payment-terminal-" + runID,
			PlanID:       externalPlanID,
			TokenBalance: cfg.Scenario.Plan.TotalAmount,
			PeriodValue:  cfg.Scenario.Plan.DurationValue,
			PeriodUnit:   cfg.Scenario.Plan.GatewayPeriodUnit,
		})

		fsm.CheckoutPaid("order-failed")
		fsm.PaymentFailed("order-failed")
		fsm.AssertNoActiveSubscription()

		fsm.CheckoutPaid("order-cancelled")
		fsm.PaymentCancelled("order-cancelled")
		fsm.AssertNoActiveSubscription()

		fsm.CheckoutPaid("order-initial")
		fsm.PaymentSucceeded("order-initial")
		initialEnd := fsm.PeriodEnd

		fsm.CheckoutPaid("order-upgrade-failed")
		fsm.PaymentFailed("order-upgrade-failed")
		fsm.AssertActivePlan(externalPlanID, cfg.Scenario.Plan.TotalAmount)
		fsm.AssertPeriodEndEquals(initialEnd)
	})

	t.Run("business FSM can switch plans while preserving old subscription on failed switch", func(t *testing.T) {
		fsm := newBusinessFSM(t, client, cfg, businessFSMConfig{
			UserID:       "biz-fsm-plan-switch-" + runID,
			PlanID:       externalPlanID,
			TokenBalance: cfg.Scenario.Plan.TotalAmount,
			PeriodValue:  cfg.Scenario.Plan.DurationValue,
			PeriodUnit:   cfg.Scenario.Plan.GatewayPeriodUnit,
		})
		fsm.CheckoutPaid("order-monthly")
		fsm.PaymentSucceeded("order-monthly")
		monthlyEnd := fsm.PeriodEnd

		fsm.CheckoutPaid("order-switch-failed")
		fsm.PaymentFailed("order-switch-failed")
		fsm.AssertActivePlan(externalPlanID, cfg.Scenario.Plan.TotalAmount)
		fsm.AssertPeriodEndEquals(monthlyEnd)

		fsm.CheckoutPaid("order-switch-daily")
		fsm.SwitchPlanPaymentSucceeded("order-switch-daily", businessFSMConfig{
			PlanID:       dailyPlanID,
			TokenBalance: dailyPlanTokens,
			PeriodValue:  dailyPlanDurationValue,
			PeriodUnit:   "days",
		})
		fsm.AssertActivePlan(dailyPlanID, cfg.Scenario.Plan.TotalAmount+dailyPlanTokens)
	})

	t.Run("business FSM ignores stale renewal replay after cancel", func(t *testing.T) {
		fsm := newBusinessFSM(t, client, cfg, businessFSMConfig{
			UserID:       "biz-fsm-cancel-replay-" + runID,
			PlanID:       externalPlanID,
			TokenBalance: cfg.Scenario.Plan.TotalAmount,
			PeriodValue:  cfg.Scenario.Plan.DurationValue,
			PeriodUnit:   cfg.Scenario.Plan.GatewayPeriodUnit,
		})
		fsm.CheckoutPaid("order-initial")
		fsm.PaymentSucceeded("order-initial")

		fsm.Cancel()
		fsm.AssertNoActiveSubscription()
		fsm.ReplayRenewalAfterCancelIgnored("order-renew-stale")
		fsm.AssertNoActiveSubscription()
	})

	t.Run("concurrent key create and revoke leaves sibling keys usable", func(t *testing.T) {
		fsm := newBusinessFSM(t, client, cfg, businessFSMConfig{
			UserID:       "biz-fsm-concurrent-key-" + runID,
			PlanID:       externalPlanID,
			TokenBalance: cfg.Scenario.Plan.TotalAmount,
			PeriodValue:  cfg.Scenario.Plan.DurationValue,
			PeriodUnit:   cfg.Scenario.Plan.GatewayPeriodUnit,
		})
		fsm.CheckoutPaid("order-initial")
		fsm.PaymentSucceeded("order-initial")

		const keyCount = 5
		var wg sync.WaitGroup
		errs := make(chan error, keyCount)
		created := make(chan keyPayload, keyCount)
		for i := 0; i < keyCount; i++ {
			i := i
			wg.Add(1)
			go func() {
				defer wg.Done()
				status, raw, err := adminPostRaw(client, cfg, "/api/admin/users/"+url.PathEscape(fsm.conf.UserID)+"/api-keys", map[string]any{
					"name": fmt.Sprintf("parallel-%d", i),
				})
				if err != nil {
					errs <- err
					return
				}
				if status != http.StatusOK {
					errs <- fmt.Errorf("create key status=%d body=%s", status, raw)
					return
				}
				var parsed apiResponse[keyPayload]
				if err := json.Unmarshal(raw, &parsed); err != nil || !parsed.Success || parsed.Data.APIKey == "" || parsed.Data.KeyID == "" {
					errs <- fmt.Errorf("decode created key err=%v body=%s", err, raw)
					return
				}
				created <- parsed.Data
			}()
		}
		wg.Wait()
		close(errs)
		close(created)
		for err := range errs {
			if err != nil {
				t.Fatal(err)
			}
		}

		keys := make([]keyPayload, 0, keyCount)
		seenIDs := map[string]bool{}
		for key := range created {
			if seenIDs[key.KeyID] {
				t.Fatalf("duplicate key id from concurrent create: %+v", key)
			}
			seenIDs[key.KeyID] = true
			keys = append(keys, key)
		}
		if len(keys) != keyCount {
			t.Fatalf("created %d keys, want %d", len(keys), keyCount)
		}

		revokeCount := 2
		errs = make(chan error, revokeCount)
		for i := 0; i < revokeCount; i++ {
			keyID := keys[i].KeyID
			wg.Add(1)
			go func() {
				defer wg.Done()
				status, raw, err := adminDeleteRaw(client, cfg, "/api/admin/api-keys/"+url.PathEscape(keyID))
				if err != nil {
					errs <- err
					return
				}
				if status != http.StatusOK {
					errs <- fmt.Errorf("revoke key status=%d body=%s", status, raw)
				}
			}()
		}
		wg.Wait()
		close(errs)
		for err := range errs {
			if err != nil {
				t.Fatal(err)
			}
		}

		for i, key := range keys {
			status, body := gatewayTraffic(t, client, cfg, key.APIKey)
			if i < revokeCount {
				if status != http.StatusUnauthorized {
					t.Fatalf("revoked parallel key %d still works: status=%d body=%s", i, status, body)
				}
				continue
			}
			if status == http.StatusUnauthorized || status == http.StatusServiceUnavailable {
				t.Fatalf("sibling parallel key %d failed: status=%d body=%s", i, status, body)
			}
		}
	})

	t.Run("deactivating a plan blocks new apply without hiding existing active subscription", func(t *testing.T) {
		planID := "deactivate-" + externalPlanID
		adminPost(t, client, cfg, "/api/plans", map[string]any{
			"id":                planID,
			"name":              "deactivate " + cfg.Scenario.Plan.Title,
			"monthly_tokens":    cfg.Scenario.Plan.TotalAmount,
			"period_value":      cfg.Scenario.Plan.DurationValue,
			"period_unit":       cfg.Scenario.Plan.GatewayPeriodUnit,
			"is_active":         true,
			"upstream_plan_ids": upstreamPlanIDs,
		}, nil)

		activeUserID := "plan-deactivate-active-" + runID
		var sub subscriptionPayload
		internalPost(t, client, cfg, "/api/internal/subscriptions/apply", map[string]any{
			"user_id": activeUserID,
			"plan_id": planID,
		}, &sub)
		assertActiveSubscription(t, sub, activeUserID, planID, cfg.Scenario.Plan.TotalAmount)

		adminPost(t, client, cfg, "/api/plans", map[string]any{
			"id":                planID,
			"name":              "deactivate " + cfg.Scenario.Plan.Title,
			"monthly_tokens":    cfg.Scenario.Plan.TotalAmount,
			"period_value":      cfg.Scenario.Plan.DurationValue,
			"period_unit":       cfg.Scenario.Plan.GatewayPeriodUnit,
			"is_active":         false,
			"upstream_plan_ids": upstreamPlanIDs,
		}, nil)

		var existing subscriptionPayload
		internalGet(t, client, cfg, "/api/internal/users/"+url.PathEscape(activeUserID)+"/subscriptions", &existing)
		assertActiveSubscription(t, existing, activeUserID, planID, cfg.Scenario.Plan.TotalAmount)

		req := newJSONRequest(t, http.MethodPost, cfg.LLMGateway.BaseURL+"/api/internal/subscriptions/apply", map[string]any{
			"user_id": "plan-deactivate-new-" + runID,
			"plan_id": planID,
		})
		req.Header.Set("Authorization", "Bearer "+cfg.LLMGateway.InternalToken)
		body := expectStatus(t, client, req, http.StatusNotFound)
		assertOpenAIError(t, body, "not_found_error", "not_found")
	})

	t.Run("extreme external user id remains deterministic and routable", func(t *testing.T) {
		// userauth 可能给出很长的 usr_xxx；这里覆盖空格和 URL 保留字符，但不包含 slash，因为旧路径协议不支持 slash 作为 user_id。
		extremeUserID := "usr_58b6bb1f68ba7f46584bd282-" + runID + "-space value+tenant:alpha#hash"
		var firstEnsure struct {
			Result string `json:"result"`
			UserID string `json:"user_id"`
		}
		internalPost(t, client, cfg, "/api/internal/users/ensure", map[string]any{"user_id": extremeUserID}, &firstEnsure)
		if firstEnsure.Result != "created" || firstEnsure.UserID != extremeUserID {
			t.Fatalf("first extreme ensure returned %+v", firstEnsure)
		}
		var secondEnsure struct {
			Result string `json:"result"`
			UserID string `json:"user_id"`
		}
		internalPost(t, client, cfg, "/api/internal/users/ensure", map[string]any{"user_id": extremeUserID}, &secondEnsure)
		if secondEnsure.Result != "existing" || secondEnsure.UserID != extremeUserID {
			t.Fatalf("second extreme ensure returned %+v", secondEnsure)
		}

		var sub subscriptionPayload
		internalPost(t, client, cfg, "/api/internal/subscriptions/apply", map[string]any{
			"user_id": extremeUserID,
			"plan_id": externalPlanID,
		}, &sub)
		assertActiveSubscription(t, sub, extremeUserID, externalPlanID, cfg.Scenario.Plan.TotalAmount)
		key := createAdminAPIKey(t, client, cfg, extremeUserID, "extreme-user")
		status, body := gatewayTraffic(t, client, cfg, key.APIKey)
		if status == http.StatusUnauthorized || status == http.StatusServiceUnavailable {
			t.Fatalf("extreme user key failed: status=%d body=%s", status, body)
		}
	})

	t.Run("old bound user does not migrate when its set is disabled", func(t *testing.T) {
		if len(cfg.Sets) < 2 {
			t.Skip("needs at least two sets")
		}
		boundSet := cfg.Sets[0]
		var overview struct {
			Sets []struct {
				ID                string `json:"id"`
				Ready             bool   `json:"ready"`
				AcceptingNewUsers bool   `json:"accepting_new_users"`
				CapacityStatus    string `json:"capacity_status"`
				MaxUsers          int    `json:"max_users"`
				UserCount         int    `json:"user_count"`
				AdmissionStatus   string `json:"admission_status"`
				AdminHealthStatus string `json:"admin_health_status"`
			} `json:"sets"`
		}
		deadline := time.Now().Add(5 * time.Second)
		for {
			overview.Sets = nil
			adminGet(t, client, cfg, "/api/admin/overview", &overview)
			var found, accepting bool
			for _, item := range overview.Sets {
				if item.ID == boundSet.ID {
					found = true
					accepting = item.Ready && item.AcceptingNewUsers
					break
				}
			}
			if found && accepting {
				break
			}
			if time.Now().After(deadline) {
				t.Fatalf("bound set %s did not become ready for admission: %+v", boundSet.ID, overview.Sets)
			}
			time.Sleep(100 * time.Millisecond)
		}
		planID := "old-bound-" + externalPlanID
		adminPost(t, client, cfg, "/api/plans", map[string]any{
			"id":                planID,
			"name":              "old bound " + cfg.Scenario.Plan.Title,
			"monthly_tokens":    cfg.Scenario.Plan.TotalAmount,
			"period_value":      cfg.Scenario.Plan.DurationValue,
			"period_unit":       cfg.Scenario.Plan.GatewayPeriodUnit,
			"is_active":         true,
			"upstream_plan_ids": map[string]int{boundSet.ID: upstreamPlanIDs[boundSet.ID]},
		}, nil)
		oldUserID := "old-bound-" + runID
		var sub subscriptionPayload
		internalPost(t, client, cfg, "/api/internal/subscriptions/apply", map[string]any{
			"user_id": oldUserID,
			"plan_id": planID,
		}, &sub)
		assertActiveSubscription(t, sub, oldUserID, planID, cfg.Scenario.Plan.TotalAmount)
		key := createAdminAPIKey(t, client, cfg, oldUserID, "old-bound")

		adminPost(t, client, cfg, "/api/sets", map[string]any{
			"id":       boundSet.ID,
			"name":     boundSet.Name,
			"base_url": boundSet.BaseURL,
			"status":   "disabled",
		}, nil)
		defer adminPost(t, client, cfg, "/api/sets", map[string]any{
			"id":       boundSet.ID,
			"name":     boundSet.Name,
			"base_url": boundSet.BaseURL,
			"status":   "active",
		}, nil)

		req := newJSONRequest(t, http.MethodPost, cfg.LLMGateway.BaseURL+"/api/internal/subscriptions/apply", map[string]any{
			"user_id": oldUserID,
			"plan_id": externalPlanID,
		})
		req.Header.Set("Authorization", "Bearer "+cfg.LLMGateway.InternalToken)
		body := expectStatus(t, client, req, http.StatusBadRequest)
		assertOpenAIError(t, body, "invalid_request_error", "bad_request")

		status, trafficBody := gatewayTraffic(t, client, cfg, key.APIKey)
		if status != http.StatusServiceUnavailable {
			t.Fatalf("old bound key should stay on disabled set: status=%d body=%s", status, trafficBody)
		}
	})

	t.Run("reapplying the same subscription adds another active entitlement", func(t *testing.T) {
		internalPost(t, client, cfg, "/api/internal/subscriptions/apply", map[string]any{
			"user_id": userID,
			"plan_id": externalPlanID,
		}, &currentSub)
		currentTokenBalance += cfg.Scenario.Plan.TotalAmount
		assertActiveSubscription(t, currentSub, userID, externalPlanID, currentTokenBalance)
	})

	t.Run("unsupported period override returns OpenAI-style error and keeps current subscription", func(t *testing.T) {
		req := newJSONRequest(t, http.MethodPost, cfg.LLMGateway.BaseURL+"/api/internal/subscriptions/apply", map[string]any{
			"user_id":      userID,
			"plan_id":      externalPlanID,
			"period_value": cfg.Scenario.Plan.DurationValue + 1,
			"period_unit":  cfg.Scenario.Plan.GatewayPeriodUnit,
		})
		req.Header.Set("Authorization", "Bearer "+cfg.LLMGateway.InternalToken)
		body := expectStatus(t, client, req, http.StatusBadRequest)
		assertOpenAIError(t, body, "invalid_request_error", "bad_request")

		var sub subscriptionPayload
		internalGet(t, client, cfg, "/api/internal/users/"+url.PathEscape(userID)+"/subscriptions", &sub)
		assertActiveSubscription(t, sub, userID, externalPlanID, currentTokenBalance)
	})

	t.Run("active subscription can be fetched after package renewal no-op", func(t *testing.T) {
		var sub subscriptionPayload
		internalGet(t, client, cfg, "/api/internal/users/"+url.PathEscape(userID)+"/subscriptions", &sub)
		assertActiveSubscription(t, sub, userID, externalPlanID, currentTokenBalance)
		wantEnd, err := time.Parse(time.RFC3339Nano, currentSub.PeriodEnd)
		if err != nil {
			t.Fatalf("parse current period end %q: %v", currentSub.PeriodEnd, err)
		}
		assertSubscriptionPeriodEnd(t, sub, wantEnd)
		currentSub = sub
	})

	t.Run("reapplying package subscription grants additional balance", func(t *testing.T) {
		var reset subscriptionPayload
		internalPost(t, client, cfg, "/api/internal/subscriptions/apply", map[string]any{
			"user_id": userID,
			"plan_id": externalPlanID,
		}, &reset)
		currentTokenBalance += cfg.Scenario.Plan.TotalAmount
		assertActiveSubscription(t, reset, userID, externalPlanID, currentTokenBalance)
		if _, err := time.Parse(time.RFC3339Nano, reset.PeriodEnd); err != nil {
			t.Fatalf("parse reset period end %q: %v", reset.PeriodEnd, err)
		}
		currentSub = reset
	})

	t.Run("seed persisted state for gateway restart verification", func(t *testing.T) {
		restartUserID := "restart-user-" + runID
		var sub subscriptionPayload
		internalPost(t, client, cfg, "/api/internal/subscriptions/apply", map[string]any{
			"user_id": restartUserID,
			"plan_id": singleSetPlanID,
		}, &sub)
		assertActiveSubscription(t, sub, restartUserID, singleSetPlanID, cfg.Scenario.Plan.TotalAmount)
		if _, err := time.Parse(time.RFC3339Nano, sub.PeriodEnd); err != nil {
			t.Fatalf("parse restart period end %q: %v", sub.PeriodEnd, err)
		}

		key := createAdminAPIKey(t, client, cfg, restartUserID, "restart-"+runID)
		revokedKey := createAdminAPIKey(t, client, cfg, restartUserID, "restart-revoked-"+runID)
		req := newJSONRequest(t, http.MethodDelete, cfg.LLMGateway.BaseURL+"/api/admin/api-keys/"+url.PathEscape(revokedKey.KeyID), nil)
		req.Header.Set("Authorization", "Bearer "+cfg.LLMGateway.AdminToken)
		expectStatus(t, client, req, http.StatusOK)
		status, trafficBody := gatewayTraffic(t, client, cfg, revokedKey.APIKey)
		if status != http.StatusUnauthorized {
			t.Fatalf("revoked restart key still works before restart: status=%d body=%s", status, trafficBody)
		}

		cancelledUserID := "restart-cancelled-" + runID
		var cancelledSub subscriptionPayload
		internalPost(t, client, cfg, "/api/internal/subscriptions/apply", map[string]any{
			"user_id": cancelledUserID,
			"plan_id": singleSetPlanID,
		}, &cancelledSub)
		assertActiveSubscription(t, cancelledSub, cancelledUserID, singleSetPlanID, cfg.Scenario.Plan.TotalAmount)
		internalPost(t, client, cfg, "/api/internal/subscriptions/cancel", map[string]any{"user_id": cancelledUserID}, nil)
		req = newJSONRequest(t, http.MethodGet, cfg.LLMGateway.BaseURL+"/api/internal/users/"+url.PathEscape(cancelledUserID)+"/subscriptions", nil)
		req.Header.Set("Authorization", "Bearer "+cfg.LLMGateway.InternalToken)
		body := expectStatus(t, client, req, http.StatusNotFound)
		assertOpenAIError(t, body, "not_found_error", "not_found")

		inactivePlanID := "restart-inactive-" + externalPlanID
		inactivePlanTokens := cfg.Scenario.Plan.TotalAmount + 777
		adminPost(t, client, cfg, "/api/plans", map[string]any{
			"id":                inactivePlanID,
			"name":              "restart inactive " + cfg.Scenario.Plan.Title,
			"monthly_tokens":    inactivePlanTokens,
			"period_value":      cfg.Scenario.Plan.DurationValue,
			"period_unit":       cfg.Scenario.Plan.GatewayPeriodUnit,
			"is_active":         true,
			"upstream_plan_ids": map[string]int{cfg.Sets[1].ID: upstreamPlanIDs[cfg.Sets[1].ID]},
		}, nil)
		adminPost(t, client, cfg, "/api/plans", map[string]any{
			"id":                inactivePlanID,
			"name":              "restart inactive updated " + cfg.Scenario.Plan.Title,
			"monthly_tokens":    inactivePlanTokens,
			"period_value":      cfg.Scenario.Plan.DurationValue,
			"period_unit":       cfg.Scenario.Plan.GatewayPeriodUnit,
			"is_active":         false,
			"upstream_plan_ids": map[string]int{cfg.Sets[1].ID: upstreamPlanIDs[cfg.Sets[1].ID]},
		}, nil)

		writeRestartState(t, restartState{
			UserID:             restartUserID,
			PlanID:             singleSetPlanID,
			APIKey:             key.APIKey,
			RevokedAPIKey:      revokedKey.APIKey,
			PeriodEnd:          sub.PeriodEnd,
			TokenBalance:       cfg.Scenario.Plan.TotalAmount,
			CancelledUserID:    cancelledUserID,
			InactivePlanID:     inactivePlanID,
			InactivePlanTokens: inactivePlanTokens,
			DisabledSetID:      cfg.Sets[0].ID,
			FallbackSetID:      cfg.Sets[1].ID,
			SplitUserID:        splitUserID,
			SplitAPIKey:        splitAPIKey,
			SplitModel:         splitModel,
		})
	})

	t.Run("admin can create multiple ai-gateway compatible keys for one user", func(t *testing.T) {
		first := createAdminAPIKey(t, client, cfg, userID, "instance-"+runID)
		second := createAdminAPIKey(t, client, cfg, userID, "sibling-"+runID)
		if first.KeyID == second.KeyID || first.APIKey == second.APIKey {
			t.Fatalf("expected distinct keys, first=%+v second=%+v", first, second)
		}
		apiKey = first.APIKey
		keyID = first.KeyID
		secondAPIKey = second.APIKey

		for label, key := range map[string]string{"first": apiKey, "second": secondAPIKey} {
			status, body := gatewayTraffic(t, client, cfg, key)
			if status == http.StatusUnauthorized {
				t.Fatalf("%s traffic was rejected before revoke: status=%d body=%s", label, status, body)
			}
		}
	})

	t.Run("ctl revokes one key without revoking sibling keys", func(t *testing.T) {
		req := newJSONRequest(t, http.MethodDelete, cfg.LLMGateway.BaseURL+"/api/admin/api-keys/"+url.PathEscape(keyID), nil)
		req.Header.Set("Authorization", "Bearer "+cfg.LLMGateway.AdminToken)
		resp := do(t, client, req)
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			body, _ := io.ReadAll(resp.Body)
			t.Fatalf("revoke status=%d body=%s", resp.StatusCode, body)
		}
		status, body := gatewayTraffic(t, client, cfg, apiKey)
		if status != http.StatusUnauthorized {
			t.Fatalf("traffic after revoke status=%d body=%s", status, body)
		}
		status, body = gatewayTraffic(t, client, cfg, secondAPIKey)
		if status == http.StatusUnauthorized {
			t.Fatalf("sibling key was revoked with first key: status=%d body=%s", status, body)
		}
		req = newJSONRequest(t, http.MethodDelete, cfg.LLMGateway.BaseURL+"/api/admin/api-keys/"+url.PathEscape(keyID), nil)
		req.Header.Set("Authorization", "Bearer "+cfg.LLMGateway.AdminToken)
		expectStatus(t, client, req, http.StatusOK)
	})

	t.Run("ctl cancels subscription and active subscription is gone", func(t *testing.T) {
		internalPost(t, client, cfg, "/api/internal/subscriptions/cancel", map[string]any{"user_id": userID}, nil)
		req := newJSONRequest(t, http.MethodGet, cfg.LLMGateway.BaseURL+"/api/internal/users/"+url.PathEscape(userID)+"/subscriptions", nil)
		req.Header.Set("Authorization", "Bearer "+cfg.LLMGateway.InternalToken)
		resp := do(t, client, req)
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusNotFound {
			body, _ := io.ReadAll(resp.Body)
			t.Fatalf("active subscription after cancel status=%d body=%s", resp.StatusCode, body)
		}
	})

	t.Run("cancel is idempotent for already-cancelled and missing users", func(t *testing.T) {
		internalPost(t, client, cfg, "/api/internal/subscriptions/cancel", map[string]any{"user_id": userID}, nil)
		internalPost(t, client, cfg, "/api/internal/subscriptions/cancel", map[string]any{"user_id": "missing-" + runID}, nil)
	})

	t.Run("new users avoid a disabled set when another mapped set is active", func(t *testing.T) {
		if len(cfg.Sets) < 2 {
			t.Skip("needs at least two sets")
		}
		disabledSet := cfg.Sets[0]
		fallbackSet := cfg.Sets[1]
		adminPost(t, client, cfg, "/api/sets", map[string]any{
			"id":       disabledSet.ID,
			"name":     disabledSet.Name,
			"base_url": disabledSet.BaseURL,
			"status":   "disabled",
		}, nil)

		disabledUserID := "disabled-pick-" + runID
		var sub subscriptionPayload
		internalPost(t, client, cfg, "/api/internal/subscriptions/apply", map[string]any{
			"user_id": disabledUserID,
			"plan_id": externalPlanID,
		}, &sub)
		assertActiveSubscription(t, sub, disabledUserID, externalPlanID, cfg.Scenario.Plan.TotalAmount)

		var created struct {
			ExternalKey   string `json:"external_key"`
			ExternalKeyID string `json:"external_key_id"`
			SetID         string `json:"set_id"`
			UpstreamKeyID int    `json:"upstream_key_id"`
		}
		adminPost(t, client, cfg, "/api/users/"+url.PathEscape(disabledUserID)+"/keys", nil, &created)
		if created.SetID != fallbackSet.ID || created.ExternalKey == "" || created.ExternalKeyID == "" || created.UpstreamKeyID <= 0 {
			t.Fatalf("new user was not assigned to fallback set %q: %+v", fallbackSet.ID, created)
		}
		status, body := gatewayTraffic(t, client, cfg, created.ExternalKey)
		if status == http.StatusUnauthorized || status == http.StatusServiceUnavailable {
			t.Fatalf("fallback-set traffic failed: status=%d body=%s", status, body)
		}
	})
}

func TestReproducibleComposeClusterStateSurvivesGatewayRestart(t *testing.T) {
	if os.Getenv("LLMGATEWAY_E2E") != "1" {
		t.Skip("set LLMGATEWAY_E2E=1 or run test/e2e/run.sh")
	}
	if os.Getenv("LLMGATEWAY_E2E_AFTER_RESTART") != "1" {
		t.Skip("restart verification runs after run.sh restarts llmgateway")
	}
	cfg := loadClusterConfig(t)
	state := readRestartState(t)
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	client := &http.Client{Timeout: 20 * time.Second}
	waitForOK(ctx, t, client, cfg.LLMGateway.BaseURL+"/healthz")

	var sets []struct {
		ID          string `json:"id"`
		Status      string `json:"status"`
		Setup       bool   `json:"setup"`
		AdminUserID int    `json:"admin_user_id"`
	}
	adminGet(t, client, cfg, "/api/sets", &sets)
	if len(sets) < 2 {
		t.Fatalf("sets were not restored after restart: %+v", sets)
	}
	setByID := map[string]struct {
		ID          string `json:"id"`
		Status      string `json:"status"`
		Setup       bool   `json:"setup"`
		AdminUserID int    `json:"admin_user_id"`
	}{}
	for _, set := range sets {
		setByID[set.ID] = set
	}
	disabledSet, ok := setByID[state.DisabledSetID]
	if !ok || disabledSet.Status != "disabled" || !disabledSet.Setup || disabledSet.AdminUserID <= 0 {
		t.Fatalf("disabled set state was not restored after restart: set=%+v ok=%v all=%+v", disabledSet, ok, sets)
	}
	fallbackSet, ok := setByID[state.FallbackSetID]
	if !ok || fallbackSet.Status != "active" || !fallbackSet.Setup || fallbackSet.AdminUserID <= 0 {
		t.Fatalf("fallback set state was not restored after restart: set=%+v ok=%v all=%+v", fallbackSet, ok, sets)
	}

	var plan struct {
		ID            string `json:"id"`
		MonthlyTokens int64  `json:"monthly_tokens"`
	}
	internalGet(t, client, cfg, "/api/internal/plans/"+url.PathEscape(state.PlanID), &plan)
	if plan.ID != state.PlanID || plan.MonthlyTokens != state.TokenBalance {
		t.Fatalf("plan was not restored after restart: %+v state=%+v", plan, state)
	}
	var inactivePlan struct {
		ID            string `json:"id"`
		MonthlyTokens int64  `json:"monthly_tokens"`
		IsActive      bool   `json:"is_active"`
	}
	internalGet(t, client, cfg, "/api/internal/plans/"+url.PathEscape(state.InactivePlanID), &inactivePlan)
	if inactivePlan.ID != state.InactivePlanID || inactivePlan.MonthlyTokens != state.InactivePlanTokens || inactivePlan.IsActive {
		t.Fatalf("inactive plan update was not restored after restart: %+v state=%+v", inactivePlan, state)
	}
	req := newJSONRequest(t, http.MethodPost, cfg.LLMGateway.BaseURL+"/api/internal/subscriptions/apply", map[string]any{
		"user_id": "restart-inactive-apply-" + state.UserID,
		"plan_id": state.InactivePlanID,
	})
	req.Header.Set("Authorization", "Bearer "+cfg.LLMGateway.InternalToken)
	errorBody := expectStatus(t, client, req, http.StatusNotFound)
	assertOpenAIError(t, errorBody, "not_found_error", "not_found")

	var sub subscriptionPayload
	internalGet(t, client, cfg, "/api/internal/users/"+url.PathEscape(state.UserID)+"/subscriptions", &sub)
	assertActiveSubscription(t, sub, state.UserID, state.PlanID, state.TokenBalance)
	assertSubscriptionPeriodEndString(t, sub, state.PeriodEnd)

	var ensure struct {
		Result string `json:"result"`
		UserID string `json:"user_id"`
	}
	internalPost(t, client, cfg, "/api/internal/users/ensure", map[string]any{"user_id": state.UserID}, &ensure)
	if ensure.Result != "existing" || ensure.UserID != state.UserID {
		t.Fatalf("existing binding was not restored after restart: %+v", ensure)
	}

	status, trafficBody := gatewayTraffic(t, client, cfg, state.APIKey)
	if status == http.StatusUnauthorized || status == http.StatusServiceUnavailable {
		t.Fatalf("persisted key traffic failed after restart: status=%d body=%s", status, trafficBody)
	}
	status, trafficBody = gatewayTraffic(t, client, cfg, state.RevokedAPIKey)
	if status != http.StatusUnauthorized {
		t.Fatalf("revoked key was restored after restart: status=%d body=%s", status, trafficBody)
	}

	req = newJSONRequest(t, http.MethodGet, cfg.LLMGateway.BaseURL+"/api/internal/users/"+url.PathEscape(state.CancelledUserID)+"/subscriptions", nil)
	req.Header.Set("Authorization", "Bearer "+cfg.LLMGateway.InternalToken)
	bodyBytes := expectStatus(t, client, req, http.StatusNotFound)
	assertOpenAIError(t, bodyBytes, "not_found_error", "not_found")
}

func TestReproducibleComposeSplitTrafficSurvivesTrafficRestart(t *testing.T) {
	if os.Getenv("LLMGATEWAY_E2E") != "1" {
		t.Skip("set LLMGATEWAY_E2E=1 or run test/e2e/run.sh")
	}
	if os.Getenv("LLMGATEWAY_E2E_AFTER_TRAFFIC_RESTART") != "1" {
		t.Skip("split traffic restart verification runs after run.sh restarts llmgateway-traffic")
	}
	cfg := loadClusterConfig(t)
	state := readRestartState(t)
	if state.SplitAPIKey == "" || state.SplitUserID == "" || state.SplitModel == "" {
		t.Fatalf("split traffic restart state is incomplete: %+v", state)
	}

	controlURL := strings.TrimRight(cfg.LLMGateway.ControlBaseURL, "/")
	trafficURL := strings.TrimRight(cfg.LLMGateway.TrafficBaseURL, "/")
	if controlURL == "" || trafficURL == "" {
		t.Fatal("split control/traffic URLs are required")
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	client := &http.Client{Timeout: 30 * time.Second}
	waitForOK(ctx, t, client, controlURL+"/healthz")
	waitForOK(ctx, t, client, trafficURL+"/healthz")

	status, body, err := gatewayRawTo(client, trafficURL, http.MethodGet, "/api/sets", cfg.LLMGateway.AdminToken, nil)
	if err != nil {
		t.Fatal(err)
	}
	if status != http.StatusNotFound {
		t.Fatalf("traffic process exposed /api/sets after restart: status=%d body=%s", status, body)
	}

	var sets []struct {
		ID    string `json:"id"`
		Setup bool   `json:"setup"`
	}
	controlCfg := cfg
	controlCfg.LLMGateway.BaseURL = controlURL
	adminGet(t, client, controlCfg, "/api/sets", &sets)
	if len(sets) < 2 {
		t.Fatalf("control state disappeared after traffic restart: %+v", sets)
	}

	trafficCfg := cfg
	trafficCfg.LLMGateway.BaseURL = trafficURL
	raw := gatewayLiveChatCompletion(t, client, trafficCfg, state.SplitAPIKey, state.SplitModel, false)
	assertLiveChatCompletion(t, raw)
	if !bytes.Contains(raw, []byte("mockllm")) {
		t.Fatalf("split traffic key did not route after traffic restart: %s", raw)
	}
}

func loadClusterConfig(t *testing.T) clusterConfig {
	t.Helper()
	path := os.Getenv("LLMGATEWAY_E2E_CLUSTER")
	if path == "" {
		t.Skip("LLMGATEWAY_E2E_CLUSTER is required; run test/e2e/run.sh")
	}
	raw, err := os.ReadFile(filepath.Clean(path))
	if err != nil {
		t.Fatalf("read cluster config: %v", err)
	}
	var cfg clusterConfig
	if err := yaml.Unmarshal(raw, &cfg); err != nil {
		t.Fatalf("decode cluster config: %v", err)
	}
	return cfg
}

func restartStateFile(t *testing.T) string {
	t.Helper()
	path := strings.TrimSpace(os.Getenv("LLMGATEWAY_E2E_STATE_FILE"))
	if path == "" {
		path = "test/e2e/.tmp/restart-state.json"
	}
	return filepath.Clean(path)
}

func writeRestartState(t *testing.T, state restartState) {
	t.Helper()
	path := restartStateFile(t)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("create restart state dir: %v", err)
	}
	raw, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		t.Fatalf("encode restart state: %v", err)
	}
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatalf("write restart state: %v", err)
	}
}

func readRestartState(t *testing.T) restartState {
	t.Helper()
	raw, err := os.ReadFile(restartStateFile(t))
	if err != nil {
		t.Fatalf("read restart state: %v", err)
	}
	var state restartState
	if err := json.Unmarshal(raw, &state); err != nil {
		t.Fatalf("decode restart state: %v", err)
	}
	if state.UserID == "" || state.PlanID == "" || state.APIKey == "" || state.PeriodEnd == "" || state.TokenBalance <= 0 {
		t.Fatalf("restart state is incomplete: %+v", state)
	}
	return state
}

func waitForOK(ctx context.Context, t *testing.T, client *http.Client, endpoint string) {
	t.Helper()
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	var lastErr error
	for {
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
		resp, err := client.Do(req)
		if err == nil && resp.StatusCode >= 200 && resp.StatusCode < 500 {
			_ = resp.Body.Close()
			return
		}
		if resp != nil {
			_ = resp.Body.Close()
			lastErr = fmt.Errorf("status %d", resp.StatusCode)
		} else if err != nil {
			lastErr = err
		}
		select {
		case <-ctx.Done():
			t.Fatalf("wait for %s: %v (last=%v)", endpoint, ctx.Err(), lastErr)
		case <-ticker.C:
		}
	}
}

type newAPISession struct {
	set     setConfig
	client  *http.Client
	baseURL string
	userID  int
}

func loginNewAPI(t *testing.T, cfg clusterConfig, set setConfig, _ string, _ string) newAPISession {
	t.Helper()
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	gatewayURL, err := url.Parse(strings.TrimRight(cfg.LLMGateway.BaseURL, "/"))
	if err != nil {
		t.Fatalf("parse llmgateway base url: %v", err)
	}
	jar.SetCookies(gatewayURL, []*http.Cookie{{Name: "llmgateway_admin_token", Value: cfg.LLMGateway.AdminToken}})
	client := &http.Client{Timeout: 20 * time.Second, Jar: jar}

	var sets []struct {
		ID          string `json:"id"`
		Setup       bool   `json:"setup"`
		AdminUserID int    `json:"admin_user_id"`
	}
	adminGet(t, client, cfg, "/api/sets", &sets)
	for _, managed := range sets {
		if managed.ID == set.ID {
			if !managed.Setup || managed.AdminUserID <= 0 {
				t.Fatalf("set %s is not bootstrapped for managed new-api session: %+v", set.ID, managed)
			}
			return newAPISession{
				set:     set,
				client:  client,
				baseURL: strings.TrimRight(cfg.LLMGateway.BaseURL, "/") + "/_llmgateway_console/" + url.PathEscape(set.ID),
				userID:  managed.AdminUserID,
			}
		}
	}
	t.Fatalf("set %s is not registered in llmgateway: %+v", set.ID, sets)
	return newAPISession{}
}

func (s newAPISession) apiURL(path string) string {
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	return strings.TrimRight(s.baseURL, "/") + path
}

func confirmPaymentCompliance(t *testing.T, session newAPISession) {
	t.Helper()
	req := newJSONRequest(t, http.MethodPost, session.apiURL("/api/option/payment_compliance"), map[string]any{"confirmed": true})
	req.Header.Set("New-Api-User", fmt.Sprintf("%d", session.userID))
	resp := do(t, session.client, req)
	defer resp.Body.Close()
	var parsed apiResponse[json.RawMessage]
	decodeSuccess(t, resp, &parsed)
}

func disableNewAPIDiskPerformanceGate(t *testing.T, session newAPISession) {
	t.Helper()
	// 测试机的 Docker 磁盘水位可能很高；这里仅关闭磁盘保护，避免真实流量 e2e 在路由前被 new-api 拦截。
	updateNewAPIOption(t, session, "performance_setting.monitor_disk_threshold", 0)
}

func configureLiveModelPricing(t *testing.T, session newAPISession, model string) {
	t.Helper()
	mergeNewAPIJSONRatioOption(t, session, "ModelRatio", model, 1)
	mergeNewAPIJSONRatioOption(t, session, "CompletionRatio", model, 1)
}

func mergeNewAPIJSONRatioOption(t *testing.T, session newAPISession, key string, model string, ratio float64) {
	t.Helper()
	options := fetchNewAPIOptions(t, session)
	ratios := map[string]float64{}
	if raw := strings.TrimSpace(options[key]); raw != "" {
		if err := json.Unmarshal([]byte(raw), &ratios); err != nil {
			t.Fatalf("decode new-api option %s: %v value=%s", key, err, raw)
		}
	}
	ratios[model] = ratio
	value, err := json.Marshal(ratios)
	if err != nil {
		t.Fatalf("encode new-api option %s: %v", key, err)
	}
	updateNewAPIOption(t, session, key, string(value))
}

func fetchNewAPIOptions(t *testing.T, session newAPISession) map[string]string {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, session.apiURL("/api/option/"), nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("New-Api-User", fmt.Sprintf("%d", session.userID))
	resp := do(t, session.client, req)
	defer resp.Body.Close()
	var parsed apiResponse[[]struct {
		Key   string `json:"key"`
		Value string `json:"value"`
	}]
	decodeSuccess(t, resp, &parsed)
	options := make(map[string]string, len(parsed.Data))
	for _, option := range parsed.Data {
		options[option.Key] = option.Value
	}
	return options
}

func assertNewAPIRatioOptionContains(t *testing.T, session newAPISession, key string, model string) {
	t.Helper()
	options := fetchNewAPIOptions(t, session)
	raw := strings.TrimSpace(options[key])
	if raw == "" {
		t.Fatalf("new-api set %s option %s is empty after bundle sync", session.set.ID, key)
	}
	ratios := map[string]float64{}
	if err := json.Unmarshal([]byte(raw), &ratios); err != nil {
		t.Fatalf("decode new-api set %s option %s: %v value=%s", session.set.ID, key, err, raw)
	}
	if _, ok := ratios[model]; !ok {
		t.Fatalf("new-api set %s option %s does not contain model %s, value=%s", session.set.ID, key, model, raw)
	}
}

func assertNewAPIGroupRatioZero(t *testing.T, session newAPISession, group string) {
	t.Helper()
	options := fetchNewAPIOptions(t, session)
	raw := strings.TrimSpace(options["GroupRatio"])
	if raw == "" {
		t.Fatalf("new-api set %s GroupRatio is empty", session.set.ID)
	}
	ratios := map[string]float64{}
	if err := json.Unmarshal([]byte(raw), &ratios); err != nil {
		t.Fatalf("decode new-api set %s GroupRatio: %v value=%s", session.set.ID, err, raw)
	}
	ratio, ok := ratios[group]
	if !ok || ratio != 0 {
		t.Fatalf("new-api set %s GroupRatio[%s]=%v ok=%v, want 0; value=%s", session.set.ID, group, ratio, ok, raw)
	}
}

func updateNewAPIOption(t *testing.T, session newAPISession, key string, value any) {
	t.Helper()
	req := newJSONRequest(t, http.MethodPut, session.apiURL("/api/option/"), map[string]any{
		"key":   key,
		"value": value,
	})
	req.Header.Set("New-Api-User", fmt.Sprintf("%d", session.userID))
	resp := do(t, session.client, req)
	defer resp.Body.Close()
	var parsed apiResponse[json.RawMessage]
	decodeSuccess(t, resp, &parsed)
}

func createUpstreamPlan(t *testing.T, session newAPISession, title string, totalAmount int64, durationUnit string, durationValue int) int {
	t.Helper()
	req := newJSONRequest(t, http.MethodPost, session.apiURL("/api/subscription/admin/plans"), map[string]any{
		"plan": map[string]any{
			"title":              title,
			"subtitle":           "llmgateway reproducible e2e",
			"price_amount":       0,
			"currency":           "USD",
			"duration_unit":      durationUnit,
			"duration_value":     durationValue,
			"enabled":            true,
			"total_amount":       totalAmount,
			"allow_balance_pay":  true,
			"quota_reset_period": "never",
		},
	})
	req.Header.Set("New-Api-User", fmt.Sprintf("%d", session.userID))
	resp := do(t, session.client, req)
	defer resp.Body.Close()
	var parsed apiResponse[struct {
		ID int `json:"id"`
	}]
	decodeSuccess(t, resp, &parsed)
	if parsed.Data.ID <= 0 {
		t.Fatalf("new-api created invalid subscription plan id: %+v", parsed)
	}
	return parsed.Data.ID
}

func loadLiveLLMConfig() (liveLLMConfig, bool) {
	apiKey := strings.TrimSpace(os.Getenv("LLMGATEWAY_LIVE_API_KEY"))
	if apiKey == "" {
		return liveLLMConfig{}, false
	}
	baseURL := strings.TrimSpace(os.Getenv("LLMGATEWAY_LIVE_BASE_URL"))
	if baseURL == "" {
		baseURL = "https://tokenhub.tencentmaas.com"
	}
	model := strings.TrimSpace(os.Getenv("LLMGATEWAY_LIVE_MODEL"))
	if model == "" {
		model = "minimax-m2.7"
	}
	return liveLLMConfig{
		APIKey:  apiKey,
		BaseURL: strings.TrimRight(baseURL, "/"),
		Model:   model,
	}, true
}

func requireMockLLMConfig(t *testing.T, cfg clusterConfig) liveLLMConfig {
	t.Helper()
	mockCfg := liveLLMConfig{
		APIKey:  strings.TrimSpace(cfg.MockLLM.APIKey),
		BaseURL: strings.TrimRight(strings.TrimSpace(cfg.MockLLM.BaseURL), "/"),
		Model:   strings.TrimSpace(cfg.MockLLM.Model),
	}
	if mockCfg.APIKey == "" || mockCfg.BaseURL == "" || mockCfg.Model == "" {
		t.Fatalf("cluster config must define mock_llm api_key/base_url/model: %+v", cfg.MockLLM)
	}
	return mockCfg
}

type channelBundleApplyState struct {
	BundleID           string `json:"bundle_id"`
	SetID              string `json:"set_id"`
	Status             string `json:"status"`
	AppliedFingerprint string `json:"applied_fingerprint"`
}

type channelBundlePlan struct {
	BundleID string `json:"bundle_id"`
	SetID    string `json:"set_id"`
	Status   string `json:"status"`
	Steps    []struct {
		ResourceID    string `json:"resource_id"`
		Action        string `json:"action"`
		RequiresForce bool   `json:"requires_force"`
	} `json:"steps"`
}

func upsertOpenAIChannelBundle(t *testing.T, client *http.Client, cfg clusterConfig, bundleID string, name string, provider liveLLMConfig) {
	t.Helper()
	adminPost(t, client, cfg, "/api/channel-bundles", map[string]any{
		"id":   bundleID,
		"name": name,
		"spec": map[string]any{
			"version": 1,
			"kind":    "newapi-channel-bundle",
			"options": []map[string]any{
				{"key": "CompletionRatio", "value": fmt.Sprintf(`{"%s":1}`, provider.Model)},
				{"key": "ModelRatio", "value": fmt.Sprintf(`{"%s":1}`, provider.Model)},
			},
			"channels": []map[string]any{
				{
					"id":         bundleID + "-openai",
					"name":       name,
					"type":       1,
					"key":        provider.APIKey,
					"base_url":   provider.BaseURL,
					"models":     provider.Model,
					"group":      "default",
					"priority":   100,
					"weight":     0,
					"status":     "enabled",
					"auto_ban":   0,
					"test_model": provider.Model,
				},
			},
		},
	}, nil)
}

func planChannelBundleForSet(t *testing.T, client *http.Client, cfg clusterConfig, bundleID string, setID string, force bool) channelBundlePlan {
	t.Helper()
	var plan channelBundlePlan
	adminPost(t, client, cfg, "/api/channel-bundles/"+url.PathEscape(bundleID)+"/plan", map[string]any{
		"set_id":      setID,
		"force_drift": force,
	}, &plan)
	return plan
}

func applyChannelBundleToSet(t *testing.T, client *http.Client, cfg clusterConfig, bundleID string, setID string) channelBundleApplyState {
	t.Helper()
	return applyChannelBundleToSetWithForceFlag(t, client, cfg, bundleID, setID, false)
}

func applyChannelBundleToSetWithForce(t *testing.T, client *http.Client, cfg clusterConfig, bundleID string, setID string) channelBundleApplyState {
	t.Helper()
	return applyChannelBundleToSetWithForceFlag(t, client, cfg, bundleID, setID, true)
}

func applyChannelBundleToSetWithForceFlag(t *testing.T, client *http.Client, cfg clusterConfig, bundleID string, setID string, force bool) channelBundleApplyState {
	t.Helper()
	var state channelBundleApplyState
	adminPost(t, client, cfg, "/api/channel-bundles/"+url.PathEscape(bundleID)+"/apply", map[string]any{
		"set_id":      setID,
		"force_drift": force,
	}, &state)
	return state
}

type newAPIChannelSnapshot struct {
	ID      int    `json:"id"`
	Name    string `json:"name"`
	Type    int    `json:"type"`
	Status  int    `json:"status"`
	Models  string `json:"models"`
	Group   string `json:"group"`
	BaseURL string `json:"base_url"`
}

func findNewAPIChannel(t *testing.T, session newAPISession, name string) newAPIChannelSnapshot {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, session.apiURL("/api/channel/search?keyword="+url.QueryEscape(name)+"&id_sort=true&page_size=50"), nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("New-Api-User", fmt.Sprintf("%d", session.userID))
	resp := do(t, session.client, req)
	defer resp.Body.Close()
	var parsed apiResponse[struct {
		Items []newAPIChannelSnapshot `json:"items"`
	}]
	decodeSuccess(t, resp, &parsed)
	for _, item := range parsed.Data.Items {
		if item.Name == name && item.ID > 0 {
			return item
		}
	}
	t.Fatalf("new-api channel %q was not found: %+v", name, parsed.Data.Items)
	return newAPIChannelSnapshot{}
}

func findNewAPIChannelByID(t *testing.T, session newAPISession, id int) newAPIChannelSnapshot {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, session.apiURL("/api/channel/search?keyword=&id_sort=true&page_size=100"), nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("New-Api-User", fmt.Sprintf("%d", session.userID))
	resp := do(t, session.client, req)
	defer resp.Body.Close()
	var parsed apiResponse[struct {
		Items []newAPIChannelSnapshot `json:"items"`
	}]
	decodeSuccess(t, resp, &parsed)
	for _, item := range parsed.Data.Items {
		if item.ID == id {
			return item
		}
	}
	t.Fatalf("new-api channel id %d was not found: %+v", id, parsed.Data.Items)
	return newAPIChannelSnapshot{}
}

func updateNewAPIChannelModels(t *testing.T, session newAPISession, name string, models string) {
	t.Helper()
	channel := findNewAPIChannel(t, session, name)
	payload := map[string]any{
		"id":       channel.ID,
		"type":     channel.Type,
		"status":   channel.Status,
		"name":     channel.Name,
		"base_url": channel.BaseURL,
		"models":   models,
		"group":    channel.Group,
	}
	req := newJSONRequest(t, http.MethodPut, session.apiURL("/api/channel/"), payload)
	req.Header.Set("New-Api-User", fmt.Sprintf("%d", session.userID))
	resp := do(t, session.client, req)
	defer resp.Body.Close()
	var parsed apiResponse[json.RawMessage]
	decodeSuccess(t, resp, &parsed)
}

func createLiveOpenAIChannel(t *testing.T, session newAPISession, liveCfg liveLLMConfig, runID string) int {
	t.Helper()
	name := "LLMGateway Live TokenHub " + runID
	channel := liveOpenAIChannelPayload(name, liveCfg)
	req := newJSONRequest(t, http.MethodPost, session.apiURL("/api/channel/"), map[string]any{
		"mode":    "single",
		"channel": channel,
	})
	req.Header.Set("New-Api-User", fmt.Sprintf("%d", session.userID))
	resp := do(t, session.client, req)
	defer resp.Body.Close()
	var addResp apiResponse[json.RawMessage]
	decodeSuccess(t, resp, &addResp)

	channelID := findLiveChannelID(t, session, name)
	channel["id"] = channelID

	// AddChannel 写入 DB 后不主动刷新内存 channel cache；UpdateChannel 会调用 InitChannelCache。
	req = newJSONRequest(t, http.MethodPut, session.apiURL("/api/channel/"), channel)
	req.Header.Set("New-Api-User", fmt.Sprintf("%d", session.userID))
	resp = do(t, session.client, req)
	defer resp.Body.Close()
	var updateResp apiResponse[json.RawMessage]
	decodeSuccess(t, resp, &updateResp)
	return channelID
}

func liveOpenAIChannelPayload(name string, liveCfg liveLLMConfig) map[string]any {
	return map[string]any{
		"type":       1,
		"key":        liveCfg.APIKey,
		"status":     1,
		"name":       name,
		"base_url":   liveCfg.BaseURL,
		"models":     liveCfg.Model,
		"group":      "default",
		"priority":   100,
		"auto_ban":   0,
		"weight":     0,
		"test_model": liveCfg.Model,
	}
}

func findLiveChannelID(t *testing.T, session newAPISession, name string) int {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, session.apiURL("/api/channel/search?keyword="+url.QueryEscape(name)+"&id_sort=true&page_size=50"), nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("New-Api-User", fmt.Sprintf("%d", session.userID))
	resp := do(t, session.client, req)
	defer resp.Body.Close()
	var parsed apiResponse[struct {
		Items []struct {
			ID   int    `json:"id"`
			Name string `json:"name"`
		} `json:"items"`
	}]
	decodeSuccess(t, resp, &parsed)
	for _, item := range parsed.Data.Items {
		if item.Name == name && item.ID > 0 {
			return item.ID
		}
	}
	t.Fatalf("live channel %q was not found after creation: %+v", name, parsed.Data.Items)
	return 0
}

func gatewayLiveChatCompletion(t *testing.T, client *http.Client, cfg clusterConfig, apiKey string, model string, stream bool) []byte {
	t.Helper()
	req := newJSONRequest(t, http.MethodPost, cfg.LLMGateway.BaseURL+"/v1/chat/completions", map[string]any{
		"model": model,
		"messages": []map[string]string{
			{"role": "system", "content": "You are a helpful assistant."},
			{"role": "user", "content": "你好"},
		},
		"stream": stream,
	})
	req.Header.Set("Authorization", "Bearer "+apiKey)
	resp := do(t, client, req)
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("live chat status=%d body=%s", resp.StatusCode, raw)
	}
	return raw
}

func runOpenAITransparentTrafficGoldenCases(t *testing.T, client *http.Client, cfg clusterConfig, apiKey string, mockCfg liveLLMConfig) {
	t.Helper()
	for _, item := range transparentTrafficGoldenCases() {
		switch item.Name {
		case "openai_non_stream_chat":
			t.Run("golden/"+item.Name, func(t *testing.T) {
				status, raw := gatewayChatCompletion(t, client, cfg, apiKey, map[string]any{
					"model": mockCfg.Model,
					"messages": []map[string]string{
						{"role": "system", "content": "You are a helpful assistant."},
						{"role": "user", "content": "你好"},
					},
					"stream": false,
				})
				if status != http.StatusOK {
					t.Fatalf("status=%d body=%s", status, raw)
				}
				assertLiveChatCompletion(t, raw)
				if !bytes.Contains(raw, []byte("mockllm")) {
					t.Fatalf("non-stream response did not include mockllm marker: %s", raw)
				}
			})
		case "openai_stream_chat":
			t.Run("golden/"+item.Name, func(t *testing.T) {
				status, raw := gatewayChatCompletion(t, client, cfg, apiKey, map[string]any{
					"model": mockCfg.Model,
					"messages": []map[string]string{
						{"role": "system", "content": "You are a helpful assistant."},
						{"role": "user", "content": "你好"},
					},
					"stream": true,
				})
				if status != http.StatusOK {
					t.Fatalf("status=%d body=%s", status, raw)
				}
				if !bytes.Contains(raw, []byte("data:")) || !bytes.Contains(raw, []byte("mockllm")) {
					t.Fatalf("stream response did not look like expected SSE: %s", raw)
				}
			})
		case "upstream_error_shape":
			t.Run("golden/"+item.Name, func(t *testing.T) {
				status, raw := gatewayChatCompletion(t, client, cfg, apiKey, map[string]any{
					"messages": []map[string]string{
						{"role": "user", "content": "你好"},
					},
				})
				if status < 400 || status >= 500 {
					t.Fatalf("status=%d body=%s, want transparent 4xx from new-api", status, raw)
				}
				if !bytes.Contains(raw, []byte("error")) && !bytes.Contains(raw, []byte("message")) {
					t.Fatalf("error response lost recognizable error shape: %s", raw)
				}
			})
		case "large_request_body":
			t.Run("golden/"+item.Name, func(t *testing.T) {
				status, raw := gatewayChatCompletion(t, client, cfg, apiKey, map[string]any{
					"model": mockCfg.Model,
					"messages": []map[string]string{
						{"role": "system", "content": "You are a helpful assistant."},
						{"role": "user", "content": "你好"},
					},
					"metadata": map[string]string{"llmgateway_e2e_large_body": strings.Repeat("x", 96*1024)},
					"stream":   false,
				})
				if status != http.StatusOK {
					t.Fatalf("status=%d body=%s", status, raw)
				}
				assertLiveChatCompletion(t, raw)
				if !bytes.Contains(raw, []byte("mockllm")) {
					t.Fatalf("large request response did not include mockllm marker: %s", raw)
				}
			})
		}
	}
}

func gatewayChatCompletion(t *testing.T, client *http.Client, cfg clusterConfig, apiKey string, body map[string]any) (int, []byte) {
	t.Helper()
	req := newJSONRequest(t, http.MethodPost, cfg.LLMGateway.BaseURL+"/v1/chat/completions", body)
	req.Header.Set("Authorization", "Bearer "+apiKey)
	resp := do(t, client, req)
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return resp.StatusCode, raw
}

func assertLiveChatCompletion(t *testing.T, raw []byte) {
	t.Helper()
	var parsed struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		t.Fatalf("decode live chat completion: %v body=%s", err, raw)
	}
	if len(parsed.Choices) == 0 || strings.TrimSpace(parsed.Choices[0].Message.Content) == "" {
		t.Fatalf("live chat completion did not include assistant content: %s", raw)
	}
}

func adminPost(t *testing.T, client *http.Client, cfg clusterConfig, path string, body any, out any) {
	t.Helper()
	req := newJSONRequest(t, http.MethodPost, cfg.LLMGateway.BaseURL+path, body)
	req.Header.Set("Authorization", "Bearer "+cfg.LLMGateway.AdminToken)
	resp := do(t, client, req)
	defer resp.Body.Close()
	decodeGatewaySuccess(t, resp, out)
}

func adminGet(t *testing.T, client *http.Client, cfg clusterConfig, path string, out any) {
	t.Helper()
	req := newJSONRequest(t, http.MethodGet, cfg.LLMGateway.BaseURL+path, nil)
	req.Header.Set("Authorization", "Bearer "+cfg.LLMGateway.AdminToken)
	resp := do(t, client, req)
	defer resp.Body.Close()
	decodeGatewaySuccess(t, resp, out)
}

func bootstrapManagedSet(t *testing.T, client *http.Client, cfg clusterConfig, setID string) {
	t.Helper()
	var bootstrap struct {
		ID    string `json:"id"`
		Setup bool   `json:"setup"`
	}
	adminPost(t, client, cfg, "/api/sets/"+url.PathEscape(setID)+"/bootstrap", nil, &bootstrap)
	if bootstrap.ID != setID || !bootstrap.Setup {
		t.Fatalf("bootstrap set %s returned %+v", setID, bootstrap)
	}
}

func internalGet(t *testing.T, client *http.Client, cfg clusterConfig, path string, out any) {
	t.Helper()
	internalGetFrom(t, client, cfg.LLMGateway.BaseURL, cfg.LLMGateway.InternalToken, path, out)
}

func internalGetFrom(t *testing.T, client *http.Client, baseURL string, token string, path string, out any) {
	t.Helper()
	req := newJSONRequest(t, http.MethodGet, strings.TrimRight(baseURL, "/")+path, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp := do(t, client, req)
	defer resp.Body.Close()
	decodeGatewaySuccess(t, resp, out)
}

func internalPost(t *testing.T, client *http.Client, cfg clusterConfig, path string, body any, out any) {
	t.Helper()
	req := newJSONRequest(t, http.MethodPost, cfg.LLMGateway.BaseURL+path, body)
	req.Header.Set("Authorization", "Bearer "+cfg.LLMGateway.InternalToken)
	resp := do(t, client, req)
	defer resp.Body.Close()
	decodeGatewaySuccess(t, resp, out)
}

func internalPostRaw(client *http.Client, cfg clusterConfig, path string, body any) (int, []byte, error) {
	return gatewayRaw(client, cfg, http.MethodPost, path, cfg.LLMGateway.InternalToken, body)
}

func adminPostRaw(client *http.Client, cfg clusterConfig, path string, body any) (int, []byte, error) {
	return gatewayRaw(client, cfg, http.MethodPost, path, cfg.LLMGateway.AdminToken, body)
}

func adminDeleteRaw(client *http.Client, cfg clusterConfig, path string) (int, []byte, error) {
	return gatewayRaw(client, cfg, http.MethodDelete, path, cfg.LLMGateway.AdminToken, nil)
}

func gatewayRaw(client *http.Client, cfg clusterConfig, method string, path string, token string, body any) (int, []byte, error) {
	return gatewayRawTo(client, cfg.LLMGateway.BaseURL, method, path, token, body)
}

func gatewayRawTo(client *http.Client, baseURL string, method string, path string, token string, body any) (int, []byte, error) {
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return 0, nil, err
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequest(method, strings.TrimRight(baseURL, "/")+path, reader)
	if err != nil {
		return 0, nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if strings.TrimSpace(token) != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := client.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return resp.StatusCode, nil, err
	}
	return resp.StatusCode, raw, nil
}

func createAdminAPIKey(t *testing.T, client *http.Client, cfg clusterConfig, userID string, name string) keyPayload {
	t.Helper()
	var created keyPayload
	adminPost(t, client, cfg, "/api/admin/users/"+url.PathEscape(userID)+"/api-keys", map[string]any{"name": name}, &created)
	if created.APIKey == "" || created.KeyID == "" || created.KeyPrefix == "" || !strings.HasPrefix(created.APIKey, created.KeyPrefix) {
		t.Fatalf("unexpected key response: %+v", created)
	}
	if created.Name != name {
		t.Fatalf("key name mismatch: got %q want %q", created.Name, name)
	}
	return created
}

func requireResourceRow(t *testing.T, rows []resourceRowPayload, id string) resourceRowPayload {
	t.Helper()
	for _, row := range rows {
		if row.ID == id {
			return row
		}
	}
	t.Fatalf("resource row %q not found in %+v", id, rows)
	return resourceRowPayload{}
}

func resourceString(row resourceRowPayload, key string) string {
	return strings.TrimSpace(fmt.Sprint(row.Values[key]))
}

func resourceBool(row resourceRowPayload, key string) bool {
	switch value := row.Values[key].(type) {
	case bool:
		return value
	case float64:
		return value != 0
	case int64:
		return value != 0
	case int:
		return value != 0
	default:
		raw := strings.TrimSpace(strings.ToLower(fmt.Sprint(value)))
		return raw == "1" || raw == "true" || raw == "yes"
	}
}

func resourceInt64(row resourceRowPayload, key string) int64 {
	switch value := row.Values[key].(type) {
	case float64:
		return int64(value)
	case int64:
		return value
	case int:
		return int64(value)
	default:
		parsed, _ := strconv.ParseInt(strings.TrimSpace(fmt.Sprint(value)), 10, 64)
		return parsed
	}
}

type businessFSMConfig struct {
	UserID       string
	PlanID       string
	TokenBalance int64
	PeriodValue  int
	PeriodUnit   string
}

// businessFSM 是 e2e 里的业务状态机桩。
// 它不实现 trade/ctl/subscription 的内部逻辑，只把真实业务事件翻译成 llmgateway drop-in API 调用。
// 这样测试表达的是“业务状态变化后，LLM 网关侧必须呈现什么结果”。
type businessFSM struct {
	t      *testing.T
	client *http.Client
	cfg    clusterConfig
	conf   businessFSMConfig

	subscription    subscriptionPayload
	PeriodEnd       time.Time
	pendingOrders   map[string]bool
	completedOrders map[string]bool
	terminalOrders  map[string]string
	keys            map[string]keyPayload
	cancelled       bool
	expectedBalance int64
}

func newBusinessFSM(t *testing.T, client *http.Client, cfg clusterConfig, conf businessFSMConfig) *businessFSM {
	t.Helper()
	if conf.UserID == "" || conf.PlanID == "" || conf.TokenBalance <= 0 {
		t.Fatalf("invalid business FSM config: %+v", conf)
	}
	return &businessFSM{
		t:               t,
		client:          client,
		cfg:             cfg,
		conf:            conf,
		pendingOrders:   map[string]bool{},
		completedOrders: map[string]bool{},
		terminalOrders:  map[string]string{},
		keys:            map[string]keyPayload{},
	}
}

func (f *businessFSM) CheckoutPaid(orderID string) {
	f.t.Helper()
	if strings.TrimSpace(orderID) == "" {
		f.t.Fatal("business checkout order id is required")
	}
	// 付费下单只产生待支付订单；支付成功前不能提前给 llmgateway 发放订阅。
	f.pendingOrders[orderID] = true
}

func (f *businessFSM) PaymentSucceeded(orderID string) {
	f.t.Helper()
	f.requirePendingOrder(orderID)
	if f.completedOrders[orderID] {
		return
	}
	if reason := f.terminalOrders[orderID]; reason != "" {
		return
	}
	f.applyPlan(f.conf)
	f.completedOrders[orderID] = true
	f.cancelled = false
}

func (f *businessFSM) PaymentFailed(orderID string) {
	f.t.Helper()
	f.requirePendingOrder(orderID)
	// 失败支付不会触发订阅发放；业务状态机只记录终态，llmgateway 不应感知这笔订单。
	f.terminalOrders[orderID] = "failed"
}

func (f *businessFSM) PaymentCancelled(orderID string) {
	f.t.Helper()
	f.requirePendingOrder(orderID)
	// 用户取消支付和支付失败一样，不能产生 active subscription 投影。
	f.terminalOrders[orderID] = "cancelled"
}

func (f *businessFSM) SwitchPlanPaymentSucceeded(orderID string, next businessFSMConfig) {
	f.t.Helper()
	f.requirePendingOrder(orderID)
	if f.completedOrders[orderID] {
		return
	}
	if reason := f.terminalOrders[orderID]; reason != "" {
		return
	}
	if next.PlanID == "" || next.TokenBalance <= 0 || next.PeriodValue <= 0 || next.PeriodUnit == "" {
		f.t.Fatalf("invalid switch target config: %+v", next)
	}
	if next.UserID == "" {
		next.UserID = f.conf.UserID
	}
	f.applyPlan(next)
	f.conf = next
	f.completedOrders[orderID] = true
	f.cancelled = false
}

func (f *businessFSM) applyPlan(conf businessFSMConfig) {
	f.t.Helper()
	var sub subscriptionPayload
	internalPost(f.t, f.client, f.cfg, "/api/internal/subscriptions/apply", map[string]any{
		"user_id": conf.UserID,
		"plan_id": conf.PlanID,
	}, &sub)
	f.expectedBalance += conf.TokenBalance
	f.acceptSubscriptionFor(sub, conf)
}

func (f *businessFSM) RenewalPaymentSucceeded(orderID string) {
	f.t.Helper()
	if strings.TrimSpace(orderID) == "" {
		f.t.Fatal("business renewal order id is required")
	}
	if f.PeriodEnd.IsZero() {
		f.t.Fatal("business renewal requires an active subscription first")
	}
	if f.completedOrders[orderID] {
		return
	}
	if reason := f.terminalOrders[orderID]; reason != "" {
		return
	}
	if f.cancelled {
		f.t.Fatalf("business renewal %q arrived after cancellation; use ReplayRenewalAfterCancelIgnored for stale callback semantics", orderID)
	}

	// LLMGateway 套餐积分订阅按长期有效期创建；活跃 pass 续费时不再延长 period_end，
	// 只确认现有订阅仍可查询。
	f.AssertActivePlan(f.conf.PlanID, f.expectedBalance)
	f.completedOrders[orderID] = true
}

func (f *businessFSM) ReplayRenewalPayment(orderID string) {
	f.t.Helper()
	// 支付回调重放应由业务状态机按 order_id 幂等吞掉，不能改变 LLMGateway 周期。
	f.RenewalPaymentSucceeded(orderID)
}

func (f *businessFSM) ReplayRenewalAfterCancelIgnored(orderID string) {
	f.t.Helper()
	if strings.TrimSpace(orderID) == "" {
		f.t.Fatal("business stale renewal order id is required")
	}
	// 取消之后到达的旧续费回调必须按业务订单状态吞掉，不能再调用 llmgateway apply。
	f.terminalOrders[orderID] = "stale_after_cancel"
}

func (f *businessFSM) CreateInstanceKey(instanceID string) string {
	f.t.Helper()
	if strings.TrimSpace(instanceID) == "" {
		f.t.Fatal("instance id is required")
	}
	key := createAdminAPIKey(f.t, f.client, f.cfg, f.conf.UserID, instanceID)
	f.keys[instanceID] = key
	return key.APIKey
}

func (f *businessFSM) RevokeInstanceKey(instanceID string) {
	f.t.Helper()
	key, ok := f.keys[instanceID]
	if !ok {
		f.t.Fatalf("instance key %q does not exist", instanceID)
	}
	req := newJSONRequest(f.t, http.MethodDelete, f.cfg.LLMGateway.BaseURL+"/api/admin/api-keys/"+url.PathEscape(key.KeyID), nil)
	req.Header.Set("Authorization", "Bearer "+f.cfg.LLMGateway.AdminToken)
	expectStatus(f.t, f.client, req, http.StatusOK)
}

func (f *businessFSM) Cancel() {
	f.t.Helper()
	internalPost(f.t, f.client, f.cfg, "/api/internal/subscriptions/cancel", map[string]any{"user_id": f.conf.UserID}, nil)
	f.subscription = subscriptionPayload{}
	f.PeriodEnd = time.Time{}
	f.expectedBalance = 0
	f.cancelled = true
}

func (f *businessFSM) ReplayCancel() {
	f.t.Helper()
	// 取消回调重放必须安全；老业务链路里重复取消是常见补偿/重试形态。
	f.Cancel()
	f.AssertNoActiveSubscription()
}

func (f *businessFSM) AssertNoActiveSubscription() {
	f.t.Helper()
	req := newJSONRequest(f.t, http.MethodGet, f.cfg.LLMGateway.BaseURL+"/api/internal/users/"+url.PathEscape(f.conf.UserID)+"/subscriptions", nil)
	req.Header.Set("Authorization", "Bearer "+f.cfg.LLMGateway.InternalToken)
	body := expectStatus(f.t, f.client, req, http.StatusNotFound)
	assertOpenAIError(f.t, body, "not_found_error", "not_found")
}

func (f *businessFSM) AssertActivePlan(planID string, tokenBalance int64) {
	f.t.Helper()
	var sub subscriptionPayload
	internalGet(f.t, f.client, f.cfg, "/api/internal/users/"+url.PathEscape(f.conf.UserID)+"/subscriptions", &sub)
	assertActiveSubscription(f.t, sub, f.conf.UserID, planID, tokenBalance)
	f.subscription = sub
	periodEnd, err := time.Parse(time.RFC3339Nano, sub.PeriodEnd)
	if err != nil {
		f.t.Fatalf("parse active plan period_end %q: %v", sub.PeriodEnd, err)
	}
	f.PeriodEnd = periodEnd.UTC()
}

func (f *businessFSM) AssertTrafficAllowed(apiKey string) {
	f.t.Helper()
	status, body := gatewayTraffic(f.t, f.client, f.cfg, apiKey)
	if status == http.StatusUnauthorized || status == http.StatusServiceUnavailable {
		f.t.Fatalf("business traffic should be allowed: status=%d body=%s", status, body)
	}
}

func (f *businessFSM) AssertTrafficUnauthorized(apiKey string) {
	f.t.Helper()
	status, body := gatewayTraffic(f.t, f.client, f.cfg, apiKey)
	if status != http.StatusUnauthorized {
		f.t.Fatalf("business traffic should be unauthorized: status=%d body=%s", status, body)
	}
}

func (f *businessFSM) AssertPeriodEndEquals(want time.Time) {
	f.t.Helper()
	assertSubscriptionPeriodEnd(f.t, f.subscription, want)
}

func (f *businessFSM) acceptSubscription(sub subscriptionPayload) {
	f.t.Helper()
	f.acceptSubscriptionFor(sub, f.conf)
}

func (f *businessFSM) acceptSubscriptionFor(sub subscriptionPayload, conf businessFSMConfig) {
	f.t.Helper()
	assertActiveSubscription(f.t, sub, conf.UserID, conf.PlanID, f.expectedBalance)
	periodEnd, err := time.Parse(time.RFC3339Nano, sub.PeriodEnd)
	if err != nil {
		f.t.Fatalf("parse business period_end %q: %v", sub.PeriodEnd, err)
	}
	f.subscription = sub
	f.PeriodEnd = periodEnd.UTC()
}

func (f *businessFSM) requirePendingOrder(orderID string) {
	f.t.Helper()
	if strings.TrimSpace(orderID) == "" {
		f.t.Fatal("business order id is required")
	}
	if !f.pendingOrders[orderID] {
		f.t.Fatalf("business order %q was not checked out before payment", orderID)
	}
}

func gatewayTraffic(t *testing.T, client *http.Client, cfg clusterConfig, apiKey string) (int, string) {
	t.Helper()
	return gatewayTrafficTo(t, client, cfg.LLMGateway.BaseURL, apiKey)
}

func gatewayTrafficTo(t *testing.T, client *http.Client, baseURL string, apiKey string) (int, string) {
	t.Helper()
	req := newJSONRequest(t, http.MethodGet, strings.TrimRight(baseURL, "/")+"/v1/models", nil)
	req.Header.Set("Authorization", "Bearer "+apiKey)
	resp := do(t, client, req)
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(body)
}

func expectStatus(t *testing.T, client *http.Client, req *http.Request, want int) []byte {
	t.Helper()
	resp := do(t, client, req)
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != want {
		t.Fatalf("%s %s status=%d want=%d body=%s", req.Method, req.URL.String(), resp.StatusCode, want, body)
	}
	return body
}

func assertOpenAIError(t *testing.T, body []byte, wantType string, wantCode string) {
	t.Helper()
	var parsed struct {
		Error struct {
			Message string `json:"message"`
			Type    string `json:"type"`
			Code    string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		t.Fatalf("decode OpenAI error: %v body=%s", err, body)
	}
	if parsed.Error.Type != wantType || parsed.Error.Code != wantCode || parsed.Error.Message == "" {
		t.Fatalf("unexpected OpenAI error: %+v body=%s", parsed.Error, body)
	}
}

func assertActiveSubscription(t *testing.T, sub subscriptionPayload, userID string, planID string, tokenBalance int64) {
	t.Helper()
	if sub.UserID != userID || sub.PlanID != planID || sub.Status != "active" || sub.TokenBalance != tokenBalance {
		t.Fatalf("unexpected active subscription: %+v want user=%s plan=%s balance=%d", sub, userID, planID, tokenBalance)
	}
	if _, err := time.Parse(time.RFC3339Nano, sub.PeriodStart); err != nil {
		t.Fatalf("invalid period_start %q: %v", sub.PeriodStart, err)
	}
	if _, err := time.Parse(time.RFC3339Nano, sub.PeriodEnd); err != nil {
		t.Fatalf("invalid period_end %q: %v", sub.PeriodEnd, err)
	}
}

func assertSubscriptionPeriodEnd(t *testing.T, sub subscriptionPayload, want time.Time) {
	t.Helper()
	got, err := time.Parse(time.RFC3339Nano, sub.PeriodEnd)
	if err != nil {
		t.Fatalf("invalid period_end %q: %v", sub.PeriodEnd, err)
	}
	if !got.Equal(want.UTC()) {
		t.Fatalf("period_end = %s, want %s", got.Format(time.RFC3339Nano), want.UTC().Format(time.RFC3339Nano))
	}
}

func assertSubscriptionPeriodEndString(t *testing.T, sub subscriptionPayload, want string) {
	t.Helper()
	got, err := time.Parse(time.RFC3339Nano, sub.PeriodEnd)
	if err != nil {
		t.Fatalf("invalid period_end %q: %v", sub.PeriodEnd, err)
	}
	wantTime, err := time.Parse(time.RFC3339Nano, want)
	if err != nil {
		t.Fatalf("invalid wanted period_end %q: %v", want, err)
	}
	if !got.Equal(wantTime) {
		t.Fatalf("period_end = %s, want %s", got.Format(time.RFC3339Nano), wantTime.Format(time.RFC3339Nano))
	}
}

func decodeGatewaySuccess(t *testing.T, resp *http.Response, out any) {
	t.Helper()
	var parsed apiResponse[json.RawMessage]
	decodeSuccess(t, resp, &parsed)
	if out == nil {
		return
	}
	if err := json.Unmarshal(parsed.Data, out); err != nil {
		t.Fatalf("decode gateway data: %v data=%s", err, string(parsed.Data))
	}
}

func decodeSuccess[T any](t *testing.T, resp *http.Response, out *apiResponse[T]) {
	t.Helper()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status=%d body=%s", resp.StatusCode, raw)
	}
	if err := json.Unmarshal(raw, out); err != nil {
		t.Fatalf("decode response: %v body=%s", err, raw)
	}
	if !out.Success {
		t.Fatalf("api success=false message=%q body=%s", out.Message, raw)
	}
}

func newJSONRequest(t *testing.T, method string, endpoint string, body any) *http.Request {
	t.Helper()
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequest(method, endpoint, reader)
	if err != nil {
		t.Fatal(err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Accept", "application/json")
	return req
}

func legacyJSONRequest(t *testing.T, method string, endpoint string, body any) *http.Request {
	t.Helper()
	req := newJSONRequest(t, method, endpoint, body)
	req.Header.Del("Accept")
	return req
}

func do(t *testing.T, client *http.Client, req *http.Request) *http.Response {
	t.Helper()
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

func uniqueID(prefix string) string {
	prefix = strings.TrimSpace(prefix)
	if prefix == "" {
		prefix = "llmgw-e2e"
	}
	return fmt.Sprintf("%s-%d", prefix, time.Now().UTC().UnixNano())
}
