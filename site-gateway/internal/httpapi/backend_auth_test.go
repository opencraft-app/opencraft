package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"git.woa.com/wisp/mono/site-gateway/internal/siteauth"
)

// The static handler still rejects writes. Authentication must run before that
// dispatch so adding a dynamic handler cannot accidentally bypass required mode.
func TestRequiredModeAuthenticatesAllMethodsBeforeDispatch(t *testing.T) {
	now := time.Date(2026, 9, 29, 0, 0, 0, 0, time.UTC)
	provider := newFakeOIDCProvider(t, now)
	defer provider.Close()
	for _, method := range []string{"POST", "PUT", "PATCH", "DELETE", "OPTIONS"} {
		for _, identity := range []string{"anonymous", "owner", "foreign-owner", "foreign-site", "forged-header"} {
			t.Run(method+"/"+identity, func(t *testing.T) {
				obj := &fakeOrigin{}
				h := newRequiredHandler(t, now, provider, activeSite("ws-abc"), obj)
				host := "ws-abc." + domesticRootDomain
				req := requestWithHost(method, host, "/api/items")
				want := http.StatusUnauthorized
				if identity == "forged-header" {
					req.Header.Set("X-User-ID", "user-1")
				}
				if identity == "owner" || identity == "foreign-owner" || identity == "foreign-site" {
					claims := siteauth.SessionClaims{SiteID: "ws-abc", SiteHost: host, UserID: "user-1", Nonce: "test-nonce"}
					want = http.StatusMethodNotAllowed
					if identity == "foreign-owner" {
						claims.UserID = "user-2"
						want = http.StatusForbidden
					}
					if identity == "foreign-site" {
						claims.SiteID = "ws-other"
						want = http.StatusForbidden
					}
					value, err := h.auth.TokenCodec.SealSession(claims)
					if err != nil {
						t.Fatal(err)
					}
					req.AddCookie(&http.Cookie{Name: siteSessionCookie, Value: value})
				}
				rec := httptest.NewRecorder()
				h.ServeHTTP(rec, req)
				if rec.Code != want {
					t.Fatalf("status=%d want=%d", rec.Code, want)
				}
				if rec.Header().Get("Location") != "" {
					t.Fatal("non-navigation request must not redirect or replay its body")
				}
				if rec.Header().Get("Cache-Control") != "private, no-store" {
					t.Fatal("missing private cache policy")
				}
				if len(obj.requests) != 0 {
					t.Fatal("write request reached static origin")
				}
			})
		}
	}
}

func TestPublicModeStillRejectsStaticWrites(t *testing.T) {
	obj := &fakeOrigin{}
	h := newHandler(activeSite("ws-abc"), obj)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, requestWithHost("POST", "ws-abc."+rootDomain, "/api/items"))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status=%d", rec.Code)
	}
	if len(obj.requests) != 0 {
		t.Fatal("write reached static origin")
	}
}

func TestShareSessionDoesNotGrantWriteAccess(t *testing.T) {
	for _, method := range []string{"POST", "PUT", "PATCH", "DELETE", "OPTIONS"} {
		for _, authenticated := range []bool{false, true} {
			t.Run(method+"/"+map[bool]string{false: "anonymous", true: "share-viewer"}[authenticated], func(t *testing.T) {
				obj := &fakeOrigin{}
				h, codec := newShareHandler(t, activeShareSite("ws-abc"), obj, nil, false)
				host := "ws-abc." + domesticRootDomain
				req := requestWithHost(method, host, "/api/items")
				want := http.StatusUnauthorized
				if authenticated {
					token, err := codec.SealShareSession(siteauth.ShareSessionClaims{SiteID: "ws-abc", SiteHost: host, Generation: shareTestGeneration, Nonce: "test-nonce"}, activeShareVerification().ExpiresAt)
					if err != nil {
						t.Fatal(err)
					}
					req.AddCookie(&http.Cookie{Name: shareSessionCookie, Value: token})
					want = http.StatusForbidden
				}
				rec := httptest.NewRecorder()
				h.ServeHTTP(rec, req)
				if rec.Code != want {
					t.Fatalf("status=%d want=%d", rec.Code, want)
				}
				if rec.Header().Get("Location") != "" {
					t.Fatal("write redirected")
				}
				if len(obj.requests) != 0 {
					t.Fatal("write reached origin")
				}
			})
		}
	}
}
