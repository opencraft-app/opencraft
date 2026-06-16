// Package pass_test MarkIsolatedWithExpiredTime DAO CAS 单测（v1.7.30 BUG-35 退费隔离）。
//
// 设计稿：
//   - .tmp/jifei_pdf_txt/预付费资源隔离接口+-+isolateResource.md §2.2 退费场景
//   - .tmp/trade-pass-isolate-design.md §11-Q22（钦点：父 task 终态写 status='isolated' + isolated_time=NOW()）
//
// 覆盖场景：
//  1. happy path：CAS WHERE status='isolating' UPDATE status='isolated' + expired_time + isolated_time
//  2. 状态不匹配：当前是 active / isolated / renewing → updated=false，不写表
//  3. pass 不存在：updated=false（无 DB 异常）
//  4. 字段写入校验：迁移成功后读出的 entity.ExpiredTime / .IsolatedTime / .Status 与入参一致
//  5. 与 MarkIsolated 的差异点：本方法多写一列 expired_time（退费 newDeadline）
package pass_test

import (
	"testing"
	"time"

	"ctl/pkg/model/pass"
)

func newRefundIsolatePassEntity(passID, status string, expiredAt time.Time) *pass.Entity {
	return &pass.Entity{
		PassID:      passID,
		UserID:      "user-refund-1",
		BundleID:    "bundle-refund-1",
		Uin:         9876543210,
		AppID:       2,
		ExpiredTime: expiredAt,
		RenewFlag:   pass.RenewFlagManual,
		Status:      status,
	}
}

func TestMarkIsolatedWithExpiredTime_HappyPath(t *testing.T) {
	setupSQLite(t)
	dao := pass.NewDao()

	originalExpired := time.Date(2026, 7, 22, 7, 22, 50, 0, time.UTC)
	if err := dao.Create(newRefundIsolatePassEntity("p-refund-1", pass.StatusIsolating, originalExpired)); err != nil {
		t.Fatalf("seed pass: %v", err)
	}

	// 退费场景：jifei 给的 newDeadline 比原到期时间早（严格 < originalExpired），
	// 但 dao 层不校验业务约束（业务约束在 logic.IsolatePass 层做），
	// 这里只验证 CAS + 字段写入语义。
	newDeadline := time.Date(2026, 6, 22, 7, 22, 50, 0, time.UTC) // -1 month
	isolatedAt := time.Date(2026, 5, 22, 10, 0, 0, 0, time.UTC)
	updated, err := dao.MarkIsolatedWithExpiredTime("p-refund-1", newDeadline, isolatedAt)
	if err != nil {
		t.Fatalf("MarkIsolatedWithExpiredTime err: %v", err)
	}
	if !updated {
		t.Fatalf("expected updated=true for status=isolating")
	}

	// 校验 3 列原子写入：status / expired_time / isolated_time
	got, err := dao.GetByPassID("p-refund-1")
	if err != nil {
		t.Fatalf("re-read pass: %v", err)
	}
	if got.Status != pass.StatusIsolated {
		t.Errorf("status mismatch: got %s want %s", got.Status, pass.StatusIsolated)
	}
	if !got.ExpiredTime.Equal(newDeadline) {
		t.Errorf("expired_time not updated to newDeadline: got %s want %s",
			got.ExpiredTime.UTC().Format(time.RFC3339),
			newDeadline.UTC().Format(time.RFC3339))
	}
	if got.IsolatedTime == nil || !got.IsolatedTime.Equal(isolatedAt) {
		t.Errorf("isolated_time not written: got %v want %s",
			got.IsolatedTime, isolatedAt.UTC().Format(time.RFC3339))
	}
}

func TestMarkIsolatedWithExpiredTime_StatusNotIsolating_NoUpdate(t *testing.T) {
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
			if err := dao.Create(newRefundIsolatePassEntity("p-refund-bad-"+tc.name, tc.status, originalExpired)); err != nil {
				t.Fatalf("seed pass: %v", err)
			}

			newDeadline := time.Date(2026, 6, 22, 7, 22, 50, 0, time.UTC)
			isolatedAt := time.Date(2026, 5, 22, 10, 0, 0, 0, time.UTC)
			updated, err := dao.MarkIsolatedWithExpiredTime("p-refund-bad-"+tc.name, newDeadline, isolatedAt)
			if err != nil {
				t.Fatalf("MarkIsolatedWithExpiredTime err: %v", err)
			}
			if updated {
				t.Fatalf("status=%s should NOT match CAS WHERE status='isolating', got updated=true", tc.status)
			}

			// 校验：表里 status / expired_time / isolated_time 都未变
			got, err := dao.GetByPassID("p-refund-bad-" + tc.name)
			if err != nil {
				t.Fatalf("re-read pass: %v", err)
			}
			if got.Status != tc.status {
				t.Errorf("status changed unexpectedly: got %s want %s", got.Status, tc.status)
			}
			if !got.ExpiredTime.Equal(originalExpired) {
				t.Errorf("expired_time changed unexpectedly: got %s want %s",
					got.ExpiredTime.UTC().Format(time.RFC3339),
					originalExpired.UTC().Format(time.RFC3339))
			}
			if got.IsolatedTime != nil {
				t.Errorf("isolated_time should remain NULL when CAS misses, got %s",
					got.IsolatedTime.UTC().Format(time.RFC3339))
			}
		})
	}
}

func TestMarkIsolatedWithExpiredTime_PassNotExists_NoUpdate(t *testing.T) {
	setupSQLite(t)
	dao := pass.NewDao()

	updated, err := dao.MarkIsolatedWithExpiredTime("p-nonexistent",
		time.Now().UTC(), time.Now().UTC())
	if err != nil {
		t.Fatalf("MarkIsolatedWithExpiredTime err: %v", err)
	}
	if updated {
		t.Fatalf("non-existent pass should NOT match CAS, got updated=true")
	}
}

// TestMarkIsolatedWithExpiredTime_OverwritesPreExistingIsolatedTime 验证：
// 即使 seed 时 isolated_time 已有值（异常脏数据 / reconcile 兜底场景），
// 本方法仍按入参覆写为新的"隔离完成时刻"。
// 与设计稿 §11-Q22 一致：父 task 终态权威写 isolated_time = NOW()。
func TestMarkIsolatedWithExpiredTime_OverwritesPreExistingIsolatedTime(t *testing.T) {
	setupSQLite(t)
	dao := pass.NewDao()

	originalExpired := time.Date(2026, 7, 22, 7, 22, 50, 0, time.UTC)
	preIsolatedTime := time.Date(2026, 5, 1, 0, 0, 0, 0, time.UTC)
	entity := newRefundIsolatePassEntity("p-refund-iso-time", pass.StatusIsolating, originalExpired)
	entity.IsolatedTime = &preIsolatedTime
	if err := dao.Create(entity); err != nil {
		t.Fatalf("seed pass: %v", err)
	}

	newDeadline := time.Date(2026, 6, 22, 7, 22, 50, 0, time.UTC)
	newIsolatedAt := time.Date(2026, 5, 22, 10, 0, 0, 0, time.UTC)
	if _, err := dao.MarkIsolatedWithExpiredTime("p-refund-iso-time", newDeadline, newIsolatedAt); err != nil {
		t.Fatalf("MarkIsolatedWithExpiredTime err: %v", err)
	}

	got, err := dao.GetByPassID("p-refund-iso-time")
	if err != nil {
		t.Fatalf("re-read: %v", err)
	}
	if got.IsolatedTime == nil || !got.IsolatedTime.Equal(newIsolatedAt) {
		t.Errorf("isolated_time must be overwritten to newIsolatedAt: got %v want %s",
			got.IsolatedTime, newIsolatedAt.UTC().Format(time.RFC3339))
	}
}
