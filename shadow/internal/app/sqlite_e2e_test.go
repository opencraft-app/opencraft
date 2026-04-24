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
)

const (
	appSQLiteUserID20 = "usr_00000000-0000-4000-8000-000000000220"
)

func TestSQLitePersistsShadowStateAcrossRestarts(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "shadow.db")
	cfg := config.Config{
		Provider:       "fake",
		BillingMode:    "fake",
		ShadowPlatform: "shadow_test",
		AuthCodeTTL:    10 * time.Minute,
		StorageDSN:     dbPath,
	}

	firstApp, err := app.New(cfg)
	if err != nil {
		t.Fatalf("build first app: %v", err)
	}
	firstServer := httptest.NewServer(firstApp.Handler())

	registerRes := postJSONForAppTest(t, firstServer.URL+"/v1/shadow/register/free-trial", map[string]any{
		"user_id":           appSQLiteUserID20,
		"country_code":      "+86",
		"phone_number":      "13800000020",
		"phone_verify_code": "123456",
		"org_name":          "shadow-demo",
		"client_ip":         "127.0.0.1",
		"client_ua":         "sqlite-e2e",
	})
	if registerRes.StatusCode != http.StatusOK {
		t.Fatalf("register status=%d body=%s", registerRes.StatusCode, readBodyForAppTest(t, registerRes))
	}

	firstServer.Close()
	if err := firstApp.Close(); err != nil {
		t.Fatalf("close first app: %v", err)
	}

	secondApp, err := app.New(cfg)
	if err != nil {
		t.Fatalf("build second app: %v", err)
	}
	defer func() {
		if err := secondApp.Close(); err != nil {
			t.Fatalf("close second app: %v", err)
		}
	}()
	secondServer := httptest.NewServer(secondApp.Handler())
	defer secondServer.Close()

	conflictRes := postJSONForAppTest(t, secondServer.URL+"/v1/shadow/register/free-trial", map[string]any{
		"user_id":           appSQLiteUserID20,
		"country_code":      "+86",
		"phone_number":      "13800000020",
		"phone_verify_code": "123456",
		"org_name":          "shadow-demo",
		"client_ip":         "127.0.0.1",
		"client_ua":         "sqlite-e2e",
	})
	if conflictRes.StatusCode != http.StatusConflict {
		t.Fatalf("conflict status=%d body=%s", conflictRes.StatusCode, readBodyForAppTest(t, conflictRes))
	}

	redirectRes, err := http.Get(secondServer.URL + "/v1/shadow/payment/redirect?user_id=" + appSQLiteUserID20 + "&mode=renew-instance")
	if err != nil {
		t.Fatalf("redirect after restart: %v", err)
	}
	if redirectRes.StatusCode != http.StatusOK {
		t.Fatalf("redirect status=%d body=%s", redirectRes.StatusCode, readBodyForAppTest(t, redirectRes))
	}
	var redirectPayload struct {
		Location string `json:"location"`
	}
	decodeJSONForAppTest(t, redirectRes, &redirectPayload)
	if !strings.Contains(redirectPayload.Location, "jumpLoginByCode") {
		t.Fatalf("unexpected redirect location=%s", redirectPayload.Location)
	}
}

func postJSONForAppTest(t *testing.T, target string, body any) *http.Response {
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

func decodeJSONForAppTest(t *testing.T, res *http.Response, out any) {
	t.Helper()
	defer res.Body.Close()
	if err := json.NewDecoder(res.Body).Decode(out); err != nil {
		t.Fatalf("decode body: %v", err)
	}
}

func readBodyForAppTest(t *testing.T, res *http.Response) string {
	t.Helper()
	defer res.Body.Close()
	var payload bytes.Buffer
	if _, err := payload.ReadFrom(res.Body); err != nil {
		t.Fatalf("read body: %v", err)
	}
	return payload.String()
}
