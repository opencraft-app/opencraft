package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestDisabledReferralRoutesAreHidden(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/v1/referrals/codes/ABC234", nil)
	rec := httptest.NewRecorder()
	NewRouter(false, nil).ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status=%d, want 404", rec.Code)
	}
}

func TestAuthenticatedRouteRejectsMissingGatewayIdentity(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/v1/referrals/me/stats", nil)
	rec := httptest.NewRecorder()
	NewRouter(true, nil).ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d, want 401", rec.Code)
	}
}
