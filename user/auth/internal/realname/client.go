package realname

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/openclaw/openclaw/mono/backend/auth/internal/service"
	"github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common"
	tchttp "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common/http"
	"github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common/profile"
)

type Config struct {
	SecretID  string
	SecretKey string
	Endpoint  string
}

type Client struct {
	client *common.Client
}

func New(cfg Config) (*Client, error) {
	endpoint := strings.TrimSpace(cfg.Endpoint)
	if endpoint == "" {
		endpoint = "faceid.tencentcloudapi.com"
	}
	credential := common.NewCredential(strings.TrimSpace(cfg.SecretID), strings.TrimSpace(cfg.SecretKey))
	cpf := profile.NewClientProfile()
	cpf.HttpProfile.Endpoint = endpoint
	return &Client{client: common.NewCommonClient(credential, "ap-guangzhou", cpf)}, nil
}

func (c *Client) Verify(ctx context.Context, name string, idCard string) (service.RealnameProviderResult, error) {
	request := tchttp.NewCommonRequest("faceid", "2018-03-01", "IdCardVerification")
	if err := request.SetActionParameters(map[string]interface{}{
		"Name":   name,
		"IdCard": idCard,
	}); err != nil {
		return service.RealnameProviderResult{}, fmt.Errorf("set action parameters: %w", err)
	}
	request.SetContext(ctx)

	response := tchttp.NewCommonResponse()
	if err := c.client.Send(request, response); err != nil {
		return service.RealnameProviderResult{}, fmt.Errorf("send id card verification request: %w", err)
	}

	var payload struct {
		Response struct {
			Result      string `json:"Result"`
			Description string `json:"Description"`
			RequestID   string `json:"RequestId"`
		} `json:"Response"`
	}
	if err := json.Unmarshal(response.GetBody(), &payload); err != nil {
		return service.RealnameProviderResult{}, fmt.Errorf("decode realname response: %w", err)
	}
	return service.RealnameProviderResult{
		Result:      payload.Response.Result,
		Description: payload.Response.Description,
		RequestID:   payload.Response.RequestID,
	}, nil
}
