package httpapi

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/openclaw/openclaw/mono/backend/auth/internal/service"
	"github.com/openclaw/openclaw/mono/backend/auth/internal/shadowbinding"
)

func TestVerifySmsCodeCompletesPreparedAccountSwitch(t *testing.T) {
	gin.SetMode(gin.TestMode)
	store := service.NewMemoryStore(service.StoreOptions{Now: fixedHTTPTestNow, SeedDefaultInvites: true})
	seed := service.NewWithStore(store, service.Options{
		Now: fixedHTTPTestNow, SessionTTL: 30 * 24 * time.Hour,
		VerificationCodeGenerator: fixedVerificationCode("111111"),
	})
	if _, err := seed.SendVerificationCode(context.Background(), "13800138999"); err != nil {
		t.Fatal(err)
	}
	if _, err := seed.VerifySMS(context.Background(), service.VerifySMSInput{Name: "Phone User", Phone: "13800138999", Code: "111111"}); err != nil {
		t.Fatal(err)
	}
	sender := &httpStubPhoneAuthSMSSender{}
	svc := service.NewWithStore(store, service.Options{
		Now: fixedHTTPTestNow, SessionTTL: 30 * 24 * time.Hour,
		PhoneAuth: service.PhoneAuthConfig{Enabled: true, SMSSender: sender},
	})
	router := NewRouter(svc, ServerConfig{
		CookieSecure: true, CookieSameSite: http.SameSiteNoneMode, SessionTTL: 30 * 24 * time.Hour,
		Federation: newSwitchTestFederationConfig(t),
	})
	oldLogin := performJSONRequest(t, router, http.MethodPost, "/auth/password/sign-up", map[string]any{
		"name": "Old User", "email": "old-phone-switch@example.com", "password": "password123", "inviteCode": "VALID2026",
	})
	oldSession := sessionCookieFromRecorder(t, oldLogin)
	prepare := performJSONRequest(t, router, http.MethodPost, "/auth/federation/switch/prepare", nil, oldSession)
	switchCookie := cookieFromRecorderByName(t, prepare, federationSwitchCookieName)
	if sent := performJSONRequest(t, router, http.MethodPost, "/auth/sms/send", map[string]any{"phone": "13800138999"}); sent.Code != http.StatusOK {
		t.Fatalf("send = %d %s", sent.Code, sent.Body.String())
	}

	verified := performJSONRequest(t, router, http.MethodPost, "/auth/sms/verify", map[string]any{
		"phone": "13800138999", "code": sender.lastCode,
	}, switchCookie)
	if verified.Code != http.StatusOK {
		t.Fatalf("verify = %d %s", verified.Code, verified.Body.String())
	}
	newSession := sessionCookieFromRecorder(t, verified)
	if current := performJSONRequest(t, router, http.MethodGet, "/auth/session", nil, newSession); current.Code != http.StatusOK {
		t.Fatalf("new session is not valid: %d %s", current.Code, current.Body.String())
	}
	if current := performJSONRequest(t, router, http.MethodGet, "/auth/session", nil, oldSession); current.Code != http.StatusUnauthorized {
		t.Fatalf("old session remains valid: %d %s", current.Code, current.Body.String())
	}
	if cleared := cookieFromRecorderByName(t, verified, federationSwitchCookieName); cleared.MaxAge >= 0 {
		t.Fatalf("switch cookie was not cleared: %+v", cleared)
	}
}

func TestVerifySmsCodeAcceptsMissingNameWhenPhoneAuthEnabled(t *testing.T) {
	gin.SetMode(gin.TestMode)

	store := service.NewMemoryStore(service.StoreOptions{
		Now:                fixedHTTPTestNow,
		SeedDefaultInvites: true,
	})
	seedSvc := service.NewWithStore(store, service.Options{
		Now:                       fixedHTTPTestNow,
		SessionTTL:                30 * 24 * time.Hour,
		VerificationCodeGenerator: fixedVerificationCode("111111"),
	})
	if _, err := seedSvc.SendVerificationCode(context.Background(), "13800138133"); err != nil {
		t.Fatalf("seed send failed: %v", err)
	}
	if _, err := seedSvc.VerifySMS(context.Background(), service.VerifySMSInput{
		Name:  "HTTP 原始用户",
		Phone: "13800138133",
		Code:  "111111",
	}); err != nil {
		t.Fatalf("seed verify failed: %v", err)
	}

	sender := &httpStubPhoneAuthSMSSender{}
	shadowSvc := shadowbinding.New(shadowbinding.NewMemoryStore(), &httpRecordingShadowClient{}, shadowbinding.Options{
		Enabled: true,
		Now:     fixedHTTPTestNow,
	})
	svc := service.NewWithStore(store, service.Options{
		Now:        fixedHTTPTestNow,
		SessionTTL: 30 * 24 * time.Hour,
		PhoneAuth: service.PhoneAuthConfig{
			Enabled:   true,
			SMSSender: sender,
		},
		ShadowBinding: shadowSvc,
	})
	router := NewRouter(svc, ServerConfig{
		CookieSecure:   true,
		CookieSameSite: http.SameSiteNoneMode,
		SessionTTL:     30 * 24 * time.Hour,
		PublicBaseURL:  "https://lightclaw.tech",
		AdminToken:     testAdminToken,
	})

	sendCode := performJSONRequest(t, router, http.MethodPost, "/auth/sms/send", map[string]any{
		"phone": "13800138133",
	})
	if sendCode.Code != http.StatusOK {
		t.Fatalf("expected 200 from send sms, got %d: %s", sendCode.Code, sendCode.Body.String())
	}

	recorder := performJSONRequest(t, router, http.MethodPost, "/auth/sms/verify", map[string]any{
		"phone": "13800138133",
		"code":  sender.lastCode,
	})
	if recorder.Code != http.StatusOK {
		t.Fatalf("expected 200 without name, got %d: %s", recorder.Code, recorder.Body.String())
	}

	var response sessionResponseBody
	decodeJSONResponse(t, recorder, &response)
	if response.Session.User == nil || response.Session.User.Name != "HTTP 原始用户" {
		t.Fatalf("expected existing user to keep original name, got %+v", response.Session.User)
	}
}

func TestVerifySmsCodePassesClientMetadataToNewUserShadowRegistration(t *testing.T) {
	gin.SetMode(gin.TestMode)

	store := service.NewMemoryStore(service.StoreOptions{
		Now:                fixedHTTPTestNow,
		SeedDefaultInvites: true,
	})
	shadowClient := &phoneAuthRecordingShadowClient{}
	shadowSvc := shadowbinding.New(shadowbinding.NewMemoryStore(), shadowClient, shadowbinding.Options{
		Enabled: true,
		Now:     fixedHTTPTestNow,
	})
	svc := service.NewWithStore(store, service.Options{
		Now:        fixedHTTPTestNow,
		SessionTTL: 30 * 24 * time.Hour,
		PhoneAuth: service.PhoneAuthConfig{
			Enabled:   true,
			SMSSender: &httpStubPhoneAuthSMSSender{},
		},
		ShadowBinding: shadowSvc,
	})
	router := NewRouter(svc, ServerConfig{
		CookieSecure:   true,
		CookieSameSite: http.SameSiteNoneMode,
		SessionTTL:     30 * 24 * time.Hour,
		PublicBaseURL:  "https://lightclaw.tech",
		AdminToken:     testAdminToken,
	})

	sendCode := performJSONRequest(t, router, http.MethodPost, "/auth/sms/send", map[string]any{
		"phone": "13800138137",
	})
	if sendCode.Code != http.StatusOK {
		t.Fatalf("expected 200 from send sms, got %d: %s", sendCode.Code, sendCode.Body.String())
	}

	recorder := performJSONRequestWithHeaders(t, router, http.MethodPost, "/auth/sms/verify", map[string]any{
		"phone": "13800138137",
		"code":  "888888",
	}, map[string]string{
		"User-Agent": "lightvela-phone-auth-test/1.0",
	})
	if recorder.Code != http.StatusOK {
		t.Fatalf("expected 200 from verify sms, got %d: %s", recorder.Code, recorder.Body.String())
	}
	if shadowClient.lastRegister.ClientIP != "192.0.2.1" {
		t.Fatalf("expected request client IP in shadow registration, got %+v", shadowClient.lastRegister)
	}
	if shadowClient.lastRegister.ClientUA != "lightvela-phone-auth-test/1.0" {
		t.Fatalf("expected request user agent in shadow registration, got %+v", shadowClient.lastRegister)
	}
}

type httpStubPhoneAuthSMSSender struct {
	lastCode string
}

func (s *httpStubPhoneAuthSMSSender) SendVerificationCode(_ context.Context, _ string, code string, _ int) error {
	s.lastCode = code
	return nil
}

type phoneAuthRecordingShadowClient struct {
	lastRegister shadowbinding.CloudRegisterInput
}

func (c *phoneAuthRecordingShadowClient) SendSMSVerifyCode(context.Context, shadowbinding.CloudSendSMSInput) error {
	return nil
}

func (c *phoneAuthRecordingShadowClient) RegisterShadowAccount(_ context.Context, input shadowbinding.CloudRegisterInput) (shadowbinding.CloudRegisterResult, error) {
	c.lastRegister = input
	return shadowbinding.CloudRegisterResult{Uin: 300000000071, OwnerUin: 300000000071, AppID: 1250000000}, nil
}

func (c *phoneAuthRecordingShadowClient) UpdatePhoneByAuthCode(context.Context, shadowbinding.CloudUpdatePhoneInput) error {
	return nil
}

func (c *phoneAuthRecordingShadowClient) SaveBasicAuthForSaaS(context.Context, shadowbinding.CloudSaveBasicAuthInput) error {
	return nil
}
