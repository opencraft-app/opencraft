package platform

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	tcaccount "git.woa.com/tencentcloud-internal/tencentcloud-sdk-go/tencentcloud/account/v20181225"
	tccam "git.woa.com/tencentcloud-internal/tencentcloud-sdk-go/tencentcloud/cam/v20190116"
	"git.woa.com/tencentcloud-internal/tencentcloud-sdk-go/tencentcloud/common"
	tchttp "git.woa.com/tencentcloud-internal/tencentcloud-sdk-go/tencentcloud/common/http"
	"git.woa.com/tencentcloud-internal/tencentcloud-sdk-go/tencentcloud/common/profile"
	tcsts "git.woa.com/tencentcloud-internal/tencentcloud-sdk-go/tencentcloud/sts/v20180813"
	otellog "go.opentelemetry.io/otel/log"

	"shadow/internal/cloudladder"
	"shadow/internal/telemetry"
)

type TencentCloudOptions struct {
	Region          string
	Platform        string
	AccountEndpoint string
	CAMEndpoint     string
	STSEndpoint     string
	SecretID        string
	SecretKey       string
	CloudLadder     cloudladder.Options
	RequestTimeout  time.Duration
}

type TencentCloudProvider struct {
	opts TencentCloudOptions
}

func NewTencentCloudProvider(opts TencentCloudOptions) (*TencentCloudProvider, error) {
	if opts.SecretID == "" || opts.SecretKey == "" {
		return nil, errors.New("missing tencent cloud credentials")
	}
	if opts.Platform == "" {
		return nil, errors.New("missing shadow platform")
	}
	if opts.AccountEndpoint == "" || opts.CAMEndpoint == "" || opts.STSEndpoint == "" {
		return nil, errors.New("missing tencent cloud endpoints")
	}
	if opts.Region == "" {
		opts.Region = "ap-guangzhou"
	}
	if opts.RequestTimeout == 0 {
		opts.RequestTimeout = 10 * time.Second
	}
	if err := opts.CloudLadder.Validate(); err != nil {
		return nil, err
	}
	for _, endpoint := range []string{opts.AccountEndpoint, opts.CAMEndpoint, opts.STSEndpoint} {
		if _, err := opts.CloudLadder.ValidateEndpoint(endpoint); err != nil {
			return nil, err
		}
	}
	return &TencentCloudProvider{opts: opts}, nil
}

func (p *TencentCloudProvider) baseProfile(endpoint string) *profile.ClientProfile {
	cpf := profile.NewClientProfile()
	cpf.HttpProfile.Endpoint = endpoint
	cpf.HttpProfile.ReqMethod = "POST"
	cpf.HttpProfile.ReqTimeout = int(p.opts.RequestTimeout.Seconds())
	return cpf
}

func (p *TencentCloudProvider) baseCredential() common.CredentialIface {
	return common.NewCredential(p.opts.SecretID, p.opts.SecretKey)
}

func (p *TencentCloudProvider) accountClient(credential common.CredentialIface) (*tcaccount.Client, error) {
	client, err := tcaccount.NewClient(credential, p.opts.Region, p.baseProfile(p.opts.AccountEndpoint))
	if err != nil {
		return nil, err
	}
	transport, err := p.opts.CloudLadder.TransportForEndpoint(p.opts.AccountEndpoint)
	if err != nil {
		return nil, err
	}
	if transport != nil {
		client.WithHttpTransport(transport)
	}
	return client, nil
}

func (p *TencentCloudProvider) camClient() (*tccam.Client, error) {
	client, err := tccam.NewClient(p.baseCredential(), p.opts.Region, p.baseProfile(p.opts.CAMEndpoint))
	if err != nil {
		return nil, err
	}
	transport, err := p.opts.CloudLadder.TransportForEndpoint(p.opts.CAMEndpoint)
	if err != nil {
		return nil, err
	}
	if transport != nil {
		client.WithHttpTransport(transport)
	}
	return client, nil
}

func (p *TencentCloudProvider) stsClient() (*tcsts.Client, error) {
	client, err := tcsts.NewClient(p.baseCredential(), p.opts.Region, p.baseProfile(p.opts.STSEndpoint))
	if err != nil {
		return nil, err
	}
	transport, err := p.opts.CloudLadder.TransportForEndpoint(p.opts.STSEndpoint)
	if err != nil {
		return nil, err
	}
	if transport != nil {
		client.WithHttpTransport(transport)
	}
	return client, nil
}

func (p *TencentCloudProvider) SendRegisterSMS(ctx context.Context, in SendRegisterSMSInput) error {
	telemetry.Info(ctx, telemetry.Logger("shadow/internal/platform/tencentcloud"), "tencentcloud SendSmsVerifyCode",
		otellog.String("endpoint", p.opts.AccountEndpoint),
		otellog.String("platform", p.opts.Platform),
		otellog.String("country_code", trimLeadingPlus(in.CountryCode)),
		otellog.String("phone_number", in.PhoneNumber),
		otellog.String("client_ip", in.ClientIP),
		otellog.String("lang", defaultString(in.Lang, "zh")),
	)
	client, err := p.accountClient(p.baseCredential())
	if err != nil {
		return err
	}
	req := tcaccount.NewSendSmsVerifyCodeRequest()
	req.CountryCode = common.StringPtr(trimLeadingPlus(in.CountryCode))
	req.PhoneNumber = common.StringPtr(in.PhoneNumber)
	req.Lang = common.StringPtr(defaultString(in.Lang, "zh"))
	req.ClientIP = common.StringPtr(in.ClientIP)
	if in.CaptchaAppID != "" && in.Ticket != "" && in.Random != "" {
		req.CaptchaAppId = common.StringPtr(in.CaptchaAppID)
		req.Ticket = common.StringPtr(in.Ticket)
		req.Random = common.StringPtr(in.Random)
	}
	_, err = client.SendSmsVerifyCodeWithContext(ctx, req)
	return err
}

func (p *TencentCloudProvider) RegisterShadowAccount(ctx context.Context, in RegisterShadowAccountInput) (RegisterShadowAccountResult, error) {
	telemetry.Info(ctx, telemetry.Logger("shadow/internal/platform/tencentcloud"), "tencentcloud RegisterCloudForSaaS",
		otellog.String("endpoint", p.opts.AccountEndpoint),
		otellog.String("platform", p.opts.Platform),
		otellog.String("region", p.opts.Region),
		otellog.String("client_ua", in.ClientUA),
		otellog.String("client_ip", in.ClientIP),
		otellog.String("country_name", in.CountryName),
		otellog.String("country_code", trimLeadingPlus(in.CountryCode)),
		otellog.String("register_type", in.RegisterType),
		otellog.String("lang", defaultString(in.Lang, "zh")),
		otellog.Int64("area", int64(in.Area)),
		otellog.Int64("access_level", int64(in.AccessLevel)),
		otellog.String("phone_number", in.PhoneNumber),
		otellog.String("phone_verify_code", in.PhoneVerifyCode),
		otellog.Bool("user_name_set", in.UserName != ""),
		otellog.String("user_name", in.UserName),
	)
	client, err := p.accountClient(p.baseCredential())
	if err != nil {
		return RegisterShadowAccountResult{}, err
	}
	req := tcaccount.NewRegisterCloudForSaaSRequest()
	req.ClientUA = common.StringPtr(in.ClientUA)
	req.ClientIP = common.StringPtr(in.ClientIP)
	req.CountryName = common.StringPtr(in.CountryName)
	req.CountryCode = common.StringPtr(trimLeadingPlus(in.CountryCode))
	req.RegisterType = common.StringPtr(in.RegisterType)
	req.Lang = common.StringPtr(defaultString(in.Lang, "zh"))
	req.Area = common.Uint64Ptr(in.Area)
	req.Platform = common.StringPtr(p.opts.Platform)
	req.AccessLevel = common.Uint64Ptr(in.AccessLevel)
	req.PhoneNumber = common.StringPtr(in.PhoneNumber)
	req.PhoneVerifyCode = common.StringPtr(in.PhoneVerifyCode)
	if in.UserName != "" {
		req.UserName = common.StringPtr(in.UserName)
	}
	if in.Password != "" {
		req.Password = common.StringPtr(in.Password)
	}
	resp, err := client.RegisterCloudForSaaSWithContext(ctx, req)
	if err != nil {
		return RegisterShadowAccountResult{}, err
	}
	out := RegisterShadowAccountResult{}
	if body := resp.Response; body != nil {
		out.Uin = int64(valueUint64(body.Uin))
		out.Key = valueString(body.Key)
		out.ExpiredTime = time.Unix(int64(valueUint64(body.ExpiredTime)), 0)
		out.RequestID = valueString(body.RequestId)
	}
	return out, nil
}

func (p *TencentCloudProvider) GetAppIDByUin(ctx context.Context, uin int64) (int64, error) {
	client, err := p.accountClient(p.baseCredential())
	if err != nil {
		return 0, err
	}
	req := tcaccount.NewGetAppIdByUinRequest()
	req.OpUin = common.Uint64Ptr(uint64(uin))
	resp, err := client.GetAppIdByUinWithContext(ctx, req)
	if err != nil {
		return 0, err
	}
	if resp.Response == nil || resp.Response.AppId == nil {
		return 0, errors.New("missing appid in response")
	}
	return int64(*resp.Response.AppId), nil
}

func (p *TencentCloudProvider) GetSaaSTokenByAuthCode(ctx context.Context, authCode, clientIP, clientUA string) (SaaSTokenResult, error) {
	telemetry.Info(ctx, telemetry.Logger("shadow/internal/platform/tencentcloud"), "tencentcloud GetTokenByAuthCodeForSaaS",
		otellog.String("endpoint", p.opts.CAMEndpoint),
		otellog.String("platform", p.opts.Platform),
		otellog.Bool("has_auth_code", authCode != ""),
		otellog.Int("auth_code_len", len(authCode)),
		otellog.String("client_ip", clientIP),
		otellog.String("client_ua", clientUA),
	)
	client, err := p.camClient()
	if err != nil {
		return SaaSTokenResult{}, err
	}
	req := tccam.NewGetTokenByAuthCodeForSaaSRequest()
	req.AuthCode = common.StringPtr(authCode)
	req.Platform = common.StringPtr(p.opts.Platform)
	req.ClientIP = common.StringPtr(clientIP)
	req.ClientUA = common.StringPtr(clientUA)
	resp, err := client.GetTokenByAuthCodeForSaaSWithContext(ctx, req)
	if err != nil {
		return SaaSTokenResult{}, err
	}
	out := SaaSTokenResult{}
	if body := resp.Response; body != nil {
		out.Uin = int64(valueUint64(body.Uin))
		out.OwnerUin = int64(valueUint64(body.OwnerUin))
		out.Token = valueString(body.Token)
		out.ExpiredTime = time.Unix(int64(valueUint64(body.ExpiredTime)), 0)
		out.RequestID = valueString(body.RequestId)
	}
	return out, nil
}

func (p *TencentCloudProvider) GetSaaSAccessToken(ctx context.Context, token SaaSTokenResult, clientIP, clientUA string) (TemporaryCredentials, error) {
	telemetry.Info(ctx, telemetry.Logger("shadow/internal/platform/tencentcloud"), "tencentcloud GetSaaSAccessToken",
		otellog.String("endpoint", p.opts.STSEndpoint),
		otellog.String("platform", p.opts.Platform),
		otellog.Int64("token_uin", token.Uin),
		otellog.Int64("token_owner_uin", token.OwnerUin),
		otellog.String("client_ip", clientIP),
		otellog.String("client_ua", clientUA),
	)
	client, err := p.stsClient()
	if err != nil {
		return TemporaryCredentials{}, err
	}
	req := tcsts.NewGetSaaSAccessTokenRequest()
	req.SaaSToken = common.StringPtr(token.Token)
	req.Platform = common.StringPtr(p.opts.Platform)
	req.TokenUin = common.Uint64Ptr(uint64(token.Uin))
	req.TokenOwnerUin = common.Uint64Ptr(uint64(token.OwnerUin))
	req.ClientIP = common.StringPtr(clientIP)
	req.ClientUA = common.StringPtr(clientUA)
	resp, err := client.GetSaaSAccessTokenWithContext(ctx, req)
	if err != nil {
		return TemporaryCredentials{}, err
	}
	out := TemporaryCredentials{}
	if body := resp.Response; body != nil {
		out.ExpiredTime = time.Unix(valueInt64(body.ExpiredTime), 0)
		out.RequestID = valueString(body.RequestId)
		if creds := body.Credentials; creds != nil {
			out.Token = valueString(creds.Token)
			out.TmpSecretID = valueString(creds.TmpSecretId)
			out.TmpSecretKey = valueString(creds.TmpSecretKey)
		}
	}
	return out, nil
}

func (p *TencentCloudProvider) SaveBasicAuth(ctx context.Context, in SaveBasicAuthInput) error {
	telemetry.Info(ctx, telemetry.Logger("shadow/internal/platform/tencentcloud"), "tencentcloud SaveBasicAuthForSaaS",
		otellog.String("endpoint", p.opts.AccountEndpoint),
		otellog.String("platform", p.opts.Platform),
		otellog.Int64("account_type", in.AccountType),
		otellog.String("name", in.Name),
		otellog.Bool("has_id_card", in.IDCard != ""),
	)
	tokenCred := common.NewTokenCredential(in.Creds.TmpSecretID, in.Creds.TmpSecretKey, in.Creds.Token)
	client, err := p.accountClient(tokenCred)
	if err != nil {
		return err
	}
	req := tcaccount.NewSaveBasicAuthForSaaSRequest()
	req.AccountType = common.Int64Ptr(in.AccountType)
	req.Name = common.StringPtr(in.Name)
	req.Platform = common.StringPtr(p.opts.Platform)
	if in.IDCard != "" {
		req.Idcard = common.StringPtr(in.IDCard)
	}
	_, err = client.SaveBasicAuthForSaaSWithContext(ctx, req)
	return err
}

func (p *TencentCloudProvider) AuthenticateUser(ctx context.Context, in AuthenticateUserInput) error {
	telemetry.Info(ctx, telemetry.Logger("shadow/internal/platform/tencentcloud"), "tencentcloud AuthenticateUser",
		otellog.String("endpoint", p.opts.AccountEndpoint),
		otellog.String("platform", p.opts.Platform),
		otellog.Int64("auth_uin", in.AuthUin),
		otellog.Int64("type", in.Type),
		otellog.Int64("area", in.Area),
		otellog.String("checker", in.Checker),
		otellog.String("check_type", in.CheckType),
	)
	client, err := p.accountClient(p.baseCredential())
	if err != nil {
		return err
	}
	req := tchttp.NewCommonRequest("account", "2018-12-25", "AuthenticateUser")
	req.SetContext(ctx)
	if err := req.SetActionParameters(map[string]any{
		"AuthUin":           in.AuthUin,
		"Name":              in.Name,
		"Type":              in.Type,
		"Area":              in.Area,
		"Checker":           in.Checker,
		"CheckType":         in.CheckType,
		"Addr":              in.Addr,
		"IdcardType":        in.IdcardType,
		"Idcard":            in.Idcard,
		"Contact":           in.Contact,
		"Province":          in.Province,
		"City":              in.City,
		"District":          in.District,
		"CreditCode":        in.CreditCode,
		"OrgCode":           in.OrgCode,
		"LegalPersonIdcard": in.LegalPersonIdcard,
	}); err != nil {
		return err
	}
	resp := tchttp.NewCommonResponse()
	if err := client.Send(req, resp); err != nil {
		telemetry.Error(ctx, telemetry.Logger("shadow/internal/platform/tencentcloud"), "tencentcloud AuthenticateUser failed",
			otellog.String("endpoint", p.opts.AccountEndpoint),
			otellog.Int64("auth_uin", in.AuthUin),
			otellog.String("error", err.Error()),
		)
		return err
	}
	var responseBody struct {
		Response struct {
			RequestID string `json:"RequestId"`
		} `json:"Response"`
	}
	if err := json.Unmarshal(resp.GetBody(), &responseBody); err == nil {
		telemetry.Info(ctx, telemetry.Logger("shadow/internal/platform/tencentcloud"), "tencentcloud AuthenticateUser success",
			otellog.String("endpoint", p.opts.AccountEndpoint),
			otellog.Int64("auth_uin", in.AuthUin),
			otellog.String("request_id", responseBody.Response.RequestID),
		)
	}
	return nil
}

func (p *TencentCloudProvider) DescribeBasicAuth(ctx context.Context) (DescribeBasicAuthResult, error) {
	telemetry.Info(ctx, telemetry.Logger("shadow/internal/platform/tencentcloud"), "tencentcloud DescribeBasicAuthForSaaS",
		otellog.String("endpoint", p.opts.AccountEndpoint),
		otellog.String("platform", p.opts.Platform),
	)
	client, err := p.accountClient(p.baseCredential())
	if err != nil {
		return DescribeBasicAuthResult{}, err
	}
	req := tcaccount.NewDescribeBasicAuthForSaaSRequest()
	resp, err := client.DescribeBasicAuthForSaaSWithContext(ctx, req)
	if err != nil {
		telemetry.Error(ctx, telemetry.Logger("shadow/internal/platform/tencentcloud"), "tencentcloud DescribeBasicAuthForSaaS failed",
			otellog.String("endpoint", p.opts.AccountEndpoint),
			otellog.String("error", err.Error()),
		)
		return DescribeBasicAuthResult{}, err
	}
	out := DescribeBasicAuthResult{}
	if resp.Response != nil {
		out.AccountOwnerUin = valueInt64(resp.Response.AccountOwnerUin)
		out.AccountType = valueInt64(resp.Response.AccountType)
		out.Name = valueString(resp.Response.Name)
		out.Mobile = valueString(resp.Response.Mobile)
		out.CountryCode = valueString(resp.Response.CountryCode)
		out.IDCard = valueString(resp.Response.Idcard)
		telemetry.Info(ctx, telemetry.Logger("shadow/internal/platform/tencentcloud"), "tencentcloud DescribeBasicAuthForSaaS success",
			otellog.String("endpoint", p.opts.AccountEndpoint),
			otellog.Int64("account_owner_uin", out.AccountOwnerUin),
			otellog.Int64("account_type", out.AccountType),
			otellog.String("request_id", valueString(resp.Response.RequestId)),
		)
	}
	return out, nil
}

func (p *TencentCloudProvider) UpdatePhone(ctx context.Context, in UpdatePhoneInput) error {
	client, err := p.accountClient(p.baseCredential())
	if err != nil {
		return err
	}
	req := tcaccount.NewUpdatePhoneByAuthCodeForSaaSRequest()
	req.OldPhoneCountryCode = common.StringPtr(trimLeadingPlus(in.OldPhoneCountryCode))
	req.OldPhoneNumber = common.StringPtr(in.OldPhoneNumber)
	req.NewPhoneCountryCode = common.StringPtr(trimLeadingPlus(in.NewPhoneCountryCode))
	req.NewPhoneNumber = common.StringPtr(in.NewPhoneNumber)
	req.AuthCode = common.StringPtr(in.AuthCode)
	req.VerifyCode = common.StringPtr(in.VerifyCode)
	req.Platform = common.StringPtr(p.opts.Platform)
	_, err = client.UpdatePhoneByAuthCodeForSaaSWithContext(ctx, req)
	return err
}

func trimLeadingPlus(v string) string {
	if len(v) > 0 && v[0] == '+' {
		return v[1:]
	}
	return v
}

func defaultString(v, fallback string) string {
	if v == "" {
		return fallback
	}
	return v
}

func valueString(v *string) string {
	if v == nil {
		return ""
	}
	return *v
}

func valueUint64(v *uint64) uint64 {
	if v == nil {
		return 0
	}
	return *v
}

func valueInt64(v *int64) int64 {
	if v == nil {
		return 0
	}
	return *v
}
