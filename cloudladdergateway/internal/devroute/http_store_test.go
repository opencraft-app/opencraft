package devroute

import (
	"crypto/hmac"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/openclaw/openclaw/mono/shared/cloudladdertransport"
)

func TestHTTPStoreLifecycleAndHMAC(t *testing.T) {
	now := time.Date(2026, 9, 17, 6, 0, 0, 0, time.UTC)
	var mu sync.Mutex
	var stored registryRegistration
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if !validRegistrySignature(r, body, now, "registry-secret", "cloudladdergateway") {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		switch {
		case r.URL.Path == developerRouteRegistryPath+"/ready" && r.Method == http.MethodGet:
			w.WriteHeader(http.StatusNoContent)
		case r.URL.Path == developerRouteRegistryPath && r.Method == http.MethodPut:
			mu.Lock()
			defer mu.Unlock()
			if err := json.Unmarshal(body, &stored); err != nil {
				http.Error(w, "bad json", http.StatusBadRequest)
				return
			}
			w.WriteHeader(http.StatusNoContent)
		case r.URL.Path == developerRouteRegistryPath && r.Method == http.MethodGet:
			mu.Lock()
			defer mu.Unlock()
			if stored.UIN == "" || r.URL.Query().Get("uin") != stored.UIN {
				http.NotFound(w, r)
				return
			}
			_ = json.NewEncoder(w).Encode(stored)
		case r.URL.Path == developerRouteRegistryPath && r.Method == http.MethodDelete:
			mu.Lock()
			defer mu.Unlock()
			if stored.UIN == "" || r.URL.Query().Get("uin") != stored.UIN {
				http.NotFound(w, r)
				return
			}
			var request struct {
				DisabledAt time.Time `json:"disabledAt"`
			}
			_ = json.Unmarshal(body, &request)
			stored.DisabledAt = &request.DisabledAt
			w.WriteHeader(http.StatusNoContent)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	store, err := NewHTTPStore(HTTPStoreOptions{
		BaseURL: server.URL, Secret: "registry-secret", Caller: "cloudladdergateway",
		RouteID: "developer-route-registry", Client: server.Client(), Now: func() time.Time { return now },
		AllowedCIDRs: []string{"9.0.0.0/8"}, AllowedPorts: []int{18084}, DeliveryMode: DeliveryModeDirect,
	})
	if err != nil {
		t.Fatalf("new store: %v", err)
	}
	if err := store.Ready(t.Context()); err != nil {
		t.Fatalf("ready: %v", err)
	}
	registration := Registration{
		UIN: "450860000002", UserID: "user-1", BaseURL: "http://9.1.2.3:18084",
		DeliveryMode: DeliveryModeDirect, SourceIP: "9.1.2.3", Port: 18084,
		RenewedAt: now, TTL: time.Hour,
	}
	if err := store.Upsert(t.Context(), registration); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	got, err := store.Get(t.Context(), registration.UIN)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.UIN != registration.UIN || got.BaseURL != registration.BaseURL || got.State(now) != StateActive {
		t.Fatalf("got=%+v", got)
	}
	disabledAt := now.Add(time.Minute)
	if err := store.Disable(t.Context(), registration.UIN, disabledAt); err != nil {
		t.Fatalf("disable: %v", err)
	}
	got, err = store.Get(t.Context(), registration.UIN)
	if err != nil || got.State(disabledAt) != StateDisabled {
		t.Fatalf("disabled got=%+v err=%v", got, err)
	}
}

func TestHTTPStoreRejectsUntrustedRegistryData(t *testing.T) {
	now := time.Date(2026, 9, 17, 6, 0, 0, 0, time.UTC)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(registryRegistration{
			UIN: "450860000002", UserID: "user-1", BaseURL: "http://8.8.8.8:18084",
			DeliveryMode: DeliveryModeDirect, SourceIP: "8.8.8.8", Port: 18084,
			RenewedAt: now, TTLSeconds: 3600,
		})
	}))
	defer server.Close()
	store, err := NewHTTPStore(HTTPStoreOptions{
		BaseURL: server.URL, Secret: "secret", Caller: "caller", RouteID: "route", Client: server.Client(),
		AllowedCIDRs: []string{"9.0.0.0/8"}, AllowedPorts: []int{18084}, DeliveryMode: DeliveryModeDirect,
	})
	if err != nil {
		t.Fatalf("new store: %v", err)
	}
	if _, err := store.Get(t.Context(), "450860000002"); err == nil {
		t.Fatal("expected untrusted source IP to be rejected")
	}
}

func TestHTTPStoreRejectsOutOfRangeRegistryTTL(t *testing.T) {
	now := time.Date(2026, 9, 17, 6, 0, 0, 0, time.UTC)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(registryRegistration{
			UIN: "450860000002", UserID: "user-1", BaseURL: "http://9.1.2.3:18084",
			DeliveryMode: DeliveryModeDirect, SourceIP: "9.1.2.3", Port: 18084,
			RenewedAt: now, TTLSeconds: 86401,
		})
	}))
	defer server.Close()
	store, err := NewHTTPStore(HTTPStoreOptions{
		BaseURL: server.URL, Secret: "secret", Caller: "caller", RouteID: "route", Client: server.Client(),
		AllowedCIDRs: []string{"9.0.0.0/8"}, AllowedPorts: []int{18084}, DeliveryMode: DeliveryModeDirect,
	})
	if err != nil {
		t.Fatalf("new store: %v", err)
	}
	if _, err := store.Get(t.Context(), "450860000002"); err == nil {
		t.Fatal("expected out-of-range TTL to be rejected")
	}
}

func TestHTTPStoreMapsNotFoundAndDoesNotFollowRedirects(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.URL.Path == "/redirected" {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if r.Method == http.MethodGet && r.URL.Path == developerRouteRegistryPath {
			http.NotFound(w, r)
			return
		}
		http.Redirect(w, r, "/redirected", http.StatusFound)
	}))
	defer server.Close()
	store, err := NewHTTPStore(HTTPStoreOptions{
		BaseURL: server.URL, Secret: "secret", Caller: "caller", RouteID: "route", Client: server.Client(),
		AllowedCIDRs: []string{"9.0.0.0/8"}, AllowedPorts: []int{18084}, DeliveryMode: DeliveryModeDirect,
	})
	if err != nil {
		t.Fatalf("new store: %v", err)
	}
	if _, err := store.Get(t.Context(), "450860000002"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("get error=%v", err)
	}
	requests = 0
	if err := store.Ready(t.Context()); err == nil {
		t.Fatal("expected redirect readiness failure")
	}
	if requests != 1 {
		t.Fatalf("redirect was followed, requests=%d", requests)
	}
}

func validRegistrySignature(r *http.Request, body []byte, now time.Time, secret string, caller string) bool {
	if r.Header.Get(cloudladdertransport.HeaderCaller) != caller || r.Header.Get(cloudladdertransport.HeaderTimestamp) != now.Format(time.RFC3339) {
		return false
	}
	expected := cloudladdertransport.Sign(secret, cloudladdertransport.Request{
		Caller: caller, RouteID: "developer-route-registry", Method: r.Method,
		Path: r.URL.EscapedPath(), Query: r.URL.RawQuery, Body: body, Timestamp: now.Format(time.RFC3339),
	})
	return hmac.Equal([]byte(expected), []byte(r.Header.Get(cloudladdertransport.HeaderSignature)))
}
