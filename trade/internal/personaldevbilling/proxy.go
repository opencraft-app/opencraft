package personaldevbilling

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"git.woa.com/wisp/mono/trade/internal/cloudbillingclient"
	"git.woa.com/wisp/mono/trade/internal/cloudladderauth"
	"git.woa.com/wisp/mono/trade/internal/jifeiclient"
)

const (
	OriginalAuthorizationHeader = "X-LightVela-Developer-Original-Authorization"
	DeveloperUINHeader          = "X-LightVela-Developer-UIN"
	maxResponseBody             = int64(1 << 20)
	requestTimeout              = 30 * time.Second
)

type Config struct {
	JifeiURL               string
	JifeiAppID             string
	JifeiAppSecret         string
	JifeiXQCloudUserID     string
	JifeiCloudLadderSecret string

	CloudAPIEndpoint          string
	CloudAPIGatewayURL        string
	CloudAPIRouteID           string
	CloudAPICloudLadderSecret string
	CloudAPIXQCloudUserID     string

	HTTPTransport http.RoundTripper
	Now           func() time.Time
	Nonce         func() string
}

type Proxy struct {
	jifeiURL           *url.URL
	jifeiAppID         string
	jifeiAppSecret     string
	jifeiXQCloudUserID string
	jifeiCloudSecret   string
	jifeiClient        *http.Client
	cloudAPIEndpoint   string
	cloudAPIXQCloudID  string
	cloudAPIClient     *http.Client
	now                func() time.Time
	nonce              func() string
}

type Response struct {
	StatusCode int
	Header     http.Header
	Body       []byte
}

func New(config Config) (*Proxy, error) {
	jifeiURL, err := url.Parse(strings.TrimSpace(config.JifeiURL))
	if err != nil || jifeiURL.Scheme == "" || jifeiURL.Host == "" {
		return nil, errors.New("personal DevCloud billing proxy requires JIFEI_BILLING_APIGW_URL")
	}
	for name, value := range map[string]string{
		"JIFEI_BILLING_APP_ID":     config.JifeiAppID,
		"JIFEI_BILLING_APP_SECRET": config.JifeiAppSecret,
	} {
		if strings.TrimSpace(value) == "" {
			return nil, fmt.Errorf("personal DevCloud billing proxy requires %s", name)
		}
	}
	base := config.HTTPTransport
	if base == nil {
		base = http.DefaultTransport
	}
	var cloudAPIClient *http.Client
	cloudAPIConfigured := strings.TrimSpace(config.CloudAPIGatewayURL) != "" || strings.TrimSpace(config.CloudAPICloudLadderSecret) != ""
	if cloudAPIConfigured {
		for name, value := range map[string]string{
			"TRADE_BILLING_ENDPOINT":                     config.CloudAPIEndpoint,
			"TRADE_BILLING_CLOUDLADDER_GATEWAY_BASE_URL": config.CloudAPIGatewayURL,
			"TRADE_BILLING_CLOUDLADDER_ROUTE_ID":         config.CloudAPIRouteID,
			"TRADE_BILLING_CLOUDLADDER_HMAC_SECRET":      config.CloudAPICloudLadderSecret,
			"TRADE_BILLING_X_QCLOUD_USER_ID":             config.CloudAPIXQCloudUserID,
		} {
			if strings.TrimSpace(value) == "" {
				return nil, fmt.Errorf("personal DevCloud CloudAPI proxy requires %s", name)
			}
		}
		cloudTransport, err := cloudbillingclient.NewCloudLadderTransport(cloudbillingclient.CloudLadderConfig{
			GatewayBaseURL: config.CloudAPIGatewayURL,
			RouteID:        config.CloudAPIRouteID,
			Secret:         config.CloudAPICloudLadderSecret,
		}, base)
		if err != nil {
			return nil, fmt.Errorf("configure central billing CloudAPI transport: %w", err)
		}
		cloudAPIClient = &http.Client{Transport: cloudTransport, Timeout: requestTimeout}
	}
	now := config.Now
	if now == nil {
		now = time.Now
	}
	nonce := config.Nonce
	if nonce == nil {
		nonce = randomToken
	}
	return &Proxy{
		jifeiURL:           jifeiURL,
		jifeiAppID:         strings.TrimSpace(config.JifeiAppID),
		jifeiAppSecret:     strings.TrimSpace(config.JifeiAppSecret),
		jifeiXQCloudUserID: strings.TrimSpace(config.JifeiXQCloudUserID),
		jifeiCloudSecret:   strings.TrimSpace(config.JifeiCloudLadderSecret),
		jifeiClient:        &http.Client{Transport: base, Timeout: requestTimeout},
		cloudAPIEndpoint:   strings.TrimSpace(config.CloudAPIEndpoint),
		cloudAPIXQCloudID:  strings.TrimSpace(config.CloudAPIXQCloudUserID),
		cloudAPIClient:     cloudAPIClient,
		now:                now,
		nonce:              nonce,
	}, nil
}

func (p *Proxy) Forward(ctx context.Context, kind, path, rawQuery, uin string, headers http.Header, body []byte) (*Response, error) {
	if p == nil {
		return nil, errors.New("personal DevCloud billing proxy is disabled")
	}
	uin = strings.TrimSpace(uin)
	value, err := strconv.ParseUint(uin, 10, 64)
	if err != nil || value == 0 || strconv.FormatUint(value, 10) != uin {
		return nil, errors.New("personal DevCloud capability UIN is invalid")
	}
	switch strings.ToLower(strings.TrimSpace(kind)) {
	case "jifei":
		if path != "/resource-center/interface" {
			return nil, errors.New("jifei proxy path is not allowed")
		}
		return p.forwardJifei(ctx, uin, body)
	case "cloudapi":
		if path != "/" {
			return nil, errors.New("billing CloudAPI proxy path is not allowed")
		}
		return p.forwardCloudAPI(ctx, rawQuery, uin, headers, body)
	default:
		return nil, errors.New("billing proxy kind is not allowed")
	}
}

func (p *Proxy) forwardJifei(ctx context.Context, uin string, body []byte) (*Response, error) {
	signed, err := jifeiclient.ResignPersonalDevModifyResourceStatusEnvelope(
		body, uin, p.jifeiAppID, p.jifeiAppSecret, p.now(), p.nonce(),
	)
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, p.jifeiURL.String(), bytes.NewReader(signed))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	if p.jifeiXQCloudUserID != "" {
		request.Header.Set("X-Qcloud-User-Id", p.jifeiXQCloudUserID)
	}
	if p.jifeiCloudSecret != "" {
		if err := cloudladderauth.SignProxyURLHeaders(
			p.jifeiCloudSecret, "lightvela-trade", request.Header, request.Method, request.URL, signed, p.now(),
		); err != nil {
			return nil, err
		}
	}
	request.Header.Set("X-QCloud-Transaction-ID", randomTransactionID())
	request.Header.Set("X-QCloud-Component-ID", "lightvela-trade")
	return do(p.jifeiClient, request)
}

func (p *Proxy) forwardCloudAPI(ctx context.Context, rawQuery, uin string, headers http.Header, body []byte) (*Response, error) {
	if p.cloudAPIClient == nil {
		return nil, errors.New("personal DevCloud billing CloudAPI proxy is not configured")
	}
	action := strings.TrimSpace(headers.Get("X-TC-Action"))
	if action != "CreatePayUrl" && action != "DescribeOrderList" {
		return nil, errors.New("billing CloudAPI action is not allowed")
	}
	query, err := url.ParseQuery(rawQuery)
	queryActions := query["Action"]
	if err != nil || len(queryActions) != 1 || strings.TrimSpace(queryActions[0]) != action {
		return nil, errors.New("billing CloudAPI query action mismatch")
	}
	if strings.TrimSpace(headers.Get("X-Qcloud-User-Id")) != "" {
		return nil, errors.New("billing CloudAPI route UIN must be injected centrally")
	}
	originalAuthorization := strings.TrimSpace(headers.Get(OriginalAuthorizationHeader))
	if originalAuthorization == "" {
		return nil, errors.New("billing CloudAPI TC3 authorization is missing")
	}
	target := &url.URL{Scheme: "https", Host: p.cloudAPIEndpoint, Path: "/", RawQuery: rawQuery}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, target.String(), bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	for _, name := range []string{"Content-Type", "X-TC-Action", "X-TC-Version", "X-TC-Region", "X-TC-Timestamp", "X-TC-Token", "X-Qcloud-User-Id"} {
		if value := strings.TrimSpace(headers.Get(name)); value != "" {
			request.Header.Set(name, value)
		}
	}
	request.Header.Set("Authorization", originalAuthorization)
	request.Header.Set("X-Qcloud-User-Id", p.cloudAPIXQCloudID)
	return do(p.cloudAPIClient, request)
}

func do(client *http.Client, request *http.Request) (*Response, error) {
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBody+1))
	if err != nil || int64(len(body)) > maxResponseBody {
		return nil, errors.New("billing proxy response is invalid")
	}
	return &Response{StatusCode: response.StatusCode, Header: response.Header.Clone(), Body: body}, nil
}

func randomToken() string {
	var value [8]byte
	if _, err := rand.Read(value[:]); err != nil {
		return fmt.Sprintf("%x", time.Now().UnixNano())
	}
	return hex.EncodeToString(value[:])
}

func randomTransactionID() string {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return fmt.Sprintf("%032x", time.Now().UnixNano())
	}
	return hex.EncodeToString(value[:])
}
