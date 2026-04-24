package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"shadow/internal/billing"
	"shadow/internal/httpapi"
	"shadow/internal/platform"
	"shadow/internal/shadow"
	storagesqlite "shadow/internal/storage/sqlite"
	"shadow/internal/telemetry"
)

var testTelemetryMu sync.Mutex

const (
	httpAPITestUserID0 = "usr_00000000-0000-4000-8000-000000000100"
	httpAPITestUserID1 = "usr_00000000-0000-4000-8000-000000000101"
	httpAPITestUserID2 = "usr_00000000-0000-4000-8000-000000000102"
)

type sendSMSErrorCloudProvider struct{}

func (p *sendSMSErrorCloudProvider) SendRegisterSMS(_ context.Context, _ platform.SendRegisterSMSInput) error {
	return errors.New("[TencentCloudSDKError] Code=LimitExceeded.SendFrequency, Message=send message too frequent. code frequent, RequestId=test-request-id")
}

func (p *sendSMSErrorCloudProvider) RegisterShadowAccount(context.Context, platform.RegisterShadowAccountInput) (platform.RegisterShadowAccountResult, error) {
	return platform.RegisterShadowAccountResult{}, nil
}

func (p *sendSMSErrorCloudProvider) GetAppIDByUin(context.Context, int64) (int64, error) {
	return 0, nil
}

func (p *sendSMSErrorCloudProvider) GetSaaSTokenByAuthCode(context.Context, string, string, string) (platform.SaaSTokenResult, error) {
	return platform.SaaSTokenResult{}, nil
}

func (p *sendSMSErrorCloudProvider) GetSaaSAccessToken(context.Context, platform.SaaSTokenResult, string, string) (platform.TemporaryCredentials, error) {
	return platform.TemporaryCredentials{}, nil
}

func (p *sendSMSErrorCloudProvider) SaveBasicAuth(context.Context, platform.SaveBasicAuthInput) error {
	return nil
}

func (p *sendSMSErrorCloudProvider) AuthenticateUser(context.Context, platform.AuthenticateUserInput) error {
	return nil
}

func (p *sendSMSErrorCloudProvider) DescribeBasicAuth(context.Context) (platform.DescribeBasicAuthResult, error) {
	return platform.DescribeBasicAuthResult{}, nil
}

func (p *sendSMSErrorCloudProvider) UpdatePhone(context.Context, platform.UpdatePhoneInput) error {
	return nil
}

func newTestServer(t *testing.T) http.Handler {
	t.Helper()
	store, err := storagesqlite.NewStore(filepath.Join(t.TempDir(), "shadow.db"))
	if err != nil {
		t.Fatalf("new sqlite store: %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Fatalf("close sqlite store: %v", err)
		}
	})
	svc := shadow.NewService(store, platform.NewFakeCloudProvider(), billing.NewFakeProvider(), 10*time.Minute, "shadow_test")
	return httpapi.New(svc).Handler()
}

func TestRegisterAndCallbackAuthCodeOneTime(t *testing.T) {
	logs := captureTelemetryLogs(t)
	handler := newTestServer(t)

	body := map[string]string{
		"user_id":           httpAPITestUserID0,
		"country_code":      "+86",
		"phone_number":      "13800000000",
		"phone_verify_code": "123456",
		"org_name":          "shadow-demo",
		"client_ip":         "127.0.0.1",
		"client_ua":         "go-test",
	}
	raw, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/v1/shadow/register/free-trial", bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("register status=%d body=%s", res.Code, res.Body.String())
	}

	var registerResp struct {
		UserID string `json:"user_id"`
	}
	if err := json.NewDecoder(res.Body).Decode(&registerResp); err != nil {
		t.Fatalf("decode register response: %v", err)
	}

	redirectReq := httptest.NewRequest(http.MethodGet, "/v1/shadow/payment/redirect?user_id="+httpAPITestUserID0+"&mode=renew-instance", nil)
	redirectReq.Header.Set("User-Agent", "go-test")
	redirectRes := httptest.NewRecorder()
	handler.ServeHTTP(redirectRes, redirectReq)
	if redirectRes.Code != http.StatusOK {
		t.Fatalf("redirect status=%d body=%s", redirectRes.Code, redirectRes.Body.String())
	}
	var redirectResp struct {
		Location string `json:"location"`
	}
	if err := json.NewDecoder(redirectRes.Body).Decode(&redirectResp); err != nil {
		t.Fatalf("decode redirect response: %v", err)
	}

	code := extractQueryValue(t, redirectResp.Location, "code")
	callbackPayload := map[string]any{
		"version":       "1.0",
		"caller":        "VERIFY",
		"componentName": "VERIFY",
		"eventId":       "event-1",
		"timestamp":     time.Now().Unix(),
		"interface": map[string]any{
			"interfaceName": "qcloud.saas.checkSaaSAuthCode",
			"para": map[string]any{
				"auth_code": code,
			},
		},
	}
	callbackRaw, _ := json.Marshal(callbackPayload)

	firstReq := httptest.NewRequest(http.MethodPost, "/internal/tencentcloud/account", bytes.NewReader(callbackRaw))
	firstRes := httptest.NewRecorder()
	handler.ServeHTTP(firstRes, firstReq)
	if firstRes.Code != http.StatusOK {
		t.Fatalf("first callback status=%d body=%s", firstRes.Code, firstRes.Body.String())
	}
	if !strings.Contains(firstRes.Body.String(), `"user_id":"`+httpAPITestUserID0+`"`) {
		t.Fatalf("unexpected first callback body=%s", firstRes.Body.String())
	}

	secondReq := httptest.NewRequest(http.MethodPost, "/internal/tencentcloud/account", bytes.NewReader(callbackRaw))
	secondRes := httptest.NewRecorder()
	handler.ServeHTTP(secondRes, secondReq)
	if secondRes.Code != http.StatusOK {
		t.Fatalf("second callback status=%d body=%s", secondRes.Code, secondRes.Body.String())
	}
	if !strings.Contains(secondRes.Body.String(), `"user_id":""`) {
		t.Fatalf("unexpected second callback body=%s", secondRes.Body.String())
	}

	logOutput := logs.String()
	if !strings.Contains(logOutput, `"Value":"tencentcloud callback received"`) {
		t.Fatalf("missing callback received log: %s", logOutput)
	}
	if !strings.Contains(logOutput, `"Key":"interface","Value":{"Type":"String","Value":"qcloud.saas.checkSaaSAuthCode"}`) {
		t.Fatalf("missing callback interface in logs: %s", logOutput)
	}
	if !strings.Contains(logOutput, `"Key":"has_auth_code","Value":{"Type":"Bool","Value":true}`) {
		t.Fatalf("missing auth_code summary in logs: %s", logOutput)
	}
	if !strings.Contains(logOutput, `"Value":"tencentcloud callback success"`) {
		t.Fatalf("missing callback success log: %s", logOutput)
	}
	if !strings.Contains(logOutput, `"Key":"user_id","Value":{"Type":"String","Value":"`+httpAPITestUserID0+`"}`) {
		t.Fatalf("missing callback success log for first consume: %s", logOutput)
	}
	if !strings.Contains(logOutput, `"Key":"user_id","Value":{"Type":"String","Value":""}`) {
		t.Fatalf("missing callback success log for replay consume: %s", logOutput)
	}
}

func TestRedirectContainsJumpLoginShape(t *testing.T) {
	handler := newTestServer(t)

	body := map[string]string{
		"user_id":           httpAPITestUserID1,
		"country_code":      "+86",
		"phone_number":      "13800000001",
		"phone_verify_code": "123456",
		"org_name":          "shadow-demo",
		"client_ip":         "127.0.0.1",
		"client_ua":         "go-test",
	}
	raw, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/v1/shadow/register/free-trial", bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("register status=%d body=%s", res.Code, res.Body.String())
	}

	redirectReq := httptest.NewRequest(http.MethodGet, "/v1/shadow/payment/redirect?user_id="+httpAPITestUserID1+"&mode=console&console=tced", nil)
	redirectReq.Header.Set("User-Agent", "go-test")
	redirectRes := httptest.NewRecorder()
	handler.ServeHTTP(redirectRes, redirectReq)
	if redirectRes.Code != http.StatusOK {
		t.Fatalf("redirect status=%d body=%s", redirectRes.Code, redirectRes.Body.String())
	}
	var payload struct {
		Location string `json:"location"`
	}
	if err := json.NewDecoder(redirectRes.Body).Decode(&payload); err != nil {
		t.Fatalf("decode redirect: %v", err)
	}
	if !strings.HasPrefix(payload.Location, "https://cloud.tencent.com/login/saas/jumpLoginByCode?") {
		t.Fatalf("unexpected location=%s", payload.Location)
	}
	if extractQueryValue(t, payload.Location, "platform") != "shadow_test" {
		t.Fatalf("unexpected platform in %s", payload.Location)
	}
}

func TestCallbackRequiresSharedSecret(t *testing.T) {
	logs := captureTelemetryLogs(t)
	store, err := storagesqlite.NewStore(filepath.Join(t.TempDir(), "shadow.db"))
	if err != nil {
		t.Fatalf("new sqlite store: %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Fatalf("close sqlite store: %v", err)
		}
	})
	svc := shadow.NewService(store, platform.NewFakeCloudProvider(), billing.NewFakeProvider(), 10*time.Minute, "shadow_test")
	handler := httpapi.NewWithOptions(svc, httpapi.Options{CallbackToken: "secret-token"}).Handler()

	payload := map[string]any{
		"version":       "1.0",
		"caller":        "VERIFY",
		"componentName": "VERIFY",
		"eventId":       "event-1",
		"timestamp":     time.Now().Unix(),
		"interface": map[string]any{
			"interfaceName": "qcloud.saas.checkSaaSAccountExist",
			"para": map[string]any{
				"user_id": httpAPITestUserID2,
			},
		},
	}
	raw, _ := json.Marshal(payload)

	req := httptest.NewRequest(http.MethodPost, "/internal/tencentcloud/account", bytes.NewReader(raw))
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	if res.Code != http.StatusForbidden {
		t.Fatalf("expected forbidden without token, got status=%d body=%s", res.Code, res.Body.String())
	}

	authorizedReq := httptest.NewRequest(http.MethodPost, "/internal/tencentcloud/account?token=secret-token", bytes.NewReader(raw))
	authorizedRes := httptest.NewRecorder()
	handler.ServeHTTP(authorizedRes, authorizedReq)
	if authorizedRes.Code != http.StatusOK {
		t.Fatalf("expected success with token, got status=%d body=%s", authorizedRes.Code, authorizedRes.Body.String())
	}
	if !strings.Contains(logs.String(), `"Value":"tencentcloud callback forbidden"`) {
		t.Fatalf("missing forbidden callback log body: %s", logs.String())
	}
	if !strings.Contains(logs.String(), `"Key":"token_present","Value":{"Type":"Bool","Value":false}`) {
		t.Fatalf("missing forbidden callback log: %s", logs.String())
	}
}

func TestSendRegisterSMSReturnsTooManyRequestsOnCloudRateLimit(t *testing.T) {
	store, err := storagesqlite.NewStore(filepath.Join(t.TempDir(), "shadow.db"))
	if err != nil {
		t.Fatalf("new sqlite store: %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Fatalf("close sqlite store: %v", err)
		}
	})
	svc := shadow.NewService(store, &sendSMSErrorCloudProvider{}, billing.NewFakeProvider(), 10*time.Minute, "shadow_test")
	handler := httpapi.New(svc).Handler()

	body := map[string]string{
		"country_code": "86",
		"phone_number": "13800000009",
		"client_ip":    "127.0.0.1",
		"lang":         "zh",
	}
	raw, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/v1/shadow/register/send-sms", bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	if res.Code != http.StatusTooManyRequests {
		t.Fatalf("expected 429, got status=%d body=%s", res.Code, res.Body.String())
	}
	if !strings.Contains(res.Body.String(), "LimitExceeded.SendFrequency") {
		t.Fatalf("unexpected body=%s", res.Body.String())
	}
}

func extractQueryValue(t *testing.T, location, key string) string {
	t.Helper()
	idx := strings.Index(location, "?")
	if idx < 0 {
		t.Fatalf("location has no query: %s", location)
	}
	values := location[idx+1:]
	for _, part := range strings.Split(values, "&") {
		kv := strings.SplitN(part, "=", 2)
		if len(kv) != 2 {
			continue
		}
		if kv[0] == key {
			return kv[1]
		}
	}
	t.Fatalf("missing query key %s in %s", key, location)
	return ""
}

func captureTelemetryLogs(t *testing.T) *bytes.Buffer {
	t.Helper()
	testTelemetryMu.Lock()

	var buf bytes.Buffer
	closeTelemetry, err := telemetry.Init(telemetry.Options{
		ServiceName: "shadowd-test",
		Platform:    "shadow_test",
		Provider:    "fake",
		Writer:      &buf,
	})
	if err != nil {
		testTelemetryMu.Unlock()
		t.Fatalf("init telemetry: %v", err)
	}

	t.Cleanup(func() {
		if err := closeTelemetry(); err != nil {
			t.Fatalf("close telemetry: %v", err)
		}
		testTelemetryMu.Unlock()
	})

	return &buf
}
