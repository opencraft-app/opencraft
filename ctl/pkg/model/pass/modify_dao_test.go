package pass_test

import (
	"encoding/json"
	"testing"
	"time"

	"ctl/pkg/model/pass"
	taskmodel "ctl/pkg/model/task"
	quota "ctl/pkg/model/userresourcequota"
	"ctl/pkg/resource"
	taskcommon "ctl/pkg/taskruntime/common"
)

func seedModifyTask(t *testing.T, p *pass.Entity, flowID int64) string {
	t.Helper()
	db := resource.GormDB
	if err := db.AutoMigrate(&taskmodel.Entity{}); err != nil {
		t.Fatal(err)
	}
	id := "task-" + p.PassID
	body, err := json.Marshal(taskcommon.ModifyPassTaskPayload{PassID: p.PassID, UserID: p.UserID,
		SourceBundleID: p.BundleID, TargetBundleID: p.ModifyTargetBundleID,
		TradeFlowID: flowID, DealName: "deal-" + p.PassID, SubscriptionDone: true})
	if err != nil {
		t.Fatal(err)
	}
	task := &taskmodel.Entity{TaskId: id, TaskName: taskcommon.TaskNameModifyPass,
		TaskParams: string(body), TaskState: taskmodel.StateRunning}
	task.UserID = p.UserID
	if err := db.Create(task).Error; err != nil {
		t.Fatal(err)
	}
	return id
}

func assertModifyFinalizedMarker(t *testing.T, taskID string, expected bool) {
	t.Helper()
	var task taskmodel.Entity
	if err := taskmodel.NewDao().SelectByKeyColumn(taskID, &task); err != nil {
		t.Fatal(err)
	}
	var payload taskcommon.ModifyPassTaskPayload
	if err := json.Unmarshal([]byte(task.TaskParams), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.EntitlementsFinalized != expected {
		t.Fatalf("finalized receipt=%v want %v", payload.EntitlementsFinalized, expected)
	}
}

// 同 SP 变配的两个 CAS 原语单测。需求：TAPD 1010132091137784162 §8.1 幂等
//
// TryAcquireSlotForModify 的重点是"只有 active 能进 modifying，且 flow/target 必须落盘"——
// 落盘是幂等的前提：pass 上没有 flow id 就无法区分同一笔单重投和另一笔单插队。
//
// FinalizeModify 的重点是"套餐和配额同事务提交"：只升套餐不升配额会让用户付了钱却
// 开不出第二台机器；只升配额不升套餐则会让续费按错误档位计价。

func newModifyTestPass(passID, bundleID, status string) *pass.Entity {
	return &pass.Entity{
		PassID:      passID,
		UserID:      "user-modify-1",
		BundleID:    bundleID,
		Uin:         1234567890,
		AppID:       1,
		ExpiredTime: time.Now().UTC().Add(30 * 24 * time.Hour),
		RenewFlag:   pass.RenewFlagManual,
		Status:      status,
	}
}

func seedModifyQuota(t *testing.T, userID string, total, available int64) {
	t.Helper()
	if err := quota.NewDao().DB().Create(&quota.Entity{
		UserID:                 userID,
		ResourceName:           "OPENCLAW_INSTANCE",
		ResourceKey:            "",
		ResourceQuotaTotal:     total,
		ResourceQuotaAvailable: available,
	}).Error; err != nil {
		t.Fatalf("seed quota: %v", err)
	}
}

func readModifyQuota(t *testing.T, userID string) quota.Entity {
	t.Helper()
	var got quota.Entity
	if err := quota.NewDao().DB().
		Where("user_id = ? AND resource_name = ?", userID, "OPENCLAW_INSTANCE").
		First(&got).Error; err != nil {
		t.Fatalf("read quota: %v", err)
	}
	return got
}

func TestTryAcquireSlotForModify_FromActive_PersistsFlowAndTarget(t *testing.T) {
	setupSQLite(t)
	dao := pass.NewDao()

	if err := dao.Create(newModifyTestPass("p-m-1", "bundle_launch_01", pass.StatusActive)); err != nil {
		t.Fatalf("seed pass: %v", err)
	}

	acquired, err := dao.TryAcquireSlotForModify("p-m-1", 4242, "bundle_launch_01", "bundle_cruise_01")
	if err != nil {
		t.Fatalf("TryAcquireSlotForModify err: %v", err)
	}
	if !acquired {
		t.Fatalf("expected acquired=true from active")
	}

	got, err := dao.GetByPassID("p-m-1")
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if got.Status != pass.StatusModifying {
		t.Fatalf("status = %s, want modifying", got.Status)
	}
	// flow id 和 target 必须同时落盘：受理入口靠它们判断"同一笔单重投"。
	if got.ModifyFlowID != 4242 {
		t.Fatalf("modify_flow_id = %d, want 4242", got.ModifyFlowID)
	}
	if got.ModifyTargetBundleID != "bundle_cruise_01" {
		t.Fatalf("modify_target_bundle_id = %q, want bundle_cruise_01", got.ModifyTargetBundleID)
	}
	// bundle_id 此刻不能动：权益要等实例全部升配完成才提交。
	if got.BundleID != "bundle_launch_01" {
		t.Fatalf("bundle_id changed too early: %q", got.BundleID)
	}
}

func TestTryAcquireSlotForModify_DoesNotReacquireCompletedTarget(t *testing.T) {
	setupSQLite(t)
	dao := pass.NewDao()
	if err := dao.Create(newModifyTestPass("p-completed", "bundle_cruise_01", pass.StatusActive)); err != nil {
		t.Fatal(err)
	}
	acquired, err := dao.TryAcquireSlotForModify("p-completed", 47, "bundle_launch_01", "bundle_cruise_01")
	if err != nil {
		t.Fatal(err)
	}
	if acquired {
		t.Fatal("stale source observation reacquired already completed target")
	}
	p, err := dao.GetByPassID("p-completed")
	if err != nil || p.Status != pass.StatusActive || p.ModifyFlowID != 0 {
		t.Fatalf("completed Pass mutated: %+v, %v", p, err)
	}
}

func TestTryAcquireSlotForModify_NonActiveRejected(t *testing.T) {
	for _, status := range []string{
		pass.StatusModifying,
		pass.StatusIsolating,
		pass.StatusIsolated,
		pass.StatusRenewing,
		pass.StatusDeleting,
		pass.StatusTerminating,
	} {
		t.Run(status, func(t *testing.T) {
			setupSQLite(t)
			dao := pass.NewDao()
			if err := dao.Create(newModifyTestPass("p-m", "bundle_launch_01", status)); err != nil {
				t.Fatalf("seed pass: %v", err)
			}
			acquired, err := dao.TryAcquireSlotForModify("p-m", 1, "bundle_launch_01", "bundle_cruise_01")
			if err != nil {
				t.Fatalf("TryAcquireSlotForModify err: %v", err)
			}
			if acquired {
				t.Fatalf("expected acquired=false for status=%s", status)
			}
			got, _ := dao.GetByPassID("p-m")
			if got.Status != status {
				t.Fatalf("status leaked from %s to %s", status, got.Status)
			}
			if got.ModifyFlowID != 0 {
				t.Fatalf("modify_flow_id leaked: %d", got.ModifyFlowID)
			}
		})
	}
}

func TestTryAcquireSlotForModify_MissingArgsRejected(t *testing.T) {
	setupSQLite(t)
	dao := pass.NewDao()

	cases := []struct {
		name           string
		passID         string
		flowID         int64
		targetBundleID string
	}{
		{"empty pass id", "", 1, "bundle_cruise_01"},
		{"zero flow id", "p-m", 0, "bundle_cruise_01"},
		{"empty target", "p-m", 1, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := dao.TryAcquireSlotForModify(tc.passID, tc.flowID, "bundle_launch_01", tc.targetBundleID); err == nil {
				t.Fatalf("expected error for %s", tc.name)
			}
		})
	}
	if _, err := dao.TryAcquireSlotForModify("p-m", 1, "", "bundle_cruise_01"); err == nil {
		t.Fatal("empty source must be rejected")
	}
	if _, err := dao.TryAcquireSlotForModify("p-m", 1, "bundle_cruise_01", "bundle_cruise_01"); err == nil {
		t.Fatal("identical source and target must be rejected")
	}
}

func TestFinalizeModify_CommitsBundleAndQuotaInOneTx(t *testing.T) {
	setupSQLite(t)
	dao := pass.NewDao()

	entity := newModifyTestPass("p-f-1", "bundle_launch_01", pass.StatusModifying)
	entity.ModifyFlowID = 777
	entity.ModifyTargetBundleID = "bundle_cruise_01"
	if err := dao.Create(entity); err != nil {
		t.Fatalf("seed pass: %v", err)
	}
	// 启航 total=1，用户已开出 1 台（available=0）。
	seedModifyQuota(t, entity.UserID, 1, 0)

	taskID := seedModifyTask(t, entity, 777)
	finalized, err := dao.FinalizeModify("p-f-1", 777, "bundle_cruise_01", entity.UserID, 3, taskID)
	if err != nil {
		t.Fatalf("FinalizeModify err: %v", err)
	}
	if !finalized {
		t.Fatalf("expected finalized=true")
	}
	assertModifyFinalizedMarker(t, taskID, true)

	got, err := dao.GetByPassID("p-f-1")
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if got.Status != pass.StatusActive {
		t.Fatalf("status = %s, want active", got.Status)
	}
	if got.BundleID != "bundle_cruise_01" {
		t.Fatalf("bundle_id = %q, want bundle_cruise_01", got.BundleID)
	}
	// 中间字段必须清空：残留的 flow id 会让下一笔变配被误判成"重投"。
	if got.ModifyFlowID != 0 || got.ModifyTargetBundleID != "" {
		t.Fatalf("modify fields not cleared: flow=%d target=%q", got.ModifyFlowID, got.ModifyTargetBundleID)
	}

	// 替换语义：total 1 → 3，available 平移 +2，已占用的 1 台继续计入。
	q := readModifyQuota(t, entity.UserID)
	if q.ResourceQuotaTotal != 3 {
		t.Fatalf("quota total = %d, want 3", q.ResourceQuotaTotal)
	}
	if q.ResourceQuotaAvailable != 2 {
		t.Fatalf("quota available = %d, want 2", q.ResourceQuotaAvailable)
	}
}

func TestFinalizeModify_WrongFlowIDIsNoop(t *testing.T) {
	setupSQLite(t)
	dao := pass.NewDao()

	entity := newModifyTestPass("p-f-2", "bundle_launch_01", pass.StatusModifying)
	entity.ModifyFlowID = 777
	entity.ModifyTargetBundleID = "bundle_cruise_01"
	if err := dao.Create(entity); err != nil {
		t.Fatalf("seed pass: %v", err)
	}
	seedModifyQuota(t, entity.UserID, 1, 1)

	// 另一笔 flow 来收尾：CAS 影响 0 行，套餐和配额都不能动。
	taskID := seedModifyTask(t, entity, 888)
	finalized, err := dao.FinalizeModify("p-f-2", 888, "bundle_cruise_01", entity.UserID, 3, taskID)
	if err != nil {
		t.Fatalf("FinalizeModify err: %v", err)
	}
	if finalized {
		t.Fatalf("expected finalized=false for mismatched flow id")
	}
	assertModifyFinalizedMarker(t, taskID, false)

	got, _ := dao.GetByPassID("p-f-2")
	if got.Status != pass.StatusModifying || got.BundleID != "bundle_launch_01" {
		t.Fatalf("pass mutated: status=%s bundle=%s", got.Status, got.BundleID)
	}
	if q := readModifyQuota(t, entity.UserID); q.ResourceQuotaTotal != 1 {
		t.Fatalf("quota mutated: total=%d", q.ResourceQuotaTotal)
	}
}

func TestFinalizeModify_RepeatedCallIsIdempotent(t *testing.T) {
	setupSQLite(t)
	dao := pass.NewDao()

	entity := newModifyTestPass("p-f-3", "bundle_launch_01", pass.StatusModifying)
	entity.ModifyFlowID = 999
	entity.ModifyTargetBundleID = "bundle_cruise_01"
	if err := dao.Create(entity); err != nil {
		t.Fatalf("seed pass: %v", err)
	}
	seedModifyQuota(t, entity.UserID, 1, 1)

	taskID := seedModifyTask(t, entity, 999)
	if _, err := dao.FinalizeModify("p-f-3", 999, "bundle_cruise_01", entity.UserID, 3, taskID); err != nil {
		t.Fatalf("first FinalizeModify: %v", err)
	}
	// 父 task 重投：第二次必须是 no-op，尤其不能把配额再加一遍。
	finalized, err := dao.FinalizeModify("p-f-3", 999, "bundle_cruise_01", entity.UserID, 3, taskID)
	if err != nil {
		t.Fatalf("second FinalizeModify: %v", err)
	}
	if finalized {
		t.Fatalf("expected finalized=false on repeat")
	}
	if q := readModifyQuota(t, entity.UserID); q.ResourceQuotaTotal != 3 || q.ResourceQuotaAvailable != 3 {
		t.Fatalf("quota double-applied: total=%d available=%d", q.ResourceQuotaTotal, q.ResourceQuotaAvailable)
	}
}

func TestFinalizeModify_QuotaRowMissingRollsBackPass(t *testing.T) {
	// 配额行缺失说明数据异常。此时宁可整体回滚保持 modifying 让人工介入，
	// 也不能留下"套餐已升但配额没跟上"的中间态——用户会付了钱却开不出机器。
	setupSQLite(t)
	dao := pass.NewDao()

	entity := newModifyTestPass("p-f-4", "bundle_launch_01", pass.StatusModifying)
	entity.ModifyFlowID = 555
	entity.ModifyTargetBundleID = "bundle_cruise_01"
	if err := dao.Create(entity); err != nil {
		t.Fatalf("seed pass: %v", err)
	}

	taskID := seedModifyTask(t, entity, 555)
	if _, err := dao.FinalizeModify("p-f-4", 555, "bundle_cruise_01", entity.UserID, 3, taskID); err == nil {
		t.Fatalf("expected error when quota row is missing")
	}
	assertModifyFinalizedMarker(t, taskID, false)

	got, _ := dao.GetByPassID("p-f-4")
	if got.Status != pass.StatusModifying {
		t.Fatalf("pass status = %s, want modifying (tx should roll back)", got.Status)
	}
	if got.BundleID != "bundle_launch_01" {
		t.Fatalf("bundle_id = %q, want unchanged (tx should roll back)", got.BundleID)
	}
}

func TestFinalizeModify_ReceiptWriteFailureRollsBackPassAndQuota(t *testing.T) {
	setupSQLite(t)
	dao := pass.NewDao()
	p := newModifyTestPass("p-receipt-rollback", "bundle_launch_01", pass.StatusModifying)
	p.ModifyFlowID = 777
	p.ModifyTargetBundleID = "bundle_cruise_01"
	if err := dao.Create(p); err != nil {
		t.Fatal(err)
	}
	seedModifyQuota(t, p.UserID, 1, 0)
	taskID := seedModifyTask(t, p, p.ModifyFlowID)
	if err := dao.DB().Exec("CREATE TRIGGER reject_receipt BEFORE UPDATE OF task_params ON tasks BEGIN SELECT RAISE(ABORT, 'injected receipt write failure'); END").Error; err != nil {
		t.Fatal(err)
	}
	if _, err := dao.FinalizeModify(p.PassID, p.ModifyFlowID, p.ModifyTargetBundleID, p.UserID, 3, taskID); err == nil {
		t.Fatal("expected injected receipt persistence failure")
	}
	got, err := dao.GetByPassID(p.PassID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != pass.StatusModifying || got.BundleID != p.BundleID || !got.ExpiredTime.Equal(p.ExpiredTime) || got.ModifyFlowID != p.ModifyFlowID {
		t.Fatal("receipt failure did not roll back Pass")
	}
	if q := readModifyQuota(t, p.UserID); q.ResourceQuotaTotal != 1 || q.ResourceQuotaAvailable != 0 {
		t.Fatal("receipt failure did not roll back quota")
	}
	assertModifyFinalizedMarker(t, taskID, false)
}
