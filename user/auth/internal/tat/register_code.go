package tat

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common"
	tchttp "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common/http"
	"github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common/profile"
)

const (
	defaultEndpoint      = "tat.tencentcloudapi.com"
	defaultRegion        = "ap-guangzhou"
	defaultEffectiveTime = int64(24)
)

type RegisterCodeIssuer interface {
	CreateRegisterCode(ctx context.Context, input CreateRegisterCodeInput) (RegisterCode, error)
}

type Config struct {
	SecretID           string
	SecretKey          string
	Region             string
	Endpoint           string
	EffectiveTimeHours int64
	InstanceNamePrefix string
	IpAddressRange     string
}

type CreateRegisterCodeInput struct {
	Description        string
	InstanceNamePrefix string
	RegisterLimit      int64
	EffectiveTimeHours int64
	IpAddressRange     string
}

type RegisterCode struct {
	Region             string
	RegisterCodeID     string
	RegisterCodeValue  string
	RequestID          string
	EffectiveTimeHours int64
}

type Client struct {
	client             *common.Client
	region             string
	effectiveTimeHours int64
	instanceNamePrefix string
	ipAddressRange     string
}

func New(cfg Config) (*Client, error) {
	secretID := strings.TrimSpace(cfg.SecretID)
	secretKey := strings.TrimSpace(cfg.SecretKey)
	if secretID == "" || secretKey == "" {
		return nil, fmt.Errorf("missing Tencent Cloud TAT credentials")
	}

	region := strings.TrimSpace(cfg.Region)
	if region == "" {
		region = defaultRegion
	}
	endpoint := strings.TrimSpace(cfg.Endpoint)
	if endpoint == "" {
		endpoint = defaultEndpoint
	}
	effectiveTimeHours := cfg.EffectiveTimeHours
	if effectiveTimeHours <= 0 {
		effectiveTimeHours = defaultEffectiveTime
	}

	credential := common.NewCredential(secretID, secretKey)
	cpf := profile.NewClientProfile()
	cpf.HttpProfile.Endpoint = endpoint
	return &Client{
		client:             common.NewCommonClient(credential, region, cpf),
		region:             region,
		effectiveTimeHours: effectiveTimeHours,
		instanceNamePrefix: trimMax(strings.TrimSpace(cfg.InstanceNamePrefix), 32),
		ipAddressRange:     strings.TrimSpace(cfg.IpAddressRange),
	}, nil
}

func (c *Client) CreateRegisterCode(ctx context.Context, input CreateRegisterCodeInput) (RegisterCode, error) {
	if c == nil || c.client == nil {
		return RegisterCode{}, fmt.Errorf("Tencent Cloud TAT client is not configured")
	}

	params := map[string]interface{}{
		"RegisterLimit": 1,
		"EffectiveTime": c.effectiveTimeHours,
	}
	if description := trimMax(strings.TrimSpace(input.Description), 128); description != "" {
		params["Description"] = description
	}
	if prefix := firstNonEmpty(trimMax(strings.TrimSpace(input.InstanceNamePrefix), 32), c.instanceNamePrefix); prefix != "" {
		params["InstanceNamePrefix"] = prefix
	}
	if input.RegisterLimit > 0 {
		params["RegisterLimit"] = input.RegisterLimit
	}
	if input.EffectiveTimeHours > 0 {
		params["EffectiveTime"] = input.EffectiveTimeHours
	}
	if ipRange := firstNonEmpty(strings.TrimSpace(input.IpAddressRange), c.ipAddressRange); ipRange != "" {
		params["IpAddressRange"] = ipRange
	}

	request := tchttp.NewCommonRequest("tat", "2020-10-28", "CreateRegisterCode")
	if err := request.SetActionParameters(params); err != nil {
		return RegisterCode{}, fmt.Errorf("set CreateRegisterCode parameters: %w", err)
	}
	request.SetContext(ctx)

	response := tchttp.NewCommonResponse()
	if err := c.client.Send(request, response); err != nil {
		return RegisterCode{}, fmt.Errorf("send CreateRegisterCode request: %w", err)
	}

	var payload struct {
		Response struct {
			RegisterCodeID    string `json:"RegisterCodeId"`
			RegisterCodeValue string `json:"RegisterCodeValue"`
			RequestID         string `json:"RequestId"`
		} `json:"Response"`
	}
	if err := json.Unmarshal(response.GetBody(), &payload); err != nil {
		return RegisterCode{}, fmt.Errorf("decode CreateRegisterCode response: %w", err)
	}
	if payload.Response.RegisterCodeID == "" || payload.Response.RegisterCodeValue == "" {
		return RegisterCode{}, fmt.Errorf("CreateRegisterCode returned incomplete registration code")
	}

	effectiveTimeHours, _ := params["EffectiveTime"].(int64)
	return RegisterCode{
		Region:             c.region,
		RegisterCodeID:     payload.Response.RegisterCodeID,
		RegisterCodeValue:  payload.Response.RegisterCodeValue,
		RequestID:          payload.Response.RequestID,
		EffectiveTimeHours: effectiveTimeHours,
	}, nil
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func trimMax(value string, maxLen int) string {
	if maxLen <= 0 || len(value) <= maxLen {
		return value
	}
	return value[:maxLen]
}
