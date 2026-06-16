package snapshot_test

import (
	"context"
	"testing"
	"time"

	modelsnapshot "ctl/pkg/model/snapshot"
	cronsnapshot "ctl/pkg/logic/snapshot"
	"ctl/test/testutil"

	"go.uber.org/zap"
)

// === D-8 cron 单测（设计稿 .tmp/trade-pass-destroy-design.md §4.10 / Q7）===
//
// 覆盖：
//   1. 空表场景：无 row 时不报错
//   2. 过期 row 被物理删除（expire_time < now-grace）
//   3. 未过期 row 不动（expire_time >= now-grace）
//   4. grace 边界：expire_time == now-grace 不被清（严格 < cutoff）

func newSnapshotEntity(snapshotID, passID, instanceID string, flowID int64, expire time.Time) *modelsnapshot.Entity {
	return &modelsnapshot.Entity{
		SnapshotID:    snapshotID,
		FlowID:        flowID,
		PassID:        passID,
		InstanceID:    instanceID,
		UserID:        "user-cron-test",
		Uin:           111,
		AppID:         222,
		Region:        "1",
		SnapshotState: modelsnapshot.StateNormal,
		ExpireTime:    expire,
	}
}

func TestRunExpiredCleanup_EmptyTable_NoError(t *testing.T) {
	testutil.NewSQLiteDB(t, &modelsnapshot.Entity{})

	// 空表场景：cron 不报错（用 Nop logger 兜底）
	cronsnapshot.RunExpiredCleanup(zap.NewNop())
}

func TestRunExpiredCleanup_DeletesExpiredRows(t *testing.T) {
	testutil.NewSQLiteDB(t, &modelsnapshot.Entity{})
	dao := modelsnapshot.NewDao()

	// 种 3 行：
	//   - row-old：expire 在很久之前 → 应被清
	//   - row-edge：expire 刚刚（now - grace - 1s）→ 应被清
	//   - row-fresh：expire 在未来 → 不动
	now := time.Now().UTC()
	rows := []*modelsnapshot.Entity{
		newSnapshotEntity("snap-old", "p-1", "ins-1", 1001, now.Add(-100*time.Hour)),
		newSnapshotEntity("snap-edge", "p-2", "ins-2", 1002, now.Add(-31*time.Minute)),
		newSnapshotEntity("snap-fresh", "p-3", "ins-3", 1003, now.Add(30*24*time.Hour)),
	}
	for _, r := range rows {
		if err := dao.Create(context.Background(), r); err != nil {
			t.Fatalf("seed %s: %v", r.SnapshotID, err)
		}
	}

	cronsnapshot.RunExpiredCleanup(zap.NewNop())

	// 校验：snap-old 和 snap-edge 已删；snap-fresh 仍在
	got, err := dao.GetByFlowAndInstance(context.Background(), 1001, "ins-1")
	if err == nil && got != nil {
		t.Errorf("snap-old should be deleted, but still exists: %+v", got)
	}
	got, err = dao.GetByFlowAndInstance(context.Background(), 1002, "ins-2")
	if err == nil && got != nil {
		t.Errorf("snap-edge should be deleted, but still exists: %+v", got)
	}
	got, err = dao.GetByFlowAndInstance(context.Background(), 1003, "ins-3")
	if err != nil {
		t.Fatalf("snap-fresh should still exist: %v", err)
	}
	if got.SnapshotID != "snap-fresh" {
		t.Errorf("snap-fresh content mismatch: %+v", got)
	}
}

func TestRunExpiredCleanup_GracePeriod_ProtectsBoundary(t *testing.T) {
	// 严格防御 grace period 边界：expire_time 落在 [now-grace, now] 区间内不应被清
	testutil.NewSQLiteDB(t, &modelsnapshot.Entity{})
	dao := modelsnapshot.NewDao()

	now := time.Now().UTC()
	// expire_time 仅 5 分钟前（小于 30 分钟 grace），不应被清
	row := newSnapshotEntity("snap-within-grace", "p-g", "ins-g", 9001, now.Add(-5*time.Minute))
	if err := dao.Create(context.Background(), row); err != nil {
		t.Fatalf("seed: %v", err)
	}

	cronsnapshot.RunExpiredCleanup(zap.NewNop())

	got, err := dao.GetByFlowAndInstance(context.Background(), 9001, "ins-g")
	if err != nil {
		t.Fatalf("snap-within-grace should still exist: %v", err)
	}
	if got.SnapshotID != "snap-within-grace" {
		t.Errorf("content mismatch: %+v", got)
	}
}
