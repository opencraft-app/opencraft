package devroute

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

	cloudauth "github.com/openclaw/openclaw/mono/cloudladdergateway/internal/auth"
	"github.com/openclaw/openclaw/mono/cloudladdergateway/internal/config"
)

const (
	testControlRoute  = "developer-route-registration"
	testControlCaller = "lightclaw-auth"
	testControlSecret = "developer-route-test-secret"
)

type captureTargetProbe struct {
	baseURL string
	err     error
}

func (p *captureTargetProbe) Probe(_ context.Context, baseURL string) error {
	p.baseURL = baseURL
	return p.err
}

func TestHTTPProbeRequiresHealthyTarget(t *testing.T) {
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/healthz" {
			t.Fatalf("path = %q", r.URL.Path)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer target.Close()

	probe := NewHTTPProbe("/healthz", target.Client())
	if err := probe.Probe(context.Background(), target.URL); err != nil {
		t.Fatalf("probe healthy target: %v", err)
	}

	unhealthy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "not ready", http.StatusServiceUnavailable)
	}))
	defer unhealthy.Close()
	if err := probe.Probe(context.Background(), unhealthy.URL); !errors.Is(err, ErrTargetUnreachable) {
		t.Fatalf("probe error = %v", err)
	}
}

func TestHTTPProbeDoesNotFollowRedirects(t *testing.T) {
	redirectedHits := 0
	redirected := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		redirectedHits++
		w.WriteHeader(http.StatusNoContent)
	}))
	defer redirected.Close()
	firstHop := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, redirected.URL+"/private", http.StatusFound)
	}))
	defer firstHop.Close()

	probe := NewHTTPProbe("/healthz", firstHop.Client())
	if err := probe.Probe(context.Background(), firstHop.URL); !errors.Is(err, ErrTargetUnreachable) {
		t.Fatalf("redirect probe error = %v", err)
	}
	if redirectedHits != 0 {
		t.Fatalf("probe followed redirect to second target: hits=%d", redirectedHits)
	}
}

func TestRegistrationAPIAcceptsOnlySignedServerDerivedIdentityAndAllowedTarget(t *testing.T) {
	now := time.Date(2026, 9, 8, 9, 0, 0, 0, time.UTC)
	store := NewMemoryStore()
	api := newTestAPI(t, store, nil, []string{"9.134.0.0/16"}, []int{18084}, now)

	body := `{"uin":"450860000013","targetIp":"9.134.214.121","port":18084,"ttlSeconds":28800}`
	req := signedControlRequest(t, http.MethodPost, "/v1/dev-environments/registration", body, testControlCaller)
	rec := httptest.NewRecorder()
	api.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("register status=%d body=%s", rec.Code, rec.Body.String())
	}
	registration, err := store.Get(context.Background(), "450860000013")
	if err != nil {
		t.Fatalf("get registration: %v", err)
	}
	if registration.BaseURL != "http://9.134.214.121:18084" || registration.UserID != testControlCaller || registration.SourceIP != "9.134.214.121" {
		t.Fatalf("registration = %+v", registration)
	}

	badBody := `{"uin":"450860000014","targetIp":"9.134.214.121","port":18084,"ttlSeconds":28800,"host":"internal"}`
	bad := signedControlRequest(t, http.MethodPost, "/v1/dev-environments/registration", badBody, testControlCaller)
	badRec := httptest.NewRecorder()
	api.ServeHTTP(badRec, bad)
	if badRec.Code != http.StatusBadRequest {
		t.Fatalf("unknown field status=%d body=%s", badRec.Code, badRec.Body.String())
	}

	wrongCIDRBody := `{"uin":"450860000014","targetIp":"203.0.113.9","port":18084,"ttlSeconds":28800}`
	wrongCIDR := signedControlRequest(t, http.MethodPost, "/v1/dev-environments/registration", wrongCIDRBody, testControlCaller)
	wrongCIDRRec := httptest.NewRecorder()
	api.ServeHTTP(wrongCIDRRec, wrongCIDR)
	if wrongCIDRRec.Code != http.StatusForbidden {
		t.Fatalf("non-devcloud status=%d body=%s", wrongCIDRRec.Code, wrongCIDRRec.Body.String())
	}

	wrongPortBody := `{"uin":"450860000014","targetIp":"9.134.214.121","port":3306,"ttlSeconds":28800}`
	wrongPort := signedControlRequest(t, http.MethodPost, "/v1/dev-environments/registration", wrongPortBody, testControlCaller)
	wrongPortRec := httptest.NewRecorder()
	api.ServeHTTP(wrongPortRec, wrongPort)
	if wrongPortRec.Code != http.StatusBadRequest {
		t.Fatalf("wrong port status=%d body=%s", wrongPortRec.Code, wrongPortRec.Body.String())
	}
}

func TestRegistrationAPIRejectsUnsignedAndUnexpectedCaller(t *testing.T) {
	now := time.Date(2026, 9, 8, 9, 0, 0, 0, time.UTC)
	api := newTestAPI(t, NewMemoryStore(), nil, []string{"9.134.0.0/16"}, []int{18084}, now)
	body := `{"uin":"450860000013","targetIp":"9.134.214.121","port":18084,"ttlSeconds":28800}`

	unsigned := httptest.NewRequest(http.MethodPost, "/v1/dev-environments/registration", strings.NewReader(body))
	unsignedRec := httptest.NewRecorder()
	api.ServeHTTP(unsignedRec, unsigned)
	if unsignedRec.Code != http.StatusUnauthorized {
		t.Fatalf("unsigned status=%d body=%s", unsignedRec.Code, unsignedRec.Body.String())
	}

	wrongCaller := signedControlRequest(t, http.MethodPost, "/v1/dev-environments/registration", body, "shadow")
	wrongCallerRec := httptest.NewRecorder()
	api.ServeHTTP(wrongCallerRec, wrongCaller)
	if wrongCallerRec.Code != http.StatusUnauthorized {
		t.Fatalf("wrong caller status=%d body=%s", wrongCallerRec.Code, wrongCallerRec.Body.String())
	}
}

func TestRegistrationAPIDoesNotWriteLeaseWhenTargetProbeFails(t *testing.T) {
	now := time.Date(2026, 9, 8, 9, 0, 0, 0, time.UTC)
	store := NewMemoryStore()
	probe := &captureTargetProbe{err: ErrTargetUnreachable}
	api := newTestAPI(t, store, probe, []string{"9.134.0.0/16"}, []int{18084}, now)

	body := `{"uin":"450860000013","targetIp":"9.134.214.121","port":18084,"ttlSeconds":28800}`
	req := signedControlRequest(t, http.MethodPost, "/v1/dev-environments/registration", body, testControlCaller)
	rec := httptest.NewRecorder()
	api.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadGateway || !strings.Contains(rec.Body.String(), "target_unreachable") {
		t.Fatalf("register status=%d body=%s", rec.Code, rec.Body.String())
	}
	if probe.baseURL != "http://9.134.214.121:18084" {
		t.Fatalf("probe base url = %q", probe.baseURL)
	}
	if _, err := store.Get(context.Background(), "450860000013"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("failed probe must not write registration: %v", err)
	}
}

func TestRegistrationAPIReturnsCapabilityOnceForDevtunnel(t *testing.T) {
	now := time.Date(2026, 9, 8, 9, 0, 0, 0, time.UTC)
	store := NewMemoryStore()
	t.Setenv("DEVELOPER_ROUTE_TEST_SECRET", testControlSecret)
	authenticator, err := cloudauth.New(config.Config{Auth: config.AuthConfig{
		Enabled:       true,
		TimestampSkew: "5m",
		Callers: []config.CallerConfig{{
			ID: testControlCaller, SecretEnv: "DEVELOPER_ROUTE_TEST_SECRET", Routes: []string{testControlRoute},
		}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	api, err := NewAPI(APIOptions{
		Store: store, Authenticator: authenticator,
		AllowedCIDRs: []string{"9.0.0.0/8"}, AllowedPorts: []int{18084},
		RegistrationRoute: testControlRoute, RegistrationCaller: testControlCaller,
		DeliveryMode: DeliveryModeDevtunnel, TunnelBaseURL: "http://devtunnel.testing",
		TunnelHostSuffix: "sg.tunnel.internal", DefaultTTL: time.Hour, MaxTTL: 24 * time.Hour,
		Now: func() time.Time { return now }, TunnelTokenSource: bytes.NewReader(bytes.Repeat([]byte{9}, 32)),
	})
	if err != nil {
		t.Fatal(err)
	}
	body := `{"uin":"450860000013","targetIp":"9.134.214.121","port":18084,"ttlSeconds":3600}`
	register := signedControlRequest(t, http.MethodPost, "/v1/dev-environments/registration", body, testControlCaller)
	registerRec := httptest.NewRecorder()
	api.ServeHTTP(registerRec, register)
	if registerRec.Code != http.StatusOK || !strings.Contains(registerRec.Body.String(), `"tunnelToken":"lvdt1.450860000013.`) {
		t.Fatalf("register status=%d body=%s", registerRec.Code, registerRec.Body.String())
	}
	stored, err := store.Get(context.Background(), "450860000013")
	if err != nil || stored.TunnelTokenHash == "" || strings.Contains(registerRec.Body.String(), stored.TunnelTokenHash) {
		t.Fatalf("stored registration=%+v err=%v", stored, err)
	}

	status := signedControlRequest(t, http.MethodGet, "/v1/dev-environments/registration?uin=450860000013", "", testControlCaller)
	statusRec := httptest.NewRecorder()
	api.ServeHTTP(statusRec, status)
	if statusRec.Code != http.StatusOK || strings.Contains(statusRec.Body.String(), "tunnelToken") {
		t.Fatalf("status leaked capability: status=%d body=%s", statusRec.Code, statusRec.Body.String())
	}
}

func TestRegistrationAPIDisablesWithoutDeletingTombstone(t *testing.T) {
	now := time.Date(2026, 9, 8, 9, 0, 0, 0, time.UTC)
	store := NewMemoryStore()
	if err := store.Upsert(context.Background(), Registration{
		UIN: "450860000013", UserID: testControlCaller, BaseURL: "http://9.134.214.121:18084",
		SourceIP: "9.134.214.121", Port: 18084, RenewedAt: now, TTL: 8 * time.Hour,
	}); err != nil {
		t.Fatal(err)
	}
	api := newTestAPI(t, store, nil, []string{"9.134.0.0/16"}, []int{18084}, now)

	req := signedControlRequest(t, http.MethodDelete, "/v1/dev-environments/registration?uin=450860000013", "", testControlCaller)
	rec := httptest.NewRecorder()
	api.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("disable status=%d body=%s", rec.Code, rec.Body.String())
	}
	var body struct {
		Status State `json:"status"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Status != StateDisabled {
		t.Fatalf("status=%q", body.Status)
	}
	registration, err := store.Get(context.Background(), "450860000013")
	if err != nil || registration.State(now) != StateDisabled {
		t.Fatalf("tombstone=%+v err=%v", registration, err)
	}
}

func newTestAPI(t *testing.T, store Store, probe TargetProbe, allowedCIDRs []string, allowedPorts []int, now time.Time) *API {
	t.Helper()
	t.Setenv("DEVELOPER_ROUTE_TEST_SECRET", testControlSecret)
	authenticator, err := cloudauth.New(config.Config{Auth: config.AuthConfig{
		Enabled:       true,
		TimestampSkew: "5m",
		Callers: []config.CallerConfig{{
			ID: testControlCaller, SecretEnv: "DEVELOPER_ROUTE_TEST_SECRET", Routes: []string{testControlRoute},
		}},
	}})
	if err != nil {
		t.Fatalf("new authenticator: %v", err)
	}
	api, err := NewAPI(APIOptions{
		Store: store, Authenticator: authenticator, TargetProbe: probe,
		AllowedCIDRs: allowedCIDRs, AllowedPorts: allowedPorts,
		RegistrationRoute: testControlRoute, RegistrationCaller: testControlCaller,
		DefaultTTL: 8 * time.Hour, MaxTTL: 24 * time.Hour, Now: func() time.Time { return now },
	})
	if err != nil {
		t.Fatalf("new api: %v", err)
	}
	return api
}

func signedControlRequest(t *testing.T, method string, target string, body string, caller string) *http.Request {
	t.Helper()
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	timestamp := time.Now().UTC().Format(time.RFC3339)
	req.Header.Set("X-CloudLadder-Caller", caller)
	req.Header.Set("X-CloudLadder-Timestamp", timestamp)
	req.Header.Set("X-CloudLadder-Signature", cloudauth.Sign(testControlSecret, cloudauth.Request{
		Caller: caller, RouteID: testControlRoute, Method: method, Path: req.URL.EscapedPath(),
		Query: req.URL.RawQuery, Body: []byte(body), Timestamp: timestamp,
	}))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	return req
}
