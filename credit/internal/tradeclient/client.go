package tradeclient

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

	"git.woa.com/wisp/mono/credit/internal/usage"
)

type Client struct {
	baseURL string
	token   string
	client  *http.Client
}

type InquiryRequest struct {
	ExternalUserID string `json:"external_user_id"`
	ProductID      string `json:"product_id"`
	TimeSpan       int    `json:"time_span"`
	TimeUnit       string `json:"time_unit"`
}

type OrderRequest struct {
	ExternalUserID string `json:"external_user_id"`
	ProductID      string `json:"product_id"`
	TimeSpan       int    `json:"time_span"`
	TimeUnit       string `json:"time_unit"`
}

func (r *InquiryRequest) DefaultPeriod() {
	if r.TimeSpan == 0 {
		r.TimeSpan = 1
	}
	if strings.TrimSpace(r.TimeUnit) == "" {
		r.TimeUnit = "m"
	}
}

func (r *OrderRequest) DefaultPeriod() {
	if r.TimeSpan == 0 {
		r.TimeSpan = 1
	}
	if strings.TrimSpace(r.TimeUnit) == "" {
		r.TimeUnit = "m"
	}
}

func NewClient(baseURL string, token string) *Client {
	return &Client{
		baseURL: strings.TrimRight(strings.TrimSpace(baseURL), "/"),
		token:   strings.TrimSpace(token),
		client:  &http.Client{Timeout: 10 * time.Second},
	}
}

func (c *Client) Inquiry(ctx context.Context, req InquiryRequest) (map[string]any, error) {
	return c.post(ctx, "/internal/trade/credit/inquiry", req)
}

func (c *Client) PlaceOrder(ctx context.Context, req OrderRequest) (map[string]any, error) {
	return c.post(ctx, "/internal/trade/credit/orders", req)
}

func (c *Client) PlaceOrderAndPay(ctx context.Context, req OrderRequest) (map[string]any, error) {
	return c.post(ctx, "/internal/trade/credit/orders/pay", req)
}

type RefundRequest struct {
	OwnerUin  string `json:"ownerUin"`
	UIN       string `json:"uin"`
	AppID     int64  `json:"appId"`
	ProductID string `json:"productId"`
}

func (c *Client) RefundPackage(ctx context.Context, packageID string, req RefundRequest) (map[string]any, error) {
	return c.post(ctx, "/internal/trade/credit/resources/"+escapePath(packageID)+"/refund", req)
}

func (c *Client) ReportUsage(ctx context.Context, req usage.ReportRequest) (json.RawMessage, error) {
	if c.baseURL == "" {
		return nil, fmt.Errorf("trade base url is required")
	}
	data, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/internal/trade/credit/resources/usage/report", bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Accept", "application/json")
	if c.token != "" {
		httpReq.Header.Set("Authorization", "Bearer "+c.token)
	}
	resp, err := c.client.Do(httpReq)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("trade returned status %d: %s", resp.StatusCode, string(body))
	}
	if !json.Valid(body) {
		return nil, fmt.Errorf("trade returned invalid json")
	}
	return json.RawMessage(body), nil
}

func (c *Client) post(ctx context.Context, path string, payload any) (map[string]any, error) {
	if c.baseURL == "" {
		return nil, fmt.Errorf("trade base url is required")
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+path, bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Accept", "application/json")
	if c.token != "" {
		httpReq.Header.Set("Authorization", "Bearer "+c.token)
	}
	resp, err := c.client.Do(httpReq)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("trade returned status %d: %s", resp.StatusCode, string(respBody))
	}
	var out map[string]any
	if err := json.Unmarshal(respBody, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func escapePath(value string) string {
	return url.PathEscape(strings.TrimSpace(value))
}
