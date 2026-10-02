package httpapi

import (
	"encoding/json"
	"fmt"
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

func TestFullstackShareSessionCanOnlyReadQualifiedPersistentBackend(t *testing.T) {
	now := time.Date(2026, 10, 2, 0, 0, 0, 0, time.UTC)
	provider := newFakeOIDCProvider(t, now)
	defer provider.Close()
	sites := activeSite("ws-abc")
	site := sites.sites["ws-abc"]
	site.Kind = "fullstack"
	site.ReleaseID = "wr-abc"
	site.BackendSHA256 = strings.Repeat("a", 64)
	site.AccessMode = sitemeta.AccessModeShareCode
	site.ShareGeneration = "generation-1"
	expiry := now.Add(time.Hour)
	site.ShareExpiresAt = &expiry
	h := newRequiredHandler(t, now, provider, sites, &fakeOrigin{})
	h.auth.Clock = func() time.Time { return now }
	calls := 0
	runtime := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		var in backend.Invocation
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			t.Error(err)
		}
		if !in.ReadOnly || (in.Method != "GET" && in.Method != "HEAD") {
			t.Error("share acquired writable runtime capability")
		}
		_ = json.NewEncoder(w).Encode(backend.Result{Status: 200, Body: []byte(`{"todos":["shared"]}`)})
	}))
	defer runtime.Close()
	client, err := backend.New(runtime.URL, "internal-test-token")
	if err != nil {
		t.Fatal(err)
	}
	h.backend = client
	host := "ws-abc." + domesticRootDomain
	share, err := h.auth.TokenCodec.SealShareSession(siteauth.ShareSessionClaims{SiteID: "ws-abc", SiteHost: host, Generation: "generation-1", Nonce: "share"}, now.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, method string
		enabled      bool
		generation   string
		want         int
	}{
		{"gate closed", "GET", false, "generation-1", 401},
		{"valid viewer", "GET", true, "generation-1", 200},
		{"valid head", "HEAD", true, "generation-1", 200},
		{"viewer write", "POST", true, "generation-1", 401},
		{"revoked", "GET", true, "generation-2", 401},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h.auth.BackendSharedRead = tc.enabled
			site.ShareGeneration = tc.generation
			req := requestWithHost(tc.method, host, "/api/todos")
			req.AddCookie(&http.Cookie{Name: shareSessionCookie, Value: share})
			req.Header.Set("X-Website-Release", "wr-abc")
			req.Header.Set("Origin", "https://"+host)
			req.Header.Set("X-Lightvela-Storage-Read-Only", "0")
			rec := httptest.NewRecorder()
			before := calls
			h.ServeHTTP(rec, req)
			if rec.Code != tc.want {
				t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
			}
			if tc.want != 200 && calls != before {
				t.Fatal("unauthorized upstream invocation")
			}
		})
	}
}

func TestFullstackShareAuthorizationIgnoresStalePositiveMetadata(t *testing.T) {
	for _, tc := range []struct {
		name   string
		change func(*sitemeta.Site, *fakeSites)
		want   int
	}{
		{"revoked generation", func(s *sitemeta.Site, _ *fakeSites) { s.ShareGeneration = "generation-2" }, 401},
		{"expired policy", func(s *sitemeta.Site, _ *fakeSites) {
			expiry := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
			s.ShareExpiresAt = &expiry
		}, 401},
		{"share disabled", func(s *sitemeta.Site, _ *fakeSites) { s.AccessMode = sitemeta.AccessModeOwnerOnly }, 401},
		{"fresh lookup failed", func(_ *sitemeta.Site, f *fakeSites) { f.freshErr = fmt.Errorf("fixture lookup unavailable") }, 503},
	} {
		t.Run(tc.name, func(t *testing.T) {
			now := time.Date(2026, 10, 2, 0, 0, 0, 0, time.UTC)
			provider := newFakeOIDCProvider(t, now)
			defer provider.Close()
			sites := activeSite("ws-abc")
			cached := sites.sites["ws-abc"]
			cached.Kind = "fullstack"
			cached.ReleaseID = "wr-abc"
			cached.BackendSHA256 = strings.Repeat("a", 64)
			cached.AccessMode = sitemeta.AccessModeShareCode
			cached.ShareGeneration = "generation-1"
			expires := now.Add(time.Hour)
			cached.ShareExpiresAt = &expires
			fresh := *cached
			sites.freshSites = map[string]*sitemeta.Site{"ws-abc": &fresh}
			tc.change(&fresh, sites)
			h := newRequiredHandler(t, now, provider, sites, &fakeOrigin{})
			h.auth.Clock = func() time.Time { return now }
			h.auth.BackendSharedRead = true
			called := false
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called = true; w.WriteHeader(200) }))
			defer upstream.Close()
			client, err := backend.New(upstream.URL, "internal-fixture-token")
			if err != nil {
				t.Fatal(err)
			}
			h.backend = client
			host := "ws-abc." + domesticRootDomain
			share, err := h.auth.TokenCodec.SealShareSession(siteauth.ShareSessionClaims{SiteID: "ws-abc", SiteHost: host, Generation: "generation-1", Nonce: "share"}, expires)
			if err != nil {
				t.Fatal(err)
			}
			req := requestWithHost("GET", host, "/api/todos")
			req.Header.Set("X-Website-Release", "wr-abc")
			req.AddCookie(&http.Cookie{Name: shareSessionCookie, Value: share})
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if rec.Code != tc.want || called {
				t.Fatalf("status=%d wanted=%d upstream=%v", rec.Code, tc.want, called)
			}
		})
	}
}
