package pass_test

import (
	"context"
	"errors"
	"testing"
	"time"

	pass "ctl/pkg/model/pass"
	quota "ctl/pkg/model/userresourcequota"
	"ctl/test/testutil"
)

// === trade-pass-destroy 设计稿落地（§4.3 / §11-A Q6）单测 ===
// 设计稿：.tmp/trade-pass-destroy-design.md §4.3
//
// 覆盖 MoveToHistory 的核心语义：
//   1. 首次迁移：pass 行 → INSERT history_pass + DELETE pass，alreadyMigrated=false
//   2. 重复迁移幂等：pass 不在表，history_pass 已有 → alreadyMigrated=true
//   3. 真实缺失：pass 不在表，history_pass 也不在 → ErrPassNotFound
//   4. 入参校验：empty passID / zero deletedTime → 直接返错（不入事务）
//   5. 字段镜像：迁移后 history_pass 的字段与原 pass 一致 + deleted_time / destroy_reason 正确写入
//   6. 事务一致性：成功迁移后 pass 表为空 + history_pass 表有 1 行（一次提交两表同步）

// setupSQLite 构造内存 sqlite + 自动建表（pass + history_pass + user_resource_quota 三表）
// quota 表包括在内是为了验证 MoveToHistory step 4 联动删除配额行的逻辑。
func setupSQLite(t *testing.T) {
	t.Helper()
	testutil.NewSQLiteDB(t, &pass.Entity{}, &pass.HistoryEntity{}, &quota.Entity{})
}

func newPassEntity(passID, userID string, expiredAt time.Time) *pass.Entity {
	return &pass.Entity{
		PassID:      passID,
		UserID:      userID,
		BundleID:    "bundle-test",
		Uin:         123456789,
		AppID:       1,
		ExpiredTime: expiredAt,
		RenewFlag:   pass.RenewFlagManual,
		Status:      pass.StatusIsolated,
	}
}

func TestMoveToHistory_FirstMigration_Success(t *testing.T) {
	setupSQLite(t)
	dao := pass.NewDao()
	historyDao := pass.NewHistoryDao()

	now := time.Now().UTC().Truncate(time.Second)
	expired := now.Add(30 * 24 * time.Hour)
	p := newPassEntity("p-1", "u-1", expired)
	if err := dao.Create(p); err != nil {
		t.Fatalf("seed pass: %v", err)
	}

	deletedAt := now.Add(time.Minute)
	already, err := dao.MoveToHistory(context.Background(), "p-1", deletedAt, "biz")
	if err != nil {
		t.Fatalf("MoveToHistory unexpected err: %v", err)
	}
	if already {
		t.Fatalf("first migration should return alreadyMigrated=false, got true")
	}

	// pass 表应已删除
	if _, err := dao.GetByPassID("p-1"); err == nil {
		t.Fatalf("expected pass row deleted, but still readable")
	}

	// history_pass 表应有 1 行，字段镜像 + deletedTime + destroyReason 正确
	got, err := historyDao.GetByPassID(context.Background(), "p-1")
	if err != nil {
		t.Fatalf("read history_pass: %v", err)
	}
	if got.PassID != "p-1" || got.UserID != "u-1" || got.BundleID != "bundle-test" {
		t.Fatalf("history_pass field mirror mismatch: %+v", got)
	}
	if got.Uin != 123456789 || got.AppID != 1 {
		t.Fatalf("history_pass uin/appid mirror mismatch: uin=%d appid=%d", got.Uin, got.AppID)
	}
	if !got.DeletedTime.Equal(deletedAt) {
		t.Fatalf("history_pass deleted_time mismatch: got=%s want=%s", got.DeletedTime, deletedAt)
	}
	if got.DestroyReason != "biz" {
		t.Fatalf("history_pass destroy_reason mismatch: %s", got.DestroyReason)
	}
	// Bug fix（用户 2026-05-25 拍板）：history_pass.status 不再镜像销毁瞬间 pass.status，
	// 而是强制写为 'deleted' 终态枚举（详见 history_entity.go fromActivePass 注释）。
	if got.Status != pass.StatusDeleted {
		t.Fatalf("history_pass status should be 'deleted' (terminal enum), got: %s", got.Status)
	}
}

// TestMoveToHistory_DeletesUserResourceQuota 验证 MoveToHistory step 4 联动删除
// user_resource_quota 行（用户 2026-05-25 拍板的 bug #1+#2 合并修复）。
//
// 场景：销毁 pass 之前 seed 一行 OPENCLAW_INSTANCE 配额；MoveToHistory 成功后该行应被删除。
func TestMoveToHistory_DeletesUserResourceQuota(t *testing.T) {
	setupSQLite(t)
	dao := pass.NewDao()
	quotaDao := quota.NewDao()

	now := time.Now().UTC().Truncate(time.Second)
	expired := now.Add(30 * 24 * time.Hour)
	p := newPassEntity("p-quota", "u-quota", expired)
	if err := dao.Create(p); err != nil {
		t.Fatalf("seed pass: %v", err)
	}

	// seed 一行 OPENCLAW_INSTANCE 配额（模拟创建 pass 时由 CreatePassWithQuota 注入的行）
	if err := quotaDao.DB().Create(&quota.Entity{
		UserID:                 "u-quota",
		ResourceName:           "OPENCLAW_INSTANCE",
		ResourceKey:            "",
		ResourceQuotaAvailable: 1,
		ResourceQuotaTotal:     1,
	}).Error; err != nil {
		t.Fatalf("seed quota: %v", err)
	}

	deletedAt := now.Add(time.Minute)
	if _, err := dao.MoveToHistory(context.Background(), "p-quota", deletedAt, "biz"); err != nil {
		t.Fatalf("MoveToHistory unexpected err: %v", err)
	}

	// 断言 1：pass 行已删除
	if _, err := dao.GetByPassID("p-quota"); err == nil {
		t.Fatalf("expected pass row deleted, but still readable")
	}

	// 断言 2：user_resource_quota 行已被同事务联动删除（bug #1+#2 修复核心）
	got, err := quotaDao.SelectQuota("u-quota", "OPENCLAW_INSTANCE", "")
	if err != nil {
		t.Fatalf("query quota after MoveToHistory: %v", err)
	}
	if got != nil {
		t.Fatalf("user_resource_quota row should be deleted, but still exists: %+v", got)
	}
}

func TestMoveToHistory_RepeatedCall_IdempotentAlreadyMigrated(t *testing.T) {
	setupSQLite(t)
	dao := pass.NewDao()

	now := time.Now().UTC().Truncate(time.Second)
	p := newPassEntity("p-2", "u-2", now.Add(30*24*time.Hour))
	if err := dao.Create(p); err != nil {
		t.Fatalf("seed pass: %v", err)
	}

	// 第一次：正常迁移
	already1, err1 := dao.MoveToHistory(context.Background(), "p-2", now, "qn")
	if err1 != nil || already1 {
		t.Fatalf("first call: err=%v already=%v", err1, already1)
	}

	// 第二次：pass 已不在 + history_pass 已有 → 幂等 alreadyMigrated=true
	already2, err2 := dao.MoveToHistory(context.Background(), "p-2", now, "qn")
	if err2 != nil {
		t.Fatalf("second call unexpected err: %v", err2)
	}
	if !already2 {
		t.Fatalf("repeated call should return alreadyMigrated=true")
	}
}

func TestMoveToHistory_NoSuchPass_ReturnsErrPassNotFound(t *testing.T) {
	setupSQLite(t)
	dao := pass.NewDao()

	already, err := dao.MoveToHistory(context.Background(), "p-ghost", time.Now(), "biz")
	if !errors.Is(err, pass.ErrPassNotFound) {
		t.Fatalf("expected ErrPassNotFound, got err=%v already=%v", err, already)
	}
	if already {
		t.Fatalf("ghost pass should not be marked alreadyMigrated")
	}
}

func TestMoveToHistory_EmptyPassID_RejectsBeforeTx(t *testing.T) {
	setupSQLite(t)
	dao := pass.NewDao()

	_, err := dao.MoveToHistory(context.Background(), "", time.Now(), "biz")
	if err == nil {
		t.Fatalf("expected error for empty passID")
	}
}

func TestMoveToHistory_ZeroDeletedTime_RejectsBeforeTx(t *testing.T) {
	setupSQLite(t)
	dao := pass.NewDao()

	_, err := dao.MoveToHistory(context.Background(), "p-x", time.Time{}, "biz")
	if err == nil {
		t.Fatalf("expected error for zero deletedTime")
	}
}

func TestMoveToHistory_DestroyReasonEmpty_AllowedAsTombstone(t *testing.T) {
	// Q24 拍板：destroyReason 空串是合法值（"用户控制台 DeletePass 入口未经 jifei 二次回标的兜底场景"）
	setupSQLite(t)
	dao := pass.NewDao()
	historyDao := pass.NewHistoryDao()

	now := time.Now().UTC().Truncate(time.Second)
	p := newPassEntity("p-3", "u-3", now.Add(time.Hour))
	if err := dao.Create(p); err != nil {
		t.Fatalf("seed pass: %v", err)
	}

	already, err := dao.MoveToHistory(context.Background(), "p-3", now, "")
	if err != nil || already {
		t.Fatalf("empty destroyReason should succeed: err=%v already=%v", err, already)
	}
	got, err := historyDao.GetByPassID(context.Background(), "p-3")
	if err != nil {
		t.Fatalf("read history_pass: %v", err)
	}
	if got.DestroyReason != "" {
		t.Fatalf("destroy_reason should be empty string, got %q", got.DestroyReason)
	}
}

func TestMoveToHistory_TwoPasses_IsolationBetweenRows(t *testing.T) {
	// 多 pass 并行迁移：每行独立事务，互不影响
	setupSQLite(t)
	dao := pass.NewDao()
	historyDao := pass.NewHistoryDao()

	now := time.Now().UTC().Truncate(time.Second)
	for _, id := range []string{"a", "b", "c"} {
		if err := dao.Create(newPassEntity(id, "u-"+id, now.Add(time.Hour))); err != nil {
			t.Fatalf("seed %s: %v", id, err)
		}
	}

	for _, id := range []string{"a", "b"} {
		already, err := dao.MoveToHistory(context.Background(), id, now, "biz")
		if err != nil || already {
			t.Fatalf("migrate %s: err=%v already=%v", id, err, already)
		}
	}

	// a/b 已迁，c 仍在 pass 表
	if _, err := dao.GetByPassID("c"); err != nil {
		t.Fatalf("pass c should still exist: %v", err)
	}
	for _, id := range []string{"a", "b"} {
		if _, err := historyDao.GetByPassID(context.Background(), id); err != nil {
			t.Fatalf("history_pass %s: %v", id, err)
		}
	}
	// history_pass 不应有 c
	hc, err := historyDao.GetByPassID(context.Background(), "c")
	if err == nil {
		t.Fatalf("history_pass c should not exist, got %+v", hc)
	}
}

func TestHistoryDao_ListByUserID_OrderByDeletedTimeDesc(t *testing.T) {
	setupSQLite(t)
	dao := pass.NewDao()
	historyDao := pass.NewHistoryDao()

	now := time.Now().UTC().Truncate(time.Second)
	// 同 user 三条 pass，分别在 t1 < t2 < t3 销毁
	for i, id := range []string{"x1", "x2", "x3"} {
		if err := dao.Create(newPassEntity(id, "u-same", now.Add(time.Hour))); err != nil {
			t.Fatalf("seed %s: %v", id, err)
		}
		_, err := dao.MoveToHistory(context.Background(), id, now.Add(time.Duration(i)*time.Second), "biz")
		if err != nil {
			t.Fatalf("migrate %s: %v", id, err)
		}
	}

	rows, err := historyDao.ListByUserID(context.Background(), "u-same")
	if err != nil {
		t.Fatalf("ListByUserID: %v", err)
	}
	if len(rows) != 3 {
		t.Fatalf("expected 3 rows, got %d", len(rows))
	}
	// 按 deleted_time DESC：x3 → x2 → x1
	if rows[0].PassID != "x3" || rows[1].PassID != "x2" || rows[2].PassID != "x1" {
		t.Fatalf("ordering mismatch: %s %s %s", rows[0].PassID, rows[1].PassID, rows[2].PassID)
	}
}

func TestHistoryDao_Insert_DirectInsertion(t *testing.T) {
	setupSQLite(t)
	historyDao := pass.NewHistoryDao()

	now := time.Now().UTC().Truncate(time.Second)
	p := newPassEntity("p-direct", "u-d", now.Add(time.Hour))
	if err := historyDao.Insert(context.Background(), p, now, "other"); err != nil {
		t.Fatalf("Insert: %v", err)
	}
	got, err := historyDao.GetByPassID(context.Background(), "p-direct")
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if got.PassID != "p-direct" || got.DestroyReason != "other" {
		t.Fatalf("direct insert mirror mismatch: %+v", got)
	}
}

func TestHistoryDao_Insert_NilEntity_Rejected(t *testing.T) {
	setupSQLite(t)
	historyDao := pass.NewHistoryDao()

	if err := historyDao.Insert(context.Background(), nil, time.Now(), "biz"); err == nil {
		t.Fatalf("expected error for nil entity")
	}
}
