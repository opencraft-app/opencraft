package main

import (
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	cloudauth "github.com/openclaw/openclaw/mono/cloudladdergateway/internal/auth"
	"github.com/openclaw/openclaw/mono/cloudladdergateway/internal/config"
)

func TestBuildDeveloperRouteRuntimeWiresSignedRegistrationAPI(t *testing.T) {
	t.Setenv("DEVELOPER_ROUTE_TEST_SECRET", "developer-route-test-secret")
	authenticator, err := cloudauth.New(config.Config{Auth: config.AuthConfig{
		Enabled:       true,
		TimestampSkew: "5m",
		Callers: []config.CallerConfig{{
			ID: "lightclaw-auth", SecretEnv: "DEVELOPER_ROUTE_TEST_SECRET", Routes: []string{"developer-route-registration"},
		}},
	}})
	if err != nil {
		t.Fatalf("new authenticator: %v", err)
	}
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/healthz" {
			t.Fatalf("probe path = %q", r.URL.Path)
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer target.Close()
	targetPort := target.Listener.Addr().(*net.TCPAddr).Port
	cfg := config.Config{DeveloperRoutes: config.DeveloperRoutesConfig{
		Enabled: true, RouteID: "jifei-callback", Store: "memory",
		RegistrationRoute: "developer-route-registration", RegistrationCaller: "lightclaw-auth",
		DeliveryMode: "direct", AllowedCIDRs: []string{"127.0.0.0/8"},
		AllowedPorts: []int{targetPort}, DefaultTTL: "8h", MaxTTL: "24h",
		ProbePath: "/healthz", ProbeTimeout: "1s",
	}}
	routing, handler, err := buildDeveloperRouteRuntime(cfg, authenticator, nil)
	if err != nil {
		t.Fatalf("build runtime: %v", err)
	}
	if routing.Store == nil || routing.RouteID != "jifei-callback" || handler == nil {
		t.Fatalf("routing=%+v handler=%v", routing, handler)
	}
	body := fmt.Sprintf(`{"uin":"450860000013","targetIp":"127.0.0.1","port":%d,"ttlSeconds":28800}`, targetPort)
	req := httptest.NewRequest(http.MethodPost, "/v1/dev-environments/registration", strings.NewReader(body))
	timestamp := time.Now().UTC().Format(time.RFC3339)
	req.Header.Set("X-CloudLadder-Caller", "lightclaw-auth")
	req.Header.Set("X-CloudLadder-Timestamp", timestamp)
	req.Header.Set("X-CloudLadder-Signature", cloudauth.Sign("developer-route-test-secret", cloudauth.Request{
		Caller: "lightclaw-auth", RouteID: "developer-route-registration", Method: http.MethodPost,
		Path: req.URL.EscapedPath(), Body: []byte(body), Timestamp: timestamp,
	}))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestBuildDeveloperRouteRuntimeHTTPStoreRequiresSecret(t *testing.T) {
	t.Setenv("MISSING_REGISTRY_SECRET", "")
	cfg := config.Config{DeveloperRoutes: config.DeveloperRoutesConfig{
		Enabled: true, RouteID: "jifei-callback", Store: "http",
		RegistryBaseURL: "https://api-sandbox-bj-7.lightclaw.tech",
		RegistryRouteID: "developer-route-registry", RegistryCaller: "cloudladdergateway",
		RegistrySecretEnv: "MISSING_REGISTRY_SECRET", RegistryTimeout: "1s",
		RegistrationRoute: "developer-route-registration", RegistrationCaller: "lightclaw-auth",
		DeliveryMode: DeliveryModeDirectForTest, AllowedCIDRs: []string{"9.0.0.0/8"},
		AllowedPorts: []int{18084}, DefaultTTL: "8h", MaxTTL: "24h",
		ProbePath: "/healthz", ProbeTimeout: "1s",
	}}
	if _, _, err := buildDeveloperRouteRuntime(cfg, nil, nil); err == nil || !strings.Contains(err.Error(), "secret env") {
		t.Fatalf("buildDeveloperRouteRuntime() error = %v", err)
	}
}

const DeliveryModeDirectForTest = "direct"
