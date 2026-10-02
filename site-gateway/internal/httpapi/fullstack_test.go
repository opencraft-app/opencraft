package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"git.woa.com/wisp/mono/site-gateway/internal/backend"
	"git.woa.com/wisp/mono/site-gateway/internal/siteauth"
	"git.woa.com/wisp/mono/site-gateway/internal/sitemeta"
)

func TestFullstackOwnerRequestUsesPinnedRevisionAndStripsCredentials(t *testing.T) {
	const digest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	var calls int
	runtime := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Path != "/v1/sites/ws-abc/releases/wr-abc/invoke" {
			t.Errorf("path=%s", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer internal-test-token" || r.Header.Get("Cookie") != "" {
			t.Error("incorrect runtime credentials")
		}
		var in backend.Invocation
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			t.Error(err)
		}
		if in.SHA256 != digest || in.Method != "POST" || in.Path != "/api/sum?q=1" || string(in.Body) != "payload" {
			t.Errorf("wrong invocation %+v", in)
		}
		for k := range in.Headers {
			if k != "Content-Type" && k != "Accept" {
				t.Errorf("credential header leaked: %s", k)
			}
		}
		_ = json.NewEncoder(w).Encode(backend.Result{Status: 201, Headers: map[string]string{"Content-Type": "application/json", "Set-Cookie": "bad=1"}, Body: []byte(`{"ok":true}`)})
	}))
	defer runtime.Close()
	now := time.Date(2026, 9, 29, 0, 0, 0, 0, time.UTC)
	provider := newFakeOIDCProvider(t, now)
	defer provider.Close()
	sites := activeSite("ws-abc")
	sites.sites["ws-abc"].Kind = "fullstack"
	sites.sites["ws-abc"].ReleaseID = "wr-abc"
	sites.sites["ws-abc"].BackendSHA256 = digest
	obj := &fakeOrigin{}
	h := newRequiredHandler(t, now, provider, sites, obj)
	client, err := backend.New(runtime.URL, "internal-test-token")
	if err != nil {
		t.Fatal(err)
	}
	h.backend = client
	host := "ws-abc." + domesticRootDomain
	token, err := h.auth.TokenCodec.SealSession(siteauth.SessionClaims{SiteID: "ws-abc", SiteHost: host, UserID: "user-1", Nonce: "n"})
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, origin, cookie string
		status               int
	}{
		{"owner", "https://" + host, token, 201},
		{"anonymous", "https://" + host, "", 401},
		{"csrf", "https://attacker.example", token, 403},
		{"no-origin", "", token, 403},
	} {
		t.Run(tc.name, func(t *testing.T) {
			before := calls
			req := requestWithHost("POST", host, "/api/sum?q=1")
			req.Body = http.NoBody
			req = httptest.NewRequest("POST", "https://"+host+"/api/sum?q=1", strings.NewReader("payload"))
			req.Host = host
			req.Header.Set("X-Website-Release", "wr-abc")
 req.Header.Set("Origin", tc.origin)
			req.Header.Set("Authorization", "Bearer browser-secret")
			req.Header.Set("X-User-ID", "forged")
			req.Header.Set("Content-Type", "application/json")
			if tc.cookie != "" {
				req.AddCookie(&http.Cookie{Name: siteSessionCookie, Value: tc.cookie})
			}
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if rec.Code != tc.status {
				t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
			}
			if rec.Header().Get("Set-Cookie") != "" || rec.Header().Get("Location") != "" {
				t.Fatal("unsafe response headers")
			}
			if tc.status != 201 && calls != before {
				t.Fatal("unauthorized runtime call")
			}
		})
	}
	if len(obj.requests) != 0 {
		t.Fatal("API fell back to static origin")
	}
	sites.freshSites = map[string]*sitemeta.Site{"ws-abc": {SiteID: "ws-abc", Status: sitemeta.StatusSuspended, UserID: "user-1", Kind: "fullstack", ReleaseID: "wr-abc", BackendSHA256: digest}}
	req := requestWithHost("GET", host, "/api/sum")
	req.AddCookie(&http.Cookie{Name: siteSessionCookie, Value: token})
	rec := httptest.NewRecorder()
	before := calls
	h.ServeHTTP(rec, req)
	if rec.Code != 403 || calls != before {
		t.Fatal("stale active cache bypassed suspension")
	}
}
