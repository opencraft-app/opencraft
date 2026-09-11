package llmgateway

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"git.woa.com/wisp/mono/credit/internal/service"
)

type Client struct {
	baseURL string
	token   string
	client  *http.Client
}

func NewClient(baseURL string, token string) *Client {
	return &Client{
		baseURL: strings.TrimRight(strings.TrimSpace(baseURL), "/"),
		token:   strings.TrimSpace(token),
		client:  &http.Client{Timeout: 10 * time.Second},
	}
}

func (c *Client) ApplySubscription(ctx context.Context, req service.ApplySubscriptionRequest) (service.Subscription, error) {
	var resp struct {
		Success bool                 `json:"success"`
		Data    service.Subscription `json:"data"`
		Message string               `json:"message"`
	}
	body := map[string]any{
		"idempotency_key":   req.IdempotencyKey,
		"user_id":           req.UserID,
		"plan_id":           req.PlanID,
		"subscription_name": req.SubscriptionName,
		"is_unique":         req.IsUnique,
	}
	if err := c.doJSON(ctx, http.MethodPost, "/api/internal/subscriptions/apply", body, &resp); err != nil {
		return service.Subscription{}, err
	}
	if !resp.Success {
		return service.Subscription{}, fmt.Errorf("llmgateway apply subscription failed: %s", resp.Message)
	}
	return resp.Data, nil
}

func (c *Client) CancelSelectedSubscriptions(ctx context.Context, req service.CancelSelectedSubscriptionsRequest) error {
	body := map[string]any{
		"user_id":            req.UserID,
		"subscription_names": req.SubscriptionNames,
	}
	var resp struct {
		Success bool   `json:"success"`
		Message string `json:"message"`
	}
	if err := c.doJSON(ctx, http.MethodPost, "/api/internal/subscriptions/cancel-selected", body, &resp); err != nil {
		return err
	}
	if !resp.Success {
		return fmt.Errorf("llmgateway cancel selected subscriptions failed: %s", resp.Message)
	}
	return nil
}

func (c *Client) ListActiveSubscriptions(ctx context.Context, userID string) (service.ActiveSubscriptionList, error) {
	var resp struct {
		Success bool                           `json:"success"`
		Data    service.ActiveSubscriptionList `json:"data"`
		Message string                         `json:"message"`
	}
	if err := c.doJSON(ctx, http.MethodGet, "/api/internal/users/"+escapePath(userID)+"/subscriptions/active", nil, &resp); err != nil {
		return service.ActiveSubscriptionList{}, err
	}
	if !resp.Success {
		return service.ActiveSubscriptionList{}, fmt.Errorf("llmgateway list active subscriptions failed: %s", resp.Message)
	}
	return resp.Data, nil
}

func (c *Client) doJSON(ctx context.Context, method string, path string, payload any, out any) error {
	if c.baseURL == "" {
		return fmt.Errorf("llmgateway base url is required")
	}
	var body io.Reader
	if payload != nil {
		data, err := json.Marshal(payload)
		if err != nil {
			return err
		}
		body = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, body)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	resp, err := c.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("llmgateway returned status %d: %s", resp.StatusCode, string(respBody))
	}
	return json.Unmarshal(respBody, out)
}

func escapePath(value string) string {
	return url.PathEscape(strings.TrimSpace(value))
}
