package instance

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	psandbox "ctl/pkg/adapter/sandbox"
	pctx "ctl/pkg/context"
	"ctl/pkg/errcode"
	modelinstance "ctl/pkg/model/instance"
	taskmodel "ctl/pkg/model/task"
	"ctl/pkg/taskruntime/common"
	"ctl/test/testutil"

	"go.uber.org/zap"
)

func TestUpdateModifyPassPayloadPreservesFinalizedReceipt(t *testing.T) {
	db := testutil.NewSQLiteDB(t, &taskmodel.Entity{})
	entity := &taskmodel.Entity{TaskId: "t-receipt-merge", TaskName: common.TaskNameModifyPass,
		TaskParams: `{"pass_id":"p-receipt","subscription_done":true,"entitlements_finalized":true,"future_field":{"keep":1}}`}
	if err := db.Create(entity).Error; err != nil {
		t.Fatal(err)
	}
	for _, done := range []bool{false, true} {
		if err := UpdateModifyPassPayload(pctx.NewContext(nil), entity.TaskId, &ModifyPassTaskPayload{PassID: "p-receipt", SubscriptionDone: done}); err != nil {
			t.Fatal(err)
		}
	}
	var got taskmodel.Entity
	if err := db.First(&got, "task_id = ?", entity.TaskId).Error; err != nil {
		t.Fatal(err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal([]byte(got.TaskParams), &fields); err != nil {
		t.Fatal(err)
	}
	if string(fields["entitlements_finalized"]) != "true" || string(fields["subscription_done"]) != "true" || string(fields["future_field"]) != `{"keep":1}` {
		t.Fatal("stale progress writer erased a committed receipt or unknown field")
	}
}

type modifyInstanceDaoStub struct {
	modelinstance.Dao
	entity *modelinstance.Entity
	getErr error
}

func (s *modifyInstanceDaoStub) GetByInstanceID(_ pctx.Context, _ string) (*modelinstance.Entity, error) {
	if s.getErr != nil {
		return nil, s.getErr
	}
	return s.entity, nil
}

type modifyTaskDaoStub struct {
	taskmodel.Dao
	updates []map[string]interface{}
	err     error
}

func (s *modifyTaskDaoStub) UpdateByKeyColumn(updates map[string]interface{}, _ ...interface{}) error {
	if s.err != nil {
		return s.err
	}
	s.updates = append(s.updates, updates)
	return nil
}

type modifySandboxAdapterStub struct {
	psandbox.Adapter
	modifyResp *psandbox.ModifyOperation
	modifyErr  error
	modifyReqs []psandbox.ModifyRequest
	getResp    *psandbox.ModifyOperation
	getErr     error
	getCalls   int
}

func (s *modifySandboxAdapterStub) Modify(
	_ context.Context,
	_ string,
	req *psandbox.ModifyRequest,
) (*psandbox.ModifyOperation, error) {
	if req != nil {
		s.modifyReqs = append(s.modifyReqs, *req)
	}
	if s.modifyErr != nil {
		return nil, s.modifyErr
	}
	return s.modifyResp, nil
}

func (s *modifySandboxAdapterStub) GetModifyOperation(
	_ context.Context,
	_ string,
) (*psandbox.ModifyOperation, error) {
	s.getCalls++
	if s.getErr != nil {
		return nil, s.getErr
	}
	return s.getResp, nil
}

func newModifyTaskLogic(dao *modifyInstanceDaoStub, sandbox *modifySandboxAdapterStub, tasks *modifyTaskDaoStub) *logic {
	return &logic{
		instanceDao:    dao,
		sandboxAdapter: sandbox,
		taskDao:        tasks,
		logger:         zap.NewNop(),
	}
}

func runningInstance() *modifyInstanceDaoStub {
	return &modifyInstanceDaoStub{entity: &modelinstance.Entity{
		Id:         1,
		InstanceId: "ins-modify-1",
		SandboxId:  "sbx-modify-1",
		Status:     modelinstance.InstanceStatusRunning,
	}}
}

func modifyPayload() *common.ModifyInstanceTaskPayload {
	return &common.ModifyInstanceTaskPayload{
		InstanceID:   "ins-modify-1",
		PassID:       "pass-1",
		TargetPoolID: "pool-4c8g80g",
		TargetSKUID:  "sku-hermes-4c8g",
	}
}

// 阶段 1 的核心不变量：operation_id 必须在返回轮询等待之前落盘，否则下一轮重投会对
// 同一块系统盘发第二次扩容。
func TestRunModifyInstanceTaskPersistsOperationIDBeforeWaiting(t *testing.T) {
	sandbox := &modifySandboxAdapterStub{modifyResp: &psandbox.ModifyOperation{
		OperationID: "mop-1",
		Status:      psandbox.ModifyOperationStatusRunning,
	}}
	tasks := &modifyTaskDaoStub{}
	l := newModifyTaskLogic(runningInstance(), sandbox, tasks)
	payload := modifyPayload()

	err := l.RunModifyInstanceTask(pctx.NewContext(context.Background()), "task-1", payload)
	if !errors.Is(err, modifyPollWaitErr) {
		t.Fatalf("err = %v, want poll wait", err)
	}
	if payload.SandboxOperationID != "mop-1" {
		t.Fatalf("payload operation id = %q, want mop-1", payload.SandboxOperationID)
	}
	if len(tasks.updates) != 1 {
		t.Fatalf("task payload persisted %d times, want 1", len(tasks.updates))
	}
	if len(sandbox.modifyReqs) != 1 || sandbox.modifyReqs[0].IdempotencyKey != "task-1" {
		t.Fatalf("unexpected modify requests: %+v", sandbox.modifyReqs)
	}
	if sandbox.modifyReqs[0].TargetPoolID != "pool-4c8g80g" || sandbox.modifyReqs[0].TargetSKUID != "sku-hermes-4c8g" {
		t.Fatalf("target not forwarded verbatim: %+v", sandbox.modifyReqs[0])
	}
}

// 落盘失败时不能吞错：一旦把 poll wait 当成功返回，operation_id 就永久丢失。
func TestRunModifyInstanceTaskFailsWhenOperationIDCannotPersist(t *testing.T) {
	sandbox := &modifySandboxAdapterStub{modifyResp: &psandbox.ModifyOperation{OperationID: "mop-1"}}
	tasks := &modifyTaskDaoStub{err: errors.New("db down")}
	l := newModifyTaskLogic(runningInstance(), sandbox, tasks)

	err := l.RunModifyInstanceTask(pctx.NewContext(context.Background()), "task-1", modifyPayload())
	if err == nil || errors.Is(err, modifyPollWaitErr) {
		t.Fatalf("err = %v, want persist failure", err)
	}
}

// payload 已带 operation_id 时只能轮询，绝不能再发一次 Modify。
func TestRunModifyInstanceTaskPollsExistingOperation(t *testing.T) {
	cases := []struct {
		name      string
		op        *psandbox.ModifyOperation
		wantWait  bool
		wantError bool
	}{
		{
			name:     "completed",
			op:       &psandbox.ModifyOperation{OperationID: "mop-1", Status: psandbox.ModifyOperationStatusCompleted},
			wantWait: false,
		},
		{
			name:     "running",
			op:       &psandbox.ModifyOperation{OperationID: "mop-1", Status: psandbox.ModifyOperationStatusRunning, CurrentStep: "resize_disk"},
			wantWait: true,
		},
		{
			name:      "failed",
			op:        &psandbox.ModifyOperation{OperationID: "mop-1", Status: psandbox.ModifyOperationStatusFailed, CurrentStep: "resize_disk", LastError: "cbs quota"},
			wantError: true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			sandbox := &modifySandboxAdapterStub{getResp: tc.op}
			l := newModifyTaskLogic(runningInstance(), sandbox, &modifyTaskDaoStub{})
			payload := modifyPayload()
			payload.SandboxOperationID = "mop-1"

			err := l.RunModifyInstanceTask(pctx.NewContext(context.Background()), "task-1", payload)
			switch {
			case tc.wantWait && !errors.Is(err, modifyPollWaitErr):
				t.Fatalf("err = %v, want poll wait", err)
			case tc.wantError && (err == nil || errors.Is(err, modifyPollWaitErr) || errors.Is(err, ErrModifyPermanentFailed)):
				// sandbox 的 failed 是终态，但这里保持可重试：耗尽窗口后父 task 会用
				// 新 task ID 重派，从而拿到一份新账本继续前滚。
				t.Fatalf("err = %v, want retryable failure", err)
			case !tc.wantWait && !tc.wantError && err != nil:
				t.Fatalf("err = %v, want success", err)
			}
			if sandbox.getCalls != 1 {
				t.Fatalf("GetModifyOperation calls = %d, want 1", sandbox.getCalls)
			}
			if len(sandbox.modifyReqs) != 0 {
				t.Fatalf("re-issued Modify on a live operation: %+v", sandbox.modifyReqs)
			}
		})
	}
}

// sandbox 的三个 modify 错误码分别对应"已收敛/永久失败/可重试"，误判会让永不放弃的
// 父 task 空转或让已完成的升配被判失败。
func TestRunModifyInstanceTaskClassifiesSandboxErrors(t *testing.T) {
	cases := []struct {
		name          string
		err           error
		wantSuccess   bool
		wantPermanent bool
	}{
		{
			name:        "already applied is convergence",
			err:         errors.New("status conflict: MODIFY_TARGET_ALREADY_APPLIED: spec already applied"),
			wantSuccess: true,
		},
		{
			name:          "ledger conflict is permanent",
			err:           errors.New("status conflict: MODIFY_OPERATION_CONFLICT: key reused"),
			wantPermanent: true,
		},
		{
			name:          "downgrade is permanent",
			err:           errors.New("unprocessable: MODIFY_TARGET_NOT_UPGRADE: target is smaller"),
			wantPermanent: true,
		},
		{
			name: "transport error stays retryable",
			err:  errors.New("dial tcp: connection refused"),
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			sandbox := &modifySandboxAdapterStub{modifyErr: tc.err}
			l := newModifyTaskLogic(runningInstance(), sandbox, &modifyTaskDaoStub{})

			err := l.RunModifyInstanceTask(pctx.NewContext(context.Background()), "task-1", modifyPayload())
			switch {
			case tc.wantSuccess:
				if err != nil {
					t.Fatalf("err = %v, want success", err)
				}
			case tc.wantPermanent:
				if !errors.Is(err, ErrModifyPermanentFailed) {
					t.Fatalf("err = %v, want permanent failure", err)
				}
			default:
				if err == nil || errors.Is(err, ErrModifyPermanentFailed) {
					t.Fatalf("err = %v, want retryable failure", err)
				}
			}
		})
	}
}

// 缺 payload 关键字段时立即终态失败，而不是耗尽一小时重试窗口。
func TestRunModifyInstanceTaskRejectsIncompletePayload(t *testing.T) {
	l := newModifyTaskLogic(runningInstance(), &modifySandboxAdapterStub{}, &modifyTaskDaoStub{})
	ctx := pctx.NewContext(context.Background())

	cases := map[string]struct {
		taskID  string
		payload *common.ModifyInstanceTaskPayload
	}{
		"nil payload":    {taskID: "task-1", payload: nil},
		"no instance":    {taskID: "task-1", payload: &common.ModifyInstanceTaskPayload{TargetPoolID: "pool-1"}},
		"no target pool": {taskID: "task-1", payload: &common.ModifyInstanceTaskPayload{InstanceID: "ins-1"}},
		"no idempotency key": {taskID: "", payload: &common.ModifyInstanceTaskPayload{
			InstanceID: "ins-1", TargetPoolID: "pool-1",
		}},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			if err := l.RunModifyInstanceTask(ctx, tc.taskID, tc.payload); !errors.Is(err, ErrModifyPermanentFailed) {
				t.Fatalf("err = %v, want permanent failure", err)
			}
		})
	}
}

// 实例已经不在了或没有云资源可升配时，套餐级权益仍由父 task 升级，子 task 不该卡住流程。
func TestRunModifyInstanceTaskNoOpCases(t *testing.T) {
	ctx := pctx.NewContext(context.Background())
	cases := map[string]*modifyInstanceDaoStub{
		"instance deleted mid-flight": {getErr: errcode.ErrInstanceNotFound},
		"terminal state": {entity: &modelinstance.Entity{
			InstanceId: "ins-modify-1", SandboxId: "sbx-modify-1", Status: modelinstance.InstanceStatusDeleted,
		}},
		"no sandbox bound": {entity: &modelinstance.Entity{
			InstanceId: "ins-modify-1", Status: modelinstance.InstanceStatusRunning,
		}},
	}
	for name, dao := range cases {
		t.Run(name, func(t *testing.T) {
			sandbox := &modifySandboxAdapterStub{}
			l := newModifyTaskLogic(dao, sandbox, &modifyTaskDaoStub{})
			if err := l.RunModifyInstanceTask(ctx, "task-1", modifyPayload()); err != nil {
				t.Fatalf("err = %v, want no-op success", err)
			}
			if len(sandbox.modifyReqs) != 0 {
				t.Fatalf("unexpected sandbox calls: %+v", sandbox.modifyReqs)
			}
		})
	}
}

// 实例正处于别的操作中间态（创建/暂停/删除）时不能动规格，但这是暂态错，可重试。
func TestRunModifyInstanceTaskWaitsForUnstableInstance(t *testing.T) {
	dao := &modifyInstanceDaoStub{entity: &modelinstance.Entity{
		InstanceId: "ins-modify-1", SandboxId: "sbx-modify-1", Status: modelinstance.InstanceStatusPaused,
	}}
	sandbox := &modifySandboxAdapterStub{}
	l := newModifyTaskLogic(dao, sandbox, &modifyTaskDaoStub{})

	err := l.RunModifyInstanceTask(pctx.NewContext(context.Background()), "task-1", modifyPayload())
	if err == nil || errors.Is(err, ErrModifyPermanentFailed) {
		t.Fatalf("err = %v, want retryable failure", err)
	}
	if len(sandbox.modifyReqs) != 0 {
		t.Fatalf("unexpected sandbox calls: %+v", sandbox.modifyReqs)
	}
}
