package ses

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common"
	tchttp "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common/http"
	"github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common/profile"
)

const (
	defaultEndpoint = "ses.tencentcloudapi.com"
	defaultRegion   = "ap-guangzhou"
	apiVersion      = "2020-10-02"
)

type Config struct {
	SecretID  string
	SecretKey string
	Region    string
	Endpoint  string
}

type Client struct {
	client *common.Client
}

func New(cfg Config) (*Client, error) {
	secretID := strings.TrimSpace(cfg.SecretID)
	secretKey := strings.TrimSpace(cfg.SecretKey)
	if secretID == "" || secretKey == "" {
		return nil, fmt.Errorf("missing tencent ses credentials")
	}
	region := strings.TrimSpace(cfg.Region)
	if region == "" {
		region = defaultRegion
	}
	endpoint := strings.TrimSpace(cfg.Endpoint)
	if endpoint == "" {
		endpoint = defaultEndpoint
	}

	credential := common.NewCredential(secretID, secretKey)
	cpf := profile.NewClientProfile()
	cpf.HttpProfile.Endpoint = endpoint
	return &Client{client: common.NewCommonClient(credential, region, cpf)}, nil
}

type SendSimpleEmailInput struct {
	From    string
	To      string
	Subject string
	HTML    string
	Text    string
}

type SendSimpleEmailResult struct {
	MessageID string
	RequestID string
}

func (c *Client) SendSimpleEmail(ctx context.Context, input SendSimpleEmailInput) (SendSimpleEmailResult, error) {
	to := strings.TrimSpace(input.To)
	if to == "" {
		return SendSimpleEmailResult{}, fmt.Errorf("missing destination email")
	}
	from := strings.TrimSpace(input.From)
	if from == "" {
		return SendSimpleEmailResult{}, fmt.Errorf("missing from email address")
	}

	request := tchttp.NewCommonRequest("ses", apiVersion, "SendEmail")
	if err := request.SetActionParameters(map[string]any{
		"FromEmailAddress": from,
		"Subject":          strings.TrimSpace(input.Subject),
		"Destination":      []string{to},
		"Simple": map[string]string{
			"Html": base64.StdEncoding.EncodeToString([]byte(input.HTML)),
			"Text": base64.StdEncoding.EncodeToString([]byte(input.Text)),
		},
	}); err != nil {
		return SendSimpleEmailResult{}, fmt.Errorf("set send email parameters: %w", err)
	}
	request.SetContext(ctx)

	response := tchttp.NewCommonResponse()
	if err := c.client.Send(request, response); err != nil {
		return SendSimpleEmailResult{}, fmt.Errorf("send email request: %w", err)
	}

	var payload struct {
		Response struct {
			MessageID string `json:"MessageId"`
			RequestID string `json:"RequestId"`
			Error     *struct {
				Code    string `json:"Code"`
				Message string `json:"Message"`
			} `json:"Error"`
		} `json:"Response"`
	}
	if err := json.Unmarshal(response.GetBody(), &payload); err != nil {
		return SendSimpleEmailResult{}, fmt.Errorf("decode ses response: %w", err)
	}
	if payload.Response.Error != nil {
		return SendSimpleEmailResult{}, fmt.Errorf(
			"ses send email failed: %s: %s",
			payload.Response.Error.Code,
			payload.Response.Error.Message,
		)
	}
	return SendSimpleEmailResult{
		MessageID: payload.Response.MessageID,
		RequestID: payload.Response.RequestID,
	}, nil
}
