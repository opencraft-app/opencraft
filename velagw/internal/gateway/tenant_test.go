package gateway

import (
	"encoding/base64"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestNormalizeTenantDefaultsToPending(t *testing.T) {
	tenant, err := normalizeTenant(Tenant{ExternalUserID: "user-pending"})
	if err != nil {
		t.Fatal(err)
	}
	if tenant.Backend != UserBackendPending || tenant.SetID != "" {
		t.Fatalf("tenant = %+v, want pending without set", tenant)
	}
}

func TestListTenantsMergesBindingsAssignmentsAndKeyCounts(t *testing.T) {
	store := NewMemoryStore()
	if err := store.SaveUserBinding(t.Context(), UserBinding{
		ExternalUserID: "tenant-new",
		SetID:          "set-a",
		UpstreamUserID: 101,
		Username:       "sgw-tenant-new",
		LastPlanID:     "plan-pro",
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveUserAssignment(t.Context(), UserAssignment{
		ExternalUserID: "tenant-new",
		Backend:        UserBackendNew,
		SetID:          "set-a",
	}); err != nil {
		t.Fatal(err)
	}
	for _, keyID := range []string{"key-a", "key-b"} {
		if err := store.SaveAPIKeyBinding(t.Context(), APIKeyBinding{
			ExternalKey:   "sk-" + keyID,
			ExternalKeyID: keyID,
			UserID:        "tenant-new",
			SetID:         "set-a",
			UpstreamKey:   "upstream-" + keyID,
		}); err != nil {
			t.Fatal(err)
		}
	}
	if err := store.SaveUserAssignment(t.Context(), UserAssignment{
		ExternalUserID: "tenant-old",
		Backend:        UserBackendPending,
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveUserBinding(t.Context(), UserBinding{
		ExternalUserID: "tenant-pending",
		SetID:          "set-b",
		Username:       "sgw-tenant-pending",
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveTenant(t.Context(), Tenant{
		ExternalUserID: "tenant-pending",
		Backend:        UserBackendNew,
		SetID:          "set-b",
		Status:         TenantStatusActive,
		Source:         "binding",
	}); err != nil {
		t.Fatal(err)
	}

	svc := NewService(store, nil, Options{})
	result, err := svc.ListTenants(t.Context(), TenantListOptions{Limit: 10, IncludeTotal: true})
	if err != nil {
		t.Fatal(err)
	}
	if tenantExactTotal(result) != 3 || len(result.Items) != 3 {
		t.Fatalf("unexpected tenant list size: %+v", result)
	}
	byID := map[string]TenantSummary{}
	for _, item := range result.Items {
		byID[item.UserID] = item
	}
	if byID["tenant-new"].Backend != UserBackendNew ||
		byID["tenant-new"].SetID != "set-a" ||
		byID["tenant-new"].Username != "sgw-tenant-new" ||
		byID["tenant-new"].LastPlanID != "plan-pro" ||
		byID["tenant-new"].KeyCount != 2 ||
		byID["tenant-new"].AssignmentStatus != "explicit" {
		t.Fatalf("unexpected new tenant summary: %+v", byID["tenant-new"])
	}
	if byID["tenant-old"].Backend != UserBackendPending || byID["tenant-old"].AssignmentStatus != "explicit" {
		t.Fatalf("unexpected old tenant summary: %+v", byID["tenant-old"])
	}
	if byID["tenant-pending"].Backend != UserBackendNew ||
		byID["tenant-pending"].SetID != "set-b" ||
		byID["tenant-pending"].AssignmentStatus != "bound_unassigned" {
		t.Fatalf("unexpected pending tenant summary: %+v", byID["tenant-pending"])
	}
}

func TestListTenantsUsesTenantMasterAsInventory(t *testing.T) {
	store := NewMemoryStore()
	if err := store.SaveUserBinding(t.Context(), UserBinding{
		ExternalUserID: "binding-only",
		SetID:          "set-a",
		Username:       "sgw-binding-only",
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveTenantObservation(t.Context(), TenantObservation{
		ExternalUserID:  "observation-only",
		Backend:         UserBackendPending,
		CreditStatus:    "unavailable",
		ObservedAt:      time.Date(2026, 7, 5, 12, 0, 0, 0, time.UTC),
		CreditAvailable: 1,
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveTenant(t.Context(), Tenant{
		ExternalUserID: "tenant-master",
		Backend:        UserBackendNew,
		SetID:          "set-a",
		Status:         TenantStatusActive,
		Source:         "unit-test",
		DisplayName:    "Tenant Master",
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveUserBinding(t.Context(), UserBinding{
		ExternalUserID: "tenant-master",
		SetID:          "set-a",
		Username:       "sgw-tenant-master",
		LastPlanID:     "plan-pro",
	}); err != nil {
		t.Fatal(err)
	}

	svc := NewService(store, nil, Options{})
	result, err := svc.ListTenants(t.Context(), TenantListOptions{Limit: 10, IncludeTotal: true})
	if err != nil {
		t.Fatal(err)
	}
	if tenantExactTotal(result) != 1 || len(result.Items) != 1 {
		t.Fatalf("tenant inventory should come from master table only: %+v", result)
	}
	item := result.Items[0]
	if item.UserID != "tenant-master" || item.Status != TenantStatusActive || item.Source != "unit-test" || item.DisplayName != "Tenant Master" {
		t.Fatalf("unexpected tenant master summary: %+v", item)
	}
}

func TestSetUserAssignmentMaintainsTenantMaster(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})

	assignment, err := svc.SetUserAssignment(t.Context(), UserAssignment{
		ExternalUserID: "user-1",
		Backend:        UserBackendNew,
		SetID:          "set-a",
	})
	if err != nil {
		t.Fatal(err)
	}
	tenant, ok, err := store.GetTenant(t.Context(), "user-1")
	if err != nil || !ok {
		t.Fatalf("tenant master not saved: ok=%v err=%v", ok, err)
	}
	if tenant.Backend != assignment.Backend || tenant.SetID != assignment.SetID || tenant.Status != TenantStatusActive {
		t.Fatalf("tenant master does not mirror assignment: tenant=%+v assignment=%+v", tenant, assignment)
	}
}

func TestTenantModelRejectsNewBackendWithoutSetID(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})

	if err := store.SaveTenant(t.Context(), Tenant{
		ExternalUserID: "user-1",
		Backend:        UserBackendNew,
	}); err == nil {
		t.Fatal("expected tenant save to reject backend=new without set_id")
	}

	if _, err := svc.SetUserAssignment(t.Context(), UserAssignment{
		ExternalUserID: "user-1",
		Backend:        UserBackendNew,
	}); err == nil {
		t.Fatal("expected assignment facade to reject backend=new without set_id")
	}
}

func TestDisabledTenantBlocksRouteWrites(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	if err := svc.RegisterSet(t.Context(), RegisterSetInput{ID: "set-a", BaseURL: "http://set-a", Status: SetStatusActive}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveTenant(t.Context(), Tenant{
		ExternalUserID: "user-1",
		Backend:        UserBackendPending,
		Status:         TenantStatusDisabled,
	}); err != nil {
		t.Fatal(err)
	}

	if _, err := svc.EnsureUserBinding(t.Context(), "user-1"); err == nil {
		t.Fatal("expected disabled tenant to reject binding allocation")
	}
	if _, err := svc.SetUserAssignment(t.Context(), UserAssignment{
		ExternalUserID: "user-1",
		Backend:        UserBackendNew,
		SetID:          "set-a",
	}); err == nil {
		t.Fatal("expected disabled tenant to reject assignment changes")
	}
}

func TestListTenantsRejectsSearchCombinedWithFilters(t *testing.T) {
	store := NewMemoryStore()
	for _, binding := range []UserBinding{
		{ExternalUserID: "alpha", SetID: "set-a", Username: "sgw-alpha", LastPlanID: "plan-pro"},
		{ExternalUserID: "beta", SetID: "set-b", Username: "sgw-beta", LastPlanID: "plan-basic"},
	} {
		if err := store.SaveTenant(t.Context(), Tenant{
			ExternalUserID: binding.ExternalUserID,
			Backend:        UserBackendNew,
			SetID:          binding.SetID,
			Status:         TenantStatusActive,
		}); err != nil {
			t.Fatal(err)
		}
		if err := store.SaveUserBinding(t.Context(), binding); err != nil {
			t.Fatal(err)
		}
	}
	svc := NewService(store, nil, Options{})

	_, err := svc.ListTenants(t.Context(), TenantListOptions{
		Keyword: "beta",
		Backend: UserBackendNew,
		SetID:   "set-b",
		Limit:   10,
	})
	if !errors.Is(err, ErrInvalidTenantListOptions) {
		t.Fatalf("error = %v, want ErrInvalidTenantListOptions", err)
	}
}

func TestListTenantsIncludesLatestObservationProjection(t *testing.T) {
	store := NewMemoryStore()
	if err := store.SaveUserBinding(t.Context(), UserBinding{
		ExternalUserID: "tenant-new",
		SetID:          "set-a",
		UpstreamUserID: 42,
		Username:       "sgw-tenant-new",
		LastPlanID:     "plan-old",
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveTenant(t.Context(), Tenant{
		ExternalUserID: "tenant-new",
		Backend:        UserBackendNew,
		SetID:          "set-a",
		Status:         TenantStatusActive,
	}); err != nil {
		t.Fatal(err)
	}
	observedAt := time.Date(2026, 7, 5, 10, 30, 0, 0, time.UTC)
	if err := store.SaveTenantObservation(t.Context(), TenantObservation{
		ExternalUserID:        "tenant-new",
		Backend:               UserBackendNew,
		SetID:                 "set-a",
		UpstreamUserID:        42,
		Username:              "sgw-tenant-new",
		CurrentPlanID:         "plan-pro",
		SubscriptionStatus:    "active",
		CreditAvailable:       8800,
		CreditStatus:          "ok",
		HasActiveSubscription: true,
		ObservedAt:            observedAt,
	}); err != nil {
		t.Fatal(err)
	}

	svc := NewService(store, nil, Options{})
	result, err := svc.ListTenants(t.Context(), TenantListOptions{Keyword: "tenant-new", IncludeTotal: true})
	if err != nil {
		t.Fatal(err)
	}
	if tenantExactTotal(result) != 1 || len(result.Items) != 1 {
		t.Fatalf("unexpected tenant list: %+v", result)
	}
	item := result.Items[0]
	if item.ObservedPlanID != "plan-pro" ||
		item.ObservedSubscriptionStatus != "active" ||
		item.ObservedCreditAvailable != 8800 ||
		item.ObservedCreditStatus != "ok" ||
		!item.ObservedAt.Equal(observedAt) {
		t.Fatalf("observation projection missing from tenant summary: %+v", item)
	}
}

func TestListTenantsCursorPaginatesByUpdatedAtAndUserID(t *testing.T) {
	store := NewMemoryStore()
	newTenantForCursorTest(store, "alpha", time.Date(2026, 7, 5, 12, 0, 0, 0, time.UTC))
	newTenantForCursorTest(store, "beta", time.Date(2026, 7, 5, 11, 0, 0, 0, time.UTC))
	newTenantForCursorTest(store, "gamma", time.Date(2026, 7, 5, 11, 0, 0, 0, time.UTC))
	newTenantForCursorTest(store, "omega", time.Date(2026, 7, 5, 10, 0, 0, 0, time.UTC))
	svc := NewService(store, nil, Options{})

	firstPage, err := svc.ListTenants(t.Context(), TenantListOptions{Limit: 2, IncludeTotal: true})
	if err != nil {
		t.Fatal(err)
	}
	if tenantExactTotal(firstPage) != 4 || !firstPage.HasMore || firstPage.NextCursor == "" {
		t.Fatalf("unexpected first page metadata: %+v", firstPage)
	}
	if got := tenantIDs(firstPage.Items); got != "alpha,gamma" {
		t.Fatalf("first page = %s", got)
	}

	secondPage, err := svc.ListTenants(t.Context(), TenantListOptions{Limit: 2, Cursor: firstPage.NextCursor, IncludeTotal: true})
	if err != nil {
		t.Fatal(err)
	}
	if tenantExactTotal(secondPage) != 4 || secondPage.HasMore || secondPage.NextCursor != "" {
		t.Fatalf("unexpected second page metadata: %+v", secondPage)
	}
	if got := tenantIDs(secondPage.Items); got != "beta,omega" {
		t.Fatalf("second page = %s", got)
	}
}

func TestListTenantsRejectsInvalidCursor(t *testing.T) {
	svc := NewService(NewMemoryStore(), nil, Options{})

	_, err := svc.ListTenants(t.Context(), TenantListOptions{Cursor: "not-a-cursor"})
	if !errors.Is(err, ErrInvalidTenantCursor) {
		t.Fatalf("error = %v, want ErrInvalidTenantCursor", err)
	}
}

func TestListTenantsSkipsExactTotalByDefault(t *testing.T) {
	store := NewMemoryStore()
	newTenantForCursorTest(store, "tenant-a", time.Date(2026, 7, 14, 10, 0, 0, 0, time.UTC))
	svc := NewService(store, nil, Options{})

	result, err := svc.ListTenants(t.Context(), TenantListOptions{Limit: 50})
	if err != nil {
		t.Fatal(err)
	}
	if result.Total != nil {
		t.Fatalf("default tenant list must not calculate exact total: %+v", result.Total)
	}
}

func TestListTenantsSearchesUserIDThenUsernameByPrefix(t *testing.T) {
	store := NewMemoryStore()
	for _, item := range []struct {
		userID   string
		username string
	}{
		{userID: "acme-01", username: "acme-duplicate"},
		{userID: "acme-02", username: "sgw-02"},
		{userID: "user-03", username: "acme-03"},
		{userID: "user-04", username: "acme-04"},
	} {
		newTenantForCursorTest(store, item.userID, time.Date(2026, 7, 14, 10, 0, 0, 0, time.UTC))
		binding := store.users[item.userID]
		binding.Username = item.username
		store.users[item.userID] = binding
	}
	svc := NewService(store, nil, Options{})

	first, err := svc.ListTenants(t.Context(), TenantListOptions{Keyword: "acme", Limit: 2})
	if err != nil {
		t.Fatal(err)
	}
	if got := tenantIDs(first.Items); got != "acme-01,acme-02" || !first.HasMore || first.NextCursor == "" {
		t.Fatalf("unexpected user id search phase: ids=%s result=%+v", got, first)
	}
	second, err := svc.ListTenants(t.Context(), TenantListOptions{Keyword: "acme", Limit: 2, Cursor: first.NextCursor})
	if err != nil {
		t.Fatal(err)
	}
	if got := tenantIDs(second.Items); got != "user-03,user-04" || second.HasMore {
		t.Fatalf("unexpected username search phase: ids=%s result=%+v", got, second)
	}
}

func TestListTenantsShortSearchIsExactOnly(t *testing.T) {
	store := NewMemoryStore()
	newTenantForCursorTest(store, "xy", time.Date(2026, 7, 14, 10, 0, 0, 0, time.UTC))
	newTenantForCursorTest(store, "xy-long", time.Date(2026, 7, 14, 9, 0, 0, 0, time.UTC))
	svc := NewService(store, nil, Options{})

	result, err := svc.ListTenants(t.Context(), TenantListOptions{Keyword: "xy", Limit: 50})
	if err != nil {
		t.Fatal(err)
	}
	if got := tenantIDs(result.Items); got != "xy" {
		t.Fatalf("short search must be exact: %s", got)
	}
}

func TestListTenantsCursorIsBoundToFilters(t *testing.T) {
	store := NewMemoryStore()
	newTenantForCursorTest(store, "tenant-a", time.Date(2026, 7, 14, 10, 0, 0, 0, time.UTC))
	newTenantForCursorTest(store, "tenant-b", time.Date(2026, 7, 14, 9, 0, 0, 0, time.UTC))
	svc := NewService(store, nil, Options{})

	first, err := svc.ListTenants(t.Context(), TenantListOptions{Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	_, err = svc.ListTenants(t.Context(), TenantListOptions{Limit: 1, Backend: UserBackendNew, Cursor: first.NextCursor})
	if !errors.Is(err, ErrInvalidTenantCursor) {
		t.Fatalf("error = %v, want cursor/filter mismatch", err)
	}
}

func TestListTenantsRejectsLegacyCursor(t *testing.T) {
	legacy := base64.RawURLEncoding.EncodeToString([]byte(`{"updated_at":"2026-07-14T10:00:00Z","user_id":"tenant-a"}`))
	svc := NewService(NewMemoryStore(), nil, Options{})

	_, err := svc.ListTenants(t.Context(), TenantListOptions{Cursor: legacy})
	if !errors.Is(err, ErrInvalidTenantCursor) {
		t.Fatalf("error = %v, want ErrInvalidTenantCursor", err)
	}
}

func newTenantForCursorTest(store *MemoryStore, userID string, updatedAt time.Time) {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.tenants[userID] = Tenant{
		ExternalUserID: userID,
		Backend:        UserBackendNew,
		SetID:          "set-a",
		Status:         TenantStatusActive,
		CreatedAt:      updatedAt,
		UpdatedAt:      updatedAt,
	}
	store.users[userID] = UserBinding{
		ExternalUserID: userID,
		SetID:          "set-a",
		Username:       "sgw-" + userID,
		CreatedAt:      updatedAt,
		UpdatedAt:      updatedAt,
	}
}

func tenantIDs(items []TenantSummary) string {
	ids := make([]string, 0, len(items))
	for _, item := range items {
		ids = append(ids, item.UserID)
	}
	return strings.Join(ids, ",")
}

func tenantExactTotal(result TenantListResult) int {
	if result.Total == nil {
		return -1
	}
	return *result.Total
}
