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
	"time"
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
	Name          string `json:"name"`
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
	if a.baseURL == "" || a.adminToken == "" || a.internalToken == "" {
		return nil, fmt.Errorf("llmgateway quota reset endpoints are not configured")
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
	if values.SetID == "" || values.UpstreamUserID <= 0 {
		return nil, fmt.Errorf("llmgateway user binding is incomplete")
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
	baseCount := 0
	var matched quotaSubscription
	now := time.Now().Unix()
	for _, item := range subscriptionsResponse.Data {
		sub := item.Subscription
		if !strings.EqualFold(sub.Status, "active") || sub.EndTime <= now {
			continue
		}
		name := strings.TrimSpace(sub.Name)
		if strings.HasPrefix(name, "credit-package:") || strings.HasPrefix(name, "free-credit:") {
			continue
		}
		if name != "" && !strings.HasPrefix(name, "package:") {
			return nil, fmt.Errorf("unknown active subscription kind for subscription %d", sub.ID)
		}
		baseCount++
		matched = sub
	}
	if baseCount != 1 || matched.ID <= 0 || matched.PlanID <= 0 || matched.NextResetTime <= 0 {
		return nil, fmt.Errorf("expected exactly one active, periodically resettable package subscription, found %d", baseCount)
	}
	// The current new-api endpoint resets every active subscription for a plan.
	// Refuse a shared plan even when the other subscription is additive.
	samePlanCount := 0
	for _, item := range subscriptionsResponse.Data {
		sub := item.Subscription
		if strings.EqualFold(sub.Status, "active") && sub.EndTime > now && sub.PlanID == matched.PlanID {
			samePlanCount++
		}
	}
	if samePlanCount != 1 {
		return nil, fmt.Errorf("package plan is shared by %d active subscriptions", samePlanCount)
	}

	active, err := a.ListActiveSubscriptions(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("resolve llmgateway package plan: %w", err)
	}
	planID := ""
	projectionCount := 0
	for _, sub := range active.Subscriptions {
		if sub.ID != strconv.Itoa(matched.ID) {
			continue
		}
		projectionCount++
		planID = strings.TrimSpace(sub.PlanID)
		projectedName := strings.TrimSpace(sub.Name)
		if sub.UserID != userID || !strings.EqualFold(sub.Status, "active") ||
			(projectedName != "" && !strings.HasPrefix(projectedName, "package:")) {
			return nil, fmt.Errorf("package subscription projection is not an active package for this user")
		}
		if projectedName != "" && matched.Name != "" && projectedName != strings.TrimSpace(matched.Name) {
			return nil, fmt.Errorf("package subscription name differs from llmgateway projection")
		}
	}
	if projectionCount != 1 || planID == "" {
		return nil, fmt.Errorf("expected exactly one package subscription plan projection, found %d", projectionCount)
	}
	var mappingsResponse struct {
		Data []struct {
			SetID          string `json:"set_id"`
			Status         string `json:"status"`
			UpstreamPlanID int    `json:"upstream_plan_id"`
		} `json:"data"`
	}
	if err := a.doQuotaAdminJSON(ctx, http.MethodGet,
		"/api/plans/"+url.PathEscape(planID)+"/sets", nil, &mappingsResponse); err != nil {
		return nil, fmt.Errorf("get llmgateway package plan mappings: %w", err)
	}
	readyCount := 0
	for _, mapping := range mappingsResponse.Data {
		if mapping.SetID == values.SetID && strings.EqualFold(mapping.Status, "ready") && mapping.UpstreamPlanID == matched.PlanID {
			readyCount++
		}
	}
	if readyCount != 1 {
		return nil, fmt.Errorf("expected exactly one ready mapping for package subscription plan, found %d", readyCount)
	}
	return &quotaResetTarget{
		setID: values.SetID, upstreamUserID: values.UpstreamUserID,
		planID: planID, upstreamPlanID: matched.PlanID, subscription: matched,
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
