package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/openclaw/openclaw/mono/backend/auth/internal/devroute"
	"github.com/openclaw/openclaw/mono/shared/cloudladdertransport"
)

func TestDeveloperRouteRegistryHMACLifecycle(t *testing.T) {
	gin.SetMode(gin.TestMode)
	registry := devroute.NewMemoryRegistry()
	router := gin.New()
	registerDeveloperRouteRegistryRoutes(router, ServerConfig{
		DeveloperRouteRegistry: registry, DeveloperRouteRegistrySecret: "registry-secret",
		DeveloperRouteRegistryCaller: "cloudladdergateway", DeveloperRouteRegistryRouteID: "developer-route-registry",
	})
	renewedAt := time.Date(2026, 9, 17, 6, 0, 0, 0, time.UTC)
	signedAt := time.Now().UTC().Truncate(time.Second)
	registration := devroute.StoredRegistration{
		UIN: "450860000002", UserID: "user-1", BaseURL: "http://9.1.2.3:18084",
		DeliveryMode: "direct", SourceIP: "9.1.2.3", Port: 18084,
		RenewedAt: renewedAt, TTLSeconds: 3600,
	}
	body, _ := json.Marshal(registration)
	response := performSignedRegistryRequest(t, router, http.MethodPut, developerRouteRegistryPath, body, signedAt)
	if response.Code != http.StatusNoContent {
		t.Fatalf("upsert status=%d body=%s", response.Code, response.Body.String())
	}

	response = performSignedRegistryRequest(t, router, http.MethodGet, developerRouteRegistryPath+"?uin=450860000002", nil, signedAt)
	if response.Code != http.StatusOK {
		t.Fatalf("get status=%d body=%s", response.Code, response.Body.String())
	}
	var got devroute.StoredRegistration
	if err := json.Unmarshal(response.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode get: %v", err)
	}
	if got.UIN != registration.UIN || got.TunnelTokenHash != "" || got.DisabledAt != nil {
		t.Fatalf("unexpected registration: %+v", got)
	}

	disabledAt := renewedAt.Add(time.Minute)
	disableBody, _ := json.Marshal(map[string]time.Time{"disabledAt": disabledAt})
	response = performSignedRegistryRequest(t, router, http.MethodDelete, developerRouteRegistryPath+"?uin=450860000002", disableBody, signedAt)
	if response.Code != http.StatusNoContent {
		t.Fatalf("disable status=%d body=%s", response.Code, response.Body.String())
	}
	stored, err := registry.Get(t.Context(), registration.UIN)
	if err != nil || stored.DisabledAt == nil || !stored.DisabledAt.Equal(disabledAt) {
		t.Fatalf("stored=%+v err=%v", stored, err)
	}
}

func TestDeveloperRouteRegistryRejectsUnsignedAndInvalidRecords(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	registerDeveloperRouteRegistryRoutes(router, ServerConfig{
		DeveloperRouteRegistry: devroute.NewMemoryRegistry(), DeveloperRouteRegistrySecret: "registry-secret",
		DeveloperRouteRegistryCaller: "cloudladdergateway", DeveloperRouteRegistryRouteID: "developer-route-registry",
	})

	unsigned := httptest.NewRequest(http.MethodGet, developerRouteRegistryPath+"/ready", nil)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, unsigned)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("unsigned status=%d", response.Code)
	}

	invalid := devroute.StoredRegistration{
		UIN: "450860000002", UserID: "user-1", BaseURL: "http://9.1.2.3:18084",
		DeliveryMode: "devtunnel", SourceIP: "9.1.2.3", Port: 18084,
		TunnelHost: "450860000002.tunnel.internal", TunnelTokenHash: "not-a-sha256",
		RenewedAt: time.Date(2026, 9, 17, 6, 0, 0, 0, time.UTC), TTLSeconds: 3600,
	}
	body, _ := json.Marshal(invalid)
	response = performSignedRegistryRequest(t, router, http.MethodPut, developerRouteRegistryPath, body, time.Now().UTC().Truncate(time.Second))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("invalid status=%d body=%s", response.Code, response.Body.String())
	}
}

func performSignedRegistryRequest(t *testing.T, handler http.Handler, method string, target string, body []byte, now time.Time) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, target, bytes.NewReader(body))
	cloudladdertransport.SignHTTPHeaders("registry-secret", request.Header, cloudladdertransport.Request{
		Caller: "cloudladdergateway", RouteID: "developer-route-registry", Method: method,
		Path: request.URL.EscapedPath(), Query: request.URL.RawQuery, Body: body,
	}, now)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}
