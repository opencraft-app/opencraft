package app_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"shadow/internal/app"
	"shadow/internal/config"
	"shadow/internal/mockcloud"
)

const (
	appMockUserID100 = "usr_00000000-0000-4000-8000-000000000200"
)

func TestE2E_MockCloudBackend_RegisterRedirectAndUpdatePhone(t *testing.T) {
	backend := mockcloud.NewBackend("shadow_test")
	backendServer := httptest.NewServer(backend.Handler())
	defer backendServer.Close()

	dbPath := filepath.Join(t.TempDir(), "shadow.db")
	cfg := config.Config{
		Provider:            "mock",
		BillingMode:         "http",
		ShadowPlatform:      "shadow_test",
		CallbackToken:       "callback-secret",
		AuthCodeTTL:         10 * time.Minute,
		StorageDSN:          dbPath,
		AccountEndpoint:     backendServer.URL + "/account",
		CAMEndpoint:         backendServer.URL + "/cam",
		STSEndpoint:         backendServer.URL + "/sts",
		BillingEndpoint:     backendServer.URL + "/billing/interfaces/interface.php",
		DianshiEndpoint:     backendServer.URL + "/dianshi/activity_web/activity/do_goods",
		RecoveryEndpoint:    backendServer.URL + "/recovery/free-trial",
		FreeTrialActivityID: "15152",
		FreeTrialActID:      "134393",
		SubProductCode:      "sp_tced_saas",
	}

	shadowApp, err := app.New(cfg)
	if err != nil {
		t.Fatalf("new app: %v", err)
	}
	defer func() {
		if err := shadowApp.Close(); err != nil {
			t.Fatalf("close app: %v", err)
		}
	}()
	shadowServer := httptest.NewServer(shadowApp.Handler())
	defer shadowServer.Close()

	backend.SetCallbackURL(shadowServer.URL + "/internal/tencentcloud/account?token=callback-secret")

	sendSMSRes := postJSONForMockCloudE2E(t, shadowServer.URL+"/v1/shadow/register/send-sms", map[string]any{
		"country_code": "+86",
		"phone_number": "13800000100",
		"client_ip":    "127.0.0.1",
		"lang":         "zh",
	})
	if sendSMSRes.StatusCode != http.StatusNoContent {
		t.Fatalf("send register sms status=%d body=%s", sendSMSRes.StatusCode, readBodyForMockCloudE2E(t, sendSMSRes))
	}
	registerCode, ok := backend.SMSCode("+86", "13800000100")
	if !ok {
		t.Fatalf("missing register sms code")
	}

	registerRes := postJSONForMockCloudE2E(t, shadowServer.URL+"/v1/shadow/register/free-trial", map[string]any{
		"user_id":           appMockUserID100,
		"country_code":      "+86",
		"phone_number":      "13800000100",
		"phone_verify_code": registerCode,
		"org_name":          "shadow-demo",
		"client_ip":         "127.0.0.1",
		"client_ua":         "mockcloud-e2e",
	})
	if registerRes.StatusCode != http.StatusOK {
		t.Fatalf("register status=%d body=%s", registerRes.StatusCode, readBodyForMockCloudE2E(t, registerRes))
	}
	var registerPayload struct {
		UserID     string `json:"user_id"`
		AppID      int64  `json:"appid"`
		InstanceID string `json:"instance_id"`
	}
	decodeJSONForMockCloudE2E(t, registerRes, &registerPayload)
	if registerPayload.UserID != appMockUserID100 || registerPayload.AppID == 0 || registerPayload.InstanceID == "" {
		t.Fatalf("unexpected register payload=%+v", registerPayload)
	}

	redirectRes, err := http.Get(shadowServer.URL + "/v1/shadow/payment/redirect?user_id=" + appMockUserID100 + "&mode=renew-instance")
	if err != nil {
		t.Fatalf("get redirect: %v", err)
	}
	if redirectRes.StatusCode != http.StatusOK {
		t.Fatalf("redirect status=%d body=%s", redirectRes.StatusCode, readBodyForMockCloudE2E(t, redirectRes))
	}
	var redirectPayload struct {
		Location string `json:"location"`
	}
	decodeJSONForMockCloudE2E(t, redirectRes, &redirectPayload)
	if !strings.Contains(redirectPayload.Location, "jumpLoginByCode") {
		t.Fatalf("unexpected redirect location=%s", redirectPayload.Location)
	}

	updateSMSRes := postJSONForMockCloudE2E(t, shadowServer.URL+"/v1/shadow/phone/send-sms", map[string]any{
		"user_id":      appMockUserID100,
		"country_code": "+86",
		"phone_number": "13800000101",
		"client_ip":    "127.0.0.1",
		"lang":         "zh",
	})
	if updateSMSRes.StatusCode != http.StatusNoContent {
		t.Fatalf("send update sms status=%d body=%s", updateSMSRes.StatusCode, readBodyForMockCloudE2E(t, updateSMSRes))
	}
	updateCode, ok := backend.SMSCode("+86", "13800000101")
	if !ok {
		t.Fatalf("missing update sms code")
	}

	updateRes := postJSONForMockCloudE2E(t, shadowServer.URL+"/v1/shadow/phone/verify", map[string]any{
		"user_id":          appMockUserID100,
		"new_country_code": "+86",
		"new_phone_number": "13800000101",
		"verify_code":      updateCode,
	})
	if updateRes.StatusCode != http.StatusNoContent {
		t.Fatalf("update phone status=%d body=%s", updateRes.StatusCode, readBodyForMockCloudE2E(t, updateRes))
	}

	account, ok := backend.AccountByShadowUser(appMockUserID100)
	if !ok {
		t.Fatalf("missing backend account")
	}
	if account.PhoneNumber != "13800000101" {
		t.Fatalf("expected backend phone updated, got=%s", account.PhoneNumber)
	}
}

func postJSONForMockCloudE2E(t *testing.T, target string, body any) *http.Response {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal body: %v", err)
	}
	res, err := http.Post(target, "application/json", bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("post %s: %v", target, err)
	}
	return res
}

func decodeJSONForMockCloudE2E(t *testing.T, res *http.Response, out any) {
	t.Helper()
	defer res.Body.Close()
	if err := json.NewDecoder(res.Body).Decode(out); err != nil {
		t.Fatalf("decode body: %v", err)
	}
}

func readBodyForMockCloudE2E(t *testing.T, res *http.Response) string {
	t.Helper()
	defer res.Body.Close()
	var payload bytes.Buffer
	if _, err := payload.ReadFrom(res.Body); err != nil {
		t.Fatalf("read body: %v", err)
	}
	return payload.String()
}
