package gateway

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestValidateManagedSetAdminBaseURL(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name    string
		setID   string
		baseURL string
		wantErr bool
	}{
		{name: "short service", setID: "set-auto-000001", baseURL: "http://llmgateway-set-auto-000001-newapi-admin:3000"},
		{name: "legacy short service", setID: "set-auto-000001", baseURL: "http://llmgateway-set-auto-000001-newapi:3000"},
		{name: "namespace service fqdn", setID: "set-auto-000001", baseURL: "http://llmgateway-set-auto-000001-newapi-admin.llmgateway.svc:3000"},
		{name: "full cluster fqdn", setID: "set-auto-000001", baseURL: "http://llmgateway-set-auto-000001-newapi-admin.llmgateway.svc.cluster.local:3000"},
		{name: "metadata ip", setID: "set-auto-000001", baseURL: "http://169.254.169.254:3000", wantErr: true},
		{name: "loopback ip", setID: "set-auto-000001", baseURL: "http://127.0.0.1:3000", wantErr: true},
		{name: "unrelated cluster service", setID: "set-auto-000001", baseURL: "http://kubernetes.default.svc:3000", wantErr: true},
		{name: "external hostname", setID: "set-auto-000001", baseURL: "http://llmgateway-set-auto-000001-newapi-admin.example.com:3000", wantErr: true},
		{name: "wrong set", setID: "set-auto-000001", baseURL: "http://llmgateway-set-auto-000002-newapi-admin:3000", wantErr: true},
		{name: "wrong port", setID: "set-auto-000001", baseURL: "http://llmgateway-set-auto-000001-newapi-admin:80", wantErr: true},
		{name: "https", setID: "set-auto-000001", baseURL: "https://llmgateway-set-auto-000001-newapi-admin:3000", wantErr: true},
		{name: "path", setID: "set-auto-000001", baseURL: "http://llmgateway-set-auto-000001-newapi-admin:3000/latest/meta-data", wantErr: true},
		{name: "query", setID: "set-auto-000001", baseURL: "http://llmgateway-set-auto-000001-newapi-admin:3000?next=metadata", wantErr: true},
		{name: "userinfo", setID: "set-auto-000001", baseURL: "http://user@llmgateway-set-auto-000001-newapi-admin:3000", wantErr: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := validateManagedSetAdminBaseURL(test.setID, test.baseURL)
			if test.wantErr && !errors.Is(err, ErrUnsafeSetURL) {
				t.Fatalf("error = %v, want ErrUnsafeSetURL", err)
			}
			if !test.wantErr && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
		})
	}
}

func TestValidateManagedSetTrafficBaseURL(t *testing.T) {
	t.Parallel()
	for _, baseURL := range []string{
		"http://llmgateway-set-auto-000001-newapi-traffic:3000",
		"http://llmgateway-set-auto-000001-g2-newapi-traffic:3000",
	} {
		if err := validateManagedSetTrafficBaseURL("set-auto-000001", baseURL); err != nil {
			t.Fatalf("%s: %v", baseURL, err)
		}
	}
	for _, baseURL := range []string{
		"http://169.254.169.254:3000",
		"http://llmgateway-set-auto-000001-g0-newapi-traffic:3000",
		"http://llmgateway-set-auto-000002-newapi-traffic:3000",
	} {
		if err := validateManagedSetTrafficBaseURL("set-auto-000001", baseURL); !errors.Is(err, ErrUnsafeSetURL) {
			t.Fatalf("%s error = %v, want ErrUnsafeSetURL", baseURL, err)
		}
	}
}

func TestStrictSetURLPolicyRejectsUnsafeRegistrationAndPatch(t *testing.T) {
	t.Parallel()
	store := NewMemoryStore()
	service := NewService(store, nil, Options{EnforceManagedSetURLs: true})

	err := service.RegisterSet(t.Context(), RegisterSetInput{
		ID: "set-a", BaseURL: "http://169.254.169.254:3000", Status: SetStatusActive,
	})
	if !errors.Is(err, ErrUnsafeSetURL) {
		t.Fatalf("register error = %v, want ErrUnsafeSetURL", err)
	}

	mustSaveSet(t, store, Set{ID: "set-a", BaseURL: "http://llmgateway-set-a-newapi-admin:3000", Status: SetStatusActive})
	_, err = service.PatchResourceRow(t.Context(), "sets", "set-a", map[string]any{
		"base_url": "http://kubernetes.default.svc:3000",
	})
	if !errors.Is(err, ErrUnsafeSetURL) {
		t.Fatalf("patch error = %v, want ErrUnsafeSetURL", err)
	}
	set, ok, getErr := store.GetSet(t.Context(), "set-a")
	if getErr != nil || !ok {
		t.Fatalf("get set ok=%v err=%v", ok, getErr)
	}
	if set.BaseURL != "http://llmgateway-set-a-newapi-admin:3000" {
		t.Fatalf("unsafe patch changed base url to %q", set.BaseURL)
	}
}

func TestStrictSetURLPolicyAcceptsManagedServices(t *testing.T) {
	t.Parallel()
	service := NewService(NewMemoryStore(), nil, Options{EnforceManagedSetURLs: true})
	err := service.RegisterSet(t.Context(), RegisterSetInput{
		ID:             "set-auto-000001",
		BaseURL:        "http://llmgateway-set-auto-000001-newapi-admin:3000",
		TrafficBaseURL: "http://llmgateway-set-auto-000001-g2-newapi-traffic:3000",
		Status:         SetStatusActive,
	})
	if err != nil {
		t.Fatalf("register managed set: %v", err)
	}
}

func TestStrictNewAPITransportBlocksCrossOriginRedirect(t *testing.T) {
	t.Parallel()
	var requests int
	service := NewService(NewMemoryStore(), roundTripFunc(func(request *http.Request) (*http.Response, error) {
		requests++
		if requests > 1 {
			t.Fatalf("unsafe redirect reached underlying transport: %s", request.URL)
		}
		return &http.Response{
			StatusCode: http.StatusFound,
			Header:     http.Header{"Location": []string{"http://169.254.169.254/latest/meta-data"}},
			Body:       io.NopCloser(strings.NewReader("redirect")),
			Request:    request,
		}, nil
	}), Options{EnforceManagedSetURLs: true})

	_, err := service.newAPIClient("set-a", "http://llmgateway-set-a-newapi-admin:3000").GetSetup(t.Context())
	if !errors.Is(err, ErrUnsafeSetURL) {
		t.Fatalf("error = %v, want ErrUnsafeSetURL", err)
	}
	if requests != 1 {
		t.Fatalf("underlying requests = %d, want 1", requests)
	}
}

func TestStrictConsoleProxyRejectsUnsafeStoredDestination(t *testing.T) {
	t.Parallel()
	store := NewMemoryStore()
	mustSaveSet(t, store, Set{ID: "set-a", BaseURL: "http://169.254.169.254:3000", Status: SetStatusActive})
	service := NewService(store, roundTripFunc(func(request *http.Request) (*http.Response, error) {
		t.Fatalf("unsafe console request reached transport: %s", request.URL)
		return nil, nil
	}), Options{EnforceManagedSetURLs: true})

	request := httptest.NewRequest(http.MethodGet, "/admin", nil)
	recorder := httptest.NewRecorder()
	service.ProxyConsoleHTTP(recorder, request, "set-a", "/")
	if recorder.Code != http.StatusBadGateway {
		t.Fatalf("status = %d body = %s", recorder.Code, recorder.Body.String())
	}
}

func TestStrictTrafficProxyRejectsUnsafeCachedDestination(t *testing.T) {
	t.Parallel()
	store := NewMemoryStore()
	cache := NewMemoryAPIKeyRouteCache(0, 10)
	service := NewService(store, roundTripFunc(func(request *http.Request) (*http.Response, error) {
		t.Fatalf("unsafe traffic request reached transport: %s", request.URL)
		return nil, nil
	}), Options{EnforceManagedSetURLs: true, KeyRouteCache: cache})
	externalKey, externalKeyID := saveTestAPIKey(t, store, "unsafe-cache", APIKeyBinding{})
	lookup := parseTrafficRouteLookup(externalKey)
	if err := cache.SetRoute(t.Context(), TrafficRouteSnapshot{
		ExternalKeyID:   externalKeyID,
		ExternalKeyHash: hashExternalKey(externalKey),
		SecretHash:      lookup.SecretHash,
		KeyVersion:      lookup.Version,
		RouteSlot:       lookup.RouteSlot,
		SetID:           "set-a",
		SetBaseURL:      "http://169.254.169.254:3000",
		UpstreamKey:     "sk-upstream",
		Enabled:         true,
	}); err != nil {
		t.Fatal(err)
	}

	request := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{"model":"auto"}`))
	request.Header.Set("Authorization", "Bearer "+externalKey)
	recorder := httptest.NewRecorder()
	service.ProxyHTTP(recorder, request)
	if recorder.Code != http.StatusBadGateway {
		t.Fatalf("status = %d body = %s", recorder.Code, recorder.Body.String())
	}
}
