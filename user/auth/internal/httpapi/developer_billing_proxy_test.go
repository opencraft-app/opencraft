package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/openclaw/openclaw/mono/backend/auth/internal/devroute"
)

func personalDevCapabilityFixture(uin string) (string, string) {
	token := "lvdt1." + uin + "." + base64.RawURLEncoding.EncodeToString(make([]byte, 32))
	digest := sha256.Sum256([]byte(token))
	return token, hex.EncodeToString(digest[:])
}

func newPersonalDevBillingProxyTestRouter(t *testing.T, upstream http.HandlerFunc) (*gin.Engine, *devroute.MemoryRegistry) {
	t.Helper()
	server := httptest.NewServer(upstream)
	t.Cleanup(server.Close)
	registry := devroute.NewMemoryRegistry()
	proxy, err := newPersonalDevBillingProxy(ServerConfig{
		PersonalDevBillingProxyEnabled: true,
		PersonalDevBillingProxyURL:     server.URL + personalDevBillingProxyTargetBase,
		PersonalDevBillingProxyToken:   "internal-token",
		DeveloperRouteRegistry:         registry,
		PersonalDevBillingProxyClient:  server.Client(),
	})
	if err != nil {
		t.Fatal(err)
	}
	router := gin.New()
	registerPersonalDevBillingProxyRoutes(router, proxy)
	return router, registry
}

func registerPersonalDevCapability(t *testing.T, registry *devroute.MemoryRegistry, uin, digest string, renewedAt time.Time, disabledAt *time.Time) {
	t.Helper()
	if err := registry.Upsert(context.Background(), devroute.StoredRegistration{
		UIN: uin, UserID: "usr_test", DeliveryMode: "devtunnel", SourceIP: "9.1.2.3", Port: 18084,
		BaseURL: "http://devtunnel.testing", TunnelHost: "uin-" + uin + ".tunnel.internal",
		TunnelTokenHash: digest, RenewedAt: renewedAt, TTLSeconds: 3600, DisabledAt: disabledAt,
	}); err != nil {
		t.Fatal(err)
	}
	if disabledAt != nil {
		if err := registry.Disable(context.Background(), uin, *disabledAt); err != nil {
			t.Fatal(err)
		}
	}
}

func TestPersonalDevBillingProxyForwardsAllowedJifeiRequest(t *testing.T) {
	const uin = "450860000023"
	token, digest := personalDevCapabilityFixture(uin)
	seen := false
	router, registry := newPersonalDevBillingProxyTestRouter(t, func(w http.ResponseWriter, r *http.Request) {
		seen = true
		if r.URL.Path != personalDevBillingProxyTargetBase+"/jifei/resource-center/interface" {
			t.Fatalf("path=%q", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer internal-token" || r.Header.Get(personalDevUINHeader) != uin {
			t.Fatalf("internal auth headers=%v", r.Header)
		}
		if r.Header.Get(personalDevCapabilityHeader) != "" {
			t.Fatal("capability leaked to Trade")
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"returnCode":0}`))
	})
	registerPersonalDevCapability(t, registry, uin, digest, time.Now().UTC(), nil)
	body := `{"interface":{"interfaceName":"qcloud.operation.ModifyResourceStatus","extraPara":{"ownerUin":"450860000023"},"para":{"uin":"450860000023"}}}`
	request := httptest.NewRequest(http.MethodPost, "/auth/dev-environments/billing-proxy/jifei/resource-center/interface", strings.NewReader(body))
	request.Header.Set(personalDevCapabilityHeader, token)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK || !seen || strings.TrimSpace(recorder.Body.String()) != `{"returnCode":0}` {
		t.Fatalf("status=%d seen=%v body=%q", recorder.Code, seen, recorder.Body.String())
	}
}

func TestPersonalDevBillingProxyRejectsInvalidCapabilityAndJifeiEnvelope(t *testing.T) {
	const uin = "450860000023"
	token, digest := personalDevCapabilityFixture(uin)
	router, registry := newPersonalDevBillingProxyTestRouter(t, func(http.ResponseWriter, *http.Request) {
		t.Fatal("upstream must not be called")
	})
	registerPersonalDevCapability(t, registry, uin, digest, time.Now().UTC(), nil)
	tests := []struct {
		name       string
		capability string
		body       string
		want       int
	}{
		{name: "invalid capability", capability: "bad", body: `{}`, want: http.StatusUnauthorized},
		{name: "different uin", capability: token, body: `{"interface":{"interfaceName":"qcloud.operation.ModifyResourceStatus","extraPara":{"ownerUin":"450860000024"},"para":{"uin":"450860000024"}}}`, want: http.StatusForbidden},
		{name: "different interface", capability: token, body: `{"interface":{"interfaceName":"qcloud.Deal.OnlineRefund","extraPara":{"ownerUin":"450860000023"},"para":{"uin":"450860000023"}}}`, want: http.StatusForbidden},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "/auth/dev-environments/billing-proxy/jifei/resource-center/interface", strings.NewReader(tc.body))
			request.Header.Set(personalDevCapabilityHeader, tc.capability)
			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, request)
			if recorder.Code != tc.want {
				t.Fatalf("status=%d want=%d body=%s", recorder.Code, tc.want, recorder.Body.String())
			}
		})
	}
}

func TestPersonalDevBillingProxyRejectsExpiredAndDisabledCapabilities(t *testing.T) {
	const uin = "450860000023"
	disabledAt := time.Now().UTC()
	tests := []struct {
		name       string
		renewedAt  time.Time
		disabledAt *time.Time
	}{
		{name: "expired", renewedAt: time.Now().UTC().Add(-2 * time.Hour)},
		{name: "disabled", renewedAt: time.Now().UTC(), disabledAt: &disabledAt},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			token, digest := personalDevCapabilityFixture(uin)
			router, registry := newPersonalDevBillingProxyTestRouter(t, func(http.ResponseWriter, *http.Request) {
				t.Fatal("upstream must not be called")
			})
			registerPersonalDevCapability(t, registry, uin, digest, tc.renewedAt, tc.disabledAt)
			request := httptest.NewRequest(http.MethodPost, "/auth/dev-environments/billing-proxy/jifei/resource-center/interface", strings.NewReader(`{}`))
			request.Header.Set(personalDevCapabilityHeader, token)
			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, request)
			if recorder.Code != http.StatusUnauthorized {
				t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
			}
		})
	}
}

func TestPersonalDevBillingProxyCloudAPIUsesCapabilityIdentityAndRejectsClientRouteUIN(t *testing.T) {
	const uin = "450860000023"
	token, digest := personalDevCapabilityFixture(uin)
	router, registry := newPersonalDevBillingProxyTestRouter(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != personalDevBillingProxyTargetBase+"/cloudapi/" || r.URL.RawQuery != "Action=CreatePayUrl" {
			t.Fatalf("target=%s?%s", r.URL.Path, r.URL.RawQuery)
		}
		if r.Header.Get("X-TC-Action") != "CreatePayUrl" || r.Header.Get("Authorization") != "Bearer internal-token" {
			t.Fatalf("headers=%v", r.Header)
		}
		if got := r.Header.Get(personalDevOriginalAuthHeader); got != "TC3-HMAC-SHA256 signed" {
			t.Fatalf("original TC3 authorization=%q", got)
		}
		w.WriteHeader(http.StatusOK)
	})
	registerPersonalDevCapability(t, registry, uin, digest, time.Now().UTC(), nil)
	request := httptest.NewRequest(http.MethodPost, "/auth/dev-environments/billing-proxy/cloudapi/?Action=CreatePayUrl", strings.NewReader(`{}`))
	request.Header.Set(personalDevCapabilityHeader, token)
	request.Header.Set("X-TC-Action", "CreatePayUrl")
	request.Header.Set("Authorization", "TC3-HMAC-SHA256 signed")
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}

	injectedRouteUIN := httptest.NewRequest(http.MethodPost, "/auth/dev-environments/billing-proxy/cloudapi/?Action=CreatePayUrl", strings.NewReader(`{}`))
	injectedRouteUIN.Header.Set(personalDevCapabilityHeader, token)
	injectedRouteUIN.Header.Set("X-Qcloud-User-Id", "450860000002")
	injectedRouteUIN.Header.Set("X-TC-Action", "CreatePayUrl")
	injectedRouteUIN.Header.Set("Authorization", "TC3-HMAC-SHA256 signed")
	injectedRouteUINRecorder := httptest.NewRecorder()
	router.ServeHTTP(injectedRouteUINRecorder, injectedRouteUIN)
	if injectedRouteUINRecorder.Code != http.StatusForbidden {
		t.Fatalf("injected route uin status=%d body=%s", injectedRouteUINRecorder.Code, injectedRouteUINRecorder.Body.String())
	}

	actionMismatch := httptest.NewRequest(http.MethodPost, "/auth/dev-environments/billing-proxy/cloudapi/?Action=OnlineRefund", strings.NewReader(`{}`))
	actionMismatch.Header.Set(personalDevCapabilityHeader, token)
	actionMismatch.Header.Set("X-TC-Action", "CreatePayUrl")
	actionMismatch.Header.Set("Authorization", "TC3-HMAC-SHA256 signed")
	actionMismatchRecorder := httptest.NewRecorder()
	router.ServeHTTP(actionMismatchRecorder, actionMismatch)
	if actionMismatchRecorder.Code != http.StatusForbidden {
		t.Fatalf("action mismatch status=%d body=%s", actionMismatchRecorder.Code, actionMismatchRecorder.Body.String())
	}
}

func TestPersonalDevBillingProxyRejectsPreviouslyValidCapabilityAfterDisable(t *testing.T) {
	const uin = "450860000023"
	token, digest := personalDevCapabilityFixture(uin)
	upstreamCalls := 0
	router, registry := newPersonalDevBillingProxyTestRouter(t, func(w http.ResponseWriter, _ *http.Request) {
		upstreamCalls++
		w.WriteHeader(http.StatusOK)
	})
	registerPersonalDevCapability(t, registry, uin, digest, time.Now().UTC(), nil)
	body := `{"interface":{"interfaceName":"qcloud.operation.ModifyResourceStatus","extraPara":{"ownerUin":"450860000023"},"para":{"uin":"450860000023"}}}`
	request := func() *http.Request {
		req := httptest.NewRequest(http.MethodPost, "/auth/dev-environments/billing-proxy/jifei/resource-center/interface", strings.NewReader(body))
		req.Header.Set(personalDevCapabilityHeader, token)
		return req
	}

	before := httptest.NewRecorder()
	router.ServeHTTP(before, request())
	if before.Code != http.StatusOK || upstreamCalls != 1 {
		t.Fatalf("before disable status=%d upstreamCalls=%d", before.Code, upstreamCalls)
	}
	if err := registry.Disable(context.Background(), uin, time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	after := httptest.NewRecorder()
	router.ServeHTTP(after, request())
	if after.Code != http.StatusUnauthorized || upstreamCalls != 1 {
		t.Fatalf("after disable status=%d upstreamCalls=%d body=%s", after.Code, upstreamCalls, after.Body.String())
	}
}

func TestPersonalDevBillingProxyRejectsUnknownTarget(t *testing.T) {
	router, _ := newPersonalDevBillingProxyTestRouter(t, func(http.ResponseWriter, *http.Request) {
		t.Fatal("upstream must not be called")
	})
	for _, path := range []string{
		"/auth/dev-environments/billing-proxy/jifei/other",
		"/auth/dev-environments/billing-proxy/cloudapi/%2e%2e/internal",
		"/auth/dev-environments/billing-proxy/arbitrary/path",
	} {
		request := httptest.NewRequest(http.MethodPost, path, nil)
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusNotFound {
			t.Fatalf("path=%s status=%d body=%s", path, recorder.Code, recorder.Body.String())
		}
	}
}
