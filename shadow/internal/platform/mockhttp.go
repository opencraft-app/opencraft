package platform

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
)

type MockHTTPProvider struct {
	opts   TencentCloudOptions
	client *http.Client
}

func NewMockHTTPProvider(opts TencentCloudOptions) (*MockHTTPProvider, error) {
	if opts.Platform == "" {
		return nil, errors.New("missing shadow platform")
	}
	if opts.AccountEndpoint == "" || opts.CAMEndpoint == "" || opts.STSEndpoint == "" {
		return nil, errors.New("missing mock cloud endpoints")
	}
	if opts.RequestTimeout == 0 {
		opts.RequestTimeout = 10 * time.Second
	}
	return &MockHTTPProvider{
		opts:   opts,
		client: &http.Client{Timeout: opts.RequestTimeout},
	}, nil
}

func (p *MockHTTPProvider) SendRegisterSMS(ctx context.Context, in SendRegisterSMSInput) error {
	var resp struct {
		OK bool `json:"ok"`
	}
	return p.post(ctx, p.opts.AccountEndpoint+"/send-sms", map[string]any{
		"platform":     p.opts.Platform,
		"country_code": in.CountryCode,
		"phone_number": in.PhoneNumber,
	}, &resp)
}

func (p *MockHTTPProvider) RegisterShadowAccount(ctx context.Context, in RegisterShadowAccountInput) (RegisterShadowAccountResult, error) {
	var resp struct {
		Uin         int64  `json:"uin"`
		Key         string `json:"key"`
		ExpiredTime int64  `json:"expired_time"`
		RequestID   string `json:"request_id"`
	}
	err := p.post(ctx, p.opts.AccountEndpoint+"/register", map[string]any{
		"platform":          p.opts.Platform,
		"country_code":      in.CountryCode,
		"phone_number":      in.PhoneNumber,
		"phone_verify_code": in.PhoneVerifyCode,
		"user_name":         in.UserName,
	}, &resp)
	if err != nil {
		return RegisterShadowAccountResult{}, err
	}
	return RegisterShadowAccountResult{
		Uin:         resp.Uin,
		Key:         resp.Key,
		ExpiredTime: time.Unix(resp.ExpiredTime, 0),
		RequestID:   resp.RequestID,
	}, nil
}

func (p *MockHTTPProvider) GetAppIDByUin(ctx context.Context, uin int64) (int64, error) {
	var resp struct {
		AppID int64 `json:"appid"`
	}
	if err := p.post(ctx, p.opts.AccountEndpoint+"/get-appid", map[string]any{
		"uin": uin,
	}, &resp); err != nil {
		return 0, err
	}
	return resp.AppID, nil
}

func (p *MockHTTPProvider) GetSaaSTokenByAuthCode(ctx context.Context, authCode, clientIP, clientUA string) (SaaSTokenResult, error) {
	var resp struct {
		Uin         int64  `json:"uin"`
		OwnerUin    int64  `json:"owner_uin"`
		Token       string `json:"token"`
		ExpiredTime int64  `json:"expired_time"`
		RequestID   string `json:"request_id"`
	}
	err := p.post(ctx, p.opts.CAMEndpoint+"/token-by-auth-code", map[string]any{
		"platform":  p.opts.Platform,
		"auth_code": authCode,
		"client_ip": clientIP,
		"client_ua": clientUA,
	}, &resp)
	if err != nil {
		return SaaSTokenResult{}, err
	}
	return SaaSTokenResult{
		Uin:         resp.Uin,
		OwnerUin:    resp.OwnerUin,
		Token:       resp.Token,
		ExpiredTime: time.Unix(resp.ExpiredTime, 0),
		RequestID:   resp.RequestID,
	}, nil
}

func (p *MockHTTPProvider) GetSaaSAccessToken(ctx context.Context, token SaaSTokenResult, clientIP, clientUA string) (TemporaryCredentials, error) {
	var resp struct {
		Token        string `json:"token"`
		TmpSecretID  string `json:"tmp_secret_id"`
		TmpSecretKey string `json:"tmp_secret_key"`
		ExpiredTime  int64  `json:"expired_time"`
		RequestID    string `json:"request_id"`
	}
	err := p.post(ctx, p.opts.STSEndpoint+"/access-token", map[string]any{
		"platform":  p.opts.Platform,
		"token":     token.Token,
		"client_ip": clientIP,
		"client_ua": clientUA,
	}, &resp)
	if err != nil {
		return TemporaryCredentials{}, err
	}
	return TemporaryCredentials{
		Token:        resp.Token,
		TmpSecretID:  resp.TmpSecretID,
		TmpSecretKey: resp.TmpSecretKey,
		ExpiredTime:  time.Unix(resp.ExpiredTime, 0),
		RequestID:    resp.RequestID,
	}, nil
}

func (p *MockHTTPProvider) SaveBasicAuth(ctx context.Context, in SaveBasicAuthInput) error {
	var resp struct {
		OK bool `json:"ok"`
	}
	return p.post(ctx, p.opts.AccountEndpoint+"/save-basic-auth", map[string]any{
		"name": in.Name,
	}, &resp)
}

func (p *MockHTTPProvider) AuthenticateUser(ctx context.Context, in AuthenticateUserInput) error {
	var resp struct {
		OK bool `json:"ok"`
	}
	return p.post(ctx, p.opts.AccountEndpoint+"/authenticate-user", map[string]any{
		"auth_uin":            in.AuthUin,
		"name":                in.Name,
		"type":                in.Type,
		"area":                in.Area,
		"checker":             in.Checker,
		"check_type":          in.CheckType,
		"addr":                in.Addr,
		"idcard_type":         in.IdcardType,
		"idcard":              in.Idcard,
		"contact":             in.Contact,
		"province":            in.Province,
		"city":                in.City,
		"district":            in.District,
		"credit_code":         in.CreditCode,
		"org_code":            in.OrgCode,
		"legal_person_idcard": in.LegalPersonIdcard,
	}, &resp)
}

func (p *MockHTTPProvider) DescribeBasicAuth(ctx context.Context) (DescribeBasicAuthResult, error) {
	var resp struct {
		AccountOwnerUin int64  `json:"account_owner_uin"`
		AccountType     int64  `json:"account_type"`
		Name            string `json:"name"`
		Mobile          string `json:"mobile"`
		CountryCode     string `json:"country_code"`
		IDCard          string `json:"idcard"`
	}
	if err := p.post(ctx, p.opts.AccountEndpoint+"/describe-basic-auth", map[string]any{}, &resp); err != nil {
		return DescribeBasicAuthResult{}, err
	}
	return DescribeBasicAuthResult{
		AccountOwnerUin: resp.AccountOwnerUin,
		AccountType:     resp.AccountType,
		Name:            resp.Name,
		Mobile:          resp.Mobile,
		CountryCode:     resp.CountryCode,
		IDCard:          resp.IDCard,
	}, nil
}

func (p *MockHTTPProvider) UpdatePhone(ctx context.Context, in UpdatePhoneInput) error {
	var resp struct {
		OK bool `json:"ok"`
	}
	return p.post(ctx, p.opts.AccountEndpoint+"/update-phone", map[string]any{
		"platform":               p.opts.Platform,
		"old_phone_country_code": in.OldPhoneCountryCode,
		"old_phone_number":       in.OldPhoneNumber,
		"new_phone_country_code": in.NewPhoneCountryCode,
		"new_phone_number":       in.NewPhoneNumber,
		"auth_code":              in.AuthCode,
		"verify_code":            in.VerifyCode,
	}, &resp)
}

func (p *MockHTTPProvider) post(ctx context.Context, url string, payload any, out any) error {
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := p.client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode/100 != 2 {
		var body struct {
			Error string `json:"error"`
		}
		_ = json.NewDecoder(res.Body).Decode(&body)
		if strings.TrimSpace(body.Error) != "" {
			return errors.New(body.Error)
		}
		return errors.New("mock cloud request failed")
	}
	return json.NewDecoder(res.Body).Decode(out)
}
