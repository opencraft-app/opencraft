package pass

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	pctx "ctl/pkg/context"
	modelinstance "ctl/pkg/model/instance"
	modelpass "ctl/pkg/model/pass"
	taskmodel "ctl/pkg/model/task"
	taskcommon "ctl/pkg/taskruntime/common"
	"ctl/test/testutil"

	"go.uber.org/zap"
)

func TestFinalizedModifyWorkerResumesOnlyCallbackFromDurableReceipt(t *testing.T) {
	for _, mode := range []string{"execute", "lock_fallback"} {
		for _, state := range []string{modelpass.StatusRenewing, modelpass.StatusIsolated, "deleted"} {
			t.Run(mode+"/"+state, func(t *testing.T) {
				db := testutil.NewSQLiteDB(t, &taskmodel.Entity{}, &modelpass.Entity{})
				payload := taskcommon.ModifyPassTaskPayload{PassID: "p-durable", UserID: "u-durable",
					SourceBundleID: "bundle_launch_01", TargetBundleID: "bundle_cruise_01",
					TradeFlowID: 71, DealName: "deal-durable", SubscriptionDone: true, EntitlementsFinalized: true}
				body, _ := json.Marshal(payload)
				entity := &taskmodel.Entity{TaskId: "t-durable", TaskName: taskcommon.TaskNameModifyPass, TaskState: taskmodel.StateRunning, TaskParams: string(body)}
				entity.UserID = payload.UserID
				if err := db.Create(entity).Error; err != nil {
					t.Fatal(err)
				}
				if state != "deleted" {
					p := &modelpass.Entity{PassID: payload.PassID, UserID: payload.UserID, Status: state, BundleID: "later-bundle"}
					if err := db.Create(p).Error; err != nil {
						t.Fatal(err)
					}
				}
				task := newModifyPassTask()
				task.TaskId, task.TaskEntity = entity.TaskId, entity
				// Simulate an old MQ message: only the durable DB copy has marker.
				payload.EntitlementsFinalized = false
				task.in = &payload
				calls := 0
				task.completeFlow = func(_ context.Context, flowID int64, result, _ string) error {
					calls++
					if flowID != 71 || result != "completed" {
						t.Fatal("callback did not use original flow")
					}
					if calls == 1 {
						return errors.New("temporary callback failure")
					}
					return nil
				}
				run := task.execute
				if mode == "lock_fallback" {
					run = task.idempotentCheck
				}
				if _, err := run(pctx.NewContext(nil)); err == nil {
					t.Fatal("callback failure must stay retryable")
				}
				if _, err := run(pctx.NewContext(nil)); err != nil {
					t.Fatalf("durable receipt resume: %v", err)
				}
				if calls != 2 || task.TaskEntity.TaskState != taskmodel.StateSuccess {
					t.Fatal("callback retry did not finish original task")
				}
				// No bundle/instance/quota tables exist, so success also proves the
				// worker skipped entitlement and cloud-dispatch paths entirely.
				var got taskmodel.Entity
				if err := db.First(&got, "task_id = ?", entity.TaskId).Error; err != nil || got.TaskParams != string(body) {
					t.Fatalf("receipt changed after callback: %v", err)
				}
			})
		}
	}
}

func modifyChild(id int64, taskID, instanceID, state string) *taskmodel.Entity {
	params, _ := json.Marshal(taskcommon.ModifyInstanceTaskPayload{InstanceID: instanceID})
	ct := &taskmodel.Entity{
		TaskId:     taskID,
		TaskName:   taskcommon.TaskNameModifyInstance,
		TaskParams: string(params),
		TaskState:  state,
	}
	ct.Id = &id
	return ct
}

// VelaGW 订阅的幂等键必须绑定订单而不是绑定 task（§7.2 指定 modify:{dealName}）。
//
// 父 task 会被重投、子 task 会被重派，task id 每轮都变；用 task id 当幂等键等于
// 每次重试都是一次"新"的订阅申请，用户会拿到多份积分。
func TestSubscriptionIdempotencyKeyBindsToTheOrder(t *testing.T) {
	withDeal := &modifyPassTask{in: &taskcommon.ModifyPassTaskPayload{
		DealName: "deal-123", TradeFlowID: 9001,
	}}
	if got := withDeal.subscriptionIdempotencyKey(); got != "modify:deal-123" {
		t.Errorf("key = %q, want modify:deal-123", got)
	}

	// dev/test 直连不带 dealName，退回 flow id 仍能保证同一笔变配只切一次订阅。
	withoutDeal := &modifyPassTask{in: &taskcommon.ModifyPassTaskPayload{TradeFlowID: 9001}}
	if got := withoutDeal.subscriptionIdempotencyKey(); got != "modify:flow-9001" {
		t.Errorf("fallback key = %q, want modify:flow-9001", got)
	}
	if withDeal.subscriptionIdempotencyKey() == withoutDeal.subscriptionIdempotencyKey() {
		t.Error("dealName and flow-id keys must not collide")
	}
}

func TestNotifyModifyFlowCompletedReturnsErrorForParentRetry(t *testing.T) {
	wantErr := errors.New("trade unavailable")
	task := &modifyPassTask{
		in: &taskcommon.ModifyPassTaskPayload{TradeFlowID: 9001},
		completeFlow: func(_ context.Context, flowID int64, result, _ string) error {
			if flowID != 9001 || result != "completed" {
				t.Fatalf("unexpected CompleteFlow args: flowID=%d result=%q", flowID, result)
			}
			return wantErr
		},
	}

	err := task.notifyModifyFlowCompleted(zap.NewNop())
	if !errors.Is(err, wantErr) {
		t.Fatalf("err=%v, want wrapped %v", err, wantErr)
	}
}

func TestNotifyModifyFlowCompletedSkipsDevFlow(t *testing.T) {
	called := false
	task := &modifyPassTask{
		in: &taskcommon.ModifyPassTaskPayload{TradeFlowID: 0},
		completeFlow: func(context.Context, int64, string, string) error {
			called = true
			return nil
		},
	}
	if err := task.notifyModifyFlowCompleted(zap.NewNop()); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if called {
		t.Fatal("CompleteFlow must not be called for flowID=0")
	}
}

// 失败重派会给同一实例留下多份子 task。只有最新那份能代表实例现状——把历史失败
// 也算进去，父 task 就永远提交不了权益，pass 会永久停在 modifying。
func TestLatestModifyChildPerInstancePrefersTheNewestAttempt(t *testing.T) {
	children := []*taskmodel.Entity{
		modifyChild(10, "task-a-1", "ins-a", taskmodel.StateFailed),
		modifyChild(11, "task-a-2", "ins-a", taskmodel.StateSuccess),
		modifyChild(12, "task-b-1", "ins-b", taskmodel.StateRunning),
	}
	// task_id 不是单调序列，所以顺序不能作为新旧依据。
	shuffled := []*taskmodel.Entity{children[1], children[2], children[0]}

	latest := latestModifyChildPerInstance(shuffled, zap.NewNop())
	if len(latest) != 2 {
		t.Fatalf("instances tracked = %d, want 2: %+v", len(latest), latest)
	}
	if got := latest["ins-a"].TaskId; got != "task-a-2" {
		t.Fatalf("ins-a latest = %s, want the replacement task-a-2", got)
	}
	if got := latest["ins-b"].TaskId; got != "task-b-1" {
		t.Fatalf("ins-b latest = %s, want task-b-1", got)
	}
}

func modifyInstance(id, status string) *modelinstance.Entity {
	return &modelinstance.Entity{InstanceId: id, Status: status}
}

// TestAdvanceInstancesSkipsSandboxWhenPassHasNoInstance 覆盖 §10.1 的零实例升配。
//
// 买了套餐还没开机是正常场景，这时升配只该动套餐级权益。本用例故意**不**准备
// sandbox adapter：一旦零实例没被短路，就会走到 ResolveModifyTargetPool 并因为
// adapter 工厂未初始化直接 panic。所以这条 nil 断言是真的在守"跳过 Sandbox"，
// 而不是读代码读出来的结论。
func TestAdvanceInstancesSkipsSandboxWhenPassHasNoInstance(t *testing.T) {
	testutil.NewSQLiteDB(t, &modelinstance.Entity{}, &taskmodel.Entity{})

	task := &modifyPassTask{in: &taskcommon.ModifyPassTaskPayload{
		PassID:         "p-noinst",
		TargetBundleID: "bundle_cruise_01",
	}}
	err := task.advanceInstances(
		pctx.NewContext(context.Background()),
		zap.NewNop(),
		"user-with-no-instance",
		"spec-4c8g80g",
	)
	if err != nil {
		t.Fatalf("advanceInstances = %v, want nil: zero instances must skip the sandbox step entirely", err)
	}
}

// assessModifyChildren 是"能不能切权益"的唯一闸口（§10.1）。
//
// 判宽了的后果是资损方向的：一台还停在 2C4G 的机器会被按巡游档位计费和使用。
// 判严了只是多转一轮父 task，所以每个非"全部成功"的形态都必须拦下来。
func TestAssessModifyChildrenHoldsEntitlementUnlessEveryInstanceSucceeded(t *testing.T) {
	live := []*modelinstance.Entity{
		modifyInstance("ins-a", modelinstance.InstanceStatusRunning),
		modifyInstance("ins-b", modelinstance.InstanceStatusRunning),
	}

	cases := []struct {
		name        string
		instances   []*modelinstance.Entity
		dispatched  map[string]*taskmodel.Entity
		wantPending int
		wantFailed  int
	}{
		{
			name:      "全部成功才放行",
			instances: live,
			dispatched: map[string]*taskmodel.Entity{
				"ins-a": modifyChild(10, "task-a", "ins-a", taskmodel.StateSuccess),
				"ins-b": modifyChild(11, "task-b", "ins-b", taskmodel.StateSuccess),
			},
		},
		{
			name:      "一台失败：整体拦下",
			instances: live,
			dispatched: map[string]*taskmodel.Entity{
				"ins-a": modifyChild(10, "task-a", "ins-a", taskmodel.StateSuccess),
				"ins-b": modifyChild(11, "task-b", "ins-b", taskmodel.StateFailed),
			},
			wantFailed: 1,
		},
		{
			name:      "一台还在跑：等",
			instances: live,
			dispatched: map[string]*taskmodel.Entity{
				"ins-a": modifyChild(10, "task-a", "ins-a", taskmodel.StateSuccess),
				"ins-b": modifyChild(11, "task-b", "ins-b", taskmodel.StateRunning),
			},
			wantPending: 1,
		},
		{
			name:        "一台没派发出去：等下一轮补",
			instances:   live,
			dispatched:  map[string]*taskmodel.Entity{"ins-a": modifyChild(10, "task-a", "ins-a", taskmodel.StateSuccess)},
			wantPending: 1,
		},
		{
			// 终态实例不会再被升配。把它们算进 pending，pass 会永久卡在 modifying。
			name: "Deleted / Failed 实例不参与判定",
			instances: []*modelinstance.Entity{
				modifyInstance("ins-a", modelinstance.InstanceStatusRunning),
				modifyInstance("ins-gone", modelinstance.InstanceStatusDeleted),
				modifyInstance("ins-bad", modelinstance.InstanceStatusFailed),
			},
			dispatched: map[string]*taskmodel.Entity{
				"ins-a": modifyChild(10, "task-a", "ins-a", taskmodel.StateSuccess),
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			pending, failed := assessModifyChildren(tc.instances, tc.dispatched)
			if pending != tc.wantPending {
				t.Errorf("pending = %d, want %d", pending, tc.wantPending)
			}
			if len(failed) != tc.wantFailed {
				t.Errorf("failed = %v, want %d entries", failed, tc.wantFailed)
			}
		})
	}
}

func TestLatestModifyChildPerInstanceIgnoresUnusableChildren(t *testing.T) {
	other := modifyChild(20, "task-other", "ins-a", taskmodel.StateSuccess)
	other.TaskName = "SomeOtherTask"
	noInstance := modifyChild(21, "task-empty", "", taskmodel.StateSuccess)
	badPayload := modifyChild(22, "task-bad", "ins-a", taskmodel.StateSuccess)
	badPayload.TaskParams = "{not json"

	latest := latestModifyChildPerInstance(
		[]*taskmodel.Entity{nil, other, noInstance, badPayload},
		zap.NewNop(),
	)
	if len(latest) != 0 {
		t.Fatalf("expected nothing tracked, got %+v", latest)
	}
}
