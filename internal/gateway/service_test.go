package gateway

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestEnsureUserBindsToFirstActiveSetAndReusesBinding(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{RootUsername: "set-root", RootPassword: "Qq373866172!"})
	saveReadyServiceSet(t, store, "set-a")
	saveReadyServiceSet(t, store, "set-b")

	binding, err := svc.EnsureUserBinding(t.Context(), "user-1")
	if err != nil {
		t.Fatal(err)
	}
	if binding.SetID != "set-a" {
		t.Fatalf("set id = %s, want set-a", binding.SetID)
	}

	again, err := svc.EnsureUserBinding(t.Context(), "user-1")
	if err != nil {
		t.Fatal(err)
	}
	if again.SetID != binding.SetID {
		t.Fatalf("binding moved from %s to %s", binding.SetID, again.SetID)
	}
}

func TestEnsureUserBindingPreservesExistingTenantRoute(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{RootUsername: "set-root", RootPassword: "Qq373866172!"})
	saveReadyServiceSet(t, store, "set-a")
	saveReadyServiceSet(t, store, "set-b")
	setA, _, err := store.GetSet(t.Context(), "set-a")
	if err != nil {
		t.Fatal(err)
	}
	setA.ObservedUserCount = 10
	if err := store.SaveSet(t.Context(), setA); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.SetUserAssignment(t.Context(), UserAssignment{
		ExternalUserID: "user-1",
		Backend:        UserBackendNew,
		SetID:          "set-a",
	}); err != nil {
		t.Fatal(err)
	}

	binding, err := svc.EnsureUserBinding(t.Context(), "user-1")
	if err != nil {
		t.Fatal(err)
	}
	if binding.SetID != "set-a" {
		t.Fatalf("binding set = %q, want explicit assignment set-a", binding.SetID)
	}
	assignment, err := svc.GetUserAssignment(t.Context(), "user-1")
	if err != nil {
		t.Fatal(err)
	}
	if assignment.Backend != UserBackendNew || assignment.SetID != "set-a" {
		t.Fatalf("ensure binding should not downgrade tenant route: %+v", assignment)
	}
}

func TestEnsureUserBindingCreatesNewAPICompatiblePassword(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	saveReadyServiceSet(t, store, "set-a")

	binding, err := svc.EnsureUserBinding(t.Context(), "user-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(binding.Password) < 8 || len(binding.Password) > 20 {
		t.Fatalf("password length = %d, want 8..20", len(binding.Password))
	}
}

func TestEnsureUserBindingShortensLongExternalUserIDForNewAPIUsername(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	saveReadyServiceSet(t, store, "set-a")

	binding, err := svc.EnsureUserBinding(t.Context(), "usr_58b6bb1f68ba7f46584bd282")
	if err != nil {
		t.Fatal(err)
	}
	if len(binding.Username) > 20 {
		t.Fatalf("username length = %d, want <= 20: %q", len(binding.Username), binding.Username)
	}
	again, err := svc.EnsureUserBinding(t.Context(), "usr_58b6bb1f68ba7f46584bd282")
	if err != nil {
		t.Fatal(err)
	}
	if again.Username != binding.Username {
		t.Fatalf("username is not deterministic: %q != %q", again.Username, binding.Username)
	}
}

func TestProxyRewritesExternalKeyAndRoutesToBoundSet(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer sk-upstream" {
			t.Fatalf("authorization = %q", r.Header.Get("Authorization"))
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer upstream.Close()

	store := NewMemoryStore()
	svc := NewService(store, http.DefaultTransport, Options{})
	if err := svc.RegisterSet(t.Context(), RegisterSetInput{ID: "set-a", BaseURL: upstream.URL, Status: SetStatusActive}); err != nil {
		t.Fatal(err)
	}
	externalKey, _ := saveTestAPIKey(t, store, "rewrite", APIKeyBinding{SetID: "set-a", UpstreamKey: "sk-upstream"})

	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	req.Header.Set("Authorization", "Bearer "+externalKey)
	rec := httptest.NewRecorder()

	svc.ProxyHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	if rec.Body.String() != `{"ok":true}` {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestProxyCancelsUpstreamWhenClientContextIsCanceled(t *testing.T) {
	upstreamCanceled := make(chan struct{})
	release := make(chan struct{})
	store := NewMemoryStore()
	svc := NewService(store, roundTripFunc(func(r *http.Request) (*http.Response, error) {
		select {
		case <-r.Context().Done():
			close(upstreamCanceled)
			<-release
			return nil, r.Context().Err()
		case <-time.After(time.Second):
			return nil, errors.New("upstream context was not canceled")
		}
	}), Options{})
	if err := svc.RegisterSet(t.Context(), RegisterSetInput{ID: "set-a", BaseURL: "http://upstream", Status: SetStatusActive}); err != nil {
		t.Fatal(err)
	}
	externalKey, _ := saveTestAPIKey(t, store, "cancel", APIKeyBinding{SetID: "set-a", UpstreamKey: "sk-upstream"})

	ctx, cancel := context.WithCancel(context.Background())
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{"model":"x"}`)).WithContext(ctx)
	req.Header.Set("Authorization", "Bearer "+externalKey)
	done := make(chan struct{})
	go func() {
		defer close(done)
		svc.ProxyHTTP(httptest.NewRecorder(), req)
	}()

	cancel()
	select {
	case <-upstreamCanceled:
	case <-time.After(time.Second):
		t.Fatal("upstream did not observe client cancellation")
	}
	close(release)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("proxy did not return after upstream cancellation")
	}
}

func TestProxyUsesBYOKUpstreamKeyWhenUserPrefersBYOK(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer sk-byok-upstream" {
			t.Fatalf("authorization = %q", r.Header.Get("Authorization"))
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer upstream.Close()

	store := NewMemoryStore()
	svc := NewService(store, http.DefaultTransport, Options{})
	if err := svc.RegisterSet(t.Context(), RegisterSetInput{ID: "set-a", BaseURL: upstream.URL, Status: SetStatusActive}); err != nil {
		t.Fatal(err)
	}
	externalKey, _ := saveTestAPIKey(t, store, "byok", APIKeyBinding{
		SetID:       "set-a",
		UserID:      "user-1",
		UpstreamKey: "sk-platform-upstream",
	})
	if err := store.SaveUserLLMSettings(t.Context(), UserLLMSettings{
		ExternalUserID:    "user-1",
		Routing:           UserLLMRouting{Mode: LLMRouteBYOKFirst},
		Providers:         []UserLLMProvider{},
		BYOKUpstreamKey:   "sk-byok-upstream",
		BYOKUpstreamKeyID: 77,
	}); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	req.Header.Set("Authorization", "Bearer "+externalKey)
	rec := httptest.NewRecorder()

	svc.ProxyHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
}

func TestProxyFallsBackToPlatformKeyWhenBYOKGroupIsNotReady(t *testing.T) {
	var authorizations []string
	store := NewMemoryStore()
	svc := NewService(store, roundTripFunc(func(r *http.Request) (*http.Response, error) {
		authorizations = append(authorizations, r.Header.Get("Authorization"))
		if r.Header.Get("Authorization") == "Bearer sk-byok-upstream" {
			return &http.Response{
				StatusCode: http.StatusForbidden,
				Header:     http.Header{"Content-Type": []string{"application/json"}},
				Body:       io.NopCloser(strings.NewReader(`{"error":{"message":"分组 byok_xxx 已被弃用"}}`)),
			}, nil
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": []string{"application/json"}},
			Body:       io.NopCloser(strings.NewReader(`{"ok":true}`)),
		}, nil
	}), Options{})
	if err := svc.RegisterSet(t.Context(), RegisterSetInput{ID: "set-a", BaseURL: "http://upstream", Status: SetStatusActive}); err != nil {
		t.Fatal(err)
	}
	externalKey, _ := saveTestAPIKey(t, store, "byok-fallback", APIKeyBinding{
		SetID:       "set-a",
		UserID:      "user-1",
		UpstreamKey: "sk-platform-upstream",
	})
	if err := store.SaveUserLLMSettings(t.Context(), UserLLMSettings{
		ExternalUserID:    "user-1",
		Routing:           UserLLMRouting{Mode: LLMRouteBYOKFirst},
		Providers:         []UserLLMProvider{},
		BYOKUpstreamKey:   "sk-byok-upstream",
		BYOKUpstreamKeyID: 77,
	}); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{"model":"auto"}`))
	req.Header.Set("Authorization", "Bearer "+externalKey)
	rec := httptest.NewRecorder()

	svc.ProxyHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	if strings.Join(authorizations, ",") != "Bearer sk-byok-upstream,Bearer sk-platform-upstream" {
		t.Fatalf("authorizations = %#v", authorizations)
	}
}

func TestBYOKProviderPriorityKeepsUserOrderForNewAPIDescendingPriority(t *testing.T) {
	priorities := []int64{
		byokProviderPriority(0, 3),
		byokProviderPriority(1, 3),
		byokProviderPriority(2, 3),
	}
	if priorities[0] != 30 || priorities[1] != 20 || priorities[2] != 10 {
		t.Fatalf("priorities = %+v, want provider order to map to descending new-api priority", priorities)
	}
}

func TestBYOKRemoteIdentifiersAreShortAndDeterministic(t *testing.T) {
	userID := "usr_58b6bb1f68ba7f46584bd282"
	group := byokGroupForUser(userID)
	tokenName := byokTokenRemoteName(userID)
	channelName := byokProviderRemoteName(userID, "provider-with-a-very-long-name")

	if group != byokGroupForUser(userID) || tokenName != byokTokenRemoteName(userID) || channelName != byokProviderRemoteName(userID, "provider-with-a-very-long-name") {
		t.Fatal("BYOK remote identifiers must be deterministic")
	}
	if len(group) > 24 || len(tokenName) > 32 || len(channelName) > 48 {
		t.Fatalf("remote identifiers are too long: group=%q token=%q channel=%q", group, tokenName, channelName)
	}
	if strings.Contains(group, userID) || strings.Contains(tokenName, userID) || strings.Contains(channelName, userID) {
		t.Fatalf("remote identifiers should not embed the full external user id: group=%q token=%q channel=%q", group, tokenName, channelName)
	}
}

func TestSaveUserLLMSettingsInvalidatesTrafficRouteCache(t *testing.T) {
	var authorizations []string
	store := NewMemoryStore()
	svc := NewService(store, roundTripFunc(func(r *http.Request) (*http.Response, error) {
		authorizations = append(authorizations, r.Header.Get("Authorization"))
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": []string{"application/json"}},
			Body:       io.NopCloser(strings.NewReader(`{"ok":true}`)),
		}, nil
	}), Options{})
	if err := svc.RegisterSet(t.Context(), RegisterSetInput{ID: "set-a", BaseURL: "http://upstream", Status: SetStatusActive}); err != nil {
		t.Fatal(err)
	}
	externalKey, _ := saveTestAPIKey(t, store, "llm-settings", APIKeyBinding{
		SetID:       "set-a",
		UserID:      "user-1",
		UpstreamKey: "sk-platform-upstream",
	})
	if err := store.SaveUserLLMSettings(t.Context(), UserLLMSettings{
		ExternalUserID:    "user-1",
		Routing:           UserLLMRouting{Mode: LLMRoutePlatformFirst},
		Providers:         []UserLLMProvider{},
		BYOKUpstreamKey:   "sk-byok-upstream",
		BYOKUpstreamKeyID: 77,
	}); err != nil {
		t.Fatal(err)
	}

	firstReq := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	firstReq.Header.Set("Authorization", "Bearer "+externalKey)
	firstRec := httptest.NewRecorder()
	svc.ProxyHTTP(firstRec, firstReq)
	if firstRec.Code != http.StatusOK {
		t.Fatalf("first status = %d body = %s", firstRec.Code, firstRec.Body.String())
	}

	if _, err := svc.SaveUserLLMSettings(t.Context(), "user-1", UserLLMSettings{
		Routing: UserLLMRouting{Mode: LLMRouteBYOKFirst},
		Providers: []UserLLMProvider{{
			ID:            "provider-1",
			BaseURL:       "https://example.com",
			APIKey:        "sk-user-secret",
			ModelMappings: map[string]string{"auto": "model-a"},
			Enabled:       true,
		}},
	}); err != nil {
		t.Fatal(err)
	}

	secondReq := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	secondReq.Header.Set("Authorization", "Bearer "+externalKey)
	secondRec := httptest.NewRecorder()
	svc.ProxyHTTP(secondRec, secondReq)
	if secondRec.Code != http.StatusOK {
		t.Fatalf("second status = %d body = %s", secondRec.Code, secondRec.Body.String())
	}
	if strings.Join(authorizations, ",") != "Bearer sk-platform-upstream,Bearer sk-byok-upstream" {
		t.Fatalf("authorizations = %#v", authorizations)
	}
}

func TestProxyRejectsAPIKeyForDisabledTenant(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("disabled tenant traffic should not reach upstream")
	}))
	defer upstream.Close()

	store := NewMemoryStore()
	svc := NewService(store, http.DefaultTransport, Options{})
	if err := svc.RegisterSet(t.Context(), RegisterSetInput{ID: "set-a", BaseURL: upstream.URL, Status: SetStatusActive}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveTenant(t.Context(), Tenant{
		ExternalUserID: "user-1",
		Backend:        UserBackendNew,
		SetID:          "set-a",
		Status:         TenantStatusDisabled,
	}); err != nil {
		t.Fatal(err)
	}
	externalKey, _ := saveTestAPIKey(t, store, "disabled", APIKeyBinding{
		SetID:       "set-a",
		UserID:      "user-1",
		UpstreamKey: "sk-upstream",
	})

	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	req.Header.Set("Authorization", "Bearer "+externalKey)
	rec := httptest.NewRecorder()

	svc.ProxyHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
}

func TestProxyRejectsAPIKeyForPendingTenant(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("pending tenant traffic should not reach upstream")
	}))
	defer upstream.Close()

	store := NewMemoryStore()
	svc := NewService(store, http.DefaultTransport, Options{})
	if err := svc.RegisterSet(t.Context(), RegisterSetInput{ID: "set-a", BaseURL: upstream.URL, Status: SetStatusActive}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveTenant(t.Context(), Tenant{
		ExternalUserID: "user-pending",
		Backend:        UserBackendPending,
		Status:         TenantStatusActive,
	}); err != nil {
		t.Fatal(err)
	}
	externalKey, _ := saveTestAPIKey(t, store, "pending", APIKeyBinding{
		SetID:       "set-a",
		UserID:      "user-pending",
		UpstreamKey: "sk-upstream",
	})

	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	req.Header.Set("Authorization", "Bearer "+externalKey)
	rec := httptest.NewRecorder()
	svc.ProxyHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
}

func TestEnsureUserBindingStartsProvisioningAsAllocated(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	saveReadyServiceSet(t, store, "set-a")

	binding, err := svc.EnsureUserBinding(t.Context(), "user-1")
	if err != nil {
		t.Fatal(err)
	}
	if binding.ProvisionStatus != BindingProvisionStatusAllocated {
		t.Fatalf("provision status = %q, want %q", binding.ProvisionStatus, BindingProvisionStatusAllocated)
	}
	if binding.LastProvisionError != "" {
		t.Fatalf("last provision error = %q, want empty", binding.LastProvisionError)
	}
}

func TestProxyUsesAPIKeyRouteCacheAfterFirstLookup(t *testing.T) {
	store := &countingStore{Store: NewMemoryStore()}
	svc := NewService(store, roundTripFunc(func(r *http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": []string{"application/json"}},
			Body:       io.NopCloser(strings.NewReader(`{"ok":true}`)),
		}, nil
	}), Options{KeyRouteCache: NewMemoryAPIKeyRouteCache(time.Minute, 100)})
	if err := svc.RegisterSet(t.Context(), RegisterSetInput{ID: "set-a", BaseURL: "http://upstream", Status: SetStatusActive}); err != nil {
		t.Fatal(err)
	}
	externalKey, _ := saveTestAPIKey(t, store, "cache", APIKeyBinding{
		SetID:       "set-a",
		UpstreamKey: "sk-upstream",
	})

	for i := 0; i < 2; i++ {
		req := httptest.NewRequest(http.MethodGet, "/v1/models", nil)
		req.Header.Set("Authorization", "Bearer "+externalKey)
		rec := httptest.NewRecorder()

		svc.ProxyHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("request %d status = %d body = %s", i+1, rec.Code, rec.Body.String())
		}
	}
	if got := store.apiKeyLookups.Load(); got != 1 {
		t.Fatalf("api key store lookups = %d, want 1", got)
	}
}

func TestProxyUsesRouteSnapshotWithoutStoreLookups(t *testing.T) {
	store := &failingTrafficStore{Store: NewMemoryStore()}
	cache := NewMemoryAPIKeyRouteCache(time.Minute, 100)
	svc := NewService(store, roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if got := r.Header.Get("Authorization"); got != "Bearer sk-snapshot-upstream" {
			t.Fatalf("authorization = %q", got)
		}
		if got := r.URL.String(); got != "http://snapshot-upstream/v1/models" {
			t.Fatalf("upstream url = %q", got)
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": []string{"application/json"}},
			Body:       io.NopCloser(strings.NewReader(`{"ok":true}`)),
		}, nil
	}), Options{KeyRouteCache: cache, TrafficRouteCacheOnly: true})

	externalKeyID := "key-route-only"
	externalKey := signedExternalKeyForTest(externalKeyID, "route-secret")
	keyLookup := parseTrafficRouteLookup(externalKey)
	if err := cache.SetRoute(t.Context(), TrafficRouteSnapshot{
		ExternalKeyID:   keyLookup.ExternalKeyID,
		ExternalKeyHash: hashExternalKey(externalKey),
		SecretHash:      keyLookup.SecretHash,
		KeyVersion:      keyLookup.Version,
		RouteSlot:       keyLookup.RouteSlot,
		SetID:           "set-a",
		SetBaseURL:      "http://snapshot-upstream",
		UserID:          "user-1",
		UpstreamKey:     "sk-snapshot-upstream",
		Enabled:         true,
	}); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodGet, "/v1/models", nil)
	req.Header.Set("Authorization", "Bearer "+externalKey)
	rec := httptest.NewRecorder()

	svc.ProxyHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
}

func TestProxyUsesSetRuntimeRouteAndRevisionTransport(t *testing.T) {
	store := &failingTrafficStore{Store: NewMemoryStore()}
	cache := NewMemoryAPIKeyRouteCache(time.Minute, 100)
	var requestedURL string
	manager := NewTransportManager(func() http.RoundTripper {
		return roundTripFunc(func(r *http.Request) (*http.Response, error) {
			requestedURL = r.URL.String()
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     http.Header{"Content-Type": []string{"application/json"}},
				Body:       io.NopCloser(strings.NewReader(`{"ok":true}`)),
			}, nil
		})
	}, time.Minute)
	defer manager.Close()
	svc := NewService(store, nil, Options{
		KeyRouteCache:           cache,
		TrafficRouteCacheOnly:   true,
		SetRuntimeRouteRequired: true,
		TrafficTransportManager: manager,
	})

	externalKeyID := "key-runtime-route"
	externalKey := signedExternalKeyForTest(externalKeyID, "runtime-secret")
	keyLookup := parseTrafficRouteLookup(externalKey)
	if err := cache.SetRoute(t.Context(), TrafficRouteSnapshot{
		ExternalKeyID: keyLookup.ExternalKeyID, SecretHash: keyLookup.SecretHash,
		KeyVersion: keyLookup.Version, RouteSlot: keyLookup.RouteSlot, SetID: "set-a",
		SetBaseURL: "http://legacy-upstream", UpstreamKey: "sk-upstream", Enabled: true,
	}); err != nil {
		t.Fatal(err)
	}
	if applied, err := cache.SetSetRuntime(t.Context(), SetRuntimeRouteSnapshot{
		SetID: "set-a", RuntimeGeneration: 13, RouteRevision: 21,
		TrafficBaseURL: "http://runtime-upstream", Enabled: true,
	}); err != nil || !applied {
		t.Fatalf("set runtime applied=%v err=%v", applied, err)
	}

	req := httptest.NewRequest(http.MethodGet, "/v1/models", nil)
	req.Header.Set("Authorization", "Bearer "+externalKey)
	rec := httptest.NewRecorder()
	svc.ProxyHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if requestedURL != "http://runtime-upstream/v1/models" {
		t.Fatalf("requested URL=%q, want runtime route", requestedURL)
	}
}

func TestProxyFailsClosedWhenSetRuntimeRouteIsRequiredAndMissing(t *testing.T) {
	cache := NewMemoryAPIKeyRouteCache(time.Minute, 100)
	svc := NewService(&failingTrafficStore{Store: NewMemoryStore()}, nil, Options{
		KeyRouteCache: cache, TrafficRouteCacheOnly: true, SetRuntimeRouteRequired: true,
	})
	externalKeyID := "key-runtime-missing"
	externalKey := signedExternalKeyForTest(externalKeyID, "runtime-secret")
	keyLookup := parseTrafficRouteLookup(externalKey)
	if err := cache.SetRoute(t.Context(), TrafficRouteSnapshot{
		ExternalKeyID: keyLookup.ExternalKeyID, SecretHash: keyLookup.SecretHash,
		KeyVersion: keyLookup.Version, RouteSlot: keyLookup.RouteSlot, SetID: "set-a",
		SetBaseURL: "http://legacy-upstream", UpstreamKey: "sk-upstream", Enabled: true,
	}); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodGet, "/v1/models", nil)
	req.Header.Set("Authorization", "Bearer "+externalKey)
	rec := httptest.NewRecorder()
	svc.ProxyHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestProxyRejectsRouteCacheMissWithoutStoreFallbackWhenCacheOnly(t *testing.T) {
	store := &countingStore{Store: NewMemoryStore()}
	svc := NewService(store, nil, Options{KeyRouteCache: NewMemoryAPIKeyRouteCache(time.Minute, 100), TrafficRouteCacheOnly: true})

	req := httptest.NewRequest(http.MethodGet, "/v1/models", nil)
	req.Header.Set("Authorization", "Bearer "+signedExternalKeyForTest("key-missing", "missing-secret"))
	rec := httptest.NewRecorder()

	svc.ProxyHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	if got := store.apiKeyLookups.Load(); got != 0 {
		t.Fatalf("traffic cache-only mode hit store %d times", got)
	}
}

func TestRegisterSetStatusRefreshesTrafficRouteSnapshots(t *testing.T) {
	store := NewMemoryStore()
	cache := NewMemoryAPIKeyRouteCache(time.Minute, 100)
	svc := NewService(store, nil, Options{KeyRouteCache: cache})
	if err := svc.RegisterSet(t.Context(), RegisterSetInput{ID: "set-a", BaseURL: "http://upstream", Status: SetStatusActive}); err != nil {
		t.Fatal(err)
	}
	externalKeyID := "key-set-status"
	externalKey := signedExternalKeyForTest(externalKeyID, "set-secret")
	if err := store.SaveAPIKeyBinding(t.Context(), APIKeyBinding{
		ExternalKey:   externalKey,
		ExternalKeyID: externalKeyID,
		SetID:         "set-a",
		UserID:        "user-1",
		UpstreamKey:   "sk-upstream",
	}); err != nil {
		t.Fatal(err)
	}
	if err := svc.refreshSetTrafficRoutes(t.Context(), "set-a"); err != nil {
		t.Fatal(err)
	}

	lookup := parseTrafficRouteLookup(externalKey)
	if got, ok, err := cache.GetRoute(t.Context(), lookup); err != nil || !ok || !got.Enabled {
		t.Fatalf("route before disable = %+v ok=%v err=%v", got, ok, err)
	}
	if err := svc.RegisterSet(t.Context(), RegisterSetInput{ID: "set-a", BaseURL: "http://upstream", Status: SetStatusDisabled}); err != nil {
		t.Fatal(err)
	}
	if got, ok, err := cache.GetRoute(t.Context(), lookup); err != nil || !ok || got.Enabled {
		t.Fatalf("route after disable = %+v ok=%v err=%v", got, ok, err)
	}
	if err := svc.RegisterSet(t.Context(), RegisterSetInput{ID: "set-a", BaseURL: "http://upstream", Status: SetStatusActive}); err != nil {
		t.Fatal(err)
	}
	if got, ok, err := cache.GetRoute(t.Context(), lookup); err != nil || !ok || !got.Enabled {
		t.Fatalf("route after re-enable = %+v ok=%v err=%v", got, ok, err)
	}
}

func TestRegisterSetCannotReactivateDrainingLifecycle(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	mustSaveSet(t, store, Set{
		ID: "set-a", BaseURL: "http://old-upstream", Status: SetStatusDraining,
		LifecycleGeneration: 7,
	})

	if err := svc.RegisterSet(t.Context(), RegisterSetInput{
		ID: "set-a", BaseURL: "http://new-upstream", Status: SetStatusActive,
	}); err != nil {
		t.Fatal(err)
	}
	set, ok, err := store.GetSet(t.Context(), "set-a")
	if err != nil || !ok {
		t.Fatalf("set lookup ok=%v err=%v", ok, err)
	}
	if set.Status != SetStatusDraining || set.LifecycleGeneration != 7 {
		t.Fatalf("draining lifecycle was overwritten: %+v", set)
	}
	if set.BaseURL != "http://new-upstream" {
		t.Fatalf("non-lifecycle fields were not refreshed: %+v", set)
	}
}

func TestRevokeExternalKeyInvalidatesRouteCache(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, roundTripFunc(func(r *http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusOK,
			Body:       io.NopCloser(strings.NewReader(`{"ok":true}`)),
		}, nil
	}), Options{KeyRouteCache: NewMemoryAPIKeyRouteCache(time.Minute, 100)})
	if err := svc.RegisterSet(t.Context(), RegisterSetInput{ID: "set-a", BaseURL: "http://upstream", Status: SetStatusActive}); err != nil {
		t.Fatal(err)
	}
	externalKey, externalKeyID := saveTestAPIKey(t, store, "revoke", APIKeyBinding{
		SetID:       "set-a",
		UpstreamKey: "sk-upstream",
	})

	firstReq := httptest.NewRequest(http.MethodGet, "/v1/models", nil)
	firstReq.Header.Set("Authorization", "Bearer "+externalKey)
	firstRec := httptest.NewRecorder()
	svc.ProxyHTTP(firstRec, firstReq)
	if firstRec.Code != http.StatusOK {
		t.Fatalf("first status = %d body = %s", firstRec.Code, firstRec.Body.String())
	}
	if err := svc.RevokeExternalKey(t.Context(), externalKeyID); err != nil {
		t.Fatal(err)
	}

	secondReq := httptest.NewRequest(http.MethodGet, "/v1/models", nil)
	secondReq.Header.Set("Authorization", "Bearer "+externalKey)
	secondRec := httptest.NewRecorder()
	svc.ProxyHTTP(secondRec, secondReq)

	if secondRec.Code != http.StatusUnauthorized {
		t.Fatalf("status after revoke = %d body = %s", secondRec.Code, secondRec.Body.String())
	}
}

func TestProxyStripsHopByHopHeadersInBothDirections(t *testing.T) {
	store := NewMemoryStore()
	var forwarded http.Header
	svc := NewService(store, roundTripFunc(func(r *http.Request) (*http.Response, error) {
		forwarded = r.Header.Clone()
		return &http.Response{
			StatusCode: http.StatusOK,
			Header: http.Header{
				"Connection":     []string{"X-Upstream-Hop"},
				"X-Upstream-Hop": []string{"must-not-leak"},
				"Content-Type":   []string{"application/json"},
			},
			Body: io.NopCloser(strings.NewReader(`{"ok":true}`)),
		}, nil
	}), Options{})
	if err := svc.RegisterSet(t.Context(), RegisterSetInput{ID: "set-a", BaseURL: "http://upstream", Status: SetStatusActive}); err != nil {
		t.Fatal(err)
	}
	externalKey, _ := saveTestAPIKey(t, store, "hop-headers", APIKeyBinding{SetID: "set-a", UpstreamKey: "sk-upstream"})

	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	req.Header.Set("Authorization", "Bearer "+externalKey)
	req.Header.Set("Connection", "X-Request-Hop")
	req.Header.Set("X-Request-Hop", "must-not-forward")
	req.Header.Set("Proxy-Connection", "keep-alive")
	rec := httptest.NewRecorder()

	svc.ProxyHTTP(rec, req)

	if forwarded.Get("Connection") != "" || forwarded.Get("X-Request-Hop") != "" || forwarded.Get("Proxy-Connection") != "" {
		t.Fatalf("hop-by-hop headers were forwarded: %+v", forwarded)
	}
	if rec.Header().Get("Connection") != "" || rec.Header().Get("X-Upstream-Hop") != "" {
		t.Fatalf("hop-by-hop response headers leaked: %+v", rec.Header())
	}
}

func TestProxyFlushesStreamResponses(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, roundTripFunc(func(r *http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": []string{"text/event-stream"}},
			Body:       io.NopCloser(strings.NewReader("data: hello\n\n")),
		}, nil
	}), Options{})
	if err := svc.RegisterSet(t.Context(), RegisterSetInput{ID: "set-a", BaseURL: "http://upstream", Status: SetStatusActive}); err != nil {
		t.Fatal(err)
	}
	externalKey, _ := saveTestAPIKey(t, store, "stream", APIKeyBinding{SetID: "set-a", UpstreamKey: "sk-upstream"})

	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	req.Header.Set("Authorization", "Bearer "+externalKey)
	rec := httptest.NewRecorder()

	svc.ProxyHTTP(rec, req)

	if !rec.Flushed {
		t.Fatal("stream response was not flushed")
	}
}

func TestProxyAccessLogIncludesRequestRoutingAndUpstreamFields(t *testing.T) {
	var entries []AccessLog
	store := NewMemoryStore()
	svc := NewService(store, roundTripFunc(func(r *http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": []string{"text/event-stream"}},
			Body:       io.NopCloser(strings.NewReader("data: hello\n\n")),
		}, nil
	}), Options{AccessLogger: func(entry AccessLog) {
		entries = append(entries, entry)
	}})
	if err := svc.RegisterSet(t.Context(), RegisterSetInput{ID: "set-a", BaseURL: "http://upstream", Status: SetStatusActive}); err != nil {
		t.Fatal(err)
	}
	externalKey, externalKeyID := saveTestAPIKey(t, store, "access-log", APIKeyBinding{
		SetID:       "set-a",
		UpstreamKey: "sk-upstream",
	})

	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	req.Header.Set("Authorization", "Bearer "+externalKey)
	rec := httptest.NewRecorder()

	svc.ProxyHTTP(rec, req)

	if len(entries) != 1 {
		t.Fatalf("access log entries = %d, want 1", len(entries))
	}
	entry := entries[0]
	if entry.Event != "llmgateway_access" ||
		entry.ExternalKeyID != externalKeyID ||
		entry.ExternalKeyHashPrefix == "" ||
		entry.SetID != "set-a" ||
		entry.Method != http.MethodPost ||
		entry.Path != "/v1/chat/completions" ||
		entry.Status != http.StatusOK ||
		entry.UpstreamStatus != http.StatusOK ||
		!entry.Streaming ||
		entry.ErrorType != "" ||
		entry.DurationMS < 0 {
		t.Fatalf("unexpected access log entry: %+v", entry)
	}
}

func TestProxyMetricsExposeTrafficLabelsAndDuration(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, roundTripFunc(func(r *http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": []string{"text/event-stream"}},
			Body:       io.NopCloser(strings.NewReader("data: hello\n\n")),
		}, nil
	}), Options{AccessLogger: func(AccessLog) {}})
	if err := svc.RegisterSet(t.Context(), RegisterSetInput{ID: "set-a", BaseURL: "http://upstream", Status: SetStatusActive}); err != nil {
		t.Fatal(err)
	}
	externalKey, externalKeyID := saveTestAPIKey(t, store, "metrics", APIKeyBinding{
		SetID:       "set-a",
		UpstreamKey: "sk-upstream",
	})

	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	req.Header.Set("Authorization", "Bearer "+externalKey)
	rec := httptest.NewRecorder()

	svc.ProxyHTTP(rec, req)

	badReq := httptest.NewRequest(http.MethodGet, "/v1/models", nil)
	badReq.Header.Set("Authorization", "Bearer unknown-key")
	badRec := httptest.NewRecorder()
	svc.ProxyHTTP(badRec, badReq)

	metrics := svc.PrometheusMetrics()
	for _, want := range []string{
		`llmgateway_traffic_requests_total{external_key_id="` + externalKeyID + `",external_key_hash_prefix="`,
		`set_id="set-a"`,
		`status="200"`,
		`upstream_status="200"`,
		`streaming="true"`,
		`error_type=""`,
		`} 1`,
		`llmgateway_traffic_duration_ms_sum{`,
		`llmgateway_traffic_duration_ms_count{`,
		`status="401",upstream_status="0",streaming="false",error_type="invalid_bearer_token"} 1`,
	} {
		if !strings.Contains(metrics, want) {
			t.Fatalf("metrics missing %q:\n%s", want, metrics)
		}
	}
}

func TestProxyAccessLogRecordsGatewayErrorType(t *testing.T) {
	var entries []AccessLog
	store := NewMemoryStore()
	svc := NewService(store, roundTripFunc(func(r *http.Request) (*http.Response, error) {
		return nil, errors.New("dial failed")
	}), Options{AccessLogger: func(entry AccessLog) {
		entries = append(entries, entry)
	}})
	if err := svc.RegisterSet(t.Context(), RegisterSetInput{ID: "set-a", BaseURL: "http://upstream", Status: SetStatusActive}); err != nil {
		t.Fatal(err)
	}
	externalKey, externalKeyID := saveTestAPIKey(t, store, "gateway-error", APIKeyBinding{
		SetID:       "set-a",
		UpstreamKey: "sk-upstream",
	})

	req := httptest.NewRequest(http.MethodGet, "/v1/models", nil)
	req.Header.Set("Authorization", "Bearer "+externalKey)
	rec := httptest.NewRecorder()

	svc.ProxyHTTP(rec, req)

	if len(entries) != 1 {
		t.Fatalf("access log entries = %d, want 1", len(entries))
	}
	entry := entries[0]
	if entry.Status != http.StatusBadGateway ||
		entry.UpstreamStatus != 0 ||
		entry.ErrorType != "upstream_roundtrip_error" ||
		entry.ExternalKeyID != externalKeyID ||
		entry.SetID != "set-a" ||
		entry.Streaming {
		t.Fatalf("unexpected access log entry: %+v", entry)
	}
}

func TestProxyAccessLogUsesHashPrefixWhenKeyIsUnknown(t *testing.T) {
	var entries []AccessLog
	svc := NewService(NewMemoryStore(), nil, Options{AccessLogger: func(entry AccessLog) {
		entries = append(entries, entry)
	}})

	req := httptest.NewRequest(http.MethodGet, "/v1/models", nil)
	req.Header.Set("Authorization", "Bearer unknown-key")
	rec := httptest.NewRecorder()

	svc.ProxyHTTP(rec, req)

	if len(entries) != 1 {
		t.Fatalf("access log entries = %d, want 1", len(entries))
	}
	entry := entries[0]
	if entry.Status != http.StatusUnauthorized ||
		entry.ErrorType != "invalid_bearer_token" ||
		entry.ExternalKeyID != "" ||
		entry.ExternalKeyHashPrefix == "" {
		t.Fatalf("unexpected access log entry: %+v", entry)
	}
}

func TestEmitAccessLogWritesStructuredJSON(t *testing.T) {
	var buf bytes.Buffer
	oldWriter := defaultAccessLogger.Writer()
	defaultAccessLogger.SetOutput(&buf)
	defer defaultAccessLogger.SetOutput(oldWriter)

	svc := NewService(NewMemoryStore(), nil, Options{})
	svc.emitAccessLog(AccessLog{
		Time:           "2026-06-20T00:00:00Z",
		Event:          "llmgateway_access",
		Method:         http.MethodGet,
		Path:           "/v1/models",
		Status:         http.StatusUnauthorized,
		UpstreamStatus: 0,
		DurationMS:     3,
		Streaming:      false,
		ErrorType:      "invalid_bearer_token",
	})

	var decoded map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(buf.Bytes()), &decoded); err != nil {
		t.Fatalf("access log is not JSON: %v\n%s", err, buf.String())
	}
	if decoded["event"] != "llmgateway_access" ||
		decoded["upstream_status"] != float64(0) ||
		decoded["error_type"] != "invalid_bearer_token" {
		t.Fatalf("unexpected structured log: %#v", decoded)
	}
}

func TestServiceCloseIdleConnectionsClosesTransportPool(t *testing.T) {
	var closed atomic.Bool
	svc := NewService(NewMemoryStore(), closeIdleRoundTripper{
		RoundTripper: roundTripFunc(func(r *http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(""))}, nil
		}),
		close: func() {
			closed.Store(true)
		},
	}, Options{})

	svc.CloseIdleConnections()

	if !closed.Load() {
		t.Fatal("transport idle connections were not closed")
	}
}

func TestNewAPIClientUsesConfiguredTimeout(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(200 * time.Millisecond)
		writeTestJSON(t, w, map[string]any{"success": true, "data": map[string]any{"status": true}})
	}))
	defer upstream.Close()

	svc := NewService(NewMemoryStore(), upstream.Client().Transport, Options{NewAPIClientTimeout: 20 * time.Millisecond})
	_, err := svc.newAPIClient(upstream.URL).GetSetup(t.Context())
	if err == nil || !strings.Contains(err.Error(), "Client.Timeout") {
		t.Fatalf("error = %v, want configured client timeout", err)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) {
	return f(r)
}

func saveReadyServiceSet(t *testing.T, store *MemoryStore, setID string) {
	t.Helper()
	if err := store.SaveSet(t.Context(), Set{
		ID:               setID,
		Name:             setID,
		BaseURL:          "http://" + setID,
		Status:           SetStatusActive,
		Setup:            true,
		AdminUserID:      1,
		AdminAccessToken: "set-admin-token",
	}); err != nil {
		t.Fatal(err)
	}
}

type closeIdleRoundTripper struct {
	http.RoundTripper
	close func()
}

func (t closeIdleRoundTripper) CloseIdleConnections() {
	t.close()
}

type countingStore struct {
	Store
	apiKeyLookups atomic.Int64
}

func (s *countingStore) GetAPIKeyBindingByExternalKey(ctx context.Context, externalKey string) (APIKeyBinding, bool, error) {
	s.apiKeyLookups.Add(1)
	return s.Store.GetAPIKeyBindingByExternalKey(ctx, externalKey)
}

type failingTrafficStore struct {
	Store
}

func (s *failingTrafficStore) GetAPIKeyBindingByExternalKey(context.Context, string) (APIKeyBinding, bool, error) {
	return APIKeyBinding{}, false, errors.New("store must not be used on traffic hot path")
}

func (s *failingTrafficStore) GetTenant(context.Context, string) (Tenant, bool, error) {
	return Tenant{}, false, errors.New("store must not be used on traffic hot path")
}

func (s *failingTrafficStore) GetSet(context.Context, string) (Set, bool, error) {
	return Set{}, false, errors.New("store must not be used on traffic hot path")
}

func (s *failingTrafficStore) GetUserLLMSettings(context.Context, string) (UserLLMSettings, bool, error) {
	return UserLLMSettings{}, false, errors.New("store must not be used on traffic hot path")
}

func signedExternalKeyForTest(externalKeyID string, secret string) string {
	seed := []byte(externalKeyID + "\x00" + secret)
	first := sha512.Sum512(seed)
	second := sha256.Sum256(seed)
	randomBytes := append(append([]byte{}, first[:]...), second[:4]...)
	material, err := generateExternalKeyV2(bytes.NewReader(randomBytes))
	if err != nil {
		panic(err)
	}
	return material.ExternalKey
}

func saveTestAPIKey(t *testing.T, store Store, seed string, binding APIKeyBinding) (string, string) {
	t.Helper()
	externalKey := signedExternalKeyForTest(seed, "secret")
	binding.ExternalKey = externalKey
	if err := store.SaveAPIKeyBinding(t.Context(), binding); err != nil {
		t.Fatal(err)
	}
	return externalKey, parseTrafficRouteLookup(externalKey).ExternalKeyID
}
