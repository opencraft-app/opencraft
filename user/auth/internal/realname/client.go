package realname

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/openclaw/openclaw/mono/backend/auth/internal/service"
	"github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common"
	tcerr "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common/errors"
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

func (c *Client) DetectAuth(ctx context.Context, in service.RealnameFaceIDDetectAuthInput) (service.RealnameFaceIDDetectAuthResult, error) {
	request := tchttp.NewCommonRequest("faceid", "2018-03-01", "DetectAuth")
	if err := request.SetActionParameters(map[string]interface{}{
		"RuleId":      strings.TrimSpace(in.RuleID),
		"Name":        strings.TrimSpace(in.Name),
		"IdCard":      strings.TrimSpace(in.IDCard),
		"RedirectUrl": strings.TrimSpace(in.RedirectURL),
		"Extra":       strings.TrimSpace(in.Extra),
	}); err != nil {
		return service.RealnameFaceIDDetectAuthResult{}, fmt.Errorf("set detectauth parameters: %w", err)
	}
	request.SetContext(ctx)

	response := tchttp.NewCommonResponse()
	if err := c.client.Send(request, response); err != nil {
		return service.RealnameFaceIDDetectAuthResult{}, fmt.Errorf("send detectauth request: %w", err)
	}
	var payload struct {
		Response struct {
			Url       string `json:"Url"`
			BizToken  string `json:"BizToken"`
			RequestID string `json:"RequestId"`
			Error     *struct {
				Code    string `json:"Code"`
				Message string `json:"Message"`
			} `json:"Error"`
		} `json:"Response"`
	}
	if err := json.Unmarshal(response.GetBody(), &payload); err != nil {
		return service.RealnameFaceIDDetectAuthResult{}, fmt.Errorf("decode detectauth response: %w", err)
	}
	if payload.Response.Error != nil {
		return service.RealnameFaceIDDetectAuthResult{}, fmt.Errorf("detectauth %s: %s", payload.Response.Error.Code, payload.Response.Error.Message)
	}
	if strings.TrimSpace(payload.Response.BizToken) == "" || strings.TrimSpace(payload.Response.Url) == "" || strings.TrimSpace(payload.Response.RequestID) == "" {
		return service.RealnameFaceIDDetectAuthResult{}, fmt.Errorf("detectauth response missing required fields")
	}
	return service.RealnameFaceIDDetectAuthResult{
		BizToken:  strings.TrimSpace(payload.Response.BizToken),
		VerifyURL: strings.TrimSpace(payload.Response.Url),
		RequestID: strings.TrimSpace(payload.Response.RequestID),
	}, nil
}

func (c *Client) GetDetectInfoEnhanced(ctx context.Context, in service.RealnameFaceIDGetDetectInfoInput) (service.RealnameFaceIDProviderCheckResult, error) {
	request := tchttp.NewCommonRequest("faceid", "2018-03-01", "GetDetectInfoEnhanced")
	if err := request.SetActionParameters(map[string]interface{}{
		"RuleId":   strings.TrimSpace(in.RuleID),
		"BizToken": strings.TrimSpace(in.BizToken),
		"InfoType": "1",
	}); err != nil {
		return service.RealnameFaceIDProviderCheckResult{}, fmt.Errorf("set getdetectinfoenhanced parameters: %w", err)
	}
	request.SetContext(ctx)

	response := tchttp.NewCommonResponse()
	if err := c.client.Send(request, response); err != nil {
		return service.RealnameFaceIDProviderCheckResult{}, classifyGetDetectInfoEnhancedError(err)
	}
	return parseGetDetectInfoEnhancedResponse(response.GetBody(), service.RealnameFaceIDGetDetectInfoExpectation{
		RuleID:       strings.TrimSpace(in.RuleID),
		AccountID:    strings.TrimSpace(in.AccountID),
		AttemptID:    strings.TrimSpace(in.AttemptID),
		IdentityHash: strings.TrimSpace(in.IdentityHash),
		DigestKey:    in.DigestKey,
	})
}

func classifyGetDetectInfoEnhancedError(err error) error {
	var sdkErr *tcerr.TencentCloudSDKError
	if errors.As(err, &sdkErr) {
		return &service.RealnameFaceIDProviderRequestError{
			Code:      strings.TrimSpace(sdkErr.GetCode()),
			Message:   strings.TrimSpace(sdkErr.GetMessage()),
			RequestID: strings.TrimSpace(sdkErr.GetRequestId()),
		}
	}
	return fmt.Errorf("send getdetectinfoenhanced request: %w", err)
}

func parseGetDetectInfoEnhancedResponse(body []byte, expected service.RealnameFaceIDGetDetectInfoExpectation) (service.RealnameFaceIDProviderCheckResult, error) {
	var payload struct {
		Response struct {
			RequestID string `json:"RequestId"`
			Error     *struct {
				Code    string `json:"Code"`
				Message string `json:"Message"`
			} `json:"Error"`
			Text *struct {
				ErrCode        *int   `json:"ErrCode"`
				ErrMsg         string `json:"ErrMsg"`
				LiveStatus     *int   `json:"LiveStatus"`
				LiveMsg        string `json:"LiveMsg"`
				Comparestatus  *int   `json:"Comparestatus"`
				Comparemsg     string `json:"Comparemsg"`
				Name           string `json:"Name"`
				IdCard         string `json:"IdCard"`
				Extra          string `json:"Extra"`
				LivenessDetail []struct {
					ErrCode       *int   `json:"Errcode"`
					LiveStatus    *int   `json:"Livestatus"`
					CompareStatus *int   `json:"Comparestatus"`
					Name          string `json:"Name"`
					IdCard        string `json:"Idcard"`
				} `json:"LivenessDetail"`
			} `json:"Text"`
		} `json:"Response"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return service.RealnameFaceIDProviderCheckResult{}, &service.RealnameFaceIDProviderIntegrityError{Reason: "malformed JSON"}
	}
	result := service.RealnameFaceIDProviderCheckResult{
		RequestID: strings.TrimSpace(payload.Response.RequestID),
	}
	if payload.Response.Error != nil {
		return service.RealnameFaceIDProviderCheckResult{}, &service.RealnameFaceIDProviderRequestError{
			Code:      strings.TrimSpace(payload.Response.Error.Code),
			Message:   strings.TrimSpace(payload.Response.Error.Message),
			RequestID: result.RequestID,
		}
	}
	if payload.Response.Text == nil {
		return result, nil
	}
	text := payload.Response.Text
	result.ProviderExtra = strings.TrimSpace(text.Extra)
	if result.ProviderExtra != "" && result.ProviderExtra != strings.TrimSpace(expected.AttemptID) {
		return service.RealnameFaceIDProviderCheckResult{}, &service.RealnameFaceIDProviderIntegrityError{RequestID: result.RequestID, Reason: "extra mismatch"}
	}
	if text.ErrCode == nil || text.LiveStatus == nil || text.Comparestatus == nil {
		return result, nil
	}
	if *text.ErrCode != 0 || *text.LiveStatus != 0 || *text.Comparestatus != 0 {
		result.Completed = true
		result.FailureCode = strings.TrimSpace(text.ErrMsg)
		result.FailureMessage = strings.TrimSpace(text.LiveMsg + " " + text.Comparemsg)
		return result, nil
	}
	if result.ProviderExtra == "" {
		return service.RealnameFaceIDProviderCheckResult{}, &service.RealnameFaceIDProviderIntegrityError{RequestID: result.RequestID, Reason: "missing extra on successful result"}
	}
	aggregateIdentityHash := service.HashRealnameIdentityWithKey(expected.DigestKey, strings.TrimSpace(text.Name), strings.TrimSpace(text.IdCard))
	if aggregateIdentityHash != strings.TrimSpace(expected.IdentityHash) {
		return service.RealnameFaceIDProviderCheckResult{}, &service.RealnameFaceIDProviderIntegrityError{RequestID: result.RequestID, Reason: "aggregate identity mismatch"}
	}
	var passedDetail *struct {
		ErrCode       *int   `json:"Errcode"`
		LiveStatus    *int   `json:"Livestatus"`
		CompareStatus *int   `json:"Comparestatus"`
		Name          string `json:"Name"`
		IdCard        string `json:"Idcard"`
	}
	for i := range text.LivenessDetail {
		detail := &text.LivenessDetail[i]
		if detail.ErrCode != nil && detail.LiveStatus != nil && detail.CompareStatus != nil &&
			*detail.ErrCode == 0 && *detail.LiveStatus == 0 && *detail.CompareStatus == 0 &&
			strings.TrimSpace(detail.Name) != "" && strings.TrimSpace(detail.IdCard) != "" {
			passedDetail = detail
			break
		}
	}
	if passedDetail == nil {
		return service.RealnameFaceIDProviderCheckResult{}, &service.RealnameFaceIDProviderIntegrityError{RequestID: result.RequestID, Reason: "missing successful liveness detail"}
	}
	identityHash := service.HashRealnameIdentityWithKey(expected.DigestKey, strings.TrimSpace(passedDetail.Name), strings.TrimSpace(passedDetail.IdCard))
	if identityHash != strings.TrimSpace(expected.IdentityHash) {
		return service.RealnameFaceIDProviderCheckResult{}, &service.RealnameFaceIDProviderIntegrityError{RequestID: result.RequestID, Reason: "liveness identity mismatch"}
	}
	result.Completed = true
	result.Success = true
	return result, nil
}
