package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/openclaw/openclaw/mono/backend/auth/internal/service"
	"github.com/openclaw/openclaw/mono/backend/auth/internal/shadowbinding"
)

type httpTestShadowClient struct{}

func (httpTestShadowClient) SendSMSVerifyCode(context.Context, shadowbinding.CloudSendSMSInput) error {
	return nil
}

func (httpTestShadowClient) RegisterShadowAccount(context.Context, shadowbinding.CloudRegisterInput) (shadowbinding.CloudRegisterResult, error) {
	return shadowbinding.CloudRegisterResult{Uin: 300000000053, OwnerUin: 300000000053, AppID: 1250000000}, nil
}

func (httpTestShadowClient) UpdatePhoneByAuthCode(context.Context, shadowbinding.CloudUpdatePhoneInput) error {
	return nil
}

func (httpTestShadowClient) SaveBasicAuthForSaaS(context.Context, shadowbinding.CloudSaveBasicAuthInput) error {
	return nil
}

func (httpTestShadowClient) GetTemporaryCredentialsForSaaS(context.Context, shadowbinding.CloudTemporaryCredentialsInput) (shadowbinding.CloudTemporaryCredentials, error) {
	return shadowbinding.CloudTemporaryCredentials{
		Uin:          300000000053,
		OwnerUin:     300000000053,
		Token:        "tmp-token",
		TmpSecretID:  "tmp-id",
		TmpSecretKey: "tmp-key",
		ExpiredTime:  fixedHTTPTestNow().Add(time.Hour),
		RequestID:    "sts-request-id",
	}, nil
}

type httpRecordingShadowClient struct {
	basicAuthCalls int
	basicAuthErr   error
}

type httpBillingClient struct {
	result shadowbinding.BillingAccountResult
	err    error
	calls  int
}

func (c *httpBillingClient) EnsureBillingAccount(context.Context, int64) (shadowbinding.BillingAccountResult, error) {
	c.calls++
	return c.result, c.err
}

func (c *httpRecordingShadowClient) SendSMSVerifyCode(context.Context, shadowbinding.CloudSendSMSInput) error {
	return nil
}

func (c *httpRecordingShadowClient) RegisterShadowAccount(context.Context, shadowbinding.CloudRegisterInput) (shadowbinding.CloudRegisterResult, error) {
	return shadowbinding.CloudRegisterResult{Uin: 300000000053, OwnerUin: 300000000053, AppID: 1250000000}, nil
}

func (c *httpRecordingShadowClient) UpdatePhoneByAuthCode(context.Context, shadowbinding.CloudUpdatePhoneInput) error {
	return nil
}

func (c *httpRecordingShadowClient) SaveBasicAuthForSaaS(context.Context, shadowbinding.CloudSaveBasicAuthInput) error {
	c.basicAuthCalls++
	return c.basicAuthErr
}

func TestInternalShadowCredentialsRequiresTokenAndReturnsTemporaryCredentials(t *testing.T) {
	t.Parallel()

	router, svc, _ := newShadowBindingHTTPTestRouter()
	_, userID := completePhone3FAHTTPFlow(t, router, svc)
	body := map[string]any{"external_user_id": userID, "client_ip": "10.0.0.1", "client_ua": "lightvela-trade"}

	unauthorized := performJSONRequest(t, router, http.MethodPost, "/internal/shadow/credentials", body)
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("expected credentials endpoint to require token, got %d: %s", unauthorized.Code, unauthorized.Body.String())
	}

	req := newJSONRequest(t, http.MethodPost, "/internal/shadow/credentials", body)
	req.Header.Set("Authorization", "Bearer shadow-internal-token")
	response := performRequest(router, req)
	if response.Code != http.StatusOK {
		t.Fatalf("expected credentials endpoint 200, got %d: %s", response.Code, response.Body.String())
	}
	if !stringsContainsAll(response.Body.String(),
		`"code":"OK"`,
		`"uin":300000000053`,
		`"owner_uin":300000000053`,
		`"tmp_secret_id":"tmp-id"`,
		`"tmp_secret_key":"tmp-key"`,
		`"token":"tmp-token"`,
		`"expired_at":"2026-03-20T11:00:00Z"`,
	) {
		t.Fatalf("unexpected credentials response: %s", response.Body.String())
	}
}

func TestInternalShadowBindingAndTencentCloudCallback(t *testing.T) {
	t.Parallel()

	router, svc, shadowSvc := newShadowBindingHTTPTestRouter()
	sessionCookie, userID := completePhone3FAHTTPFlow(t, router, svc)

	publicBinding := performJSONRequest(t, router, http.MethodGet, "/auth/shadow/binding", nil, sessionCookie)
	if publicBinding.Code != http.StatusOK {
		t.Fatalf("expected public binding 200, got %d: %s", publicBinding.Code, publicBinding.Body.String())
	}
	if !stringsContainsAll(publicBinding.Body.String(), `"status":"active"`, `"uin":300000000053`) {
		t.Fatalf("unexpected public binding body: %s", publicBinding.Body.String())
	}
	if !stringsContainsAll(publicBinding.Body.String(), `"basicAuthStatus":"succeeded"`, `"basicAuthSyncedAt"`) {
		t.Fatalf("expected public binding to expose basic auth debug fields: %s", publicBinding.Body.String())
	}

	unauthorized := performJSONRequest(t, router, http.MethodGet, "/internal/shadow/binding?user_id="+userID, nil)
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("expected internal binding to require token, got %d: %s", unauthorized.Code, unauthorized.Body.String())
	}

	req := newJSONRequest(t, http.MethodGet, "/internal/shadow/binding?external_user_id="+userID, nil)
	req.Header.Set("Authorization", "Bearer shadow-internal-token")
	internalBinding := performRequest(router, req)
	if internalBinding.Code != http.StatusOK {
		t.Fatalf("expected internal binding 200, got %d: %s", internalBinding.Code, internalBinding.Body.String())
	}
	if !stringsContainsAll(internalBinding.Body.String(), `"code":"OK"`, `"user_id":"`+userID+`"`, `"app_id":1250000000`) {
		t.Fatalf("unexpected internal binding body: %s", internalBinding.Body.String())
	}

	code, err := shadowSvc.IssueAuthCode(context.Background(), userID, shadowbinding.AuthCodePurposeSaaSCallback)
	if err != nil {
		t.Fatalf("issue auth code: %v", err)
	}
	binding, err := shadowSvc.GetBindingByUserID(context.Background(), userID)
	if err != nil {
		t.Fatalf("get shadow binding: %v", err)
	}
	callbackBody := map[string]any{
		"version":       "1.0",
		"caller":        "VERIFY",
		"componentName": "VERIFY",
		"eventId":       4962132,
		"timestamp":     fixedHTTPTestNow().Unix(),
		"interface": map[string]any{
			"interfaceName": "qcloud.saas.checkSaaSAuthCode",
			"para": map[string]any{
				"auth_code": code.Code,
			},
		},
	}
	callbackReq := newJSONRequest(t, http.MethodPost, "/internal/tencentcloud/account?token=callback-token", callbackBody)
	callback := performRequest(router, callbackReq)
	if callback.Code != http.StatusOK {
		t.Fatalf("expected callback 200, got %d: %s", callback.Code, callback.Body.String())
	}
	if !stringsContainsAll(callback.Body.String(), `"returnCode":0`, `"user_id":"`+binding.ShadowUserName+`"`) {
		t.Fatalf("unexpected callback body: %s", callback.Body.String())
	}

	replayReq := newJSONRequest(t, http.MethodPost, "/internal/tencentcloud/account", callbackBody)
	replayReq.Header.Set("X-Shadow-Callback-Token", "callback-token")
	replay := performRequest(router, replayReq)
	if replay.Code != http.StatusOK {
		t.Fatalf("expected replay callback 200, got %d: %s", replay.Code, replay.Body.String())
	}
	if !stringsContainsAll(replay.Body.String(), `"returnCode":0`, `"user_id":""`) {
		t.Fatalf("unexpected replay callback body: %s", replay.Body.String())
	}

	prefixedBody := map[string]any{
		"interface": map[string]any{
			"interfaceName": "qcloud.saas.checkSaaSAccountExist",
			"para":          map[string]any{"user_id": userID},
		},
	}
	prefixedReq := newJSONRequest(t, http.MethodPost, "/auth/internal/tencentcloud/account", prefixedBody)
	prefixedReq.Header.Set("X-Shadow-Callback-Token", "callback-token")
	prefixed := performRequest(router, prefixedReq)
	if prefixed.Code != http.StatusOK {
		t.Fatalf("expected prefixed callback 200, got %d: %s", prefixed.Code, prefixed.Body.String())
	}
	if !stringsContainsAll(prefixed.Body.String(), `"returnCode":0`, `"exist":true`) {
		t.Fatalf("unexpected prefixed callback body: %s", prefixed.Body.String())
	}
}

func TestInternalShadowBillingRetryReturnsRegisteredIdentityUntilActive(t *testing.T) {
	gin.SetMode(gin.TestMode)
	authStore := service.NewMemoryStore(service.StoreOptions{Now: fixedHTTPTestNow, SeedDefaultInvites: true})
	billing := &httpBillingClient{err: errors.New("billing base info unavailable")}
	shadowSvc := shadowbinding.New(shadowbinding.NewMemoryStore(), httpTestShadowClient{}, shadowbinding.Options{
		Enabled:        true,
		Now:            fixedHTTPTestNow,
		SiteKind:       shadowbinding.SiteKindIntl,
		BillingAccount: billing,
		RunAsync:       func(task func()) { task() },
	})
	svc := service.NewWithStore(authStore, service.Options{
		Now:           fixedHTTPTestNow,
		SessionTTL:    30 * 24 * time.Hour,
		SiteKind:      shadowbinding.SiteKindIntl,
		ShadowBinding: shadowSvc,
	})
	router := NewRouter(svc, ServerConfig{
		SessionTTL:                 30 * 24 * time.Hour,
		ShadowBindingInternalToken: "shadow-internal-token",
	})
	const userID = "usr_intl_billing_retry"
	pending, err := shadowSvc.BindShadowAccount(context.Background(), shadowbinding.BindInput{
		UserID: userID,
		Email:  "verified@example.com",
	})
	if err != nil || pending.Status != shadowbinding.StatusPending {
		t.Fatalf("registration should return pending: binding=%+v err=%v", pending, err)
	}
	failed, err := shadowSvc.GetBindingByUserID(context.Background(), userID)
	if err != nil || failed.LastErrorCode != "billing_account_open_failed" {
		t.Fatalf("seed async billing failure: binding=%+v err=%v", failed, err)
	}

	unauthorized := performJSONRequest(t, router, http.MethodPost, "/internal/shadow/binding/retry", map[string]any{"external_user_id": userID})
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("expected retry endpoint to require token, got %d: %s", unauthorized.Code, unauthorized.Body.String())
	}

	stateReq := newJSONRequest(t, http.MethodGet, "/internal/shadow/binding/state?external_user_id="+userID, nil)
	stateReq.Header.Set("Authorization", "Bearer shadow-internal-token")
	state := performRequest(router, stateReq)
	if state.Code != http.StatusOK || !stringsContainsAll(state.Body.String(),
		`"status":"failed"`,
		`"last_error_code":"billing_account_open_failed"`,
		`"uin":300000000053`,
		`"app_id":1250000000`,
	) {
		t.Fatalf("unexpected failed binding state: %d %s", state.Code, state.Body.String())
	}

	retryReq := newJSONRequest(t, http.MethodPost, "/internal/shadow/binding/retry", map[string]any{"external_user_id": userID})
	retryReq.Header.Set("Authorization", "Bearer shadow-internal-token")
	retryFailed := performRequest(router, retryReq)
	if retryFailed.Code != http.StatusOK || !stringsContainsAll(retryFailed.Body.String(),
		`"status":"failed"`,
		`"last_error_code":"billing_account_open_failed"`,
		`"uin":300000000053`,
	) {
		t.Fatalf("retry failure must retain registered identity: %d %s", retryFailed.Code, retryFailed.Body.String())
	}

	billing.err = nil
	billing.result = shadowbinding.BillingAccountResult{IsOpen: true}
	retryReq = newJSONRequest(t, http.MethodPost, "/internal/shadow/binding/retry", map[string]any{"external_user_id": userID})
	retryReq.Header.Set("Authorization", "Bearer shadow-internal-token")
	retryActive := performRequest(router, retryReq)
	if retryActive.Code != http.StatusOK || !stringsContainsAll(retryActive.Body.String(), `"status":"active"`, `"uin":300000000053`) {
		t.Fatalf("expected active binding after retry: %d %s", retryActive.Code, retryActive.Body.String())
	}
	if billing.calls != 3 {
		t.Fatalf("expected initial open plus two retries, calls=%d", billing.calls)
	}
}

func TestRetryRealnameSyncRoutePromotesFailedBasicAuthSync(t *testing.T) {
	client := &httpRecordingShadowClient{
		basicAuthErr: errors.New("save basic auth failed"),
	}
	router, svc, shadowSvc := newShadowBindingHTTPTestRouterWithClient(client)

	phone := "13800138001"
	sendLogin := performJSONRequest(t, router, http.MethodPost, "/auth/sms/send", map[string]any{"phone": phone})
	if sendLogin.Code != http.StatusOK {
		t.Fatalf("send login sms failed: %d %s", sendLogin.Code, sendLogin.Body.String())
	}
	loginCode := mustHTTPCurrentSMSCode(t, svc, phone)
	login := performJSONRequest(t, router, http.MethodPost, "/auth/sms/verify", map[string]any{"name": "测试用户", "phone": phone, "code": loginCode})
	if login.Code != http.StatusOK {
		t.Fatalf("login sms verify failed: %d %s", login.Code, login.Body.String())
	}
	sessionCookie := findSetCookie(t, login, sessionCookieName)
	var loginBody sessionResponseBody
	decodeJSONResponse(t, login, &loginBody)
	if loginBody.Session.User == nil {
		t.Fatal("expected login user")
	}
	if _, err := shadowSvc.BindShadowAccount(context.Background(), shadowbinding.BindInput{
		UserID:     loginBody.Session.User.ID,
		Phone:      phone,
		VerifyCode: "888888",
	}); err != nil {
		t.Fatalf("seed active shadow binding: %v", err)
	}

	realname := performJSONRequest(t, router, http.MethodPost, "/auth/realname/verify", map[string]any{"name": "张三", "idCard": "11010519491231002X"}, sessionCookie)
	if realname.Code != http.StatusOK {
		t.Fatalf("realname should keep local success: %d %s", realname.Code, realname.Body.String())
	}
	current := performJSONRequest(t, router, http.MethodGet, "/auth/session", nil, sessionCookie)
	if current.Code != http.StatusOK {
		t.Fatalf("current session failed: %d %s", current.Code, current.Body.String())
	}
	if !stringsContainsAll(current.Body.String(), `"realnameLevel":"idcard_2fa"`, `"realnameSyncStatus":"failed"`) {
		t.Fatalf("expected failed sync status in session: %s", current.Body.String())
	}

	client.basicAuthErr = nil
	retry := performJSONRequest(t, router, http.MethodPost, "/auth/realname/sync/retry", nil, sessionCookie)
	if retry.Code != http.StatusOK {
		t.Fatalf("retry realname sync failed: %d %s", retry.Code, retry.Body.String())
	}
	if !stringsContainsAll(retry.Body.String(), `"realnameLevel":"phone_3fa"`, `"realnameSyncStatus":"succeeded"`, `"shadowBindingStatus":"active"`) {
		t.Fatalf("unexpected retry response: %s", retry.Body.String())
	}
	if client.basicAuthCalls < 2 {
		t.Fatalf("expected retry to call basic auth again, calls=%d", client.basicAuthCalls)
	}
}

func TestShadowBindingVerifyPhoneRouteBindsCurrentSessionUser(t *testing.T) {
	t.Parallel()

	router, svc, _ := newShadowBindingHTTPTestRouter()
	phone := "13800138000"
	sendLogin := performJSONRequest(t, router, http.MethodPost, "/auth/sms/send", map[string]any{"phone": phone})
	if sendLogin.Code != http.StatusOK {
		t.Fatalf("send login sms failed: %d %s", sendLogin.Code, sendLogin.Body.String())
	}
	loginCode := mustHTTPCurrentSMSCode(t, svc, phone)
	login := performJSONRequest(t, router, http.MethodPost, "/auth/sms/verify", map[string]any{"name": "测试用户", "phone": phone, "code": loginCode})
	if login.Code != http.StatusOK {
		t.Fatalf("login sms verify failed: %d %s", login.Code, login.Body.String())
	}
	sessionCookie := findSetCookie(t, login, sessionCookieName)
	var loginBody sessionResponseBody
	decodeJSONResponse(t, login, &loginBody)
	if loginBody.Session.User == nil {
		t.Fatal("expected login response user")
	}
	userID := loginBody.Session.User.ID

	realname := performJSONRequest(t, router, http.MethodPost, "/auth/realname/verify", map[string]any{"name": "张三", "idCard": "11010519491231002X"}, sessionCookie)
	if realname.Code != http.StatusOK {
		t.Fatalf("realname failed: %d %s", realname.Code, realname.Body.String())
	}
	sendPhone := performJSONRequest(t, router, http.MethodPost, "/v1/shadow/binding/send-sms", map[string]any{
		"country_code": "86",
		"phone_number": phone,
		"lang":         "zh",
	})
	if sendPhone.Code != http.StatusOK {
		t.Fatalf("send shadow binding sms failed: %d %s", sendPhone.Code, sendPhone.Body.String())
	}
	phoneCode := mustHTTPCurrentSMSCode(t, svc, phone)

	legacy := performJSONRequest(t, router, http.MethodPost, "/v1/shadow/binding/verify-phone", map[string]any{
		"country_code":      "86",
		"phone_number":      phone,
		"phone_verify_code": phoneCode,
	}, sessionCookie)
	if legacy.Code != http.StatusOK {
		t.Fatalf("expected shadow binding verify-phone route 200, got %d: %s", legacy.Code, legacy.Body.String())
	}
	if !stringsContainsAll(legacy.Body.String(), `"ok":true`, `"realname_level":"phone_3fa"`, `"shadow_binding_status":"active"`, `"user_id":"`+userID+`"`) {
		t.Fatalf("unexpected shadow binding verify-phone body: %s", legacy.Body.String())
	}

	binding := performJSONRequest(t, router, http.MethodGet, "/auth/shadow/binding", nil, sessionCookie)
	if binding.Code != http.StatusOK {
		t.Fatalf("expected public binding 200, got %d: %s", binding.Code, binding.Body.String())
	}
	if !stringsContainsAll(binding.Body.String(), `"status":"active"`, `"userId":"`+userID+`"`) {
		t.Fatalf("unexpected public binding body: %s", binding.Body.String())
	}
}

func TestShadowRegisterCompatibilityRoutesAreRemoved(t *testing.T) {
	t.Parallel()

	router, _, _ := newShadowBindingHTTPTestRouter()

	sendSMS := performJSONRequest(t, router, http.MethodPost, "/v1/shadow/register/send-sms", map[string]any{
		"country_code": "86",
		"phone_number": "13800138000",
		"lang":         "zh",
	})
	if sendSMS.Code != http.StatusNotFound {
		t.Fatalf("expected register/send-sms route to be removed, got %d: %s", sendSMS.Code, sendSMS.Body.String())
	}

	freeTrial := performJSONRequest(t, router, http.MethodPost, "/v1/shadow/register/free-trial", map[string]any{
		"country_code":      "86",
		"phone_number":      "13800138000",
		"phone_verify_code": "123456",
	})
	if freeTrial.Code != http.StatusNotFound {
		t.Fatalf("expected register/free-trial route to be removed, got %d: %s", freeTrial.Code, freeTrial.Body.String())
	}
}

func TestInternalShadowRoutesRejectWhenTokensAreUnset(t *testing.T) {
	t.Parallel()

	gin.SetMode(gin.TestMode)
	store := service.NewMemoryStore(service.StoreOptions{Now: fixedHTTPTestNow, SeedDefaultInvites: true})
	svc := service.NewWithStore(store, service.Options{Now: fixedHTTPTestNow})
	router := NewRouter(svc, ServerConfig{SessionTTL: 30 * 24 * time.Hour})

	binding := performJSONRequest(t, router, http.MethodGet, "/internal/shadow/binding?user_id=user-1", nil)
	if binding.Code != http.StatusUnauthorized {
		t.Fatalf("expected missing internal token to deny binding lookup, got %d: %s", binding.Code, binding.Body.String())
	}
	paymentContext := performJSONRequest(t, router, http.MethodPost, "/internal/payment-methods/context", map[string]any{"external_user_id": "user-1"})
	if paymentContext.Code != http.StatusUnauthorized {
		t.Fatalf("expected missing internal token to deny payment context lookup, got %d: %s", paymentContext.Code, paymentContext.Body.String())
	}

	callback := performJSONRequest(t, router, http.MethodPost, "/internal/tencentcloud/account", map[string]any{
		"interface": map[string]any{"interfaceName": "qcloud.saas.checkSaaSAccountExist", "para": map[string]any{"user_id": "user-1"}},
	})
	if callback.Code != http.StatusForbidden {
		t.Fatalf("expected missing callback token to deny Tencent callback, got %d: %s", callback.Code, callback.Body.String())
	}
}

func newShadowBindingHTTPTestRouter() (*gin.Engine, *service.Service, *shadowbinding.Service) {
	return newShadowBindingHTTPTestRouterWithClient(httpTestShadowClient{})
}

func newShadowBindingHTTPTestRouterWithClient(client shadowbinding.TencentCloudClient) (*gin.Engine, *service.Service, *shadowbinding.Service) {
	gin.SetMode(gin.TestMode)
	store := service.NewMemoryStore(service.StoreOptions{Now: fixedHTTPTestNow, SeedDefaultInvites: true})
	shadowSvc := shadowbinding.New(shadowbinding.NewMemoryStore(), client, shadowbinding.Options{Enabled: true, Now: fixedHTTPTestNow})
	svc := service.NewWithStore(store, service.Options{
		Now:                        fixedHTTPTestNow,
		SessionTTL:                 30 * 24 * time.Hour,
		RealnameVerifier:           httpStubRealnameVerifier{},
		RealnameCipher:             httpStubRealnameCipher{},
		ShadowBinding:              shadowSvc,
		ShadowBasicAuthSyncEnabled: true,
	})
	router := NewRouter(svc, ServerConfig{
		CookieSecure:               true,
		CookieSameSite:             http.SameSiteNoneMode,
		SessionTTL:                 30 * 24 * time.Hour,
		PublicBaseURL:              "https://lightclaw.tech",
		ShadowBindingInternalToken: "shadow-internal-token",
		ShadowTencentCallbackToken: "callback-token",
	})
	return router, svc, shadowSvc
}

func completePhone3FAHTTPFlow(t *testing.T, router http.Handler, svc *service.Service) (*http.Cookie, string) {
	t.Helper()
	phone := "13800138000"
	sendLogin := performJSONRequest(t, router, http.MethodPost, "/auth/sms/send", map[string]any{"phone": phone})
	if sendLogin.Code != http.StatusOK {
		t.Fatalf("send login sms failed: %d %s", sendLogin.Code, sendLogin.Body.String())
	}
	loginCode := mustHTTPCurrentSMSCode(t, svc, phone)
	login := performJSONRequest(t, router, http.MethodPost, "/auth/sms/verify", map[string]any{"name": "测试用户", "phone": phone, "code": loginCode})
	if login.Code != http.StatusOK {
		t.Fatalf("login sms verify failed: %d %s", login.Code, login.Body.String())
	}
	sessionCookie := findSetCookie(t, login, sessionCookieName)
	var loginBody sessionResponseBody
	decodeJSONResponse(t, login, &loginBody)
	if loginBody.Session.User == nil {
		t.Fatal("expected login response user")
	}

	realname := performJSONRequest(t, router, http.MethodPost, "/auth/realname/verify", map[string]any{"name": "张三", "idCard": "11010519491231002X"}, sessionCookie)
	if realname.Code != http.StatusOK {
		t.Fatalf("realname failed: %d %s", realname.Code, realname.Body.String())
	}
	sendPhone := performJSONRequest(t, router, http.MethodPost, "/auth/sms/send", map[string]any{"phone": phone})
	if sendPhone.Code != http.StatusOK {
		t.Fatalf("send 3fa sms failed: %d %s", sendPhone.Code, sendPhone.Body.String())
	}
	phoneCode := mustHTTPCurrentSMSCode(t, svc, phone)
	verifyPhone := performJSONRequest(t, router, http.MethodPost, "/auth/realname/verify-phone", map[string]any{"code": phoneCode}, sessionCookie)
	if verifyPhone.Code != http.StatusOK {
		t.Fatalf("verify phone failed: %d %s", verifyPhone.Code, verifyPhone.Body.String())
	}
	return sessionCookie, loginBody.Session.User.ID
}

func mustHTTPCurrentSMSCode(t *testing.T, svc *service.Service, phone string) string {
	t.Helper()
	items, err := svc.ListAdminSMSChallenges(context.Background(), phone, 10)
	if err != nil {
		t.Fatalf("list sms challenges: %v", err)
	}
	for _, item := range items {
		if item.Phone == phone {
			return item.Code
		}
	}
	t.Fatalf("sms challenge for %s not found", phone)
	return ""
}

func newJSONRequest(t *testing.T, method string, path string, body map[string]any) *http.Request {
	t.Helper()
	var payload []byte
	if body != nil {
		var err error
		payload, err = json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal request: %v", err)
		}
	}
	req := httptest.NewRequest(method, path, bytes.NewReader(payload))
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	return req
}

func performRequest(router http.Handler, req *http.Request) *httptest.ResponseRecorder {
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, req)
	return recorder
}

func stringsContainsAll(value string, needles ...string) bool {
	for _, needle := range needles {
		if !strings.Contains(value, needle) {
			return false
		}
	}
	return true
}
