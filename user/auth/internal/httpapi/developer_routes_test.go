package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/openclaw/openclaw/mono/backend/auth/internal/devroute"
)

type recordingDeveloperRouteClient struct {
	registerInput devroute.RegisterInput
	getUIN        int64
	disableUIN    int64
	err           error
}

func (c *recordingDeveloperRouteClient) Register(_ context.Context, input devroute.RegisterInput) (devroute.Registration, error) {
	c.registerInput = input
	if c.err != nil {
		return devroute.Registration{}, c.err
	}
	registration := testDeveloperRouteRegistration("active")
	registration.TunnelToken = "lvdt1.300000000053.test"
	return registration, nil
}

func (c *recordingDeveloperRouteClient) Get(_ context.Context, uin int64) (devroute.Registration, error) {
	c.getUIN = uin
	if c.err != nil {
		return devroute.Registration{}, c.err
	}
	return testDeveloperRouteRegistration("active"), nil
}

func (c *recordingDeveloperRouteClient) Disable(_ context.Context, uin int64) (devroute.Registration, error) {
	c.disableUIN = uin
	if c.err != nil {
		return devroute.Registration{}, c.err
	}
	return testDeveloperRouteRegistration("disabled"), nil
}

func testDeveloperRouteRegistration(status string) devroute.Registration {
	return devroute.Registration{
		Uin:        300000000053,
		Status:     status,
		TargetIP:   "192.0.2.1",
		Port:       18084,
		TunnelHost: "uin-300000000053.tunnel.internal",
		ExpiresAt:  fixedHTTPTestNow().Add(8 * time.Hour),
		UpdatedAt:  fixedHTTPTestNow(),
	}
}

func TestPersonalDeveloperRouteRequiresSession(t *testing.T) {
	client := &recordingDeveloperRouteClient{}
	router, _, _ := newShadowBindingHTTPTestRouterWithClients(httpTestShadowClient{}, client)

	response := performJSONRequest(t, router, http.MethodPost, "/auth/dev-environments/registration", map[string]any{"port": 18084, "ttlSeconds": 28800})
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d: %s", response.Code, response.Body.String())
	}
	if client.registerInput.Uin != 0 {
		t.Fatalf("unauthorized request reached control client: %+v", client.registerInput)
	}
}

func TestPersonalDeveloperRouteDerivesUINAndIPServerSide(t *testing.T) {
	client := &recordingDeveloperRouteClient{}
	router, svc, _ := newShadowBindingHTTPTestRouterWithClients(httpTestShadowClient{}, client)
	sessionCookie, _ := completePhone3FAHTTPFlow(t, router, svc)

	response := performJSONRequest(t, router, http.MethodPost, "/auth/dev-environments/registration", map[string]any{
		"port": 18084, "ttlSeconds": 28800,
	}, sessionCookie)
	if response.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", response.Code, response.Body.String())
	}
	if client.registerInput.Uin != 300000000053 || client.registerInput.TargetIP != "192.0.2.1" || client.registerInput.Port != 18084 || client.registerInput.TTLSeconds != 28800 {
		t.Fatalf("unexpected server-derived registration: %+v", client.registerInput)
	}
	if strings.Contains(response.Body.String(), "session") || !stringsContainsAll(response.Body.String(), `"uin":300000000053`, `"status":"active"`, `"tunnelHost":"uin-300000000053.tunnel.internal"`, `"tunnelToken":"lvdt1.300000000053.test"`) {
		t.Fatalf("unexpected response: %s", response.Body.String())
	}
	if got := response.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control=%q", got)
	}

	status := performJSONRequest(t, router, http.MethodGet, "/auth/dev-environments/registration", nil, sessionCookie)
	if status.Code != http.StatusOK || client.getUIN != 300000000053 {
		t.Fatalf("get status=%d uin=%d body=%s", status.Code, client.getUIN, status.Body.String())
	}
	if strings.Contains(status.Body.String(), "tunnelToken") {
		t.Fatalf("status response leaked one-time tunnel token: %s", status.Body.String())
	}
	disabled := performJSONRequest(t, router, http.MethodDelete, "/auth/dev-environments/registration", nil, sessionCookie)
	if disabled.Code != http.StatusOK || client.disableUIN != 300000000053 || !strings.Contains(disabled.Body.String(), `"status":"disabled"`) {
		t.Fatalf("delete status=%d uin=%d body=%s", disabled.Code, client.disableUIN, disabled.Body.String())
	}
}

func TestPersonalDeveloperRouteIsUnavailableWhenSandboxControlIsDisabled(t *testing.T) {
	router, svc, _ := newShadowBindingHTTPTestRouter()
	sessionCookie, _ := completePhone3FAHTTPFlow(t, router, svc)
	response := performJSONRequest(t, router, http.MethodPost, "/auth/dev-environments/registration", map[string]any{"port": 18084, "ttlSeconds": 28800}, sessionCookie)
	if response.Code != http.StatusServiceUnavailable || !strings.Contains(response.Body.String(), "personal_dev_environment_disabled") {
		t.Fatalf("expected disabled 503, got %d: %s", response.Code, response.Body.String())
	}
}

func TestPersonalDeveloperRouteIsUnavailableWithoutAuthService(t *testing.T) {
	handler := &Handler{developerRoutes: &recordingDeveloperRouteClient{}}
	ginContext, _ := gin.CreateTestContext(httptest.NewRecorder())
	ginContext.Request = httptest.NewRequest(http.MethodPost, "/auth/dev-environments/registration", nil)
	_, _, body, status := handler.personalDeveloperRouteIdentity(ginContext, true, true)
	if status != http.StatusServiceUnavailable || body == nil || body.Code != "personal_dev_environment_disabled" {
		t.Fatalf("status=%d body=%+v", status, body)
	}
}

func TestPersonalDeveloperRouteMapsGatewayFailures(t *testing.T) {
	client := &recordingDeveloperRouteClient{err: &devroute.Error{Status: http.StatusGatewayTimeout, Code: "target_timeout", Message: "target probe timed out"}}
	router, svc, _ := newShadowBindingHTTPTestRouterWithClients(httpTestShadowClient{}, client)
	sessionCookie, _ := completePhone3FAHTTPFlow(t, router, svc)
	response := performJSONRequest(t, router, http.MethodPost, "/auth/dev-environments/registration", map[string]any{"port": 18084, "ttlSeconds": 28800}, sessionCookie)
	if response.Code != http.StatusGatewayTimeout || !strings.Contains(response.Body.String(), "target_timeout") {
		t.Fatalf("expected 504, got %d: %s", response.Code, response.Body.String())
	}

	client.err = errors.New("connection refused")
	response = performJSONRequest(t, router, http.MethodGet, "/auth/dev-environments/registration", nil, sessionCookie)
	if response.Code != http.StatusBadGateway || !strings.Contains(response.Body.String(), "personal_dev_environment_unavailable") {
		t.Fatalf("expected 502, got %d: %s", response.Code, response.Body.String())
	}
}
