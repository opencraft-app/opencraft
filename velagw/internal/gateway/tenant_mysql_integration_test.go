//go:build integration

package gateway

import (
	"context"
	"testing"
	"time"
)

func TestMySQLTenantListAndStatisticsUseProductionQueries(t *testing.T) {
	store := newIsolatedMySQLStore(t)
	defer func() { _ = store.Close() }()
	ctx := context.Background()
	base := time.Date(2026, 7, 14, 12, 0, 0, 0, time.UTC)

	tenants := []Tenant{
		{ExternalUserID: "tenant-001", Backend: UserBackendNew, SetID: "set-a", Status: TenantStatusActive, UpdatedAt: base.Add(4 * time.Minute)},
		{ExternalUserID: "tenant-002", Backend: UserBackendNew, SetID: "set-a", Status: TenantStatusDisabled, UpdatedAt: base.Add(3 * time.Minute)},
		{ExternalUserID: "user-by-name", Backend: UserBackendPending, Status: TenantStatusActive, UpdatedAt: base.Add(2 * time.Minute)},
		{ExternalUserID: "other-user", Backend: UserBackendNew, SetID: "set-b", Status: TenantStatusActive, UpdatedAt: base.Add(time.Minute)},
		{ExternalUserID: "deleted-user", Backend: UserBackendNew, SetID: "set-a", Status: TenantStatusDeleted, UpdatedAt: base},
	}
	for _, tenant := range tenants {
		if err := store.SaveTenant(ctx, tenant); err != nil {
			t.Fatal(err)
		}
		if _, err := store.db.ExecContext(ctx, `UPDATE llmgateway_tenants SET updated_at = ? WHERE external_user_id = ?`, tenant.UpdatedAt, tenant.ExternalUserID); err != nil {
			t.Fatal(err)
		}
	}
	for _, binding := range []UserBinding{
		{ExternalUserID: "tenant-001", SetID: "set-a", Username: "sgw-tenant-001"},
		{ExternalUserID: "tenant-002", SetID: "set-a", Username: "sgw-tenant-002"},
		{ExternalUserID: "user-by-name", SetID: "set-old", Username: "tenant-by-username"},
	} {
		if err := store.SaveUserBinding(ctx, binding); err != nil {
			t.Fatal(err)
		}
	}
	for index := 0; index < 2; index++ {
		if err := store.SaveAPIKeyBinding(ctx, APIKeyBinding{
			ExternalKey:   "sk-tenant-001-" + string(rune('a'+index)),
			ExternalKeyID: "key-tenant-001-" + string(rune('a'+index)),
			SetID:         "set-a",
			UserID:        "tenant-001",
		}); err != nil {
			t.Fatal(err)
		}
	}

	page, err := store.ListTenants(ctx, TenantListOptions{Limit: 2})
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != nil || len(page.Items) != 2 || !page.HasMore || page.NextCursor == "" {
		t.Fatalf("first page = %+v", page)
	}
	if page.Items[0].UserID != "tenant-001" || page.Items[0].KeyCount != 2 {
		t.Fatalf("first tenant = %+v", page.Items[0])
	}
	second, err := store.ListTenants(ctx, TenantListOptions{Limit: 2, Cursor: page.NextCursor})
	if err != nil {
		t.Fatal(err)
	}
	if len(second.Items) != 2 || second.Items[0].UserID != "user-by-name" {
		t.Fatalf("second page = %+v", second)
	}

	search, err := store.ListTenants(ctx, TenantListOptions{Keyword: "tenant", Limit: 10, IncludeTotal: true})
	if err != nil {
		t.Fatal(err)
	}
	if search.Total == nil || *search.Total != 3 || len(search.Items) != 3 {
		t.Fatalf("prefix search = %+v", search)
	}
	if search.Items[2].UserID != "user-by-name" {
		t.Fatalf("username phase was not appended: %+v", search.Items)
	}

	job := WorkerJob{
		Name:            WorkerJobRefreshTenantStatistics,
		Kind:            WorkerJobRefreshTenantStatistics,
		Enabled:         true,
		IntervalSeconds: 600,
		Status:          WorkerJobStatusIdle,
		NextRunAt:       base,
	}
	if err := store.SaveWorkerJob(ctx, job); err != nil {
		t.Fatal(err)
	}
	if _, acquired, err := store.TryAcquireWorkerJobLease(ctx, job.Name, "worker-it", time.Minute, time.Now().UTC()); err != nil || !acquired {
		t.Fatalf("acquire statistics lease=%v err=%v", acquired, err)
	}
	refreshed, err := store.RefreshTenantStatistics(ctx, job.Name, "worker-it", base.Add(10*time.Minute))
	if err != nil || !refreshed {
		t.Fatalf("refresh statistics=%v err=%v", refreshed, err)
	}
	stats, ok, err := store.GetTenantStatistics(ctx)
	if err != nil || !ok {
		t.Fatalf("get statistics ok=%v err=%v", ok, err)
	}
	if stats.Total != 4 || stats.NewTotal != 3 || stats.PendingTotal != 1 || stats.ActiveTotal != 3 || stats.DisabledTotal != 1 || stats.DeletedTotal != 1 {
		t.Fatalf("statistics = %+v", stats)
	}
}

func TestMySQLTenantListIndexesAreInstalled(t *testing.T) {
	store := newIsolatedMySQLStore(t)
	defer func() { _ = store.Close() }()

	want := map[string]bool{
		"idx_llmgateway_tenants_backend_page":        false,
		"idx_llmgateway_tenants_set_page":            false,
		"idx_llmgateway_tenants_backend_status":      false,
		"idx_llmgateway_user_bindings_username_user": false,
	}
	rows, err := store.db.QueryContext(t.Context(), `
		SELECT DISTINCT index_name
		FROM information_schema.statistics
		WHERE table_schema = DATABASE()
		  AND index_name IN (?, ?, ?, ?)
	`, "idx_llmgateway_tenants_backend_page", "idx_llmgateway_tenants_set_page", "idx_llmgateway_tenants_backend_status", "idx_llmgateway_user_bindings_username_user")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatal(err)
		}
		want[name] = true
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	for name, installed := range want {
		if !installed {
			t.Fatalf("index %s was not installed", name)
		}
	}
}

func TestMySQLTenantDeletionProgressUsesAtomicCounters(t *testing.T) {
	store := newIsolatedMySQLStore(t)
	defer func() { _ = store.Close() }()
	ctx := t.Context()
	base := time.Date(2026, 7, 22, 7, 0, 0, 0, time.UTC)

	if err := store.SaveSet(ctx, Set{ID: "set-delete", Name: "set-delete", Status: SetStatusActive, MaxUsers: 10}); err != nil {
		t.Fatal(err)
	}
	for _, userID := range []string{"delete-001", "delete-002"} {
		if err := store.SaveTenant(ctx, Tenant{ExternalUserID: userID, Backend: UserBackendNew, SetID: "set-delete", Status: TenantStatusActive}); err != nil {
			t.Fatal(err)
		}
		if err := store.SaveUserBinding(ctx, UserBinding{ExternalUserID: userID, SetID: "set-delete", Username: "sgw-" + userID}); err != nil {
			t.Fatal(err)
		}
	}
	job := TenantDeletionJob{
		ID: "tenant-delete-atomic", Status: TenantDeletionStatusClaiming,
		SelectorType: tenantDeletionSelectorUserIDs, SnapshotAt: base,
		TargetCount: 2, Version: 1, CreatedAt: base, UpdatedAt: base,
	}
	targets := []TenantDeletionTarget{
		{JobID: job.ID, ExternalUserID: "delete-001", SetID: "set-delete", Status: TenantDeletionTargetStatusPending},
		{JobID: job.ID, ExternalUserID: "delete-002", SetID: "set-delete", Status: TenantDeletionTargetStatusPending},
	}
	if err := store.CreateTenantDeletionJob(ctx, job, targets); err != nil {
		t.Fatal(err)
	}
	job, err := store.ClaimTenantDeletionJob(ctx, job.ID, 10, base)
	if err != nil || job.Status != TenantDeletionStatusQueued || job.ClaimedCount != 2 {
		t.Fatalf("claim job=%+v err=%v", job, err)
	}

	first, acquired, err := store.AcquireTenantDeletionTarget(ctx, "worker-a", time.Minute, base)
	if err != nil || !acquired {
		t.Fatalf("acquire first=%+v acquired=%v err=%v", first, acquired, err)
	}
	job, err = store.PurgeTenantDeletionTarget(ctx, first, base.Add(time.Second))
	if err != nil || job.Status != TenantDeletionStatusRunning || job.SuccessCount != 1 || job.FailureCount != 0 {
		t.Fatalf("purge first job=%+v err=%v", job, err)
	}

	second, acquired, err := store.AcquireTenantDeletionTarget(ctx, "worker-b", time.Minute, base.Add(2*time.Second))
	if err != nil || !acquired {
		t.Fatalf("acquire second=%+v acquired=%v err=%v", second, acquired, err)
	}
	if err := store.FailTenantDeletionTarget(ctx, second, "temporary", base.Add(3*time.Second)); err != nil {
		t.Fatal(err)
	}
	job, _, err = store.GetTenantDeletionJob(ctx, job.ID)
	if err != nil || job.Status != TenantDeletionStatusPartial || job.SuccessCount != 1 || job.FailureCount != 1 {
		t.Fatalf("failed job=%+v err=%v", job, err)
	}

	second, acquired, err = store.AcquireTenantDeletionTarget(ctx, "worker-a", time.Minute, base.Add(tenantDeletionRetryDelay+4*time.Second))
	if err != nil || !acquired {
		t.Fatalf("retry second=%+v acquired=%v err=%v", second, acquired, err)
	}
	job, err = store.PurgeTenantDeletionTarget(ctx, second, base.Add(tenantDeletionRetryDelay+5*time.Second))
	if err != nil || job.Status != TenantDeletionStatusSucceeded || job.SuccessCount != 2 || job.FailureCount != 0 {
		t.Fatalf("purge retry job=%+v err=%v", job, err)
	}
}
