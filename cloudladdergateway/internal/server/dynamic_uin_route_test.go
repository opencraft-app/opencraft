package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/openclaw/openclaw/mono/cloudladdergateway/internal/auth"
	"github.com/openclaw/openclaw/mono/cloudladdergateway/internal/config"
	"github.com/openclaw/openclaw/mono/cloudladdergateway/internal/devroute"
	"github.com/openclaw/openclaw/mono/cloudladdergateway/internal/proxy"
)

func TestDynamicUINRouteOverridesStaticRegistration(t *testing.T) {
	var fallbackHits, staticHits, dynamicHits int
	fallback := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fallbackHits++
		_, _ = w.Write([]byte("fallback"))
	}))
	defer fallback.Close()
	static := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		staticHits++
		_, _ = w.Write([]byte("static"))
	}))
	defer static.Close()
	dynamic := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		dynamicHits++
		_, _ = w.Write([]byte("dynamic"))
	}))
	defer dynamic.Close()

	now := time.Date(2026, 9, 8, 10, 0, 0, 0, time.UTC)
	store := devroute.NewMemoryStore()
	if err := store.Upsert(context.Background(), devroute.Registration{
		UIN: "450860000013", UserID: "usr_dev", BaseURL: dynamic.URL,
		DeliveryMode: devroute.DeliveryModeDirect, SourceIP: "9.134.214.121", Port: 18084,
		RenewedAt: now, TTL: 8 * time.Hour,
	}); err != nil {
		t.Fatal(err)
	}
	router := newDynamicRouteRouter(t, fallback.URL, static.URL, store, now)
	rec := postCallback(t, router, jifeiCallbackBody(`"450860000013"`))
	if rec.Code != http.StatusOK || rec.Body.String() != "dynamic" {
		t.Fatalf("status=%d body=%q", rec.Code, rec.Body.String())
	}
	if dynamicHits != 1 || staticHits != 0 || fallbackHits != 0 {
		t.Fatalf("hits dynamic=%d static=%d fallback=%d", dynamicHits, staticHits, fallbackHits)
	}
}

func TestDynamicUINRouteFailsClosedWhenRegistrationIsUnavailable(t *testing.T) {
	states := []struct {
		name         string
		disabled     bool
		renewedAt    time.Time
		wantResponse int
	}{
		{name: "expired", renewedAt: time.Date(2026, 9, 8, 1, 0, 0, 0, time.UTC), wantResponse: http.StatusServiceUnavailable},
		{name: "disabled", renewedAt: time.Date(2026, 9, 8, 9, 0, 0, 0, time.UTC), disabled: true, wantResponse: http.StatusServiceUnavailable},
	}
	for _, tc := range states {
		t.Run(tc.name, func(t *testing.T) {
			var fallbackHits, dynamicHits int
			fallback := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				fallbackHits++
			}))
			defer fallback.Close()
			dynamic := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				dynamicHits++
			}))
			defer dynamic.Close()
			now := time.Date(2026, 9, 8, 10, 0, 0, 0, time.UTC)
			store := devroute.NewMemoryStore()
			registration := devroute.Registration{
				UIN: "450860000013", UserID: "usr_dev", BaseURL: dynamic.URL,
				DeliveryMode: devroute.DeliveryModeDirect, SourceIP: "9.134.214.121", Port: 18084,
				RenewedAt: tc.renewedAt, TTL: 30 * time.Minute,
			}
			if tc.disabled {
				disabledAt := now.Add(-time.Minute)
				registration.DisabledAt = &disabledAt
			}
			if err := store.Upsert(context.Background(), registration); err != nil {
				t.Fatal(err)
			}
			if tc.disabled {
				if err := store.Disable(context.Background(), registration.UIN, now.Add(-time.Minute)); err != nil {
					t.Fatal(err)
				}
			}
			router := newDynamicRouteRouter(t, fallback.URL, "", store, now)
			rec := postCallback(t, router, jifeiCallbackBody(`"450860000013"`))
			if rec.Code != tc.wantResponse {
				t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
			}
			if fallbackHits != 0 || dynamicHits != 0 {
				t.Fatalf("unavailable registration must not forward: dynamic=%d fallback=%d", dynamicHits, fallbackHits)
			}
		})
	}
}

func TestDynamicUINRouteKeepsFallbackForNeverRegisteredUIN(t *testing.T) {
	var fallbackHits int
	fallback := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fallbackHits++
		_, _ = w.Write([]byte("fallback"))
	}))
	defer fallback.Close()
	now := time.Date(2026, 9, 8, 10, 0, 0, 0, time.UTC)
	router := newDynamicRouteRouter(t, fallback.URL, "", devroute.NewMemoryStore(), now)
	rec := postCallback(t, router, jifeiCallbackBody(`"450860009999"`))
	if rec.Code != http.StatusOK || fallbackHits != 1 {
		t.Fatalf("status=%d body=%s fallback=%d", rec.Code, rec.Body.String(), fallbackHits)
	}
}

func newDynamicRouteRouter(t *testing.T, fallbackURL string, staticURL string, store devroute.Store, now time.Time) http.Handler {
	t.Helper()
	routes := []config.RouteConfig{{
		ID: "jifei-callback", Condition: `request.method == "POST"`,
		Upstream: config.UpstreamConfig{BaseURL: fallbackURL, Timeout: "2s", AllowedMethods: []string{"POST"}},
	}}
	staticRoutes := map[string][]config.UinRoute{}
	if staticURL != "" {
		routes = append(routes, config.RouteConfig{
			ID: "jifei-callback-static", Condition: `request.method == "POST"`,
			Upstream: config.UpstreamConfig{BaseURL: staticURL, Timeout: "2s", AllowedMethods: []string{"POST"}},
		})
		staticRoutes["jifei-callback"] = []config.UinRoute{{Uin: "450860000013", RouteID: "jifei-callback-static"}}
	}
	cfg := config.Config{MaxBodyBytes: config.DefaultMaxBodyBytes, Routes: routes}
	engine, err := proxy.NewEngine(cfg)
	if err != nil {
		t.Fatal(err)
	}
	authenticator, err := auth.New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	return NewGinRouterWithDeveloperRoutes(engine, authenticator, cfg.MaxBodyBytes, staticRoutes, DeveloperRoutes{
		RouteID: "jifei-callback", Store: store, Now: func() time.Time { return now },
	})
}
