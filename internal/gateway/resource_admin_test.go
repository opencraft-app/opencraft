package gateway

import "testing"

func TestTenantResourceRowsExcludeDeletedTenants(t *testing.T) {
	store := NewMemoryStore()
	for _, tenant := range []Tenant{
		{ExternalUserID: "active-user", Backend: UserBackendPending, Status: TenantStatusActive},
		{ExternalUserID: "deleted-user", Backend: UserBackendPending, Status: TenantStatusDeleted},
	} {
		if err := store.SaveTenant(t.Context(), tenant); err != nil {
			t.Fatal(err)
		}
	}

	svc := NewService(store, nil, Options{})
	result, err := svc.ListResourceRows(t.Context(), "tenants", ResourceListOptions{Limit: 50})
	if err != nil {
		t.Fatal(err)
	}
	if result.Total != 1 {
		t.Fatalf("tenant resource total = %d, want 1", result.Total)
	}
	if len(result.Rows) != 1 || result.Rows[0].ID != "active-user" {
		t.Fatalf("tenant resource rows = %+v, want only active-user", result.Rows)
	}
}
