package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/openclaw/openclaw/mono/backend/auth/internal/service"
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

func TestPrepareReferralClaimsImmediatelyForAuthenticatedUser(t *testing.T) {
	now := time.Date(2026, 9, 17, 8, 20, 0, 0, time.UTC)
	store := service.NewMemoryStore(service.StoreOptions{Now: func() time.Time { return now }})
	svc := service.NewWithStore(store, service.Options{Now: func() time.Time { return now }})
	session, err := svc.SignUpWithPassword(context.Background(), service.PasswordSignUpInput{
		Name: "Existing", Email: "existing@example.com", Password: "password123",
	})
	if err != nil {
		t.Fatal(err)
	}
	router := NewRouter(svc, ServerConfig{ReferralEnabled: true, CookieSecure: true})
	req := httptest.NewRequest(http.MethodPost, "/auth/referral/prepare", strings.NewReader(`{"code":"HBYGSPXSAD"}`))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: session.Token})
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	for _, cookie := range rec.Result().Cookies() {
		if cookie.Name == referralCookieName && cookie.MaxAge > 0 {
			t.Fatalf("authenticated claim must not leave referral cookie: %+v", cookie)
		}
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
