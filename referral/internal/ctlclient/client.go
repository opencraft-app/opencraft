package ctlclient

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

type Client struct {
	baseURL string
	token   string
	http    *http.Client
}

type GrantRequest struct {
	UserID           string `json:"user_id"`
	CreditAmount     int64  `json:"credit_amount"`
	Source           string `json:"source"`
	IdempotencyKey   string `json:"idempotency_key"`
	InviteeUserID    string `json:"invitee_user_id"`
	QualifyingPassID string `json:"qualifying_pass_id"`
}

type GrantResult struct {
	SubscriptionID   string `json:"subscription_id"`
	SubscriptionName string `json:"subscription_name"`
}

type RevokeRequest struct {
	UserID            string   `json:"user_id"`
	SubscriptionNames []string `json:"subscription_names"`
}

type responseEnvelope struct {
	Code    string          `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data"`
}

func New(baseURL, token string) *Client {
	return &Client{
		baseURL: strings.TrimRight(strings.TrimSpace(baseURL), "/"),
		token:   strings.TrimSpace(token),
		http:    &http.Client{Timeout: 10 * time.Second},
	}
}

func (c *Client) Grant(ctx context.Context, request GrantRequest) (GrantResult, error) {
	body, err := json.Marshal(request)
	if err != nil {
		return GrantResult{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/internal/ctl/passes/free-credit", bytes.NewReader(body))
	if err != nil {
		return GrantResult{}, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return GrantResult{}, fmt.Errorf("grant referral credit: %w", err)
	}
	defer resp.Body.Close()
	responseBody, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return GrantResult{}, err
	}
	var envelope responseEnvelope
	if err := json.Unmarshal(responseBody, &envelope); err != nil {
		return GrantResult{}, fmt.Errorf("decode CTL grant response: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return GrantResult{}, fmt.Errorf("CTL grant failed: status=%d code=%s message=%s", resp.StatusCode, envelope.Code, envelope.Message)
	}
	var result GrantResult
	if err := json.Unmarshal(envelope.Data, &result); err != nil {
		return GrantResult{}, fmt.Errorf("decode CTL grant data: %w", err)
	}
	if strings.TrimSpace(result.SubscriptionID) == "" {
		return GrantResult{}, fmt.Errorf("CTL grant returned empty subscription_id")
	}
	return result, nil
}

func (c *Client) Revoke(ctx context.Context, request RevokeRequest) error {
	body, err := json.Marshal(request)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/internal/ctl/passes/free-credit/revoke", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("revoke referral credit: %w", err)
	}
	defer resp.Body.Close()
	responseBody, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		var envelope responseEnvelope
		_ = json.Unmarshal(responseBody, &envelope)
		return fmt.Errorf("CTL revoke failed: status=%d code=%s message=%s", resp.StatusCode, envelope.Code, envelope.Message)
	}
	return nil
}
