package llmgateway

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
)

type UserQuotaResetter interface {
	ResetUserQuota(ctx context.Context, userID string, dryRun bool) (*UserQuotaResetResult, error)
}

type UserQuotaResetResult struct {
	UserID            string `json:"user_id"`
	SetID             string `json:"set_id"`
	UpstreamUserID    int    `json:"upstream_user_id"`
	PlanID            string `json:"plan_id"`
	UpstreamPlanID    int    `json:"upstream_plan_id"`
	SubscriptionID    string `json:"subscription_id"`
	AmountUsedBefore  int64  `json:"amount_used_before"`
	AmountUsedAfter   int64  `json:"amount_used_after"`
	NextResetTime     int64  `json:"next_reset_time"`
	EndTime           int64  `json:"end_time"`
	DryRun            bool   `json:"dry_run"`
	Status            string `json:"status"`
	ScheduleUnchanged bool   `json:"schedule_unchanged"`
}

type quotaSubscription struct {
	ID            int    `json:"id"`
	Status        string `json:"status"`
	PlanID        int    `json:"plan_id"`
	AmountUsed    int64  `json:"amount_used"`
	NextResetTime int64  `json:"next_reset_time"`
	EndTime       int64  `json:"end_time"`
}

func (a *LLMGatewayAdapter) ResetUserQuota(ctx context.Context, userID string, dryRun bool) (*UserQuotaResetResult, error) {
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return nil, fmt.Errorf("user_id is required")
	}
	if a.baseURL == "" || a.adminToken == "" {
		return nil, fmt.Errorf("llmgateway admin endpoint is not configured")
	}

	target, err := a.resolveQuotaResetTarget(ctx, userID)
	if err != nil {
		return nil, err
	}
	result := &UserQuotaResetResult{
		UserID: userID, SetID: target.setID, UpstreamUserID: target.upstreamUserID,
		PlanID: target.planID, UpstreamPlanID: target.upstreamPlanID,
		SubscriptionID:   strconv.Itoa(target.subscription.ID),
		AmountUsedBefore: target.subscription.AmountUsed,
		AmountUsedAfter:  target.subscription.AmountUsed,
		NextResetTime:    target.subscription.NextResetTime,
		EndTime:          target.subscription.EndTime,
		DryRun:           dryRun, Status: "ready",
	}
	if dryRun {
		return result, nil
	}
	if target.subscription.AmountUsed == 0 {
		result.Status = "already_reset"
		result.ScheduleUnchanged = true
		return result, nil
	}

	resetPath := fmt.Sprintf(
		"/_llmgateway_console/%s/api/subscription/admin/users/%d/subscriptions/reset",
		url.PathEscape(target.setID), target.upstreamUserID,
	)
	var resetResponse struct {
		Success bool `json:"success"`
		Data    struct {
			ResetCount       int  `json:"reset_count"`
			UserCount        int  `json:"user_count"`
			AdvanceResetTime bool `json:"advance_reset_time"`
		} `json:"data"`
	}
	if err := a.doQuotaAdminJSON(ctx, http.MethodPost, resetPath, map[string]any{
		"plan_id": target.upstreamPlanID, "advance_reset_time": false,
	}, &resetResponse); err != nil {
		return nil, err
	}
	if resetResponse.Data.ResetCount != 1 || resetResponse.Data.UserCount != 1 || resetResponse.Data.AdvanceResetTime {
		return nil, fmt.Errorf("quota reset did not affect exactly one user subscription without advancing time")
	}

	after, err := a.resolveQuotaResetTarget(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("verify quota reset: %w", err)
	}
	if after.setID != target.setID || after.upstreamUserID != target.upstreamUserID ||
		after.upstreamPlanID != target.upstreamPlanID || after.subscription.ID != target.subscription.ID {
		return nil, fmt.Errorf("quota reset target changed during verification")
	}
	if after.subscription.AmountUsed != 0 {
		return nil, fmt.Errorf("quota reset verification found amount_used=%d", after.subscription.AmountUsed)
	}
	if after.subscription.NextResetTime != target.subscription.NextResetTime || after.subscription.EndTime != target.subscription.EndTime {
		return nil, fmt.Errorf("quota reset changed subscription schedule")
	}
	result.AmountUsedAfter = 0
	result.Status = "reset"
	result.ScheduleUnchanged = true
	return result, nil
}

type quotaResetTarget struct {
	setID          string
	upstreamUserID int
	planID         string
	upstreamPlanID int
	subscription   quotaSubscription
}

func (a *LLMGatewayAdapter) resolveQuotaResetTarget(ctx context.Context, userID string) (*quotaResetTarget, error) {
	var bindingResponse struct {
		Data struct {
			Row struct {
				Values struct {
					SetID          string `json:"set_id"`
					UpstreamUserID int    `json:"upstream_user_id"`
					LastPlanID     string `json:"last_plan_id"`
				} `json:"values"`
			} `json:"row"`
		} `json:"data"`
	}
	if err := a.doQuotaAdminJSON(ctx, http.MethodGet,
		"/api/admin/resources/user_bindings/rows/"+url.PathEscape(userID), nil, &bindingResponse); err != nil {
		return nil, fmt.Errorf("get llmgateway user binding: %w", err)
	}
	values := bindingResponse.Data.Row.Values
	values.SetID = strings.TrimSpace(values.SetID)
	values.LastPlanID = strings.TrimSpace(values.LastPlanID)
	if values.SetID == "" || values.UpstreamUserID <= 0 || values.LastPlanID == "" {
		return nil, fmt.Errorf("llmgateway user binding is incomplete")
	}

	var mappingsResponse struct {
		Data []struct {
			SetID          string `json:"set_id"`
			Status         string `json:"status"`
			UpstreamPlanID int    `json:"upstream_plan_id"`
		} `json:"data"`
	}
	if err := a.doQuotaAdminJSON(ctx, http.MethodGet,
		"/api/plans/"+url.PathEscape(values.LastPlanID)+"/sets", nil, &mappingsResponse); err != nil {
		return nil, fmt.Errorf("get llmgateway plan mappings: %w", err)
	}
	upstreamPlanID := 0
	readyCount := 0
	for _, mapping := range mappingsResponse.Data {
		if mapping.SetID == values.SetID && strings.EqualFold(mapping.Status, "ready") && mapping.UpstreamPlanID > 0 {
			upstreamPlanID = mapping.UpstreamPlanID
			readyCount++
		}
	}
	if readyCount != 1 {
		return nil, fmt.Errorf("expected exactly one ready plan mapping for set %s, found %d", values.SetID, readyCount)
	}

	listPath := fmt.Sprintf(
		"/_llmgateway_console/%s/api/subscription/admin/users/%d/subscriptions",
		url.PathEscape(values.SetID), values.UpstreamUserID,
	)
	var subscriptionsResponse struct {
		Data []struct {
			Subscription quotaSubscription `json:"subscription"`
		} `json:"data"`
	}
	if err := a.doQuotaAdminJSON(ctx, http.MethodGet, listPath, nil, &subscriptionsResponse); err != nil {
		return nil, fmt.Errorf("list llmgateway user subscriptions: %w", err)
	}
	activeCount := 0
	matchingCount := 0
	var matched quotaSubscription
	for _, item := range subscriptionsResponse.Data {
		sub := item.Subscription
		if !strings.EqualFold(sub.Status, "active") {
			continue
		}
		activeCount++
		if sub.PlanID == upstreamPlanID {
			matchingCount++
			matched = sub
		}
	}
	if activeCount != 1 || matchingCount != 1 || matched.ID <= 0 || matched.NextResetTime <= 0 || matched.EndTime <= 0 {
		return nil, fmt.Errorf("expected exactly one active subscription and one matching plan")
	}
	return &quotaResetTarget{
		setID: values.SetID, upstreamUserID: values.UpstreamUserID,
		planID: values.LastPlanID, upstreamPlanID: upstreamPlanID, subscription: matched,
	}, nil
}

func (a *LLMGatewayAdapter) doQuotaAdminJSON(ctx context.Context, method, path string, body any, out any) error {
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(encoded)
	}
	req, err := http.NewRequestWithContext(ctx, method, a.baseURL+path, reader)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	a.applyAdminAuth(req)
	resp, err := a.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		return fmt.Errorf("llmgateway admin returned status %d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	var envelope struct {
		Success *bool  `json:"success"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(raw, &envelope); err == nil && envelope.Success != nil && !*envelope.Success {
		return fmt.Errorf("llmgateway admin request failed: %s", strings.TrimSpace(envelope.Message))
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("decode llmgateway admin response: %w", err)
	}
	return nil
}
