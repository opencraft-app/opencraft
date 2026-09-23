package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/openclaw/openclaw/mono/backend/auth/internal/service"
	"github.com/openclaw/openclaw/mono/backend/auth/internal/shadowbinding"
)

func TestDeveloperTestAccountLeaseRoutesAreDisabledByDefault(t *testing.T) {
	router, _, _ := newShadowBindingHTTPTestRouter()
	response := performJSONRequest(t, router, http.MethodPost, "/auth/dev-environments/account-lease", map[string]any{
		"targetIp": "9.1.2.3", "ttlSeconds": 28800,
	})
	if response.Code != http.StatusNotFound {
		t.Fatalf("disabled account lease route status = %d, want 404: %s", response.Code, response.Body.String())
	}
}

func TestDeveloperTestAccountLeaseHTTPContract(t *testing.T) {
	router, service, userID := newDeveloperTestAccountLeaseHTTPTestRouter(t)

	forbidden := performJSONRequest(t, router, http.MethodPost, "/auth/dev-environments/account-lease", map[string]any{
		"targetIp": "9.1.2.3", "ttlSeconds": 28800,
	})
	if forbidden.Code != http.StatusForbidden || !stringsContainsAll(forbidden.Body.String(), `"code":"developer_test_account_source_forbidden"`) {
		t.Fatalf("untrusted source status = %d, body=%s", forbidden.Code, forbidden.Body.String())
	}

	invalid := performDeveloperTestAccountLease(t, router, "14.116.239.35", map[string]any{
		"targetIp": "127.0.0.1", "ttlSeconds": 28800,
	})
	if invalid.Code != http.StatusBadRequest || !stringsContainsAll(invalid.Body.String(), `"code":"invalid_target_ip"`) {
		t.Fatalf("unsafe target status = %d, body=%s", invalid.Code, invalid.Body.String())
	}
	first := performDeveloperTestAccountLease(t, router, "14.116.239.35", map[string]any{
		"targetIp": "9.1.2.3", "ttlSeconds": 28800,
	})
	if first.Code != http.StatusOK {
		t.Fatalf("lease account status = %d, body=%s", first.Code, first.Body.String())
	}
	var leased developerTestAccountLeaseResponse
	decodeJSONResponse(t, first, &leased)
	if leased.UserID != userID || leased.SessionToken == "" || leased.LeaseVersion != 1 || leased.LeaseExpires == "" || leased.SessionExpires == "" {
		t.Fatalf("unexpected lease response: %+v", leased)
	}

	renewWithoutSession := performDeveloperTestAccountLease(t, router, "14.22.11.167", map[string]any{
		"targetIp": "9.1.2.3", "ttlSeconds": 43200,
	})
	if renewWithoutSession.Code != http.StatusUnauthorized || !stringsContainsAll(renewWithoutSession.Body.String(), `"code":"developer_test_account_renewal_requires_session"`) {
		t.Fatalf("unauthenticated renewal status = %d, body=%s", renewWithoutSession.Code, renewWithoutSession.Body.String())
	}

	renewed := performDeveloperTestAccountLeaseWithToken(t, router, "14.22.11.167", leased.SessionToken, map[string]any{
		"targetIp": "9.1.2.3", "ttlSeconds": 43200,
	})
	if renewed.Code != http.StatusOK {
		t.Fatalf("renew account status = %d, body=%s", renewed.Code, renewed.Body.String())
	}
	var renewedLease developerTestAccountLeaseResponse
	decodeJSONResponse(t, renewed, &renewedLease)
	if renewedLease.UserID != userID || renewedLease.LeaseVersion != 2 || renewedLease.SessionToken == leased.SessionToken {
		t.Fatalf("unexpected renewed lease: %+v", renewedLease)
	}

	busy := performDeveloperTestAccountLease(t, router, "21.8.8.8", map[string]any{
		"targetIp": "21.8.8.8", "ttlSeconds": 28800,
	})
	if busy.Code != http.StatusConflict || !stringsContainsAll(busy.Body.String(), `"code":"developer_test_account_busy"`) {
		t.Fatalf("occupied pool status = %d, body=%s", busy.Code, busy.Body.String())
	}

	wrongOwner := performDeveloperTestAccountRelease(t, router, renewedLease.SessionToken, "21.8.8.8")
	if wrongOwner.Code != http.StatusConflict || !stringsContainsAll(wrongOwner.Body.String(), `"code":"developer_test_account_lease_not_found"`) {
		t.Fatalf("wrong-owner release status = %d, body=%s", wrongOwner.Code, wrongOwner.Body.String())
	}

	released := performDeveloperTestAccountRelease(t, router, renewedLease.SessionToken, "9.1.2.3")
	if released.Code != http.StatusOK || !stringsContainsAll(released.Body.String(), `"userId":"`+userID+`"`, `"released":true`, `"leaseVersion":3`) {
		t.Fatalf("release status = %d, body=%s", released.Code, released.Body.String())
	}
	if _, err := service.CurrentSession(context.Background(), renewedLease.SessionToken); err == nil {
		t.Fatal("released account lease session remained valid")
	}
}

func newDeveloperTestAccountLeaseHTTPTestRouter(t *testing.T) (*gin.Engine, *service.Service, string) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	store := service.NewMemoryStore(service.StoreOptions{Now: fixedHTTPTestNow, SeedDefaultInvites: true})
	shadowService := shadowbinding.New(shadowbinding.NewMemoryStore(), httpTestShadowClient{}, shadowbinding.Options{Enabled: true, Now: fixedHTTPTestNow})
	authService := service.NewWithStore(store, service.Options{
		Now:                        fixedHTTPTestNow,
		SessionTTL:                 30 * 24 * time.Hour,
		RealnameVerifier:           httpStubRealnameVerifier{},
		RealnameCipher:             httpStubRealnameCipher{},
		ShadowBinding:              shadowService,
		ShadowBasicAuthSyncEnabled: true,
	})
	seedRouter := NewRouter(authService, ServerConfig{
		CookieSecure:               true,
		CookieSameSite:             http.SameSiteNoneMode,
		SessionTTL:                 30 * 24 * time.Hour,
		PublicBaseURL:              "https://api-sandbox-bj-7.lightclaw.tech",
		ShadowBindingInternalToken: "shadow-internal-token",
		ShadowTencentCallbackToken: "callback-token",
	})
	_, userID := completePhone3FAHTTPFlow(t, seedRouter, authService)

	router := NewRouter(authService, ServerConfig{
		CookieSecure:                       true,
		CookieSameSite:                     http.SameSiteNoneMode,
		SessionTTL:                         30 * 24 * time.Hour,
		PublicBaseURL:                      "https://api-sandbox-bj-7.lightclaw.tech",
		ShadowBindingInternalToken:         "shadow-internal-token",
		ShadowTencentCallbackToken:         "callback-token",
		DeveloperTestAccountLeaseEnabled:   true,
		DeveloperTestAccountPoolUserIDs:    []string{userID},
		DeveloperTestAccountLeaseNamespace: "sandbox-bj-7",
		DeveloperTestAccountSourceCIDRs: []netip.Prefix{
			netip.MustParsePrefix("9.0.0.0/8"),
			netip.MustParsePrefix("21.0.0.0/8"),
			netip.MustParsePrefix("14.22.11.160/29"),
			netip.MustParsePrefix("14.116.239.32/29"),
		},
	})
	return router, authService, userID
}

func TestDeveloperTestAccountLeaseForceTakeoverHTTPContract(t *testing.T) {
	router, authService, userID := newDeveloperTestAccountLeaseHTTPTestRouter(t)

	first := performDeveloperTestAccountLease(t, router, "21.214.48.147", map[string]any{
		"targetIp": "21.214.48.147", "ttlSeconds": 28800,
	})
	if first.Code != http.StatusOK {
		t.Fatalf("initial lease status = %d, body=%s", first.Code, first.Body.String())
	}
	var leased developerTestAccountLeaseResponse
	decodeJSONResponse(t, first, &leased)

	// Same DevCloud, session lost locally, force omitted: still locked out.
	blocked := performDeveloperTestAccountLease(t, router, "21.214.48.147", map[string]any{
		"targetIp": "21.214.48.147", "ttlSeconds": 28800,
	})
	if blocked.Code != http.StatusUnauthorized || !stringsContainsAll(blocked.Body.String(), `"code":"developer_test_account_renewal_requires_session"`) {
		t.Fatalf("sessionless re-acquire status = %d, body=%s", blocked.Code, blocked.Body.String())
	}

	forced := performDeveloperTestAccountLease(t, router, "21.214.48.147", map[string]any{
		"targetIp": "21.214.48.147", "ttlSeconds": 28800, "force": true,
	})
	if forced.Code != http.StatusOK {
		t.Fatalf("forced takeover status = %d, body=%s", forced.Code, forced.Body.String())
	}
	var reclaimed developerTestAccountLeaseResponse
	decodeJSONResponse(t, forced, &reclaimed)
	if reclaimed.UserID != userID || reclaimed.LeaseVersion != leased.LeaseVersion+1 || reclaimed.SessionToken == leased.SessionToken {
		t.Fatalf("unexpected forced takeover response: %+v", reclaimed)
	}
	if _, err := authService.CurrentSession(context.Background(), leased.SessionToken); err == nil {
		t.Fatal("stale lease session remained valid after forced takeover")
	}

	// force never bypasses the source allowlist.
	forbidden := performJSONRequest(t, router, http.MethodPost, "/auth/dev-environments/account-lease", map[string]any{
		"targetIp": "21.214.48.147", "ttlSeconds": 28800, "force": true,
	})
	if forbidden.Code != http.StatusForbidden || !stringsContainsAll(forbidden.Body.String(), `"code":"developer_test_account_source_forbidden"`) {
		t.Fatalf("forced takeover from untrusted source status = %d, body=%s", forbidden.Code, forbidden.Body.String())
	}

	// force never lets another DevCloud steal an active lease from a single-account pool.
	otherOwner := performDeveloperTestAccountLease(t, router, "21.214.48.148", map[string]any{
		"targetIp": "21.214.48.148", "ttlSeconds": 28800, "force": true,
	})
	if otherOwner.Code != http.StatusConflict || !stringsContainsAll(otherOwner.Body.String(), `"code":"developer_test_account_busy"`) {
		t.Fatalf("forced takeover by a different owner status = %d, body=%s", otherOwner.Code, otherOwner.Body.String())
	}
}

func performDeveloperTestAccountRelease(t *testing.T, router http.Handler, token string, targetIP string) *httptest.ResponseRecorder {
	t.Helper()
	payload, err := json.Marshal(map[string]any{"targetIp": targetIP})
	if err != nil {
		t.Fatalf("marshal release payload: %v", err)
	}
	request := httptest.NewRequest(http.MethodDelete, "/auth/dev-environments/account-lease", bytes.NewReader(payload))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("X-Lightclaw-Client-IP", "14.116.239.35")
	return performRequest(router, request)
}

func performDeveloperTestAccountLease(t *testing.T, router http.Handler, sourceIP string, body any) *httptest.ResponseRecorder {
	t.Helper()
	return performDeveloperTestAccountLeaseWithToken(t, router, sourceIP, "", body)
}

func performDeveloperTestAccountLeaseWithToken(t *testing.T, router http.Handler, sourceIP string, token string, body any) *httptest.ResponseRecorder {
	t.Helper()
	payload, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal lease payload: %v", err)
	}
	request := httptest.NewRequest(http.MethodPost, "/auth/dev-environments/account-lease", bytes.NewReader(payload))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Lightclaw-Client-IP", sourceIP)
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	return performRequest(router, request)
}
