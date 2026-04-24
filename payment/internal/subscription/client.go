package subscription

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
	baseURL       string
	internalToken string
	httpClient    *http.Client
}

func NewClient(baseURL, internalToken string) *Client {
	return &Client{
		baseURL:       strings.TrimRight(strings.TrimSpace(baseURL), "/"),
		internalToken: strings.TrimSpace(internalToken),
		httpClient:    &http.Client{Timeout: 10 * time.Second},
	}
}

func (c *Client) ApplyPayment(ctx context.Context, orderID, externalUserID, code, providerOrderID string) error {
	body, err := json.Marshal(map[string]string{
		"orderId":        orderID,
		"externalUserId": externalUserID,
		"code":           code,
		"providerOrderId": providerOrderID,
	})
	if err != nil {
		return fmt.Errorf("marshal apply payment request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/internal/subscriptions/apply-payment", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("build apply payment request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.internalToken)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("apply payment to subscription: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		payload, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("apply payment to subscription: status=%d body=%s", resp.StatusCode, strings.TrimSpace(string(payload)))
	}
	return nil
}
