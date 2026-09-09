package gateway

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// This tests the required deployment policy, not the currently deployed config.
func TestNativeLoginPublicRulesAreExact(t *testing.T) {
	calls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()
	auth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer auth.Close()
	handler, err := NewHandler(Config{AuthServiceURL: auth.URL, Routes: []Route{{
		Name: "auth", Prefix: "/auth/", Upstream: upstream.URL, Access: AccessAuthenticated,
		PublicAllow: []PublicRule{{Method: "GET", Path: "/auth/native/start"}, {Method: "POST", Path: "/auth/native/token"}},
	}}})
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		method, path string
		allowed      bool
	}{
		{"GET", "/auth/native/start", true}, {"POST", "/auth/native/token", true},
		{"GET", "/auth/native/token", false}, {"POST", "/auth/native/start", false}, {"GET", "/auth/session", false},
	} {
		before := calls
		r := httptest.NewRecorder()
		handler.ServeHTTP(r, httptest.NewRequest(tc.method, tc.path, nil))
		if tc.allowed {
			if r.Code != 204 || calls != before+1 {
				t.Errorf("public %s %s: %d", tc.method, tc.path, r.Code)
			}
		} else if r.Code != 401 || calls != before {
			t.Errorf("protected %s %s: %d", tc.method, tc.path, r.Code)
		}
	}
}
