package creditclient

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
)

type Client interface {
	CompletePackage(ctx context.Context, req *CompletePackageRequest) (*PackageDetail, error)
	GetUsedAmounts(ctx context.Context, req *UsedAmountRequest) (map[string]UsedAmountItem, error)
	ListResourceAppIDs(ctx context.Context, req *ResourcePageRequest) ([]int64, int64, error)
	ListUserResources(ctx context.Context, req *UserResourcePageRequest) ([]ResourceItem, int64, error)
	QueryResources(ctx context.Context, req *ResourceQueryRequest) ([]ResourceItem, error)
	IsolatePackage(ctx context.Context, packageID string, reason string) error
}

type HTTPClient struct {
	baseURL string
	token   string
	client  *http.Client
}

type CompletePackageRequest struct {
	DealName   string `json:"deal_name"`
	BigOrderID string `json:"big_order_id"`
	UserID     string `json:"user_id"`
	ProductID  string `json:"product_id"`
	Uin        string `json:"uin"`
	AppID      int64  `json:"app_id"`
	TimeSpan   int    `json:"time_span"`
	TimeUnit   string `json:"time_unit"`
}

type PackageDetail struct {
	PackageID string `json:"package_id"`
	UserID    string `json:"user_id"`
	ProductID string `json:"product_id"`
}

type UsedAmountRequest struct {
	Uin         string   `json:"uin"`
	AppID       int64    `json:"app_id"`
	ResourceIDs []string `json:"resource_ids"`
}

type UsedAmountItem struct {
	PackageID string      `json:"package_id"`
	ProductID string      `json:"product_id"`
	DealName  string      `json:"deal_name"`
	UsedRatio json.Number `json:"used_ratio"`
}

type ResourcePageRequest struct {
	ProductIDs []string `json:"product_ids"`
	PageNo     int      `json:"page_no"`
	PageSize   int      `json:"page_size"`
}

type UserResourcePageRequest struct {
	Uin        string   `json:"uin"`
	AppID      int64    `json:"app_id"`
	ProductIDs []string `json:"product_ids"`
	PageNo     int      `json:"page_no"`
	PageSize   int      `json:"page_size"`
}

type ResourceQueryRequest struct {
	Uin         string   `json:"uin,omitempty"`
	AppID       int64    `json:"app_id"`
	ResourceIDs []string `json:"resource_ids"`
}

type ResourceItem struct {
	PackageID    string     `json:"package_id"`
	ProductID    string     `json:"product_id"`
	Uin          string     `json:"uin"`
	AppID        int64      `json:"app_id"`
	CreatedTime  time.Time  `json:"created_time"`
	ExpiredTime  time.Time  `json:"expired_time"`
	IsolatedTime *time.Time `json:"isolated_time,omitempty"`
	Status       string     `json:"status"`
	AllowReturn  bool       `json:"allow_return"`
}

func New(baseURL string, token string) *HTTPClient {
	return &HTTPClient{
		baseURL: strings.TrimRight(strings.TrimSpace(baseURL), "/"),
		token:   strings.TrimSpace(token),
		client:  &http.Client{Timeout: 4 * time.Second},
	}
}

func (c *HTTPClient) CompletePackage(ctx context.Context, req *CompletePackageRequest) (*PackageDetail, error) {
	var resp struct {
		Success bool          `json:"success"`
		Data    PackageDetail `json:"data"`
		Message string        `json:"message"`
	}
	if err := c.post(ctx, "/internal/credit/packages/complete", req, &resp); err != nil {
		return nil, err
	}
	if !resp.Success {
		return nil, fmt.Errorf("credit complete package failed: %s", resp.Message)
	}
	return &resp.Data, nil
}

func (c *HTTPClient) GetUsedAmounts(ctx context.Context, req *UsedAmountRequest) (map[string]UsedAmountItem, error) {
	var resp struct {
		Success bool                      `json:"success"`
		Data    map[string]UsedAmountItem `json:"data"`
		Message string                    `json:"message"`
	}
	if err := c.post(ctx, "/internal/credit/packages/used-amount", req, &resp); err != nil {
		return nil, err
	}
	if !resp.Success {
		return nil, fmt.Errorf("credit get used amounts failed: %s", resp.Message)
	}
	return resp.Data, nil
}

func (c *HTTPClient) ListResourceAppIDs(ctx context.Context, req *ResourcePageRequest) ([]int64, int64, error) {
	var resp struct {
		Success bool `json:"success"`
		Data    struct {
			AppIDs []int64 `json:"app_ids"`
			Total  int64   `json:"total"`
		} `json:"data"`
		Message string `json:"message"`
	}
	if err := c.post(ctx, "/internal/credit/packages/app-ids", req, &resp); err != nil {
		return nil, 0, err
	}
	if !resp.Success {
		return nil, 0, fmt.Errorf("credit list resource app ids failed: %s", resp.Message)
	}
	return resp.Data.AppIDs, resp.Data.Total, nil
}

func (c *HTTPClient) ListUserResources(ctx context.Context, req *UserResourcePageRequest) ([]ResourceItem, int64, error) {
	var resp struct {
		Success bool `json:"success"`
		Data    struct {
			Resources []ResourceItem `json:"resources"`
			Total     int64          `json:"total"`
		} `json:"data"`
		Message string `json:"message"`
	}
	if err := c.post(ctx, "/internal/credit/packages/by-owner", req, &resp); err != nil {
		return nil, 0, err
	}
	if !resp.Success {
		return nil, 0, fmt.Errorf("credit list user resources failed: %s", resp.Message)
	}
	return resp.Data.Resources, resp.Data.Total, nil
}

func (c *HTTPClient) QueryResources(ctx context.Context, req *ResourceQueryRequest) ([]ResourceItem, error) {
	var resp struct {
		Success bool           `json:"success"`
		Data    []ResourceItem `json:"data"`
		Message string         `json:"message"`
	}
	if err := c.post(ctx, "/internal/credit/packages/query-resources", req, &resp); err != nil {
		return nil, err
	}
	if !resp.Success {
		return nil, fmt.Errorf("credit query resources failed: %s", resp.Message)
	}
	return resp.Data, nil
}

func (c *HTTPClient) IsolatePackage(ctx context.Context, packageID string, reason string) error {
	return c.packageAction(ctx, packageID, "isolate", map[string]string{"reason": reason})
}

func (c *HTTPClient) packageAction(ctx context.Context, packageID string, action string, payload any) error {
	var resp struct {
		Success bool   `json:"success"`
		Message string `json:"message"`
	}
	if err := c.post(ctx, "/internal/credit/packages/"+escapePath(packageID)+"/"+action, payload, &resp); err != nil {
		return err
	}
	if !resp.Success {
		return fmt.Errorf("credit package %s failed: %s", action, resp.Message)
	}
	return nil
}

func (c *HTTPClient) post(ctx context.Context, path string, payload any, out any) error {
	if c.baseURL == "" {
		return fmt.Errorf("credit base url is required")
	}
	var body io.Reader
	if payload != nil {
		data, err := json.Marshal(payload)
		if err != nil {
			return err
		}
		body = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+path, body)
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
		return fmt.Errorf("credit returned status %d: %s", resp.StatusCode, string(respBody))
	}
	return json.Unmarshal(respBody, out)
}

func escapePath(value string) string {
	return url.PathEscape(strings.TrimSpace(value))
}
