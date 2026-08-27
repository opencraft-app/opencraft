package shadowbinding

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common"
	tchttp "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common/http"
)

type TencentCloudBillingConfig struct {
	SecretID       string
	SecretKey      string
	Region         string
	Endpoint       string
	RequestTimeout time.Duration
	CloudLadder    CloudLadderConfig
}

type TencentCloudBillingClient struct {
	client *common.Client
}

func NewTencentCloudBillingClient(cfg TencentCloudBillingConfig) (*TencentCloudBillingClient, error) {
	secretID := strings.TrimSpace(cfg.SecretID)
	secretKey := strings.TrimSpace(cfg.SecretKey)
	if secretID == "" || secretKey == "" {
		return nil, fmt.Errorf("shadow billing tencentcloud secret id/key are required")
	}
	region := strings.TrimSpace(cfg.Region)
	if region == "" {
		region = "ap-guangzhou"
	}
	endpoint := strings.TrimSpace(cfg.Endpoint)
	if endpoint == "" {
		endpoint = "billing.tencentcloudapi.com"
	}
	timeout := cfg.RequestTimeout
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	client, err := newCommonClient(
		common.NewCredential(secretID, secretKey),
		region,
		clientProfile(endpoint, timeout),
		cfg.CloudLadder,
		cfg.CloudLadder.RouteID,
	)
	if err != nil {
		return nil, err
	}
	return &TencentCloudBillingClient{client: client}, nil
}

func (c *TencentCloudBillingClient) Available() bool {
	return c != nil && c.client != nil
}

func (c *TencentCloudBillingClient) EnsureBillingAccount(ctx context.Context, uin int64) (BillingAccountResult, error) {
	if !c.Available() {
		return BillingAccountResult{}, fmt.Errorf("shadow billing tencentcloud client is not configured")
	}
	req, err := newBillingAccountRequest(ctx, uin)
	if err != nil {
		return BillingAccountResult{}, err
	}
	resp := tchttp.NewCommonResponse()
	if err := c.client.Send(req, resp); err != nil {
		return BillingAccountResult{}, fmt.Errorf("send DescribeBillingAccountInner: %w", err)
	}
	var payload struct {
		Response struct {
			IsOpen    bool   `json:"IsOpen"`
			RequestID string `json:"RequestId"`
		} `json:"Response"`
	}
	if err := json.Unmarshal(resp.GetBody(), &payload); err != nil {
		return BillingAccountResult{}, fmt.Errorf("decode DescribeBillingAccountInner response: %w", err)
	}
	return BillingAccountResult{
		IsOpen:    payload.Response.IsOpen,
		RequestID: strings.TrimSpace(payload.Response.RequestID),
	}, nil
}

func newBillingAccountRequest(ctx context.Context, uin int64) (*tchttp.CommonRequest, error) {
	if uin <= 0 {
		return nil, fmt.Errorf("shadow billing target uin is required")
	}
	req := tchttp.NewCommonRequest("billing", "2018-07-09", "DescribeBillingAccountInner")
	if err := req.SetActionParameters(map[string]any{
		"IsAutoOpenAccount": 1,
		"QueryUin":          fmt.Sprintf("%d", uin),
	}); err != nil {
		return nil, fmt.Errorf("set DescribeBillingAccountInner parameters: %w", err)
	}
	req.SetContext(ctx)
	return req, nil
}
