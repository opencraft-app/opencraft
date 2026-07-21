package instance

import (
	"context"
	"errors"
	"testing"

	psandbox "ctl/pkg/adapter/sandbox"
	pctx "ctl/pkg/context"
	"ctl/pkg/errcode"
	modelinstance "ctl/pkg/model/instance"
	modelpass "ctl/pkg/model/pass"
	"ctl/pkg/transport"

	"go.uber.org/zap"
)

type resumeTransition struct {
	from []string
	to   string
}

type resumeInstanceDaoStub struct {
	modelinstance.Dao
	entity      *modelinstance.Entity
	transitions []resumeTransition
}

func hasStatus(statuses []string, target string) bool {
	for _, status := range statuses {
		if status == target {
			return true
		}
	}
	return false
}

func (s *resumeInstanceDaoStub) GetByInstanceID(pctx.Context, string) (*modelinstance.Entity, error) {
	return s.entity, nil
}

func (s *resumeInstanceDaoStub) TransitionStatus(_ pctx.Context, _ int64, from []string, to string) error {
	if !hasStatus(from, s.entity.Status) {
		return errcode.ErrInstanceStatusInvalid
	}
	s.transitions = append(s.transitions, resumeTransition{from: append([]string(nil), from...), to: to})
	s.entity.Status = to
	return nil
}

func (s *resumeInstanceDaoStub) UpdateWithStatusPrecondition(_ pctx.Context, _ int64, from []string, updates map[string]interface{}) error {
	if !hasStatus(from, s.entity.Status) {
		return errcode.ErrInstanceStatusInvalid
	}
	status, _ := updates[modelinstance.ColumnStatus].(string)
	s.transitions = append(s.transitions, resumeTransition{from: append([]string(nil), from...), to: status})
	s.entity.Status = status
	return nil
}

type resumeSandboxAdapterStub struct {
	psandbox.Adapter
	resumeCalls int
	pauseCalls  int
	resumeHook  func()
	pauseErr    error
}

func (s *resumeSandboxAdapterStub) ResumeSandbox(context.Context, string, *psandbox.ResumeSandboxRequest) (*psandbox.Sandbox, error) {
	s.resumeCalls++
	if s.resumeHook != nil {
		s.resumeHook()
	}
	return &psandbox.Sandbox{}, nil
}

func (s *resumeSandboxAdapterStub) PauseSandbox(context.Context, string) error {
	s.pauseCalls++
	return s.pauseErr
}

type passListerStub struct {
	passes []*modelpass.Entity
	err    error
}

func (s *passListerStub) ListByUserID(string) ([]*modelpass.Entity, error) {
	return s.passes, s.err
}

func TestRequireActivePassRejectsNonActiveLifecycleStates(t *testing.T) {
	ctx := pctx.NewContext(nil).WithUserID("user-1")
	for _, tc := range []struct {
		name   string
		status string
		want   error
	}{
		{name: "missing", want: errcode.ErrInstanceNoActivePass},
		{name: "isolating", status: modelpass.StatusIsolating, want: errcode.ErrPassIsolating},
		{name: "isolated", status: modelpass.StatusIsolated, want: errcode.ErrPassIsolated},
		{name: "renewing", status: modelpass.StatusRenewing, want: errcode.ErrPassRenewing},
		{name: "deleting", status: modelpass.StatusDeleting, want: errcode.ErrPassDeleting},
		{name: "terminating", status: modelpass.StatusTerminating, want: errcode.ErrPassTerminating},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var passes []*modelpass.Entity
			if tc.status != "" {
				passes = []*modelpass.Entity{{PassID: "pass-1", Status: tc.status}}
			}
			logic := &logic{passLister: &passListerStub{passes: passes}}
			if err := logic.requireActivePass(ctx); !errors.Is(err, tc.want) {
				t.Fatalf("requireActivePass() error = %v, want %v", err, tc.want)
			}
		})
	}

	logic := &logic{passLister: &passListerStub{passes: []*modelpass.Entity{{PassID: "pass-1", Status: modelpass.StatusActive}}}}
	if err := logic.requireActivePass(ctx); err != nil {
		t.Fatalf("active pass should be accepted: %v", err)
	}
}

func TestStartTerminalSessionRequiresActivePassBeforeSandboxCall(t *testing.T) {
	sandbox := &commandSandboxAdapterStub{}
	logic := &logic{
		instanceDao: &commandInstanceDaoStub{entity: &modelinstance.Entity{
			InstanceId: "ins-1",
			UserId:     "user-1",
			Status:     modelinstance.InstanceStatusRunning,
			SandboxId:  "sbx-1",
		}},
		passLister:     &passListerStub{passes: []*modelpass.Entity{{PassID: "pass-1", Status: modelpass.StatusIsolated}}},
		sandboxAdapter: sandbox,
	}

	_, err := logic.StartTerminalSession(pctx.NewContext(nil).WithUserID("user-1"), "ins-1")
	if !errors.Is(err, errcode.ErrPassIsolated) {
		t.Fatalf("StartTerminalSession() error = %v, want %v", err, errcode.ErrPassIsolated)
	}
	if len(sandbox.terminalCalls) != 0 {
		t.Fatalf("sandbox must not be called, got %v", sandbox.terminalCalls)
	}
}

func TestInstanceOwnershipIsCheckedBeforeActivePass(t *testing.T) {
	logic := &logic{
		instanceDao: &commandInstanceDaoStub{err: errcode.ErrInstanceNotFound},
		passLister:  &passListerStub{},
	}

	_, err := logic.StartTerminalSession(pctx.NewContext(nil).WithUserID("other-user"), "ins-1")
	if !errors.Is(err, errcode.ErrInstanceNotFound) {
		t.Fatalf("StartTerminalSession() error = %v, want ownership-safe %v", err, errcode.ErrInstanceNotFound)
	}
}

func TestResumeInstanceRequiresActivePassBeforeSandboxCall(t *testing.T) {
	sandbox := &commandSandboxAdapterStub{}
	logic := &logic{
		instanceDao: &commandInstanceDaoStub{entity: &modelinstance.Entity{
			InstanceId: "ins-1",
			UserId:     "user-1",
			Status:     modelinstance.InstanceStatusPaused,
			SandboxId:  "sbx-1",
		}},
		passLister:     &passListerStub{passes: []*modelpass.Entity{{PassID: "pass-1", Status: modelpass.StatusDeleting}}},
		sandboxAdapter: sandbox,
	}

	_, err := logic.ResumeInstance(pctx.NewContext(nil).WithUserID("user-1"), "ins-1", &transport.ResumeInstanceRequest{})
	if !errors.Is(err, errcode.ErrPassDeleting) {
		t.Fatalf("ResumeInstance() error = %v, want %v", err, errcode.ErrPassDeleting)
	}
	if len(sandbox.terminalCalls) != 0 || len(sandbox.calls) != 0 {
		t.Fatal("sandbox must not be called when pass is deleting")
	}
}

func TestResumeInstanceUsesTransitionStatusAndRollsBackWhenPassStartsIsolating(t *testing.T) {
	passLister := &passListerStub{passes: []*modelpass.Entity{{PassID: "pass-1", Status: modelpass.StatusActive}}}
	dao := &resumeInstanceDaoStub{entity: &modelinstance.Entity{
		Id:         1,
		InstanceId: "ins-1",
		UserId:     "user-1",
		Status:     modelinstance.InstanceStatusPaused,
		SandboxId:  "sbx-1",
	}}
	sandbox := &resumeSandboxAdapterStub{resumeHook: func() {
		passLister.passes[0].Status = modelpass.StatusIsolating
	}}
	logic := &logic{
		instanceDao:    dao,
		passLister:     passLister,
		sandboxAdapter: sandbox,
	}

	_, err := logic.ResumeInstance(pctx.NewContext(nil).WithUserID("user-1"), "ins-1", &transport.ResumeInstanceRequest{})
	if !errors.Is(err, errcode.ErrPassIsolating) {
		t.Fatalf("ResumeInstance() error = %v, want %v", err, errcode.ErrPassIsolating)
	}
	if sandbox.resumeCalls != 1 || sandbox.pauseCalls != 1 {
		t.Fatalf("expected one resume and compensating pause, got resume=%d pause=%d", sandbox.resumeCalls, sandbox.pauseCalls)
	}
	if dao.entity.Status != modelinstance.InstanceStatusPaused {
		t.Fatalf("instance status = %s, want %s", dao.entity.Status, modelinstance.InstanceStatusPaused)
	}
	if len(dao.transitions) != 2 {
		t.Fatalf("transitions = %+v, want Paused -> Resuming -> Paused", dao.transitions)
	}
	if dao.transitions[0].to != modelinstance.InstanceStatusResuming || dao.transitions[1].to != modelinstance.InstanceStatusPaused {
		t.Fatalf("unexpected transitions: %+v", dao.transitions)
	}
}

func TestResumeInstanceTransitionsPausedThroughResumingToRunning(t *testing.T) {
	dao := &resumeInstanceDaoStub{entity: &modelinstance.Entity{
		Id:         1,
		InstanceId: "ins-1",
		UserId:     "user-1",
		Status:     modelinstance.InstanceStatusPaused,
		SandboxId:  "sbx-1",
	}}
	sandbox := &resumeSandboxAdapterStub{}
	logic := &logic{
		instanceDao: dao,
		passLister: &passListerStub{passes: []*modelpass.Entity{{
			PassID: "pass-1",
			Status: modelpass.StatusActive,
		}}},
		sandboxAdapter: sandbox,
	}

	resp, err := logic.ResumeInstance(pctx.NewContext(nil).WithUserID("user-1"), "ins-1", &transport.ResumeInstanceRequest{})
	if err != nil {
		t.Fatalf("ResumeInstance() error = %v", err)
	}
	if resp.Status != modelinstance.InstanceStatusRunning || dao.entity.Status != modelinstance.InstanceStatusRunning {
		t.Fatalf("resume status = response:%s entity:%s", resp.Status, dao.entity.Status)
	}
	if sandbox.resumeCalls != 1 || sandbox.pauseCalls != 0 {
		t.Fatalf("unexpected sandbox calls: resume=%d pause=%d", sandbox.resumeCalls, sandbox.pauseCalls)
	}
	if len(dao.transitions) != 2 || dao.transitions[0].to != modelinstance.InstanceStatusResuming || dao.transitions[1].to != modelinstance.InstanceStatusRunning {
		t.Fatalf("unexpected transitions: %+v", dao.transitions)
	}
}

func TestResumeInstanceKeepsResumingWhenCompensatingPauseFails(t *testing.T) {
	passLister := &passListerStub{passes: []*modelpass.Entity{{PassID: "pass-1", Status: modelpass.StatusActive}}}
	dao := &resumeInstanceDaoStub{entity: &modelinstance.Entity{
		Id:         1,
		InstanceId: "ins-1",
		UserId:     "user-1",
		Status:     modelinstance.InstanceStatusPaused,
		SandboxId:  "sbx-1",
	}}
	sandbox := &resumeSandboxAdapterStub{
		resumeHook: func() { passLister.passes[0].Status = modelpass.StatusIsolating },
		pauseErr:   errors.New("pause unavailable"),
	}
	logic := &logic{
		instanceDao:    dao,
		passLister:     passLister,
		sandboxAdapter: sandbox,
		logger:         zap.NewNop(),
	}

	_, err := logic.ResumeInstance(pctx.NewContext(nil).WithUserID("user-1"), "ins-1", &transport.ResumeInstanceRequest{})
	if !errors.Is(err, errcode.ErrSandboxServiceError) {
		t.Fatalf("ResumeInstance() error = %v, want %v", err, errcode.ErrSandboxServiceError)
	}
	if dao.entity.Status != modelinstance.InstanceStatusResuming {
		t.Fatalf("instance status = %s, want %s so isolate can retry", dao.entity.Status, modelinstance.InstanceStatusResuming)
	}
	if len(dao.transitions) != 1 || dao.transitions[0].to != modelinstance.InstanceStatusResuming {
		t.Fatalf("unexpected transitions: %+v", dao.transitions)
	}
}
