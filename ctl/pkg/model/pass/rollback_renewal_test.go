// Package pass_test RollbackRenewal DAO CAS 单测（R-MR-5 续费失败回滚收尾，2026-05-24 用户拍板）。
package pass_test

import (
	"testing"
	"time"

	"ctl/pkg/model/pass"
)

func newRollbackRenewPassEntity(passID, status string, expiredAt time.Time, isolatedAt *time.Time) *pass.Entity {
	return &pass.Entity{
		PassID:       passID,
		UserID:       "user-rollback-renew-1",
		BundleID:     "bundle-rollback-renew-1",
		Uin:          1234567890,
		AppID:        1,
		ExpiredTime:  expiredAt,
		IsolatedTime: isolatedAt,
		RenewFlag:    pass.RenewFlagManual,
		Status:       status,
	}
}

// active 续费失败回滚：targetStatus=active；originalIsolatedTime=nil。
func TestRollbackRenewal_HappyPath_ActiveRollback(t *testing.T) {
	setupSQLite(t)
	dao := pass.NewDao()

	originalExpired := time.Date(2026, 7, 22, 7, 22, 50, 0, time.UTC)
	if err := dao.Create(newRollbackRenewPassEntity("p-rollback-active", pass.StatusRenewing, originalExpired, nil)); err != nil {
		t.Fatalf("seed pass: %v", err)
	}

	updated, err := dao.RollbackRenewal("p-rollback-active", pass.StatusActive, originalExpired, nil)
	if err != nil {
		t.Fatalf("RollbackRenewal err: %v", err)
	}
	if !updated {
		t.Fatalf("expected updated=true for status=renewing")
	}

	got, err := dao.GetByPassID("p-rollback-active")
	if err != nil {
		t.Fatalf("re-read pass: %v", err)
	}
	if got.Status != pass.StatusActive {
		t.Errorf("status mismatch: got %s want %s", got.Status, pass.StatusActive)
	}
	if !got.ExpiredTime.Equal(originalExpired) {
		t.Errorf("expired_time not rolled back: got %s want %s",
			got.ExpiredTime.UTC().Format(time.RFC3339),
			originalExpired.UTC().Format(time.RFC3339))
	}
	if got.IsolatedTime != nil {
		t.Errorf("isolated_time should be NULL for active rollback, got %s",
			got.IsolatedTime.UTC().Format(time.RFC3339))
	}
}

// isolated 续费失败回滚：targetStatus=isolated；originalIsolatedTime 非 nil。
func TestRollbackRenewal_HappyPath_IsolatedRollback(t *testing.T) {
	setupSQLite(t)
	dao := pass.NewDao()

	originalExpired := time.Date(2026, 7, 22, 7, 22, 50, 0, time.UTC)
	originalIsolated := time.Date(2026, 5, 1, 10, 0, 0, 0, time.UTC)
	if err := dao.Create(newRollbackRenewPassEntity("p-rollback-isolated", pass.StatusRenewing, originalExpired, &originalIsolated)); err != nil {
		t.Fatalf("seed pass: %v", err)
	}

	updated, err := dao.RollbackRenewal("p-rollback-isolated", pass.StatusIsolated, originalExpired, &originalIsolated)
	if err != nil {
		t.Fatalf("RollbackRenewal err: %v", err)
	}
	if !updated {
		t.Fatalf("expected updated=true")
	}

	got, err := dao.GetByPassID("p-rollback-isolated")
	if err != nil {
		t.Fatalf("re-read pass: %v", err)
	}
	if got.Status != pass.StatusIsolated {
		t.Errorf("status mismatch: got %s want %s", got.Status, pass.StatusIsolated)
	}
	if !got.ExpiredTime.Equal(originalExpired) {
		t.Errorf("expired_time not rolled back: got %s want %s",
			got.ExpiredTime.UTC().Format(time.RFC3339),
			originalExpired.UTC().Format(time.RFC3339))
	}
	if got.IsolatedTime == nil || !got.IsolatedTime.Equal(originalIsolated) {
		t.Errorf("isolated_time not rolled back: got %v want %s",
			got.IsolatedTime, originalIsolated.UTC().Format(time.RFC3339))
	}
}

// CAS 失败：状态不是 renewing → updated=false。
func TestRollbackRenewal_StatusNotRenewing_NoUpdate(t *testing.T) {
	cases := []struct {
		name   string
		status string
	}{
		{"active", pass.StatusActive},
		{"isolated", pass.StatusIsolated},
		{"isolating", pass.StatusIsolating},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			setupSQLite(t)
			dao := pass.NewDao()

			originalExpired := time.Date(2026, 7, 22, 7, 22, 50, 0, time.UTC)
			if err := dao.Create(newRollbackRenewPassEntity("p-rollback-bad-"+tc.name, tc.status, originalExpired, nil)); err != nil {
				t.Fatalf("seed pass: %v", err)
			}

			updated, err := dao.RollbackRenewal("p-rollback-bad-"+tc.name, pass.StatusActive, originalExpired, nil)
			if err != nil {
				t.Fatalf("RollbackRenewal err: %v", err)
			}
			if updated {
				t.Fatalf("status=%s should NOT match CAS WHERE status='renewing', got updated=true", tc.status)
			}

			got, err := dao.GetByPassID("p-rollback-bad-" + tc.name)
			if err != nil {
				t.Fatalf("re-read: %v", err)
			}
			if got.Status != tc.status {
				t.Errorf("status changed unexpectedly: got %s want %s", got.Status, tc.status)
			}
		})
	}
}

// pass 不存在：updated=false。
func TestRollbackRenewal_PassNotExists_NoUpdate(t *testing.T) {
	setupSQLite(t)
	dao := pass.NewDao()

	updated, err := dao.RollbackRenewal("p-nonexistent-rollback", pass.StatusActive, time.Now().UTC(), nil)
	if err != nil {
		t.Fatalf("RollbackRenewal err: %v", err)
	}
	if updated {
		t.Fatalf("non-existent pass should NOT match CAS, got updated=true")
	}
}

// expired_time 必须被覆写为 originalExpiredTime（即使 DB 中当前值不同，模拟 FinalizeRenewal 已写入）。
func TestRollbackRenewal_OverwritesExpiredTime(t *testing.T) {
	setupSQLite(t)
	dao := pass.NewDao()

	wrongNewExpired := time.Date(2026, 8, 22, 7, 22, 50, 0, time.UTC)
	if err := dao.Create(newRollbackRenewPassEntity("p-rollback-overwrite", pass.StatusRenewing, wrongNewExpired, nil)); err != nil {
		t.Fatalf("seed pass: %v", err)
	}

	originalExpired := time.Date(2026, 7, 22, 7, 22, 50, 0, time.UTC)
	updated, err := dao.RollbackRenewal("p-rollback-overwrite", pass.StatusActive, originalExpired, nil)
	if err != nil {
		t.Fatalf("RollbackRenewal err: %v", err)
	}
	if !updated {
		t.Fatalf("expected updated=true")
	}

	got, err := dao.GetByPassID("p-rollback-overwrite")
	if err != nil {
		t.Fatalf("re-read: %v", err)
	}
	if !got.ExpiredTime.Equal(originalExpired) {
		t.Errorf("expired_time should be overwritten to original: got %s want %s",
			got.ExpiredTime.UTC().Format(time.RFC3339),
			originalExpired.UTC().Format(time.RFC3339))
	}
}

// active 回滚：DB 中 isolated_time 必须被清成 NULL（即使有 stale 值，防御 SQL 正确性）。
func TestRollbackRenewal_ActiveRollback_ClearsIsolatedTime(t *testing.T) {
	setupSQLite(t)
	dao := pass.NewDao()

	staleIsolated := time.Date(2026, 5, 1, 10, 0, 0, 0, time.UTC)
	originalExpired := time.Date(2026, 7, 22, 7, 22, 50, 0, time.UTC)
	if err := dao.Create(newRollbackRenewPassEntity("p-rollback-clear-iso", pass.StatusRenewing, originalExpired, &staleIsolated)); err != nil {
		t.Fatalf("seed pass: %v", err)
	}

	updated, err := dao.RollbackRenewal("p-rollback-clear-iso", pass.StatusActive, originalExpired, nil)
	if err != nil {
		t.Fatalf("RollbackRenewal err: %v", err)
	}
	if !updated {
		t.Fatalf("expected updated=true")
	}

	got, err := dao.GetByPassID("p-rollback-clear-iso")
	if err != nil {
		t.Fatalf("re-read: %v", err)
	}
	if got.IsolatedTime != nil {
		t.Errorf("active rollback must NULL isolated_time even if DB had stale value, got %s",
			got.IsolatedTime.UTC().Format(time.RFC3339))
	}
}
