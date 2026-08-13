// Package cloudbillingclient wraps Tencent Cloud Billing CloudAPI calls used by trade.
package cloudbillingclient

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	neturl "net/url"
	"strings"
	"time"

	"github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common"
	tchttp "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common/http"
	"github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common/profile"
)

const (
	defaultBillingRegion   = "ap-guangzhou"
	defaultBillingEndpoint = "billing.tencentcloudapi.com"
	defaultRequestTimeout  = 10 * time.Second
	headerXQCloudUserID    = "X-Qcloud-User-Id"
)

// Client is the CloudAPI surface used by placeorder.
type Client interface {
	DescribeOrderList(ctx context.Context, credentials TemporaryCredentials, req *DescribeOrderListRequest) (*DescribeOrderListResponse, error)
	CreatePayURL(ctx context.Context, credentials TemporaryCredentials, req *CreatePayURLRequest) (*CreatePayURLResponse, error)
}

type Config struct {
	XQCloudUserID  string
	Region         string
	Endpoint       string
	RequestTimeout time.Duration
	CloudLadder    CloudLadderConfig
	HTTPTransport  http.RoundTripper
}

type CloudLadderConfig struct {
	Enabled        bool
	GatewayBaseURL string
	RouteID        string
	Caller         string
	Secret         string
}

type TencentCloudClient struct {
	region        string
	endpoint      string
	timeout       time.Duration
	transport     http.RoundTripper
	xQCloudUserID string
}

type TemporaryCredentials struct {
	SecretID  string
	SecretKey string
	Token     string
}

func NewTencentCloudClient(cfg Config) (*TencentCloudClient, error) {
	region := strings.TrimSpace(cfg.Region)
	if region == "" {
		region = defaultBillingRegion
	}
	endpoint := strings.TrimSpace(cfg.Endpoint)
	if endpoint == "" {
		endpoint = defaultBillingEndpoint
	}
	timeout := cfg.RequestTimeout
	if timeout <= 0 {
		timeout = defaultRequestTimeout
	}

	baseTransport := cfg.HTTPTransport
	if baseTransport == nil {
		baseTransport = http.DefaultTransport
	}
	transport, err := newCloudLadderTransport(cfg.CloudLadder, baseTransport)
	if err != nil {
		return nil, err
	}
	return &TencentCloudClient{
		region:        region,
		endpoint:      endpoint,
		timeout:       timeout,
		transport:     transport,
		xQCloudUserID: strings.TrimSpace(cfg.XQCloudUserID),
	}, nil
}

func newCloudLadderTransport(cfg CloudLadderConfig, base http.RoundTripper) (http.RoundTripper, error) {
	if !cfg.Enabled {
		if base != nil {
			return base, nil
		}
		return http.DefaultTransport, nil
	}
	return newCloudLadderRoundTripper(cloudLadderTransportOptions{
		gatewayBaseURL: cfg.GatewayBaseURL,
		routeID:        cfg.RouteID,
		caller:         cfg.Caller,
		secret:         cfg.Secret,
		base:           base,
	})
}

type CreatePayURLRequest struct {
	OrderIDs      []string
	ChargeAmount  int64
	Platform      string
	ContractOrder int
	CancelURL     string
	ReturnURL     string
	PayScene      string
	PayOption     string
	Application   string
}

type CreatePayURLResponse struct {
	URL       string
	RequestID string
}

func (c *TencentCloudClient) CreatePayURL(ctx context.Context, credentials TemporaryCredentials, in *CreatePayURLRequest) (*CreatePayURLResponse, error) {
	if c == nil || c.transport == nil {
		return nil, fmt.Errorf("billing tencentcloud client is not configured")
	}
	secretID := strings.TrimSpace(credentials.SecretID)
	secretKey := strings.TrimSpace(credentials.SecretKey)
	token := strings.TrimSpace(credentials.Token)
	if secretID == "" || secretKey == "" || token == "" {
		return nil, errors.New("billing temporary credentials are incomplete")
	}
	req, err := newCreatePayURLCommonRequest(ctx, in, c.xQCloudUserID)
	if err != nil {
		return nil, err
	}
	cpf := profile.NewClientProfile()
	cpf.HttpProfile.Endpoint = c.endpoint
	cpf.HttpProfile.ReqTimeout = int(c.timeout / time.Second)
	if cpf.HttpProfile.ReqTimeout < 1 {
		cpf.HttpProfile.ReqTimeout = 1
	}
	client := common.NewCommonClient(common.NewTokenCredential(secretID, secretKey, token), c.region, cpf)
	client.WithHttpTransport(c.transport)
	resp := tchttp.NewCommonResponse()
	if err := client.Send(req, resp); err != nil {
		return nil, fmt.Errorf("send CreatePayUrl: %w", err)
	}
	var payload struct {
		Response struct {
			URL       string `json:"Url"`
			RequestID string `json:"RequestId"`
		} `json:"Response"`
	}
	if err := json.Unmarshal(resp.GetBody(), &payload); err != nil {
		return nil, fmt.Errorf("decode CreatePayUrl response: %w", err)
	}
	if strings.TrimSpace(payload.Response.URL) == "" {
		return nil, fmt.Errorf("CreatePayUrl returned empty url, requestId=%s", payload.Response.RequestID)
	}
	return &CreatePayURLResponse{
		URL:       normalizePayURL(payload.Response.URL),
		RequestID: strings.TrimSpace(payload.Response.RequestID),
	}, nil
}

func NewCreatePayURLCommonRequest(ctx context.Context, in *CreatePayURLRequest) (*tchttp.CommonRequest, error) {
	return newCreatePayURLCommonRequest(ctx, in, "")
}

func newCreatePayURLCommonRequest(
	ctx context.Context,
	in *CreatePayURLRequest,
	xQCloudUserID string,
) (*tchttp.CommonRequest, error) {
	params, err := createPayURLParams(in)
	if err != nil {
		return nil, err
	}
	req := tchttp.NewCommonRequest("billing", "2018-07-09", "CreatePayUrl")
	if err := req.SetActionParameters(params); err != nil {
		return nil, fmt.Errorf("set CreatePayUrl parameters: %w", err)
	}
	if value := strings.TrimSpace(xQCloudUserID); value != "" {
		req.SetHeader(map[string]string{headerXQCloudUserID: value})
	}
	req.SetContext(ctx)
	return req, nil
}

func createPayURLParams(in *CreatePayURLRequest) (map[string]any, error) {
	if in == nil {
		return nil, errors.New("CreatePayUrl request is required")
	}
	orderIDs := make([]string, 0, len(in.OrderIDs))
	for _, id := range in.OrderIDs {
		if v := strings.TrimSpace(id); v != "" {
			orderIDs = append(orderIDs, v)
		}
	}
	if len(orderIDs) == 0 {
		return nil, errors.New("CreatePayUrl OrderIds is required")
	}
	params := map[string]any{"OrderIds": orderIDs}
	if in.ChargeAmount > 0 {
		params["ChargeAmount"] = in.ChargeAmount
	}
	if v := strings.TrimSpace(in.Platform); v != "" {
		params["Platform"] = v
	}
	if in.ContractOrder != 0 {
		params["ContractOrder"] = in.ContractOrder
	}
	if v := strings.TrimSpace(in.CancelURL); v != "" {
		params["CancelUrl"] = v
	}
	if v := strings.TrimSpace(in.ReturnURL); v != "" {
		params["ReturnUrl"] = v
	}
	if v := strings.TrimSpace(in.PayScene); v != "" {
		params["PayScene"] = v
	}
	if v := strings.TrimSpace(in.PayOption); v != "" {
		if strings.EqualFold(v, "chargePay") && in.ChargeAmount <= 0 {
			return nil, errors.New("CreatePayUrl ChargeAmount must be > 0 when PayOption is chargePay")
		}
		params["PayOption"] = v
	}
	if v := strings.TrimSpace(in.Application); v != "" {
		params["Application"] = v
	}
	return params, nil
}

func normalizePayURL(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	u, err := neturl.Parse(trimmed)
	if err == nil && u.IsAbs() {
		return trimmed
	}
	if strings.HasPrefix(trimmed, "/") {
		return "https://buy.cloud.tencent.com" + trimmed
	}
	return trimmed
}
