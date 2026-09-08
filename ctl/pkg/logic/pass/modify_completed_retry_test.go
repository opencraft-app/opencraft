package pass

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"reflect"
	"testing"
	"time"

	passmodel "ctl/pkg/model/pass"
	taskmodel "ctl/pkg/model/task"
	taskcommon "ctl/pkg/taskruntime/common"
	"ctl/pkg/transport"
	"ctl/test/testutil"
)

// Reproduce: CTL finalized the Pass but Trade failed to persist acceptance.
// A retry must reuse the durable parent task, not reject the old source bundle.
func TestAcceptPassModifyCompletedSameFlowUsesDurableReceipt(t *testing.T) {
	for _, state := range []string{taskmodel.StateCreated, taskmodel.StateRunning, taskmodel.StateSuccess} {
		t.Run(state, func(t *testing.T) {
			db := testutil.NewSQLiteDB(t, &passmodel.Entity{}, &taskmodel.Entity{})
			deadline := time.Date(2026, 10, 7, 7, 30, 42, 0, time.UTC)
			p := &passmodel.Entity{PassID: "pass-retry", BundleID: "bundle_cruise_01", Status: passmodel.StatusActive, Uin: 450860000002, AppID: 1374210036, ExpiredTime: deadline}
			p.UserID = "usr-retry"
			if err := db.Create(p).Error; err != nil {
				t.Fatal(err)
			}
			payload := taskcommon.ModifyPassTaskPayload{PassID: p.PassID, UserID: p.UserID, SourceBundleID: "bundle_launch_01", TargetBundleID: p.BundleID, TradeFlowID: 47, DealName: "deal-retry"}
			body, _ := json.Marshal(payload)
			sum := sha256.Sum256([]byte(fmt.Sprintf("%s:%s:%d", taskcommon.TaskNameModifyPass, p.PassID, 47)))
			id := fmt.Sprintf("task-modify-pass-%x", sum[:16])
			task := &taskmodel.Entity{TaskId: id, TaskName: taskcommon.TaskNameModifyPass, TaskParams: string(body), TaskState: state}
			task.UserID = p.UserID
			if err := db.Create(task).Error; err != nil {
				t.Fatal(err)
			}
			req := &transport.PassModifyRequest{CheckPassModifyRequest: transport.CheckPassModifyRequest{SourceBundleID: payload.SourceBundleID, TargetBundleID: payload.TargetBundleID, Uin: p.Uin, AppID: p.AppID, CurDeadline: &deadline}, TradeFlowID: 47, DealName: payload.DealName}
			got, err := (&logic{}).AcceptPassModify(p.PassID, req)
			if err != nil || got != id {
				t.Fatalf("same-flow completed retry got task=%q err=%v, want %q", got, err, id)
			}
			if got, err := (&logic{}).resumeModifyForSameFlow(p.PassID, req, modifyLogger()); err != nil || got != id {
				t.Fatalf("completion racing CAS retry got task=%q err=%v", got, err)
			}
			for _, change := range []func(*transport.PassModifyRequest){
				func(r *transport.PassModifyRequest) { r.TradeFlowID++ },
				func(r *transport.PassModifyRequest) { r.DealName = "different-deal" },
				func(r *transport.PassModifyRequest) { r.Uin++ },
				func(r *transport.PassModifyRequest) { r.SourceBundleID = "different-source" },
			} {
				bad := *req
				change(&bad)
				if _, err := (&logic{}).AcceptPassModify(p.PassID, &bad); err == nil {
					t.Fatal("mismatched receipt accepted")
				}
			}
			var count int64
			db.Model(&taskmodel.Entity{}).Count(&count)
			if count != 1 {
				t.Fatalf("retry created extra task: %d", count)
			}
		})
	}
}

// A completed modify is an immutable fact about its original flow, even when
// the Pass has subsequently renewed, been isolated, or changed bundle. Losing
// Trade acceptance must not turn that historical delivery into a refundable 4xx.
// Encode the proposed durable marker as JSON so this regression compiles before
// the production payload gains the field. This fixture assumes that marker was
// committed atomically with the original FinalizeModify transaction.
func TestAcceptPassModifyFinalizedReceiptSurvivesLaterPassChanges(t *testing.T) {
	for _, tc := range []struct {
		name, status, bundleID string
	}{
		{"renewing", passmodel.StatusRenewing, "bundle_cruise_01"},
		{"isolated", passmodel.StatusIsolated, "bundle_cruise_01"},
		// A later lifecycle operation must not change the meaning of the old
		// receipt; this case does not assert another modify edge is allowed.
		{"later_bundle", passmodel.StatusActive, "bundle_cruise_ai_01"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db := testutil.NewSQLiteDB(t, &passmodel.Entity{}, &taskmodel.Entity{})
			originalDeadline := time.Date(2026, 10, 7, 7, 30, 42, 0, time.UTC)
			p := &passmodel.Entity{PassID: "pass-historical-retry", BundleID: tc.bundleID, Status: tc.status,
				Uin: 450860000002, AppID: 1374210036, ExpiredTime: originalDeadline.AddDate(0, 1, 0)}
			p.UserID = "usr-historical-retry"
			if err := db.Create(p).Error; err != nil {
				t.Fatal(err)
			}
			payload := taskcommon.ModifyPassTaskPayload{PassID: p.PassID, UserID: p.UserID,
				SourceBundleID: "bundle_launch_01", TargetBundleID: "bundle_cruise_01",
				TradeFlowID: 47, DealName: "deal-historical-retry", SubscriptionDone: true}
			body, err := json.Marshal(payload)
			if err != nil {
				t.Fatal(err)
			}
			var fields map[string]interface{}
			if err := json.Unmarshal(body, &fields); err != nil {
				t.Fatal(err)
			}
			fields["entitlements_finalized"] = true
			body, err = json.Marshal(fields)
			if err != nil {
				t.Fatal(err)
			}
			sum := sha256.Sum256([]byte(fmt.Sprintf("%s:%s:%d", taskcommon.TaskNameModifyPass, p.PassID, payload.TradeFlowID)))
			id := fmt.Sprintf("task-modify-pass-%x", sum[:16])
			task := &taskmodel.Entity{TaskId: id, TaskName: taskcommon.TaskNameModifyPass,
				TaskParams: string(body), TaskState: taskmodel.StateRunning}
			task.UserID = p.UserID
			if err := db.Create(task).Error; err != nil {
				t.Fatal(err)
			}
			req := &transport.PassModifyRequest{CheckPassModifyRequest: transport.CheckPassModifyRequest{
				SourceBundleID: payload.SourceBundleID, TargetBundleID: payload.TargetBundleID,
				Uin: p.Uin, AppID: p.AppID, CurDeadline: &originalDeadline},
				TradeFlowID: payload.TradeFlowID, DealName: payload.DealName}
			var before passmodel.Entity
			if err := db.First(&before, "pass_id = ?", p.PassID).Error; err != nil {
				t.Fatal(err)
			}
			for attempt := 0; attempt < 2; attempt++ {
				got, err := (&logic{}).AcceptPassModify(p.PassID, req)
				if err != nil || got != id {
					t.Errorf("attempt %d: delivered original flow must return receipt, not a refundable error: task=%q err=%v; want %q", attempt, got, err, id)
				}
			}
			for name, change := range map[string]func(*transport.PassModifyRequest){
				"flow":   func(r *transport.PassModifyRequest) { r.TradeFlowID++ },
				"deal":   func(r *transport.PassModifyRequest) { r.DealName = "other-deal" },
				"uin":    func(r *transport.PassModifyRequest) { r.Uin++ },
				"app":    func(r *transport.PassModifyRequest) { r.AppID++ },
				"source": func(r *transport.PassModifyRequest) { r.SourceBundleID = "other-source" },
				"target": func(r *transport.PassModifyRequest) { r.TargetBundleID = "other-target" },
			} {
				bad := *req
				change(&bad)
				if _, err := (&logic{}).AcceptPassModify(p.PassID, &bad); err == nil {
					t.Errorf("mismatched %s accepted by historical receipt", name)
				}
			}
			var after passmodel.Entity
			if err := db.First(&after, "pass_id = ?", p.PassID).Error; err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(before, after) {
				t.Error("receipt replay changed Pass state, bundle, expiry, or ownership")
			}
			var tasks []taskmodel.Entity
			if err := db.Find(&tasks).Error; err != nil {
				t.Fatal(err)
			}
			if len(tasks) != 1 || tasks[0].TaskId != id || tasks[0].TaskParams != string(body) || tasks[0].TaskState != taskmodel.StateRunning {
				t.Error("receipt replay created, restarted, or rewrote a task")
			}
			// SubscriptionDone alone is not proof of FinalizeModify. Without the
			// atomic marker, none of these later states may be blindly accepted.
			delete(fields, "entitlements_finalized")
			unfinalized, err := json.Marshal(fields)
			if err != nil {
				t.Fatal(err)
			}
			if err := db.Model(&taskmodel.Entity{}).Where("task_id = ?", id).Update("task_params", string(unfinalized)).Error; err != nil {
				t.Fatal(err)
			}
			if _, err := (&logic{}).AcceptPassModify(p.PassID, req); err == nil {
				t.Error("unfinalized task must not bypass current Pass validation")
			}
		})
	}
}
