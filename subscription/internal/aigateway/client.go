package aigateway

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"git.woa.com/wisp/mono/subscription/internal/service"
)

type Client struct {
	baseURL    string
	httpClient *http.Client
}

type remoteSubscription struct {
	ID     string `json:"id"`
	UserID string `json:"user_id"`
	PlanID string `json:"plan_id"`
	Status string `json:"status"`
}

func NewClient(baseURL string) *Client {
	return &Client{
		baseURL:    strings.TrimRight(strings.TrimSpace(baseURL), "/"),
		httpClient: &http.Client{Timeout: 10 * time.Second},
	}
}

func (c *Client) SetSubscriptionByExternalUID(ctx context.Context, externalUserID, planID string) (*service.AIGatewaySubscription, error) {
	body, err := json.Marshal(map[string]string{
		"user_id":  externalUserID,
		"plan_id":  planID,
		"nickname": externalUserID,
		"phone":    syntheticPhoneForExternalUser(externalUserID),
	})
	if err != nil {
		return nil, fmt.Errorf("marshal subscribe body: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/api/internal/subscriptions/apply", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("build subscribe request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("subscribe user: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return nil, fmt.Errorf("subscribe user: status=%d body=%s", resp.StatusCode, strings.TrimSpace(string(respBody)))
	}

	var subscription remoteSubscription
	if err := json.NewDecoder(resp.Body).Decode(&subscription); err != nil {
		return nil, fmt.Errorf("decode subscribe response: %w", err)
	}

	return &service.AIGatewaySubscription{
		ID:     subscription.ID,
		UserID: subscription.UserID,
		PlanID: subscription.PlanID,
		Status: subscription.Status,
	}, nil
}

func (c *Client) CancelSubscriptionByExternalUID(ctx context.Context, externalUserID string) error {
	body, err := json.Marshal(map[string]string{
		"user_id": externalUserID,
	})
	if err != nil {
		return fmt.Errorf("marshal cancel body: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/api/internal/subscriptions/cancel", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("build cancel request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("cancel subscription: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("cancel subscription: status=%d body=%s", resp.StatusCode, strings.TrimSpace(string(respBody)))
	}
	return nil
}

func syntheticPhoneForExternalUser(externalUserID string) string {
	sum := sha256.Sum256([]byte(externalUserID))
	digits := make([]byte, 9)
	for i := range digits {
		digits[i] = '0' + (sum[i] % 10)
	}
	return "13" + string(digits)
}
