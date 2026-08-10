package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"ctl/pkg/errcode"
	modelinstance "ctl/pkg/model/instance"
	"ctl/pkg/websiteauth"
)

type fakeWebsiteCredentialStore struct {
	issueToken       string
	issueErr         error
	issueCalls       int
	validate         *websiteauth.Binding
	validateErr      error
	revokeErr        error
	revokeInstanceID string
	revokeKeyID      string
}

func (s *fakeWebsiteCredentialStore) Issue(_ context.Context, userID, instanceID string) (string, websiteauth.Binding, error) {
	s.issueCalls++
	if s.issueErr != nil {
		return "", websiteauth.Binding{}, s.issueErr
	}
	return s.issueToken, websiteauth.Binding{
		KeyID:      "key-1",
		UserID:     userID,
		InstanceID: instanceID,
		CreatedAt:  time.Unix(1_800_000_000, 0).UTC(),
	}, nil
}

func (s *fakeWebsiteCredentialStore) Validate(context.Context, string) (*websiteauth.Binding, error) {
	return s.validate, s.validateErr
}

func (s *fakeWebsiteCredentialStore) Revoke(_ context.Context, instanceID, keyID string) error {
	s.revokeInstanceID = instanceID
	s.revokeKeyID = keyID
	return s.revokeErr
}

func (s *fakeWebsiteCredentialStore) RevokeInstance(context.Context, string) error {
	return nil
}

type fakeWebsiteInstanceReader struct {
	instances map[string]websiteInstanceBinding
	err       error
}

func (r *fakeWebsiteInstanceReader) GetWebsiteInstanceBinding(_ context.Context, instanceID string) (*websiteInstanceBinding, error) {
	if r.err != nil {
		return nil, r.err
	}
	binding, ok := r.instances[instanceID]
	if !ok {
		return nil, errcode.ErrInstanceNotFound
	}
	if binding.Status == "" {
		binding.Status = "Running"
	}
	return &binding, nil
}

func TestWebsiteCredentialIssueFailsClosedWithoutInternalToken(t *testing.T) {
	t.Setenv("CTL_INTERNAL_TOKEN", "")
	h := &websiteCredentialHandler{
		store: &fakeWebsiteCredentialStore{issueToken: "one-time-token"},
		instances: &fakeWebsiteInstanceReader{instances: map[string]websiteInstanceBinding{
			"ins-1": {InstanceID: "ins-1", UserID: "user-from-db"},
		}},
	}
	req := httptest.NewRequest(http.MethodPost, "/internal/ctl/instances/ins-1/website-credential", nil)
	req.Header.Set("Authorization", "Bearer anything")
	rec := httptest.NewRecorder()

	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401; body=%s", rec.Code, rec.Body.String())
	}
}

func TestWebsiteCredentialIssueRejectsInvalidInternalToken(t *testing.T) {
	t.Setenv("CTL_INTERNAL_TOKEN", "expected")
	h := &websiteCredentialHandler{
		store:     &fakeWebsiteCredentialStore{issueToken: "one-time-token"},
		instances: &fakeWebsiteInstanceReader{},
	}
	req := httptest.NewRequest(http.MethodPost, "/internal/ctl/instances/ins-1/website-credential", nil)
	req.Header.Set("Authorization", "Bearer wrong")
	rec := httptest.NewRecorder()

	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401; body=%s", rec.Code, rec.Body.String())
	}
}

func TestWebsiteCredentialIssueDerivesUserFromInstance(t *testing.T) {
	t.Setenv("CTL_INTERNAL_TOKEN", "expected")
	h := &websiteCredentialHandler{
		store: &fakeWebsiteCredentialStore{issueToken: "one-time-token"},
		instances: &fakeWebsiteInstanceReader{instances: map[string]websiteInstanceBinding{
			"ins-1": {InstanceID: "ins-1", UserID: "user-from-db"},
		}},
	}
	req := httptest.NewRequest(http.MethodPost, "/internal/ctl/instances/ins-1/website-credential?user_id=spoofed", nil)
	req.Header.Set("Authorization", "Bearer expected")
	req.Header.Set(headerUserID, "spoofed")
	rec := httptest.NewRecorder()

	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201; body=%s", rec.Code, rec.Body.String())
	}
	var payload struct {
		Data struct {
			Token      string `json:"token"`
			UserID     string `json:"user_id"`
			InstanceID string `json:"instance_id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if payload.Data.Token != "one-time-token" || payload.Data.UserID != "user-from-db" || payload.Data.InstanceID != "ins-1" {
		t.Fatalf("response data = %+v", payload.Data)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store", got)
	}
}

func TestWebsiteCredentialIssueRejectsInvalidInstanceState(t *testing.T) {
	t.Setenv("CTL_INTERNAL_TOKEN", "expected")
	store := &fakeWebsiteCredentialStore{issueToken: "one-time-token"}
	h := &websiteCredentialHandler{
		store: store,
		instances: &fakeWebsiteInstanceReader{instances: map[string]websiteInstanceBinding{
			"ins-1": {InstanceID: "ins-1", UserID: "user-1", Status: "Deleting"},
		}},
	}
	req := httptest.NewRequest(http.MethodPost, "/internal/ctl/instances/ins-1/website-credential", nil)
	req.Header.Set("Authorization", "Bearer expected")
	rec := httptest.NewRecorder()

	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409; body=%s", rec.Code, rec.Body.String())
	}
	if store.issueCalls != 0 {
		t.Fatalf("Issue calls = %d, want 0", store.issueCalls)
	}
}

func TestWebsiteCredentialIssueReturnsServiceUnavailableOnStoreFailure(t *testing.T) {
	t.Setenv("CTL_INTERNAL_TOKEN", "expected")
	h := &websiteCredentialHandler{
		store: &fakeWebsiteCredentialStore{issueErr: errors.New("Redis unavailable")},
		instances: &fakeWebsiteInstanceReader{instances: map[string]websiteInstanceBinding{
			"ins-1": {InstanceID: "ins-1", UserID: "user-1", Status: "Running"},
		}},
	}
	req := httptest.NewRequest(http.MethodPost, "/internal/ctl/instances/ins-1/website-credential", nil)
	req.Header.Set("Authorization", "Bearer expected")
	rec := httptest.NewRecorder()

	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503; body=%s", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store", got)
	}
}

func TestWebsiteCredentialRevokeChecksInstanceOwnership(t *testing.T) {
	t.Setenv("CTL_INTERNAL_TOKEN", "expected")
	store := &fakeWebsiteCredentialStore{revokeErr: websiteauth.ErrInvalidCredential}
	h := &websiteCredentialHandler{
		store: store,
		instances: &fakeWebsiteInstanceReader{instances: map[string]websiteInstanceBinding{
			"ins-1": {InstanceID: "ins-1", UserID: "user-1", Status: "Running"},
		}},
	}
	req := httptest.NewRequest(http.MethodDelete, "/internal/ctl/instances/ins-1/website-credentials/key-other", nil)
	req.Header.Set("Authorization", "Bearer expected")
	rec := httptest.NewRecorder()

	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404; body=%s", rec.Code, rec.Body.String())
	}
	if store.revokeInstanceID != "ins-1" || store.revokeKeyID != "key-other" {
		t.Fatalf("revoke args = (%q, %q)", store.revokeInstanceID, store.revokeKeyID)
	}
}

func TestWebsiteCredentialRevokeReturnsServiceUnavailableOnStoreFailure(t *testing.T) {
	t.Setenv("CTL_INTERNAL_TOKEN", "expected")
	h := &websiteCredentialHandler{
		store: &fakeWebsiteCredentialStore{revokeErr: errors.New("Redis unavailable")},
		instances: &fakeWebsiteInstanceReader{instances: map[string]websiteInstanceBinding{
			"ins-1": {InstanceID: "ins-1", UserID: "user-1", Status: modelinstance.InstanceStatusRunning},
		}},
	}
	req := httptest.NewRequest(http.MethodDelete, "/internal/ctl/instances/ins-1/website-credentials/key-1", nil)
	req.Header.Set("Authorization", "Bearer expected")
	rec := httptest.NewRecorder()

	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503; body=%s", rec.Code, rec.Body.String())
	}
}

func TestWebsiteCredentialAllowedInstanceStatuses(t *testing.T) {
	t.Parallel()
	tests := []struct {
		status  string
		allowed bool
	}{
		{status: modelinstance.InstanceStatusCreating, allowed: false},
		{status: modelinstance.InstanceStatusRunning, allowed: true},
		{status: modelinstance.InstanceStatusPaused, allowed: true},
		{status: modelinstance.InstanceStatusResuming, allowed: true},
		{status: modelinstance.InstanceStatusFailed, allowed: false},
		{status: modelinstance.InstanceStatusDeleting, allowed: false},
		{status: modelinstance.InstanceStatusDeleted, allowed: false},
		{status: "", allowed: false},
		{status: "Unknown", allowed: false},
	}
	for _, test := range tests {
		test := test
		t.Run(test.status, func(t *testing.T) {
			t.Parallel()
			if got := isWebsiteCredentialInstanceStatusAllowed(test.status); got != test.allowed {
				t.Fatalf("allowed = %v, want %v", got, test.allowed)
			}
		})
	}
}

func TestWebsiteCredentialIssueReturnsNotFoundForUnknownInstance(t *testing.T) {
	t.Setenv("CTL_INTERNAL_TOKEN", "expected")
	h := &websiteCredentialHandler{
		store:     &fakeWebsiteCredentialStore{issueToken: "one-time-token"},
		instances: &fakeWebsiteInstanceReader{instances: map[string]websiteInstanceBinding{}},
	}
	req := httptest.NewRequest(http.MethodPost, "/internal/ctl/instances/missing/website-credential", nil)
	req.Header.Set("Authorization", "Bearer expected")
	rec := httptest.NewRecorder()

	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404; body=%s", rec.Code, rec.Body.String())
	}
}

func TestWebsiteCredentialRouteIsRegistered(t *testing.T) {
	t.Setenv("CTL_INTERNAL_TOKEN", "expected")
	store := &fakeWebsiteCredentialStore{issueToken: "one-time-token"}
	instances := &fakeWebsiteInstanceReader{instances: map[string]websiteInstanceBinding{
		"ins-1": {InstanceID: "ins-1", UserID: "user-1"},
	}}
	router := newRouterWithWebsiteAuth(
		&instanceHandler{logic: &stubLogic{}},
		&bundleHandler{},
		&passHandler{},
		store,
		instances,
	)
	req := httptest.NewRequest(http.MethodPost, "/internal/ctl/instances/ins-1/website-credential", nil)
	req.Header.Set("Authorization", "Bearer expected")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201; body=%s", rec.Code, rec.Body.String())
	}
}

func TestWebsiteInstanceAuthInjectsValidatedIdentity(t *testing.T) {
	store := &fakeWebsiteCredentialStore{validate: &websiteauth.Binding{
		KeyID: "key-1", UserID: "user-1", InstanceID: "ins-1",
	}}
	instances := &fakeWebsiteInstanceReader{instances: map[string]websiteInstanceBinding{
		"ins-1": {InstanceID: "ins-1", UserID: "user-1"},
	}}
	var gotUserID, gotAltUserID, gotAuthorization string
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotUserID = r.Header.Get(headerUserID)
		gotAltUserID = r.Header.Get(headerUserIDAlt)
		gotAuthorization = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusNoContent)
	})
	h := websiteInstanceAuthMiddleware(store, instances, next)
	req := httptest.NewRequest(http.MethodGet, "/v1/websites", nil)
	req.Header.Set("Authorization", "Vela-Instance-Key opaque-token")
	req.Header.Set(headerUserID, "spoofed")
	req.Header.Set(headerUserIDAlt, "spoofed-alt")
	rec := httptest.NewRecorder()

	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204; body=%s", rec.Code, rec.Body.String())
	}
	if gotUserID != "user-1" || gotAltUserID != "" {
		t.Fatalf("identity headers = (%q, %q), want (user-1, empty)", gotUserID, gotAltUserID)
	}
	if gotAuthorization != "" {
		t.Fatalf("validated credential leaked downstream: %q", gotAuthorization)
	}
}

func TestWebsiteInstanceAuthRejectsInvalidKeyWithoutHeaderFallback(t *testing.T) {
	store := &fakeWebsiteCredentialStore{validateErr: websiteauth.ErrInvalidCredential}
	instances := &fakeWebsiteInstanceReader{}
	called := false
	next := http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called = true })
	h := websiteInstanceAuthMiddleware(store, instances, next)
	req := httptest.NewRequest(http.MethodGet, "/v1/websites", nil)
	req.Header.Set("Authorization", "Vela-Instance-Key invalid")
	req.Header.Set(headerUserID, "spoofed")
	rec := httptest.NewRecorder()

	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized || called {
		t.Fatalf("status = %d called = %v, want 401 and not called", rec.Code, called)
	}
}

func TestWebsiteInstanceAuthRejectsStoreFailure(t *testing.T) {
	store := &fakeWebsiteCredentialStore{validateErr: errors.New("Redis unavailable")}
	h := websiteInstanceAuthMiddleware(store, &fakeWebsiteInstanceReader{}, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Fatal("downstream must not be called")
	}))
	req := httptest.NewRequest(http.MethodGet, "/v1/websites", nil)
	req.Header.Set("Authorization", "Vela-Instance-Key opaque-token")
	rec := httptest.NewRecorder()

	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503; body=%s", rec.Code, rec.Body.String())
	}
}

func TestWebsiteInstanceAuthRejectsInvalidInstanceState(t *testing.T) {
	store := &fakeWebsiteCredentialStore{validate: &websiteauth.Binding{
		KeyID: "key-1", UserID: "user-1", InstanceID: "ins-1",
	}}
	instances := &fakeWebsiteInstanceReader{instances: map[string]websiteInstanceBinding{
		"ins-1": {InstanceID: "ins-1", UserID: "user-1", Status: "Deleting"},
	}}
	h := websiteInstanceAuthMiddleware(store, instances, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Fatal("downstream must not be called")
	}))
	req := httptest.NewRequest(http.MethodGet, "/v1/websites", nil)
	req.Header.Set("Authorization", "Vela-Instance-Key opaque-token")
	rec := httptest.NewRecorder()

	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401; body=%s", rec.Code, rec.Body.String())
	}
}

func TestWebsiteInstanceAuthRejectsOwnershipMismatch(t *testing.T) {
	store := &fakeWebsiteCredentialStore{validate: &websiteauth.Binding{
		KeyID: "key-1", UserID: "old-user", InstanceID: "ins-1",
	}}
	instances := &fakeWebsiteInstanceReader{instances: map[string]websiteInstanceBinding{
		"ins-1": {InstanceID: "ins-1", UserID: "new-user"},
	}}
	h := websiteInstanceAuthMiddleware(store, instances, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Fatal("downstream must not be called")
	}))
	req := httptest.NewRequest(http.MethodGet, "/v1/websites", nil)
	req.Header.Set("Authorization", "Vela-Instance-Key opaque-token")
	rec := httptest.NewRecorder()

	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401; body=%s", rec.Code, rec.Body.String())
	}
}

func TestWebsiteInstanceAuthRejectsMalformedScheme(t *testing.T) {
	store := &fakeWebsiteCredentialStore{}
	h := websiteInstanceAuthMiddleware(store, &fakeWebsiteInstanceReader{}, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Fatal("downstream must not be called")
	}))
	req := httptest.NewRequest(http.MethodGet, "/v1/websites", nil)
	req.Header.Set("Authorization", "Vela-Instance-Key")
	req.Header.Set(headerUserID, "spoofed")
	rec := httptest.NewRecorder()

	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401; body=%s", rec.Code, rec.Body.String())
	}
}
