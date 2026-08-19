package paymentmethod

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common"
	tcerrors "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common/errors"
	tchttp "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common/http"
	"github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common/profile"
)

const (
	billingService = "billing"
	billingVersion = "2018-07-09"
)

type TemporaryCredentials struct {
	SecretID  string
	SecretKey string
	Token     string
	ExpiresAt time.Time
}

type Config struct {
	Endpoint       string
	Region         string
	Platform       string
	Source         string
	RequestTimeout time.Duration
	HTTPTransport  http.RoundTripper
}

type Client interface {
	List(ctx context.Context, credentials TemporaryCredentials, input ListInput) (ListResult, error)
	CreateSignOrder(ctx context.Context, credentials TemporaryCredentials, input CreateSignOrderInput) (CreateSignOrderResult, error)
	SetDefault(ctx context.Context, credentials TemporaryCredentials, contractCode string) error
	Delete(ctx context.Context, credentials TemporaryCredentials, contractCode string) error
}

type PaymentMethod struct {
	ContractCode string
	MaskedNumber string
	PayerName    string
	Type         string
	IsDefault    bool
}

type ListInput struct {
	Page     int
	PageSize int
}

type ListResult struct {
	Total     int
	Items     []PaymentMethod
	RequestID string
}

type CreateSignOrderInput struct {
	ReturnURL    string
	CancelURL    string
	LanguageCode string
}

type CreateSignOrderResult struct {
	ContractCode string
	RedirectURL  string
	RequestID    string
}

type CloudError struct {
	Code      string
	Message   string
	RequestID string
}

func (e *CloudError) Error() string {
	if e == nil {
		return ""
	}
	if e.Code == "" {
		return e.Message
	}
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

func IsDefaultCardDeleteError(err error) bool {
	var cloudErr *CloudError
	return errors.As(err, &cloudErr) && cloudErr.Code == "FailedOperation.DefaultCardNoDelete"
}

type TencentCloudClient struct {
	endpoint  string
	region    string
	platform  string
	source    string
	timeout   time.Duration
	transport http.RoundTripper
}

func NewTencentCloudClient(cfg Config) (*TencentCloudClient, error) {
	endpoint := strings.TrimSpace(cfg.Endpoint)
	if endpoint == "" {
		return nil, errors.New("payment method billing endpoint is required")
	}
	region := strings.TrimSpace(cfg.Region)
	if region == "" {
		region = "ap-guangzhou"
	}
	platform := strings.TrimSpace(cfg.Platform)
	if platform == "" {
		return nil, errors.New("payment method platform is required")
	}
	source := strings.TrimSpace(cfg.Source)
	if source == "" {
		source = "REGISTER"
	}
	timeout := cfg.RequestTimeout
	if timeout <= 0 {
		timeout = 15 * time.Second
	}
	transport := cfg.HTTPTransport
	if transport == nil {
		transport = http.DefaultTransport
	}
	return &TencentCloudClient{
		endpoint:  endpoint,
		region:    region,
		platform:  platform,
		source:    source,
		timeout:   timeout,
		transport: transport,
	}, nil
}

func (c *TencentCloudClient) List(ctx context.Context, credentials TemporaryCredentials, input ListInput) (ListResult, error) {
	if input.Page < 1 || input.PageSize < 1 || input.PageSize > 100 {
		return ListResult{}, errors.New("invalid payment method pagination")
	}
	var payload struct {
		Response struct {
			Total    int `json:"Total"`
			SignList []struct {
				ContractCode string `json:"ContractCode"`
				Extend       string `json:"Extend"`
				IsDefault    int    `json:"IsDefault"`
				PayerName    string `json:"PayerName"`
				Type         string `json:"Type"`
			} `json:"SignList"`
			RequestID string `json:"RequestId"`
		} `json:"Response"`
	}
	if err := c.send(ctx, credentials, "DescribeSignInfo", map[string]any{
		"Page":     input.Page,
		"PageSize": input.PageSize,
	}, &payload); err != nil {
		return ListResult{}, err
	}
	result := ListResult{Total: payload.Response.Total, RequestID: strings.TrimSpace(payload.Response.RequestID)}
	result.Items = make([]PaymentMethod, 0, len(payload.Response.SignList))
	for _, item := range payload.Response.SignList {
		result.Items = append(result.Items, PaymentMethod{
			ContractCode: strings.TrimSpace(item.ContractCode),
			MaskedNumber: strings.TrimSpace(item.Extend),
			PayerName:    strings.TrimSpace(item.PayerName),
			Type:         strings.TrimSpace(item.Type),
			IsDefault:    item.IsDefault == 1,
		})
	}
	return result, nil
}

func (c *TencentCloudClient) CreateSignOrder(ctx context.Context, credentials TemporaryCredentials, input CreateSignOrderInput) (CreateSignOrderResult, error) {
	if err := validateHTTPSURL(input.ReturnURL); err != nil {
		return CreateSignOrderResult{}, fmt.Errorf("invalid return url: %w", err)
	}
	if err := validateHTTPSURL(input.CancelURL); err != nil {
		return CreateSignOrderResult{}, fmt.Errorf("invalid cancel url: %w", err)
	}
	languageCode := strings.TrimSpace(input.LanguageCode)
	if languageCode == "" {
		languageCode = "en"
	}
	var payload struct {
		Response struct {
			SignOrder    string `json:"SignOrder"`
			ContractCode string `json:"ContractCode"`
			RequestID    string `json:"RequestId"`
		} `json:"Response"`
	}
	if err := c.send(ctx, credentials, "CreateSignOrder", map[string]any{
		"Source":       c.source,
		"ReturnUrl":    strings.TrimSpace(input.ReturnURL),
		"CancelUrl":    strings.TrimSpace(input.CancelURL),
		"LanguageCode": languageCode,
	}, &payload); err != nil {
		return CreateSignOrderResult{}, err
	}
	redirectURL, err := paymentLink(payload.Response.SignOrder)
	if err != nil {
		return CreateSignOrderResult{}, err
	}
	contractCode := strings.TrimSpace(payload.Response.ContractCode)
	if contractCode == "" {
		return CreateSignOrderResult{}, errors.New("CreateSignOrder returned empty contract code")
	}
	return CreateSignOrderResult{
		ContractCode: contractCode,
		RedirectURL:  redirectURL,
		RequestID:    strings.TrimSpace(payload.Response.RequestID),
	}, nil
}

func (c *TencentCloudClient) SetDefault(ctx context.Context, credentials TemporaryCredentials, contractCode string) error {
	contractCode = strings.TrimSpace(contractCode)
	if contractCode == "" {
		return errors.New("payment method contract code is required")
	}
	var payload any
	return c.send(ctx, credentials, "ModifySignInfo", map[string]any{"ContractCode": contractCode}, &payload)
}

func (c *TencentCloudClient) Delete(ctx context.Context, credentials TemporaryCredentials, contractCode string) error {
	contractCode = strings.TrimSpace(contractCode)
	if contractCode == "" {
		return errors.New("payment method contract code is required")
	}
	var payload any
	return c.send(ctx, credentials, "DeleteSignInfo", map[string]any{"ContractCode": contractCode}, &payload)
}

func (c *TencentCloudClient) send(ctx context.Context, credentials TemporaryCredentials, action string, params map[string]any, out any) error {
	if c == nil || c.transport == nil {
		return errors.New("payment method billing client is not configured")
	}
	secretID := strings.TrimSpace(credentials.SecretID)
	secretKey := strings.TrimSpace(credentials.SecretKey)
	token := strings.TrimSpace(credentials.Token)
	if secretID == "" || secretKey == "" || token == "" {
		return errors.New("payment method temporary credentials are incomplete")
	}
	if !credentials.ExpiresAt.IsZero() && !credentials.ExpiresAt.After(time.Now()) {
		return errors.New("payment method temporary credentials are expired")
	}

	requestParams := make(map[string]any, len(params)+1)
	for key, value := range params {
		requestParams[key] = value
	}
	requestParams["Platform"] = c.platform

	request := tchttp.NewCommonRequest(billingService, billingVersion, action)
	request.SetContext(ctx)
	if err := request.SetActionParameters(requestParams); err != nil {
		return fmt.Errorf("set %s parameters: %w", action, err)
	}

	client := common.NewCommonClient(common.NewTokenCredential(secretID, secretKey, token), c.region, c.profile())
	client.WithHttpTransport(c.transport)
	response := tchttp.NewCommonResponse()
	if err := client.Send(request, response); err != nil {
		return cloudError(err)
	}
	if err := json.Unmarshal(response.GetBody(), out); err != nil {
		return fmt.Errorf("decode %s response: %w", action, err)
	}
	return nil
}

func (c *TencentCloudClient) profile() *profile.ClientProfile {
	cp := profile.NewClientProfile()
	cp.HttpProfile.Endpoint = c.endpoint
	cp.HttpProfile.ReqMethod = http.MethodPost
	cp.HttpProfile.ReqTimeout = int(c.timeout / time.Second)
	if cp.HttpProfile.ReqTimeout < 1 {
		cp.HttpProfile.ReqTimeout = 1
	}
	return cp
}

func cloudError(err error) error {
	var sdkErr *tcerrors.TencentCloudSDKError
	if errors.As(err, &sdkErr) {
		return &CloudError{
			Code:      strings.TrimSpace(sdkErr.GetCode()),
			Message:   strings.TrimSpace(sdkErr.GetMessage()),
			RequestID: strings.TrimSpace(sdkErr.GetRequestId()),
		}
	}
	return err
}

func paymentLink(raw string) (string, error) {
	var order struct {
		Links []struct {
			Rel  string `json:"rel"`
			Href string `json:"href"`
		} `json:"links"`
	}
	if err := json.Unmarshal([]byte(raw), &order); err != nil {
		return "", fmt.Errorf("decode CreateSignOrder sign order: %w", err)
	}
	for _, link := range order.Links {
		if !strings.EqualFold(strings.TrimSpace(link.Rel), "PAYMENT") {
			continue
		}
		redirectURL := strings.TrimSpace(link.Href)
		if err := validateHTTPSURL(redirectURL); err != nil {
			return "", fmt.Errorf("invalid CreateSignOrder payment link: %w", err)
		}
		return redirectURL, nil
	}
	return "", errors.New("CreateSignOrder returned no payment link")
}

func validateHTTPSURL(raw string) error {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return err
	}
	if parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil {
		return errors.New("absolute https URL is required")
	}
	return nil
}
