package pass_test

import (
	"testing"
	"time"

	"ctl/pkg/model/pass"
)

// === trade-pass-destroy 设计稿落地（DAO TryAcquireSlotForTerminate 双源 CAS 单测）===
// 设计稿：.tmp/trade-pass-destroy-design.md §3.5 / §4.5.2 / §4.5.3 / §11-A Q1
//
// 覆盖场景：
//   1. 双源成功 from=deleting：CAS deleting → terminating（入口 A）
//   2. 双源成功 from=isolated：CAS isolated → terminating（入口 B）
//   3. 幂等失败：当前已是 terminating（重投场景）→ acquired=false
//   4. 状态不匹配：当前是 active / isolating / renewing → acquired=false
//   5. pass 不存在：acquired=false（无 DB 异常）
//   6. 多 pass 隔离：并行 CAS 互不影响（行级原子性）

func newDestroyTestPassEntity(passID, status string) *pass.Entity {
	now := time.Now().UTC()
	return &pass.Entity{
		PassID:      passID,
		UserID:      "user-destroy-1",
		BundleID:    "bundle-1",
		Uin:         1234567890,
		AppID:       1,
		ExpiredTime: now.Add(time.Hour),
		RenewFlag:   pass.RenewFlagManual,
		Status:      status,
	}
}

func TestTryAcquireSlotForTerminate_FromDeleting_Success(t *testing.T) {
	setupSQLite(t)
	dao := pass.NewDao()

	if err := dao.Create(newDestroyTestPassEntity("p-d-1", pass.StatusDeleting)); err != nil {
		t.Fatalf("seed pass: %v", err)
	}

	acquired, err := dao.TryAcquireSlotForTerminate("p-d-1")
	if err != nil {
		t.Fatalf("TryAcquireSlotForTerminate err: %v", err)
	}
	if !acquired {
		t.Fatalf("expected acquired=true for from=deleting")
	}

	got, err := dao.GetByPassID("p-d-1")
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if got.Status != pass.StatusTerminating {
		t.Fatalf("expected status=terminating, got %s", got.Status)
	}
}

func TestTryAcquireSlotForTerminate_FromIsolated_Success(t *testing.T) {
	setupSQLite(t)
	dao := pass.NewDao()

	if err := dao.Create(newDestroyTestPassEntity("p-i-1", pass.StatusIsolated)); err != nil {
		t.Fatalf("seed pass: %v", err)
	}

	acquired, err := dao.TryAcquireSlotForTerminate("p-i-1")
	if err != nil {
		t.Fatalf("TryAcquireSlotForTerminate err: %v", err)
	}
	if !acquired {
		t.Fatalf("expected acquired=true for from=isolated")
	}

	got, err := dao.GetByPassID("p-i-1")
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if got.Status != pass.StatusTerminating {
		t.Fatalf("expected status=terminating, got %s", got.Status)
	}
}

func TestTryAcquireSlotForTerminate_AlreadyTerminating_Rejected(t *testing.T) {
	// 重投幂等：当前已是 terminating，CAS 应返 acquired=false（不视作 DB 错误）
	setupSQLite(t)
	dao := pass.NewDao()

	if err := dao.Create(newDestroyTestPassEntity("p-t-1", pass.StatusTerminating)); err != nil {
		t.Fatalf("seed pass: %v", err)
	}

	acquired, err := dao.TryAcquireSlotForTerminate("p-t-1")
	if err != nil {
		t.Fatalf("TryAcquireSlotForTerminate err: %v", err)
	}
	if acquired {
		t.Fatalf("expected acquired=false for already-terminating")
	}
}

func TestTryAcquireSlotForTerminate_StatusMismatch_Rejected(t *testing.T) {
	// 当前 status 不在 {deleting, isolated} → CAS 失败，无 DB 错误
	cases := []struct {
		name   string
		status string
	}{
		{"active", pass.StatusActive},
		{"isolating", pass.StatusIsolating},
		{"renewing", pass.StatusRenewing},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			setupSQLite(t)
			dao := pass.NewDao()
			if err := dao.Create(newDestroyTestPassEntity("p-m", tc.status)); err != nil {
				t.Fatalf("seed pass: %v", err)
			}
			acquired, err := dao.TryAcquireSlotForTerminate("p-m")
			if err != nil {
				t.Fatalf("TryAcquireSlotForTerminate err: %v", err)
			}
			if acquired {
				t.Fatalf("expected acquired=false for status=%s", tc.status)
			}
			// 防御：status 应未变
			got, _ := dao.GetByPassID("p-m")
			if got.Status != tc.status {
				t.Fatalf("status leaked from %s to %s", tc.status, got.Status)
			}
		})
	}
}

func TestTryAcquireSlotForTerminate_PassNotExist_Rejected(t *testing.T) {
	setupSQLite(t)
	dao := pass.NewDao()

	acquired, err := dao.TryAcquireSlotForTerminate("p-ghost")
	if err != nil {
		t.Fatalf("TryAcquireSlotForTerminate err on missing pass: %v", err)
	}
	if acquired {
		t.Fatalf("expected acquired=false for missing pass")
	}
}

func TestTryAcquireSlotForTerminate_TwoPasses_Isolation(t *testing.T) {
	// 多 pass 并行 CAS：行级原子性
	setupSQLite(t)
	dao := pass.NewDao()

	if err := dao.Create(newDestroyTestPassEntity("p-a", pass.StatusDeleting)); err != nil {
		t.Fatalf("seed p-a: %v", err)
	}
	if err := dao.Create(newDestroyTestPassEntity("p-b", pass.StatusActive)); err != nil {
		t.Fatalf("seed p-b: %v", err)
	}

	acqA, errA := dao.TryAcquireSlotForTerminate("p-a")
	acqB, errB := dao.TryAcquireSlotForTerminate("p-b")
	if errA != nil || errB != nil {
		t.Fatalf("unexpected err: errA=%v errB=%v", errA, errB)
	}
	if !acqA {
		t.Fatalf("p-a should succeed (from=deleting)")
	}
	if acqB {
		t.Fatalf("p-b should fail (from=active not in {deleting,isolated})")
	}

	gotA, _ := dao.GetByPassID("p-a")
	if gotA.Status != pass.StatusTerminating {
		t.Fatalf("p-a status: %s (want terminating)", gotA.Status)
	}
	gotB, _ := dao.GetByPassID("p-b")
	if gotB.Status != pass.StatusActive {
		t.Fatalf("p-b status leaked: %s (want active)", gotB.Status)
	}
}
