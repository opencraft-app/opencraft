package instance

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	psandbox "ctl/pkg/adapter/sandbox"
	pctx "ctl/pkg/context"
	"ctl/pkg/errcode"
	modelinstance "ctl/pkg/model/instance"
	"ctl/pkg/transport"
	"go.uber.org/zap"
)

type desktopResourceDAO struct {
	modelinstance.Dao
	mu     sync.Mutex
	entity modelinstance.Entity
}

func (d *desktopResourceDAO) GetByInstanceID(_ pctx.Context, id string) (*modelinstance.Entity, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if id != d.entity.InstanceId {
		return nil, errcode.ErrInstanceNotFound
	}
	e := d.entity
	return &e, nil
}

func (d *desktopResourceDAO) change(sandbox, user string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.entity.SandboxId, d.entity.UserId = sandbox, user
}

type desktopResourceBlockingAdapter struct {
	psandbox.Adapter
	mu      sync.Mutex
	targets []string
	entered chan context.Context
	release chan struct{}
	once    sync.Once
}

func (s *desktopResourceBlockingAdapter) ExecCommand(_ context.Context, _ string, _ string, _ int) (*psandbox.ExecCommandResult, error) {
	return &psandbox.ExecCommandResult{Status: "SUCCESS", ExitCode: 0}, nil
}

type desktopObserverPreparationAdapter struct {
	*desktopSandboxStub
	entered chan string
	release chan struct{}
	failed  bool
}

func (s *desktopObserverPreparationAdapter) ExecCommand(ctx context.Context, target, command string, _ int) (*psandbox.ExecCommandResult, error) {
	if !strings.Contains(command, desktopObserverProxySource) {
		return nil, errcode.ErrSandboxServiceError
	}
	s.entered <- target
	select {
	case <-s.release:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	if s.failed {
		return &psandbox.ExecCommandResult{Status: "FAILED", ExitCode: 1}, nil
	}
	return &psandbox.ExecCommandResult{Status: "SUCCESS", ExitCode: 0}, nil
}

func TestDesktopResourceWaitsForObserverAndFencesLateOwnershipChange(t *testing.T) {
	for _, outcome := range []string{"success", "failed", "owner_changed"} {
		t.Run(outcome, func(t *testing.T) {
			resetDesktopSessionsForTest()
			adapter := &desktopObserverPreparationAdapter{
				desktopSandboxStub: &desktopSandboxStub{ptyOutputs: [][]psandbox.PtyExecStreamEvent{ptyFinishEvents(desktopProbeOKMarker)}},
				entered:            make(chan string, 1), release: make(chan struct{}), failed: outcome == "failed",
			}
			l, dao, ctx := desktopResourceFixture(adapter)
			if _, err := l.EnsureDesktopResource(ctx, "ins-desktop-1"); err != nil {
				t.Fatal(err)
			}
			select {
			case target := <-adapter.entered:
				if target != desktopTestEntity().SandboxId {
					t.Fatal("wrong observer target")
				}
			case <-time.After(time.Second):
				t.Fatal("observer did not start")
			}
			session := l.desktopSessionOf("ins-desktop-1")
			read, err := l.GetDesktopResource(ctx, "ins-desktop-1")
			if err != nil || read.State != transport.DesktopResourceStatePreparing {
				t.Fatal("legacy HTTP ready advertised observer prematurely")
			}
			if outcome == "owner_changed" {
				dao.change("new-sandbox", "other-user")
			}
			close(adapter.release)
			awaitDesktopWorker(t, session)
			session.mu.Lock()
			prepared := session.observerPrepared
			session.mu.Unlock()
			if prepared != (outcome == "success") {
				t.Fatal("observer startup failure or late result escaped")
			}
			if outcome == "owner_changed" {
				if _, err := l.GetDesktopResource(ctx, "ins-desktop-1"); err != errcode.ErrInstanceNotFound {
					t.Fatal("old owner survived replacement")
				}
			}
		})
	}
}

func (s *desktopResourceBlockingAdapter) unblock() { s.once.Do(func() { close(s.release) }) }

func (s *desktopResourceBlockingAdapter) StreamPtyCommand(ctx context.Context, id string, _ *psandbox.PtyExecStreamRequest, emit func(psandbox.PtyExecStreamEvent) error) error {
	s.mu.Lock()
	n := len(s.targets)
	s.targets = append(s.targets, id)
	s.mu.Unlock()
	if n == 0 {
		s.entered <- ctx
		select {
		case <-s.release:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	for _, event := range ptyFinishEvents(desktopProbeOKMarker) {
		if err := emit(event); err != nil {
			return err
		}
	}
	return nil
}

func desktopResourceFixture(adapter psandbox.Adapter) (*logic, *desktopResourceDAO, pctx.Context) {
	dao := &desktopResourceDAO{entity: *desktopTestEntity()}
	return &logic{instanceDao: dao, sandboxAdapter: adapter, logger: zap.NewNop()}, dao,
		pctx.NewContext(context.Background()).WithUserID(dao.entity.UserId)
}

func awaitDesktopResource(t *testing.T, predicate func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if predicate() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("desktop resource did not settle")
}

func awaitDesktopWorker(t *testing.T, session *desktopSession) {
	t.Helper()
	awaitDesktopResource(t, func() bool { session.mu.Lock(); defer session.mu.Unlock(); return !session.preparing })
}

func TestDesktopResourceObservationHasNoSideEffects(t *testing.T) {
	resetDesktopSessionsForTest()
	sb := &desktopSandboxStub{}
	l, _, ctx := desktopResourceFixture(sb)
	for i := 0; i < 3; i++ {
		r, err := l.GetDesktopResource(ctx, "ins-desktop-1")
		if err != nil || r.State != transport.DesktopResourceStateUnprepared {
			t.Fatalf("read: %+v %v", r, err)
		}
	}
	if _, ok := desktopSessions.Load("ins-desktop-1"); ok {
		t.Fatal("GET allocated state")
	}
	if _, err := l.EnsureDesktopResource(pctx.NewContext(nil).WithUserID("other"), "ins-desktop-1"); err != errcode.ErrInstanceNotFound {
		t.Fatalf("ownership: %v", err)
	}
	if _, err := l.GetDesktopResource(pctx.NewContext(nil), "ins-desktop-1"); err != errcode.ErrInstanceMissingUserID {
		t.Fatalf("missing identity: %v", err)
	}
	if sb.ptyCallCount() != 0 || sb.execCmdCount() != 0 {
		t.Fatal("observation dispatched TAT")
	}
}

func TestDesktopResourceJobSurvivesRequestAndDeduplicates(t *testing.T) {
	resetDesktopSessionsForTest()
	t.Setenv(desktopIngressDomainEnv, "") // Resource readiness does not require a legacy viewer URL.
	sb := &desktopResourceBlockingAdapter{entered: make(chan context.Context, 1), release: make(chan struct{})}
	t.Cleanup(sb.unblock)
	l, _, _ := desktopResourceFixture(sb)
	request, cancel := context.WithCancel(context.Background())
	defer cancel()
	ctx := pctx.NewContext(request).WithUserID("user-desktop-1")
	r, err := l.EnsureDesktopResource(ctx, "ins-desktop-1")
	if err != nil || r.State != transport.DesktopResourceStatePreparing || r.GenerationID == "" {
		t.Fatalf("prepare: %+v %v", r, err)
	}
	workerCtx := <-sb.entered
	cancel()
	if workerCtx.Err() != nil {
		t.Fatal("worker inherited HTTP cancellation")
	}
	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			resp, e := l.EnsureDesktopResource(pctx.NewContext(nil).WithUserID("user-desktop-1"), "ins-desktop-1")
			if e != nil || resp.GenerationID != r.GenerationID {
				t.Errorf("duplicate: %+v %v", resp, e)
			}
		}()
	}
	wg.Wait()
	session := l.desktopSessionOf("ins-desktop-1")
	sb.unblock()
	awaitDesktopWorker(t, session)
	before := func() time.Time { _, _, _, _, active := session.snapshot(); return active }()
	read, err := l.GetDesktopResource(pctx.NewContext(nil).WithUserID("user-desktop-1"), "ins-desktop-1")
	if err != nil || read.State != transport.DesktopResourceStatePrepared {
		t.Fatalf("prepared: %+v %v", read, err)
	}
	_, _, _, _, after := session.snapshot()
	if !before.Equal(after) {
		t.Fatal("GET refreshed idle heartbeat")
	}
	sb.mu.Lock()
	defer sb.mu.Unlock()
	if len(sb.targets) != 1 {
		t.Fatalf("duplicate TAT calls: %v", sb.targets)
	}
	b, _ := json.Marshal(read)
	if strings.Contains(string(b), "password") || strings.Contains(string(b), "ws_url") {
		t.Fatalf("credential leak: %s", b)
	}
}

func TestDesktopResourceInstallsAndStartsWithoutGET(t *testing.T) {
	resetDesktopSessionsForTest()
	fastDesktopInstallPoll(t)
	t.Setenv(desktopIngressDomainEnv, "")
	sb := &desktopSandboxStub{ptyOutputs: [][]psandbox.PtyExecStreamEvent{
		ptyFinishEvents(desktopMissingLayerMarker), ptyFinishEvents(desktopProbeOKMarker),
	}}
	sb.execFunc = func(command string) (*psandbox.ExecCommandResult, error) {
		out := "PROGRESS=100\n" + desktopInstallDoneMarker
		if strings.Contains(command, "vela-desktop-install.sh") {
			out = desktopInstallStartedMark
		}
		return &psandbox.ExecCommandResult{Status: "SUCCESS", ExitCode: 0, Output: out}, nil
	}
	l, _, ctx := desktopResourceFixture(sb)
	if _, err := l.EnsureDesktopResource(ctx, "ins-desktop-1"); err != nil {
		t.Fatal(err)
	}
	session := l.desktopSessionOf("ins-desktop-1")
	awaitDesktopWorker(t, session)
	_, _, status, reason, _ := session.snapshot()
	if status != transport.DesktopSessionStatusReady {
		t.Fatalf("without polling: %s %s", status, reason)
	}
	if sb.ptyCallCount() != 2 || sb.execCmdCount() < 2 {
		t.Fatalf("incomplete orchestration: %d/%d", sb.ptyCallCount(), sb.execCmdCount())
	}
	sb.mu.Lock()
	defer sb.mu.Unlock()
	if !strings.Contains(sb.ptyCalls[1].Command, "x11vnc -storepasswd") {
		t.Fatal("installer completion must launch services, not enter the prior pending-probe window")
	}
}

func TestDesktopResourcePendingProbeDoesNotRelock(t *testing.T) {
	resetDesktopSessionsForTest()
	sb := &desktopSandboxStub{ptyOutputs: [][]psandbox.PtyExecStreamEvent{
		ptyFinishEvents(desktopProbePendingMarker), ptyFinishEvents(desktopProbeOKMarker),
	}}
	l, _, ctx := desktopResourceFixture(sb)
	if _, err := l.EnsureDesktopResource(ctx, "ins-desktop-1"); err != nil {
		t.Fatal(err)
	}
	session := l.desktopSessionOf("ins-desktop-1")
	awaitDesktopWorker(t, session)
	_, _, state, _, _ := session.snapshot()
	if state != transport.DesktopSessionStatusReady || sb.ptyCallCount() != 2 {
		t.Fatalf("pending probe stuck: %s", state)
	}
}

func TestDesktopResourceBindingReplacementFencesLateCommand(t *testing.T) {
	resetDesktopSessionsForTest()
	sb := &desktopResourceBlockingAdapter{entered: make(chan context.Context, 1), release: make(chan struct{})}
	t.Cleanup(sb.unblock)
	l, dao, ctx := desktopResourceFixture(sb)
	first, err := l.EnsureDesktopResource(ctx, "ins-desktop-1")
	if err != nil {
		t.Fatal(err)
	}
	<-sb.entered
	old := l.desktopSessionOf("ins-desktop-1")
	dao.change("sb-replacement", "user-desktop-1")
	r, err := l.GetDesktopResource(ctx, "ins-desktop-1")
	if err != nil || r.State != transport.DesktopResourceStateUnprepared || r.GenerationID != "" {
		t.Fatalf("stale binding observable: %+v %v", r, err)
	}
	result := make(chan *transport.DesktopResourceResponse, 1)
	errors := make(chan error, 1)
	go func() { next, e := l.EnsureDesktopResource(ctx, "ins-desktop-1"); result <- next; errors <- e }()
	sb.unblock()
	next := <-result
	if err := <-errors; err != nil {
		t.Fatal(err)
	}
	if next.GenerationID == first.GenerationID {
		t.Fatal("generation reused on replacement")
	}
	fresh := l.desktopSessionOf("ins-desktop-1")
	if fresh == old {
		t.Fatal("replacement reused mutable state")
	}
	awaitDesktopWorker(t, old)
	awaitDesktopWorker(t, fresh)
	_, _, state, _, _ := fresh.snapshot()
	if state != transport.DesktopSessionStatusReady {
		t.Fatalf("new worker overwritten: %s", state)
	}
	sb.mu.Lock()
	defer sb.mu.Unlock()
	if len(sb.targets) != 2 || sb.targets[0] != "sb-desktop-1" || sb.targets[1] != "sb-replacement" {
		t.Fatalf("wrong dispatch targets: %v", sb.targets)
	}
}

func TestDesktopResourceOwnerChangeAndRetryIsolateRecords(t *testing.T) {
	resetDesktopSessionsForTest()
	sb := &desktopSandboxStub{ptyOutputs: [][]psandbox.PtyExecStreamEvent{ptyFinishEvents(desktopProbeOKMarker)}}
	l, dao, ctx := desktopResourceFixture(sb)
	entity, _ := dao.GetByInstanceID(ctx, "ins-desktop-1")
	old, err := l.desktopSessionForEntity(ctx, entity)
	if err != nil {
		t.Fatal(err)
	}
	old.setStatus(transport.DesktopSessionStatusReady, "")
	old.mu.Lock()
	old.password = "secretpw"
	old.mu.Unlock()
	dao.change(entity.SandboxId, "new-owner")
	if _, err := l.GetDesktopResource(ctx, entity.InstanceId); err != errcode.ErrInstanceNotFound {
		t.Fatalf("old principal: %v", err)
	}
	newCtx := pctx.NewContext(nil).WithUserID("new-owner")
	r, err := l.GetDesktopResource(newCtx, entity.InstanceId)
	if err != nil || r.State != transport.DesktopResourceStateUnprepared {
		t.Fatalf("owner cache: %+v %v", r, err)
	}
	newEntity, _ := dao.GetByInstanceID(newCtx, entity.InstanceId)
	failed, err := l.desktopSessionForEntity(newCtx, newEntity)
	if err != nil {
		t.Fatal(err)
	}
	failed.setStatus(transport.DesktopSessionStatusFailed, "raw backend secretpw error")
	b, _ := json.Marshal(l.desktopResourceResponse(failed))
	if strings.Contains(string(b), "secretpw") || strings.Contains(string(b), "reason") {
		t.Fatalf("diagnostic leak: %s", b)
	}
	before := failed.generation
	resp, err := l.EnsureDesktopResource(newCtx, entity.InstanceId)
	if err != nil || resp.GenerationID == before {
		t.Fatalf("retry: %+v %v", resp, err)
	}
	fresh := l.desktopSessionOf(entity.InstanceId)
	awaitDesktopWorker(t, fresh)
	// Simulate a detached install callback from the failed generation.
	failed.endInstall(transport.DesktopSessionStatusFailed, "late failure")
	_, _, state, _, _ := fresh.snapshot()
	if fresh == failed || fresh == old || state != transport.DesktopSessionStatusReady {
		t.Fatalf("late retry write: %s", state)
	}
}

func TestDesktopResourceCanceledWorkerRequiresExplicitRetry(t *testing.T) {
	resetDesktopSessionsForTest()
	sb := &desktopSandboxStub{ptyOutputs: [][]psandbox.PtyExecStreamEvent{
		ptyFinishEvents(desktopProbePendingMarker), ptyFinishEvents(desktopProbePendingMarker),
		ptyFinishEvents(desktopProbeOKMarker),
	}}
	l, _, ctx := desktopResourceFixture(sb)
	first, err := l.EnsureDesktopResource(ctx, "ins-desktop-1")
	if err != nil {
		t.Fatal(err)
	}
	old := l.desktopSessionOf("ins-desktop-1")
	awaitDesktopResource(t, func() bool { return sb.ptyCallCount() == 2 })
	old.mu.Lock()
	cancel := old.prepareCancel
	old.mu.Unlock()
	cancel() // Local orchestration expiry/invalidation, not HTTP cancellation.
	awaitDesktopWorker(t, old)
	for i := 0; i < 3; i++ {
		r, err := l.GetDesktopResource(ctx, "ins-desktop-1")
		if err != nil || r.State != transport.DesktopResourceStateFailed {
			t.Fatalf("canceled state: %+v %v", r, err)
		}
	}
	if sb.ptyCallCount() != 2 {
		t.Fatal("GET retried canceled worker")
	}
	next, err := l.EnsureDesktopResource(ctx, "ins-desktop-1")
	if err != nil || next.GenerationID == first.GenerationID {
		t.Fatalf("explicit retry: %+v %v", next, err)
	}
	awaitDesktopWorker(t, l.desktopSessionOf("ins-desktop-1"))
	if sb.ptyCallCount() != 3 {
		t.Fatal("retry not dispatched once")
	}
}

func TestDesktopLegacyReadyCannotSurviveSandboxReplacement(t *testing.T) {
	resetDesktopSessionsForTest()
	withDesktopEnv(t, "ingress.example.test")
	sb := &desktopSandboxStub{ptyOutputs: [][]psandbox.PtyExecStreamEvent{
		ptyFinishEvents(desktopProbeOKMarker), ptyFinishEvents(desktopProbeOKMarker),
	}}
	l, dao, ctx := desktopResourceFixture(sb)
	first, err := l.EnsureDesktopSession(ctx, "ins-desktop-1")
	if err != nil {
		t.Fatal(err)
	}
	dao.change("sb-new-machine", "user-desktop-1")
	next, err := l.GetDesktopSession(ctx, "ins-desktop-1")
	if err != nil || next.Status != transport.DesktopSessionStatusReady {
		t.Fatalf("legacy rebind: %+v %v", next, err)
	}
	if !strings.Contains(next.WsURL, "sb-new-machine") || next.WsURL == first.WsURL || next.Password == first.Password {
		t.Fatal("legacy returned old Ready credentials after replacement")
	}
	if sb.ptyCallCount() != 2 {
		t.Fatal("legacy did not prepare new binding")
	}
}
