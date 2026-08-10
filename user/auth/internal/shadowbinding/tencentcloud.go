package shadowbinding

import (
	"context"
	cryptorand "crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common"
	tchttp "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common/http"
	"github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common/profile"
)

type TencentCloudConfig struct {
	SecretID        string
	SecretKey       string
	Region          string
	AccountEndpoint string
	CAMEndpoint     string
	STSEndpoint     string
	RequestTimeout  time.Duration
	Platform        string
	SiteKind        string
	CloudLadder     CloudLadderConfig
}

type TencentCloudSDKClient struct {
	accountClient  *common.Client
	camClient      *common.Client
	stsClient      *common.Client
	region         string
	accountProfile *profile.ClientProfile
	cloudLadder    CloudLadderConfig
	platform       string
	siteKind       string
}

func NewTencentCloudSDKClient(cfg TencentCloudConfig) (*TencentCloudSDKClient, error) {
	secretID := strings.TrimSpace(cfg.SecretID)
	secretKey := strings.TrimSpace(cfg.SecretKey)
	if secretID == "" || secretKey == "" {
		return nil, fmt.Errorf("shadow tencentcloud secret id/key are required")
	}
	region := strings.TrimSpace(cfg.Region)
	if region == "" {
		region = "ap-guangzhou"
	}
	endpoint := strings.TrimSpace(cfg.AccountEndpoint)
	if endpoint == "" {
		endpoint = "account.tencentcloudapi.com"
	}
	camEndpoint := strings.TrimSpace(cfg.CAMEndpoint)
	if camEndpoint == "" {
		camEndpoint = "cam.tencentcloudapi.com"
	}
	stsEndpoint := strings.TrimSpace(cfg.STSEndpoint)
	if stsEndpoint == "" {
		stsEndpoint = "sts.tencentcloudapi.com"
	}
	platform := strings.TrimSpace(cfg.Platform)
	if platform == "" {
		platform = "lightvela"
	}
	siteKind, err := ParseSiteKind(cfg.SiteKind)
	if err != nil {
		return nil, err
	}
	timeout := cfg.RequestTimeout
	if timeout <= 0 {
		timeout = 10 * time.Second
	}

	credential := common.NewCredential(secretID, secretKey)
	accountProfile := clientProfile(endpoint, timeout)
	accountClient, err := newCommonClient(credential, region, accountProfile, cfg.CloudLadder, cfg.CloudLadder.RouteID)
	if err != nil {
		return nil, err
	}
	camClient, err := newCommonClient(credential, region, clientProfile(camEndpoint, timeout), cfg.CloudLadder, cfg.CloudLadder.CAMRouteID)
	if err != nil {
		return nil, err
	}
	stsClient, err := newCommonClient(credential, region, clientProfile(stsEndpoint, timeout), cfg.CloudLadder, cfg.CloudLadder.STSRouteID)
	if err != nil {
		return nil, err
	}
	return &TencentCloudSDKClient{
		accountClient:  accountClient,
		camClient:      camClient,
		stsClient:      stsClient,
		region:         region,
		accountProfile: accountProfile,
		cloudLadder:    cfg.CloudLadder,
		platform:       platform,
		siteKind:       siteKind,
	}, nil
}

func clientProfile(endpoint string, timeout time.Duration) *profile.ClientProfile {
	cpf := profile.NewClientProfile()
	cpf.HttpProfile.Endpoint = endpoint
	cpf.HttpProfile.ReqTimeout = int(timeout / time.Second)
	if cpf.HttpProfile.ReqTimeout < 1 {
		cpf.HttpProfile.ReqTimeout = 1
	}
	return cpf
}

func newCommonClient(credential *common.Credential, region string, cpf *profile.ClientProfile, cfg CloudLadderConfig, routeID string) (*common.Client, error) {
	client := common.NewCommonClient(credential, region, cpf)
	transport, err := NewCloudLadderTransportForRoute(cfg, routeID, http.DefaultTransport)
	if err != nil {
		return nil, err
	}
	client.WithHttpTransport(transport)
	return client, nil
}

func (c *TencentCloudSDKClient) RegisterShadowAccount(ctx context.Context, in CloudRegisterInput) (CloudRegisterResult, error) {
	if c == nil || c.accountClient == nil {
		return CloudRegisterResult{}, fmt.Errorf("shadow tencentcloud client is not configured")
	}
	password, err := cloudAccountPassword()
	if err != nil {
		return CloudRegisterResult{}, err
	}
	action, params, err := registrationRequest(c.siteKind, c.platform, in, password)
	if err != nil {
		return CloudRegisterResult{}, err
	}
	req := tchttp.NewCommonRequest("account", "2018-12-25", action)
	if err := req.SetActionParameters(params); err != nil {
		return CloudRegisterResult{}, fmt.Errorf("set %s parameters: %w", action, err)
	}
	req.SetContext(ctx)

	resp := tchttp.NewCommonResponse()
	if err := c.accountClient.Send(req, resp); err != nil {
		return CloudRegisterResult{}, fmt.Errorf("send %s: %w", action, err)
	}
	var payload struct {
		Response struct {
			Uin int64 `json:"Uin"`
		} `json:"Response"`
	}
	if err := json.Unmarshal(resp.GetBody(), &payload); err != nil {
		return CloudRegisterResult{}, fmt.Errorf("decode %s response: %w", action, err)
	}
	if payload.Response.Uin <= 0 {
		return CloudRegisterResult{}, fmt.Errorf("%s returned empty uin", action)
	}
	appID, err := c.getAppIDByUin(ctx, payload.Response.Uin)
	if err != nil {
		return CloudRegisterResult{}, err
	}
	return CloudRegisterResult{Uin: payload.Response.Uin, OwnerUin: payload.Response.Uin, AppID: appID}, nil
}

func registrationRequest(siteKind string, platform string, in CloudRegisterInput, password string) (string, map[string]any, error) {
	userName := strings.TrimSpace(in.UserName)
	clientUA := strings.TrimSpace(in.ClientUA)
	if clientUA == "" {
		clientUA = "LightVelaAuth/1.0"
	}
	if siteKind == SiteKindIntl {
		email := strings.TrimSpace(in.Email)
		if email == "" {
			return "", nil, errors.New("international shadow registration email is required")
		}
		return "RegisterCloudForSaaSIntl", map[string]any{
			"ClientUA":        clientUA,
			"CountryName":     "SG",
			"CountryCode":     "65",
			"Lang":            "en",
			"Platform":        strings.TrimSpace(platform),
			"TradeName":       "kghy_01",
			"TradeOne":        "kghy_01",
			"TradeTwo":        "kghy_0101",
			"UserType":        1,
			"FullName":        userName,
			"CompanyName":     "LightVela",
			"CountryFullName": "Singapore",
			"Email":           email,
			"RegisterType":    "mail",
			"Area":            2,
			"AccessLevel":     2,
			"UserName":        userName,
			"Password":        password,
		}, nil
	}
	return "RegisterCloudForSaaS", map[string]any{
		"ClientUA":        clientUA,
		"ClientIP":        strings.TrimSpace(in.ClientIP),
		"CountryName":     "CN",
		"CountryCode":     "86",
		"RegisterType":    "phone",
		"Lang":            "zh",
		"Area":            1,
		"Platform":        strings.TrimSpace(platform),
		"AccessLevel":     2,
		"PhoneNumber":     strings.TrimSpace(in.Phone),
		"PhoneVerifyCode": strings.TrimSpace(in.VerifyCode),
		"UserName":        userName,
		"Password":        password,
	}, nil
}

func (c *TencentCloudSDKClient) SendSMSVerifyCode(ctx context.Context, in CloudSendSMSInput) error {
	if c == nil || c.accountClient == nil {
		return fmt.Errorf("shadow tencentcloud client is not configured")
	}
	countryCode := strings.TrimPrefix(strings.TrimSpace(in.CountryCode), "+")
	if countryCode == "" {
		countryCode = "86"
	}
	lang := strings.TrimSpace(in.Lang)
	if lang == "" {
		lang = "zh"
	}
	req := tchttp.NewCommonRequest("account", "2018-12-25", "SendSmsVerifyCode")
	if err := req.SetActionParameters(map[string]any{
		"CountryCode": countryCode,
		"PhoneNumber": strings.TrimSpace(in.Phone),
		"Lang":        lang,
		"ClientIP":    strings.TrimSpace(in.ClientIP),
	}); err != nil {
		return fmt.Errorf("set SendSmsVerifyCode parameters: %w", err)
	}
	req.SetContext(ctx)
	resp := tchttp.NewCommonResponse()
	if err := c.accountClient.Send(req, resp); err != nil {
		return fmt.Errorf("send SendSmsVerifyCode: %w", err)
	}
	return nil
}

func (c *TencentCloudSDKClient) UpdatePhoneByAuthCode(ctx context.Context, in CloudUpdatePhoneInput) error {
	if c == nil || c.accountClient == nil {
		return fmt.Errorf("shadow tencentcloud client is not configured")
	}
	oldCountryCode := strings.TrimSpace(in.OldPhoneCountryCode)
	if oldCountryCode == "" {
		oldCountryCode = "86"
	}
	newCountryCode := strings.TrimSpace(in.NewPhoneCountryCode)
	if newCountryCode == "" {
		newCountryCode = "86"
	}
	req := tchttp.NewCommonRequest("account", "2018-12-25", "UpdatePhoneByAuthCodeForSaaS")
	if err := req.SetActionParameters(map[string]any{
		"OldPhoneCountryCode": oldCountryCode,
		"OldPhoneNumber":      strings.TrimSpace(in.OldPhoneNumber),
		"NewPhoneCountryCode": newCountryCode,
		"NewPhoneNumber":      strings.TrimSpace(in.NewPhoneNumber),
		"AuthCode":            strings.TrimSpace(in.AuthCode),
		"VerifyCode":          strings.TrimSpace(in.VerifyCode),
		"Platform":            c.platform,
	}); err != nil {
		return fmt.Errorf("set UpdatePhoneByAuthCodeForSaaS parameters: %w", err)
	}
	req.SetContext(ctx)
	resp := tchttp.NewCommonResponse()
	if err := c.accountClient.Send(req, resp); err != nil {
		return fmt.Errorf("send UpdatePhoneByAuthCodeForSaaS: %w", err)
	}
	return nil
}

func (c *TencentCloudSDKClient) SaveBasicAuthForSaaS(ctx context.Context, in CloudSaveBasicAuthInput) error {
	if c == nil || c.camClient == nil || c.stsClient == nil || c.accountProfile == nil {
		return fmt.Errorf("shadow tencentcloud client is not configured")
	}
	startedAt := time.Now()
	slog.InfoContext(ctx, "shadow tencentcloud basic auth sync started",
		"platform", c.platform,
		"account_type", in.AccountType,
		"has_auth_code", strings.TrimSpace(in.AuthCode) != "",
		"has_id_card", strings.TrimSpace(in.IDCard) != "",
		"has_client_ip", strings.TrimSpace(in.ClientIP) != "",
		"has_client_ua", strings.TrimSpace(in.ClientUA) != "",
	)
	saasToken, err := c.getSaaSTokenByAuthCode(ctx, in.AuthCode, in.ClientIP, in.ClientUA)
	if err != nil {
		slog.WarnContext(ctx, "shadow tencentcloud basic auth sync failed at saas token",
			"platform", c.platform,
			"duration_ms", time.Since(startedAt).Milliseconds(),
			"err", err,
		)
		return err
	}
	slog.InfoContext(ctx, "shadow tencentcloud basic auth sync got saas token",
		"platform", c.platform,
		"uin", saasToken.Uin,
		"owner_uin", saasToken.OwnerUin,
		"request_id", saasToken.RequestID,
		"expires_at", saasToken.ExpiredTime.UTC().Format(time.RFC3339),
	)
	creds, err := c.getSaaSAccessToken(ctx, saasToken, in.ClientIP, in.ClientUA)
	if err != nil {
		slog.WarnContext(ctx, "shadow tencentcloud basic auth sync failed at sts credentials",
			"platform", c.platform,
			"uin", saasToken.Uin,
			"owner_uin", saasToken.OwnerUin,
			"saas_token_request_id", saasToken.RequestID,
			"duration_ms", time.Since(startedAt).Milliseconds(),
			"err", err,
		)
		return err
	}
	if strings.TrimSpace(creds.TmpSecretID) == "" || strings.TrimSpace(creds.TmpSecretKey) == "" || strings.TrimSpace(creds.Token) == "" {
		slog.WarnContext(ctx, "shadow tencentcloud basic auth sync got empty sts credentials",
			"platform", c.platform,
			"uin", saasToken.Uin,
			"owner_uin", saasToken.OwnerUin,
			"sts_request_id", creds.RequestID,
			"has_tmp_secret_id", strings.TrimSpace(creds.TmpSecretID) != "",
			"has_tmp_secret_key", strings.TrimSpace(creds.TmpSecretKey) != "",
			"has_token", strings.TrimSpace(creds.Token) != "",
			"duration_ms", time.Since(startedAt).Milliseconds(),
		)
		return fmt.Errorf("GetSaaSAccessToken returned empty credentials")
	}
	slog.InfoContext(ctx, "shadow tencentcloud basic auth sync got sts credentials",
		"platform", c.platform,
		"uin", saasToken.Uin,
		"owner_uin", saasToken.OwnerUin,
		"request_id", creds.RequestID,
		"expires_at", creds.ExpiredTime.UTC().Format(time.RFC3339),
	)
	accountClient, err := newCommonClient(common.NewTokenCredential(creds.TmpSecretID, creds.TmpSecretKey, creds.Token), c.region, c.accountProfile, c.cloudLadder, c.cloudLadder.RouteID)
	if err != nil {
		slog.WarnContext(ctx, "shadow tencentcloud basic auth sync build account client failed",
			"platform", c.platform,
			"uin", saasToken.Uin,
			"owner_uin", saasToken.OwnerUin,
			"duration_ms", time.Since(startedAt).Milliseconds(),
			"err", err,
		)
		return err
	}
	req := tchttp.NewCommonRequest("account", "2018-12-25", "SaveBasicAuthForSaaS")
	params := map[string]any{
		"AccountType": in.AccountType,
		"Name":        strings.TrimSpace(in.Name),
		"Platform":    c.platform,
	}
	if idCard := strings.TrimSpace(in.IDCard); idCard != "" {
		params["Idcard"] = idCard
	}
	if err := req.SetActionParameters(params); err != nil {
		return fmt.Errorf("set SaveBasicAuthForSaaS parameters: %w", err)
	}
	req.SetContext(ctx)
	resp := tchttp.NewCommonResponse()
	if err := accountClient.Send(req, resp); err != nil {
		slog.WarnContext(ctx, "shadow tencentcloud SaveBasicAuthForSaaS failed",
			"platform", c.platform,
			"uin", saasToken.Uin,
			"owner_uin", saasToken.OwnerUin,
			"saas_token_request_id", saasToken.RequestID,
			"sts_request_id", creds.RequestID,
			"duration_ms", time.Since(startedAt).Milliseconds(),
			"err", err,
		)
		return fmt.Errorf("send SaveBasicAuthForSaaS: %w", err)
	}
	saveRequestID := responseRequestID(resp.GetBody())
	slog.InfoContext(ctx, "shadow tencentcloud SaveBasicAuthForSaaS succeeded",
		"platform", c.platform,
		"uin", saasToken.Uin,
		"owner_uin", saasToken.OwnerUin,
		"request_id", saveRequestID,
		"saas_token_request_id", saasToken.RequestID,
		"sts_request_id", creds.RequestID,
		"duration_ms", time.Since(startedAt).Milliseconds(),
	)
	return nil
}

func (c *TencentCloudSDKClient) getSaaSTokenByAuthCode(ctx context.Context, authCode, clientIP, clientUA string) (CloudSaaSTokenResult, error) {
	req := tchttp.NewCommonRequest("cam", "2019-01-16", "GetTokenByAuthCodeForSaaS")
	if err := req.SetActionParameters(map[string]any{
		"AuthCode": strings.TrimSpace(authCode),
		"Platform": c.platform,
		"ClientIP": strings.TrimSpace(clientIP),
		"ClientUA": strings.TrimSpace(clientUA),
	}); err != nil {
		return CloudSaaSTokenResult{}, fmt.Errorf("set GetTokenByAuthCodeForSaaS parameters: %w", err)
	}
	req.SetContext(ctx)
	resp := tchttp.NewCommonResponse()
	if err := c.camClient.Send(req, resp); err != nil {
		return CloudSaaSTokenResult{}, fmt.Errorf("send GetTokenByAuthCodeForSaaS: %w", err)
	}
	var payload struct {
		Response struct {
			Uin         int64  `json:"Uin"`
			OwnerUin    int64  `json:"OwnerUin"`
			Token       string `json:"Token"`
			ExpiredTime int64  `json:"ExpiredTime"`
			RequestID   string `json:"RequestId"`
		} `json:"Response"`
	}
	if err := json.Unmarshal(resp.GetBody(), &payload); err != nil {
		return CloudSaaSTokenResult{}, fmt.Errorf("decode GetTokenByAuthCodeForSaaS response: %w", err)
	}
	if payload.Response.Token == "" {
		return CloudSaaSTokenResult{}, fmt.Errorf("GetTokenByAuthCodeForSaaS returned empty token")
	}
	return CloudSaaSTokenResult{
		Uin:         payload.Response.Uin,
		OwnerUin:    payload.Response.OwnerUin,
		Token:       payload.Response.Token,
		ExpiredTime: time.Unix(payload.Response.ExpiredTime, 0),
		RequestID:   payload.Response.RequestID,
	}, nil
}

func (c *TencentCloudSDKClient) getSaaSAccessToken(ctx context.Context, token CloudSaaSTokenResult, clientIP, clientUA string) (CloudTemporaryCredentials, error) {
	req := tchttp.NewCommonRequest("sts", "2018-08-13", "GetSaaSAccessToken")
	if err := req.SetActionParameters(map[string]any{
		"SaaSToken":     strings.TrimSpace(token.Token),
		"Platform":      c.platform,
		"TokenUin":      token.Uin,
		"TokenOwnerUin": token.OwnerUin,
		"ClientIP":      strings.TrimSpace(clientIP),
		"ClientUA":      strings.TrimSpace(clientUA),
	}); err != nil {
		return CloudTemporaryCredentials{}, fmt.Errorf("set GetSaaSAccessToken parameters: %w", err)
	}
	req.SetContext(ctx)
	resp := tchttp.NewCommonResponse()
	if err := c.stsClient.Send(req, resp); err != nil {
		return CloudTemporaryCredentials{}, fmt.Errorf("send GetSaaSAccessToken: %w", err)
	}
	var payload struct {
		Response struct {
			ExpiredTime int64  `json:"ExpiredTime"`
			RequestID   string `json:"RequestId"`
			Credentials struct {
				Token        string `json:"Token"`
				TmpSecretID  string `json:"TmpSecretId"`
				TmpSecretKey string `json:"TmpSecretKey"`
			} `json:"Credentials"`
		} `json:"Response"`
	}
	if err := json.Unmarshal(resp.GetBody(), &payload); err != nil {
		return CloudTemporaryCredentials{}, fmt.Errorf("decode GetSaaSAccessToken response: %w", err)
	}
	return CloudTemporaryCredentials{
		Token:        payload.Response.Credentials.Token,
		TmpSecretID:  payload.Response.Credentials.TmpSecretID,
		TmpSecretKey: payload.Response.Credentials.TmpSecretKey,
		ExpiredTime:  time.Unix(payload.Response.ExpiredTime, 0),
		RequestID:    payload.Response.RequestID,
	}, nil
}

func responseRequestID(body []byte) string {
	var payload struct {
		Response struct {
			RequestID string `json:"RequestId"`
		} `json:"Response"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return ""
	}
	return strings.TrimSpace(payload.Response.RequestID)
}

func (c *TencentCloudSDKClient) getAppIDByUin(ctx context.Context, uin int64) (int64, error) {
	req := tchttp.NewCommonRequest("account", "2018-12-25", "GetAppIdByUin")
	if err := req.SetActionParameters(map[string]any{"OpUin": uin}); err != nil {
		return 0, fmt.Errorf("set GetAppIdByUin parameters: %w", err)
	}
	req.SetContext(ctx)
	resp := tchttp.NewCommonResponse()
	if err := c.accountClient.Send(req, resp); err != nil {
		return 0, fmt.Errorf("send GetAppIdByUin: %w", err)
	}
	var payload struct {
		Response struct {
			AppID int64 `json:"AppId"`
		} `json:"Response"`
	}
	if err := json.Unmarshal(resp.GetBody(), &payload); err != nil {
		return 0, fmt.Errorf("decode GetAppIdByUin response: %w", err)
	}
	if payload.Response.AppID <= 0 {
		return 0, fmt.Errorf("GetAppIdByUin returned empty app id")
	}
	return payload.Response.AppID, nil
}

func cloudAccountPassword() (string, error) {
	raw := make([]byte, 8)
	if _, err := cryptorand.Read(raw); err != nil {
		return "", fmt.Errorf("generate shadow account password: %w", err)
	}
	return "Aa1!" + hex.EncodeToString(raw), nil
}
