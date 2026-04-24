package payment

import (
	"bytes"
	"context"
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

func NewClient(baseURL string) *Client {
	return &Client{
		baseURL:    strings.TrimRight(strings.TrimSpace(baseURL), "/"),
		httpClient: &http.Client{Timeout: 10 * time.Second},
	}
}

func (c *Client) CreateOrder(ctx context.Context, externalUserID, code string) (*service.PaymentOrder, error) {
	body, err := json.Marshal(map[string]string{
		"externalUserId": externalUserID,
		"code":           code,
	})
	if err != nil {
		return nil, fmt.Errorf("marshal create order request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/internal/payment/orders", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("build create order request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("create payment order: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		payload, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return nil, fmt.Errorf("create payment order: status=%d body=%s", resp.StatusCode, strings.TrimSpace(string(payload)))
	}

	var order service.PaymentOrder
	if err := json.NewDecoder(resp.Body).Decode(&order); err != nil {
		return nil, fmt.Errorf("decode create order response: %w", err)
	}
	return &order, nil
}
