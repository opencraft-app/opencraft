package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestPrepareReferralStoresNormalizedHttpOnlyContext(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := NewRouter(nil, ServerConfig{ReferralEnabled: true, CookieSecure: true})
	req := httptest.NewRequest(http.MethodPost, "/auth/referral/prepare", strings.NewReader(`{"code":" abC234 "}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	cookies := rec.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatalf("cookies=%d, want 1", len(cookies))
	}
	cookie := cookies[0]
	if cookie.Name != referralCookieName || cookie.Value != "ABC234" || cookie.Path != referralCookiePath {
		t.Fatalf("unexpected cookie: %+v", cookie)
	}
	if !cookie.HttpOnly || !cookie.Secure || cookie.SameSite != http.SameSiteLaxMode || cookie.MaxAge <= 0 {
		t.Fatalf("unsafe referral cookie: %+v", cookie)
	}
}

func TestPrepareReferralIsHiddenWhenDisabled(t *testing.T) {
	router := NewRouter(nil, ServerConfig{})
	req := httptest.NewRequest(http.MethodPost, "/auth/referral/prepare", strings.NewReader(`{"code":"ABC234"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status=%d, want 404", rec.Code)
	}
}

func TestPrepareReferralRejectsAmbiguousFormat(t *testing.T) {
	router := NewRouter(nil, ServerConfig{ReferralEnabled: true})
	req := httptest.NewRequest(http.MethodPost, "/auth/referral/prepare", strings.NewReader(`{"code":"A B"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status=%d, want 400", rec.Code)
	}
	if len(rec.Result().Cookies()) != 0 {
		t.Fatal("invalid referral code must not set a cookie")
	}
}
