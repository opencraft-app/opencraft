package sms

import (
	"context"
	"fmt"
	"log/slog"
	"strings"

	"github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common"
	"github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common/profile"
	tencentsms "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/sms/v20210111"
)

type Config struct {
	SecretID   string
	SecretKey  string
	Region     string
	Endpoint   string
	SDKAppID   string
	SignName   string
	TemplateID string
}

type Client struct {
	client     *tencentsms.Client
	sdkAppID   string
	signName   string
	templateID string
	endpoint   string
	region     string
}

func New(cfg Config) (*Client, error) {
	if strings.TrimSpace(cfg.SecretID) == "" || strings.TrimSpace(cfg.SecretKey) == "" {
		return nil, fmt.Errorf("sms credentials are required")
	}
	if strings.TrimSpace(cfg.SDKAppID) == "" {
		return nil, fmt.Errorf("sms sdk app id is required")
	}
	if strings.TrimSpace(cfg.SignName) == "" {
		return nil, fmt.Errorf("sms sign name is required")
	}
	if strings.TrimSpace(cfg.TemplateID) == "" {
		return nil, fmt.Errorf("sms template id is required")
	}
	region := strings.TrimSpace(cfg.Region)
	if region == "" {
		region = "ap-guangzhou"
	}
	endpoint := strings.TrimSpace(cfg.Endpoint)
	if endpoint == "" {
		endpoint = "sms.internal.tencentcloudapi.com"
	}

	credential := common.NewCredential(strings.TrimSpace(cfg.SecretID), strings.TrimSpace(cfg.SecretKey))
	clientProfile := profile.NewClientProfile()
	clientProfile.HttpProfile.Endpoint = endpoint
	client, err := tencentsms.NewClient(credential, region, clientProfile)
	if err != nil {
		return nil, fmt.Errorf("create sms client: %w", err)
	}

	return &Client{
		client:     client,
		sdkAppID:   strings.TrimSpace(cfg.SDKAppID),
		signName:   strings.TrimSpace(cfg.SignName),
		templateID: strings.TrimSpace(cfg.TemplateID),
		endpoint:   endpoint,
		region:     region,
	}, nil
}

func (c *Client) SendVerificationCode(ctx context.Context, phone string, code string, expiryMinutes int) error {
	if c == nil || c.client == nil {
		return fmt.Errorf("sms client is not configured")
	}
	normalizedPhone := normalizePhone(phone)
	request := tencentsms.NewSendSmsRequest()
	request.SmsSdkAppId = common.StringPtr(c.sdkAppID)
	request.SignName = common.StringPtr(c.signName)
	request.TemplateId = common.StringPtr(c.templateID)
	request.PhoneNumberSet = common.StringPtrs([]string{normalizedPhone})
	request.TemplateParamSet = common.StringPtrs([]string{code, fmt.Sprintf("%d", expiryMinutes)})

	resp, err := c.client.SendSms(request)
	if err != nil {
		slog.WarnContext(ctx, "phone auth sms send failed",
			"phone", maskPhone(phone),
			"endpoint", c.endpoint,
			"region", c.region,
			"err", err,
		)
		return fmt.Errorf("send sms: %w", err)
	}
	if resp == nil || resp.Response == nil {
		return fmt.Errorf("send sms: empty response")
	}
	for _, status := range resp.Response.SendStatusSet {
		if status == nil {
			continue
		}
		codeValue := strings.TrimSpace(ptrStringValue(status.Code))
		if !strings.EqualFold(codeValue, "Ok") {
			message := strings.TrimSpace(ptrStringValue(status.Message))
			slog.WarnContext(ctx, "phone auth sms provider rejected request",
				"phone", maskPhone(phone),
				"endpoint", c.endpoint,
				"region", c.region,
				"provider_code", codeValue,
				"provider_message", message,
			)
			if message == "" {
				message = codeValue
			}
			return fmt.Errorf("send sms rejected: %s", message)
		}
	}
	slog.InfoContext(ctx, "phone auth sms sent",
		"phone", maskPhone(phone),
		"endpoint", c.endpoint,
		"region", c.region,
		"template_id", c.templateID,
	)
	return nil
}

func ptrStringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func normalizePhone(phone string) string {
	trimmed := strings.TrimSpace(phone)
	if strings.HasPrefix(trimmed, "+") {
		return trimmed
	}
	if strings.HasPrefix(trimmed, "86") {
		return "+" + trimmed
	}
	return "+86" + trimmed
}

func maskPhone(phone string) string {
	trimmed := strings.TrimSpace(phone)
	digits := strings.Map(func(r rune) rune {
		if r >= '0' && r <= '9' {
			return r
		}
		return -1
	}, trimmed)
	if len(digits) < 7 {
		return "***"
	}
	return digits[:3] + "****" + digits[len(digits)-4:]
}
