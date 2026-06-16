// Package pass_test MarkIsolated DAO CAS 单测（trade-pass-isolate §11-Q22 钦点版）。
//
// 设计稿：.tmp/trade-pass-isolate-design.md §11-Q22
//
//	钦点 SQL：UPDATE pass SET status='isolated', isolated_time=NOW() WHERE pass_id=? AND status='isolating'
//	语义：父 task 终态写 status + isolated_time，二者同事务原子写入。
//
// 覆盖场景：
//  1. happy path：CAS WHERE status='isolating' UPDATE status='isolated' + isolated_time
//  2. 状态不匹配：当前是 active / isolated / renewing → updated=false，不写表
//  3. pass 不存在：updated=false（无 DB 异常）
//  4. expired_time 不被改写（与 MarkIsolatedWithExpiredTime 形成对照）
package pass_test

import (
	"testing"
	"time"

	"ctl/pkg/model/pass"
)

func newLifecycleIsolatePassEntity(passID, status string, expiredAt time.Time) *pass.Entity {
	return &pass.Entity{
		PassID:      passID,
		UserID:      "user-lifecycle-1",
		BundleID:    "bundle-lifecycle-1",
		Uin:         1234567890,
		AppID:       1,
		ExpiredTime: expiredAt,
		RenewFlag:   pass.RenewFlagManual,
		Status:      status,
	}
}

func TestMarkIsolated_HappyPath(t *testing.T) {
	setupSQLite(t)
	dao := pass.NewDao()

	originalExpired := time.Date(2026, 7, 22, 7, 22, 50, 0, time.UTC)
	if err := dao.Create(newLifecycleIsolatePassEntity("p-lifecycle-1", pass.StatusIsolating, originalExpired)); err != nil {
		t.Fatalf("seed pass: %v", err)
	}

	isolatedAt := time.Date(2026, 5, 22, 10, 0, 0, 0, time.UTC)
	updated, err := dao.MarkIsolated("p-lifecycle-1", isolatedAt)
	if err != nil {
		t.Fatalf("MarkIsolated err: %v", err)
	}
	if !updated {
		t.Fatalf("expected updated=true for status=isolating")
	}

	got, err := dao.GetByPassID("p-lifecycle-1")
	if err != nil {
		t.Fatalf("re-read pass: %v", err)
	}
	if got.Status != pass.StatusIsolated {
		t.Errorf("status mismatch: got %s want %s", got.Status, pass.StatusIsolated)
	}
	if got.IsolatedTime == nil || !got.IsolatedTime.Equal(isolatedAt) {
		t.Errorf("isolated_time not written: got %v want %s",
			got.IsolatedTime, isolatedAt.UTC().Format(time.RFC3339))
	}
	// expired_time 必须保持原值（生命周期分支不改 expired_time）
	if !got.ExpiredTime.Equal(originalExpired) {
		t.Errorf("expired_time should NOT be touched by MarkIsolated: got %s want %s",
			got.ExpiredTime.UTC().Format(time.RFC3339),
			originalExpired.UTC().Format(time.RFC3339))
	}
}

func TestMarkIsolated_StatusNotIsolating_NoUpdate(t *testing.T) {
	cases := []struct {
		name   string
		status string
	}{
		{"active", pass.StatusActive},
		{"isolated", pass.StatusIsolated},
		{"renewing", pass.StatusRenewing},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			setupSQLite(t)
			dao := pass.NewDao()

			originalExpired := time.Date(2026, 7, 22, 7, 22, 50, 0, time.UTC)
			if err := dao.Create(newLifecycleIsolatePassEntity("p-lifecycle-bad-"+tc.name, tc.status, originalExpired)); err != nil {
				t.Fatalf("seed pass: %v", err)
			}

			isolatedAt := time.Date(2026, 5, 22, 10, 0, 0, 0, time.UTC)
			updated, err := dao.MarkIsolated("p-lifecycle-bad-"+tc.name, isolatedAt)
			if err != nil {
				t.Fatalf("MarkIsolated err: %v", err)
			}
			if updated {
				t.Fatalf("status=%s should NOT match CAS WHERE status='isolating', got updated=true", tc.status)
			}

			got, err := dao.GetByPassID("p-lifecycle-bad-" + tc.name)
			if err != nil {
				t.Fatalf("re-read pass: %v", err)
			}
			if got.Status != tc.status {
				t.Errorf("status changed unexpectedly: got %s want %s", got.Status, tc.status)
			}
			if got.IsolatedTime != nil {
				t.Errorf("isolated_time should remain NULL when CAS misses, got %s",
					got.IsolatedTime.UTC().Format(time.RFC3339))
			}
		})
	}
}

func TestMarkIsolated_PassNotExists_NoUpdate(t *testing.T) {
	setupSQLite(t)
	dao := pass.NewDao()

	updated, err := dao.MarkIsolated("p-nonexistent-lifecycle", time.Now().UTC())
	if err != nil {
		t.Fatalf("MarkIsolated err: %v", err)
	}
	if updated {
		t.Fatalf("non-existent pass should NOT match CAS, got updated=true")
	}
}

// TestMarkIsolated_DoesNotTouchExpiredTime 与 MarkIsolatedWithExpiredTime 形成
// 对照：生命周期分支只动 status + isolated_time，绝不动 expired_time。
func TestMarkIsolated_DoesNotTouchExpiredTime(t *testing.T) {
	setupSQLite(t)
	dao := pass.NewDao()

	originalExpired := time.Date(2026, 7, 22, 7, 22, 50, 0, time.UTC)
	if err := dao.Create(newLifecycleIsolatePassEntity("p-lifecycle-keep-exp", pass.StatusIsolating, originalExpired)); err != nil {
		t.Fatalf("seed pass: %v", err)
	}

	isolatedAt := time.Date(2026, 5, 22, 10, 0, 0, 0, time.UTC)
	if _, err := dao.MarkIsolated("p-lifecycle-keep-exp", isolatedAt); err != nil {
		t.Fatalf("MarkIsolated err: %v", err)
	}

	got, err := dao.GetByPassID("p-lifecycle-keep-exp")
	if err != nil {
		t.Fatalf("re-read: %v", err)
	}
	if !got.ExpiredTime.Equal(originalExpired) {
		t.Errorf("expired_time must NOT be touched by MarkIsolated: got %s want %s",
			got.ExpiredTime.UTC().Format(time.RFC3339),
			originalExpired.UTC().Format(time.RFC3339))
	}
}
