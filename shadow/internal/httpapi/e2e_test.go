package httpapi_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"shadow/internal/billing"
	"shadow/internal/httpapi"
	"shadow/internal/platform"
	"shadow/internal/shadow"
	storagesqlite "shadow/internal/storage/sqlite"
)

const (
	httpAPIE2EUserID10 = "usr_00000000-0000-4000-8000-000000000110"
	httpAPIE2EUserID11 = "usr_00000000-0000-4000-8000-000000000111"
	httpAPIE2EUserID12 = "usr_00000000-0000-4000-8000-000000000112"
	httpAPIE2EUserID99 = "usr_00000000-0000-4000-8000-000000000199"
)

func newE2EServer(t *testing.T) *httptest.Server {
	t.Helper()
	store, err := storagesqlite.NewStore(filepath.Join(t.TempDir(), "shadow.db"))
	if err != nil {
		t.Fatalf("new sqlite store: %v", err)
	}
	svc := shadow.NewService(store, platform.NewFakeCloudProvider(), billing.NewFakeProvider(), 10*time.Minute, "shadow_test")
	server := httptest.NewServer(httpapi.New(svc).Handler())
	t.Cleanup(func() {
		server.Close()
		if err := store.Close(); err != nil {
			t.Fatalf("close sqlite store: %v", err)
		}
	})
	return server
}

func TestE2E_RegisterConflictAndAccountExistCallbacks(t *testing.T) {
	server := newE2EServer(t)
	defer server.Close()

	sendSMSRes := postJSON(t, server.URL+"/v1/shadow/register/send-sms", map[string]any{
		"country_code": "+86",
		"phone_number": "13800000010",
		"client_ip":    "127.0.0.1",
		"lang":         "zh",
	})
	if sendSMSRes.StatusCode != http.StatusNoContent {
		t.Fatalf("send sms status=%d body=%s", sendSMSRes.StatusCode, readBody(t, sendSMSRes))
	}

	registerRes := postJSON(t, server.URL+"/v1/shadow/register/free-trial", map[string]any{
		"user_id":           httpAPIE2EUserID10,
		"country_code":      "+86",
		"phone_number":      "13800000010",
		"phone_verify_code": "123456",
		"org_name":          "shadow-demo",
		"client_ip":         "127.0.0.1",
		"client_ua":         "e2e-test",
	})
	if registerRes.StatusCode != http.StatusOK {
		t.Fatalf("register status=%d body=%s", registerRes.StatusCode, readBody(t, registerRes))
	}

	conflictRes := postJSON(t, server.URL+"/v1/shadow/register/free-trial", map[string]any{
		"user_id":           httpAPIE2EUserID10,
		"country_code":      "+86",
		"phone_number":      "13800000010",
		"phone_verify_code": "123456",
		"org_name":          "shadow-demo",
		"client_ip":         "127.0.0.1",
		"client_ua":         "e2e-test",
	})
	if conflictRes.StatusCode != http.StatusConflict {
		t.Fatalf("conflict status=%d body=%s", conflictRes.StatusCode, readBody(t, conflictRes))
	}

	existRes := postJSON(t, server.URL+"/internal/tencentcloud/account", map[string]any{
		"version":       "1.0",
		"caller":        "WACCOUNT",
		"componentName": "WACCOUNT",
		"eventId":       "event-account-exist",
		"timestamp":     time.Now().Unix(),
		"interface": map[string]any{
			"interfaceName": "qcloud.saas.checkSaaSAccountExist",
			"para": map[string]any{
				"user_id": httpAPIE2EUserID10,
			},
		},
	})
	assertCallbackExist(t, existRes, true)

	notExistRes := postJSON(t, server.URL+"/internal/tencentcloud/account", map[string]any{
		"version":       "1.0",
		"caller":        "WACCOUNT",
		"componentName": "WACCOUNT",
		"eventId":       "event-account-not-exist",
		"timestamp":     time.Now().Unix(),
		"interface": map[string]any{
			"interfaceName": "qcloud.saas.checkSaaSAccountExist",
			"para": map[string]any{
				"user_id": httpAPIE2EUserID99,
			},
		},
	})
	assertCallbackExist(t, notExistRes, false)
}

func TestE2E_RedirectValidationAndUnsupportedCallback(t *testing.T) {
	server := newE2EServer(t)
	defer server.Close()

	registerRes := postJSON(t, server.URL+"/v1/shadow/register/free-trial", map[string]any{
		"user_id":           httpAPIE2EUserID11,
		"country_code":      "+86",
		"phone_number":      "13800000011",
		"phone_verify_code": "123456",
		"org_name":          "shadow-demo",
		"client_ip":         "127.0.0.1",
		"client_ua":         "e2e-test",
	})
	if registerRes.StatusCode != http.StatusOK {
		t.Fatalf("register status=%d body=%s", registerRes.StatusCode, readBody(t, registerRes))
	}

	modeMissingRes, err := http.Get(server.URL + "/v1/shadow/payment/redirect?user_id=" + httpAPIE2EUserID11)
	if err != nil {
		t.Fatalf("redirect missing mode: %v", err)
	}
	if modeMissingRes.StatusCode != http.StatusBadRequest {
		t.Fatalf("missing mode status=%d body=%s", modeMissingRes.StatusCode, readBody(t, modeMissingRes))
	}
	if !strings.Contains(readBody(t, modeMissingRes), `"mode is invalid"`) {
		t.Fatalf("unexpected missing mode body=%s", readBody(t, modeMissingRes))
	}

	invalidUserRes, err := http.Get(server.URL + "/v1/shadow/payment/redirect?user_id=abc&mode=renew-instance")
	if err != nil {
		t.Fatalf("redirect invalid user_id: %v", err)
	}
	if invalidUserRes.StatusCode != http.StatusBadRequest {
		t.Fatalf("invalid user status=%d body=%s", invalidUserRes.StatusCode, readBody(t, invalidUserRes))
	}

	unsupportedRes := postJSON(t, server.URL+"/internal/tencentcloud/account", map[string]any{
		"version":       "1.0",
		"caller":        "WACCOUNT",
		"componentName": "WACCOUNT",
		"eventId":       "event-unsupported",
		"timestamp":     time.Now().Unix(),
		"interface": map[string]any{
			"interfaceName": "qcloud.saas.unsupported",
			"para":          map[string]any{},
		},
	})
	if unsupportedRes.StatusCode != http.StatusOK {
		t.Fatalf("unsupported callback status=%d body=%s", unsupportedRes.StatusCode, readBody(t, unsupportedRes))
	}
	var payload struct {
		ReturnCode    int    `json:"returnCode"`
		ReturnMessage string `json:"returnMessage"`
	}
	decodeJSON(t, unsupportedRes, &payload)
	if payload.ReturnCode != 1 || payload.ReturnMessage != "unsupported interfaceName" {
		t.Fatalf("unexpected unsupported payload=%+v", payload)
	}
}

func TestE2E_ConsoleRedirectPreservesNestedConsolePath(t *testing.T) {
	server := newE2EServer(t)
	defer server.Close()

	registerRes := postJSON(t, server.URL+"/v1/shadow/register/free-trial", map[string]any{
		"user_id":           httpAPIE2EUserID12,
		"country_code":      "+86",
		"phone_number":      "13800000012",
		"phone_verify_code": "123456",
		"org_name":          "shadow-demo",
		"client_ip":         "127.0.0.1",
		"client_ua":         "e2e-test",
	})
	if registerRes.StatusCode != http.StatusOK {
		t.Fatalf("register status=%d body=%s", registerRes.StatusCode, readBody(t, registerRes))
	}

	redirectRes, err := http.Get(server.URL + "/v1/shadow/payment/redirect?user_id=" + httpAPIE2EUserID12 + "&mode=console&console=tced/overview")
	if err != nil {
		t.Fatalf("console redirect: %v", err)
	}
	if redirectRes.StatusCode != http.StatusOK {
		t.Fatalf("redirect status=%d body=%s", redirectRes.StatusCode, readBody(t, redirectRes))
	}

	var body struct {
		Location string `json:"location"`
	}
	decodeJSON(t, redirectRes, &body)
	location, err := url.Parse(body.Location)
	if err != nil {
		t.Fatalf("parse location: %v", err)
	}
	if got := location.Query().Get("s_url"); got != "https://console.cloud.tencent.com/tced/overview" {
		t.Fatalf("unexpected s_url=%q", got)
	}
}

func postJSON(t *testing.T, target string, body any) *http.Response {
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

func decodeJSON(t *testing.T, res *http.Response, out any) {
	t.Helper()
	defer res.Body.Close()
	if err := json.NewDecoder(res.Body).Decode(out); err != nil {
		t.Fatalf("decode body: %v", err)
	}
}

func readBody(t *testing.T, res *http.Response) string {
	t.Helper()
	defer res.Body.Close()
	var payload bytes.Buffer
	if _, err := payload.ReadFrom(res.Body); err != nil {
		t.Fatalf("read body: %v", err)
	}
	return payload.String()
}

func assertCallbackExist(t *testing.T, res *http.Response, want bool) {
	t.Helper()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("callback status=%d body=%s", res.StatusCode, readBody(t, res))
	}
	var payload struct {
		ReturnCode int `json:"returnCode"`
		Data       struct {
			Exist bool `json:"exist"`
		} `json:"data"`
	}
	decodeJSON(t, res, &payload)
	if payload.ReturnCode != 0 || payload.Data.Exist != want {
		t.Fatalf("unexpected callback payload=%+v wantExist=%v", payload, want)
	}
}
