package httpapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"shadow/internal/billing"
	"shadow/internal/httpapi"
	"shadow/internal/platform"
	"shadow/internal/shadow"
	"shadow/internal/storage"
	storagesqlite "shadow/internal/storage/sqlite"
)

func TestAdminAccountsRequiresConfiguredToken(t *testing.T) {
	handler, _ := newAdminTestServer(t, "")

	res := httptest.NewRecorder()
	handler.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/internal/shadow/admin/accounts", nil))
	if res.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503 without configured token, got %d body=%s", res.Code, res.Body.String())
	}
}

func TestAdminAccountsListsBindingsWithInternalToken(t *testing.T) {
	handler, store := newAdminTestServer(t, "admin-secret")
	ctx := context.Background()
	user, _, err := store.EnsureUser(ctx, "usr_admin_shadow", "+86", "13800000088")
	if err != nil {
		t.Fatalf("ensure user: %v", err)
	}
	if err := store.SaveBinding(ctx, storage.Binding{
		UserID:         user.ID,
		ShadowUserName: "shadow_admin",
		Uin:            330500000005,
		OwnerUin:       260203940,
		AppID:          1300000001,
		InstanceID:     "lhins-admin",
		CountryCode:    user.CountryCode,
		PhoneNumber:    user.PhoneNumber,
		CreatedAt:      time.Now().UTC(),
	}); err != nil {
		t.Fatalf("save binding: %v", err)
	}

	unauthorized := httptest.NewRecorder()
	handler.ServeHTTP(unauthorized, httptest.NewRequest(http.MethodGet, "/internal/shadow/admin/accounts", nil))
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 without request token, got %d", unauthorized.Code)
	}

	req := httptest.NewRequest(http.MethodGet, "/internal/shadow/admin/accounts?search=lhins-admin&page=1&page_size=10", nil)
	req.Header.Set("Authorization", "Bearer admin-secret")
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", res.Code, res.Body.String())
	}
	var payload struct {
		Items []storage.AdminAccount `json:"items"`
		Total int64                  `json:"total"`
		Page  int                    `json:"page"`
	}
	if err := json.NewDecoder(res.Body).Decode(&payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if payload.Total != 1 || len(payload.Items) != 1 || payload.Items[0].UserID != user.ID || payload.Page != 1 {
		t.Fatalf("unexpected response: %#v", payload)
	}

	badPage := httptest.NewRequest(http.MethodGet, "/internal/shadow/admin/accounts?page_size=101", nil)
	badPage.Header.Set("Authorization", "Bearer admin-secret")
	badPageRes := httptest.NewRecorder()
	handler.ServeHTTP(badPageRes, badPage)
	if badPageRes.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid page size, got %d", badPageRes.Code)
	}
}

func newAdminTestServer(t *testing.T, internalToken string) (http.Handler, *storagesqlite.Store) {
	t.Helper()
	store, err := storagesqlite.NewStore(filepath.Join(t.TempDir(), "shadow.db"))
	if err != nil {
		t.Fatalf("new sqlite store: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	svc := shadow.NewService(store, platform.NewFakeCloudProvider(), billing.NewFakeProvider(), 10*time.Minute, "shadow_test")
	handler := httpapi.NewWithOptions(svc, httpapi.Options{
		InternalToken: internalToken,
		Store:         store,
	}).Handler()
	return handler, store
}
