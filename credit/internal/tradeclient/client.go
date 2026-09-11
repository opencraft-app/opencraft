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

type PayURLRequest struct {
	ExternalUserID string `json:"external_user_id"`
	Platform       string `json:"platform,omitempty"`
	WxOpenID       string `json:"wx_open_id,omitempty"`
	WxAppID        string `json:"wx_app_id,omitempty"`
	CancelURL      string `json:"cancel_url,omitempty"`
	ReturnURL      string `json:"return_url,omitempty"`
}

type PayURLResult struct {
	PayURL     string  `json:"payUrl"`
	TokenID    *string `json:"tokenId,omitempty"`
	OrderID    *string `json:"orderId,omitempty"`
	MidasAppID *string `json:"midasAppId,omitempty"`
	NeedCharge int     `json:"needCharge"`
	Uin        string  `json:"uin,omitempty"`
	AppID      string  `json:"appId,omitempty"`
}

type Error struct {
	Status   int
	Code     string
	Message  string
	Endpoint string
}

func (e *Error) Error() string {
	if e == nil {
		return ""
	}
	return fmt.Sprintf("trade client: %s -> %d %s: %s", e.Endpoint, e.Status, e.Code, e.Message)
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

func (c *Client) GeneratePayURL(ctx context.Context, dealName string, req PayURLRequest) (*PayURLResult, error) {
	if c.baseURL == "" {
		return nil, fmt.Errorf("trade base url is required")
	}
	dealName = strings.TrimSpace(dealName)
	if dealName == "" {
		return nil, fmt.Errorf("deal name is required")
	}
	endpoint := "/internal/trade/orders/" + escapePath(dealName) + "/pay-url"
	payload := struct {
		PayURLRequest
		ExpectedResourceType string `json:"expected_resource_type"`
	}{
		PayURLRequest:        req,
		ExpectedResourceType: "credit_package",
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	httpReq, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		c.baseURL+endpoint,
		bytes.NewReader(data),
	)
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
		var body struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		}
		if err := json.Unmarshal(respBody, &body); err != nil {
			body.Message = strings.TrimSpace(string(respBody))
		}
		return nil, &Error{
			Status:   resp.StatusCode,
			Code:     body.Code,
			Message:  body.Message,
			Endpoint: endpoint,
		}
	}
	var result PayURLResult
	if err := json.Unmarshal(respBody, &result); err != nil {
		return nil, err
	}
	return &result, nil
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
