package resourcebillingclient

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

type Request struct {
	CID      string                `json:"cid"`
	CalcDate string                `json:"calcDate"`
	Data     map[string][]Resource `json:"data"`
}

type Resource struct {
	SerialID       string `json:"serialId"`
	OrderID        string `json:"orderId"`
	Uin            string `json:"uin"`
	AppID          int64  `json:"appId"`
	RegionID       int    `json:"regionId"`
	ZoneID         int    `json:"zoneId"`
	PayMode        int    `json:"payMode"`
	Platform       int    `json:"platform"`
	ProjectID      int    `json:"projectId"`
	CalcNum        int    `json:"calcNum"`
	TimeSpan       int    `json:"timeSpan"`
	Pid            int64  `json:"pid"`
	ProductCode    string `json:"productCode"`
	SubProductCode string `json:"subProductCode"`
	Params         string `json:"params"`
	Parts          string `json:"parts"`
	CalcDate       string `json:"calcDate"`
	StartTime      string `json:"startTime"`
	EndTime        string `json:"endTime"`
	DataStatus     string `json:"dataStatus"`
}

type ResourceCount struct {
	ReceivedCount  int `json:"receivedCount"`
	TotalCount     int `json:"totalCount"`
	SuccCount      int `json:"succCount"`
	DuplicateCount int `json:"duplicateCount"`
}

type Response struct {
	RetCode    int    `json:"retCode"`
	ReturnCode int    `json:"returnCode"`
	Message    string `json:"msg"`
	Data       struct {
		ResourceCount ResourceCount `json:"resourceCnt"`
	} `json:"data"`
}

type Client interface {
	SendResource(context.Context, Request) (*Response, error)
}

type HTTPClient struct {
	endpoint string
	host     string
	client   *http.Client
}

func New(endpoint, host string, client *http.Client) *HTTPClient {
	if client == nil {
		client = &http.Client{Timeout: 3 * time.Second}
	}
	return &HTTPClient{endpoint: strings.TrimSpace(endpoint), host: strings.TrimSpace(host), client: client}
}

func (c *HTTPClient) SendResource(ctx context.Context, request Request) (*Response, error) {
	if c.endpoint == "" {
		return nil, fmt.Errorf("sendResource endpoint is required")
	}
	payload, err := json.Marshal(request)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if c.host != "" {
		req.Host = c.host
	}
	resp, err := c.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("sendResource returned HTTP %d: %s", resp.StatusCode, string(body))
	}
	var out Response
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("decode sendResource response: %w", err)
	}
	if out.RetCode != 0 || out.ReturnCode != 0 {
		return nil, fmt.Errorf("sendResource failed: retCode=%d returnCode=%d msg=%s", out.RetCode, out.ReturnCode, out.Message)
	}
	count := out.Data.ResourceCount
	if count.TotalCount == 0 || count.SuccCount+count.DuplicateCount < count.TotalCount {
		return nil, fmt.Errorf("sendResource incomplete: received=%d total=%d success=%d duplicate=%d",
			count.ReceivedCount, count.TotalCount, count.SuccCount, count.DuplicateCount)
	}
	return &out, nil
}
