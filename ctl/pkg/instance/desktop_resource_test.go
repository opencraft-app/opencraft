package instance

import (
	"context"
	"encoding/json"
	"fmt"
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

func desktopPreparationCommandResult(command string) *psandbox.ExecCommandResult {
	output := ""
	if strings.Contains(command, "DESKTOP_TARGET_VERIFY") {
		output = desktopVerifyOutput(desktopTestIncarnation)
	} else if strings.HasSuffix(command, " --epoch") {
		output = `{"generation":""}`
	}
	return &psandbox.ExecCommandResult{Status: "SUCCESS", ExitCode: 0, Output: output}
}

func (s *desktopResourceBlockingAdapter) ExecCommand(_ context.Context, _ string, command string, _ int) (*psandbox.ExecCommandResult, error) {
	return desktopPreparationCommandResult(command), nil
}

type desktopObserverPreparationAdapter struct {
	*desktopSandboxStub
	entered chan string
	release chan struct{}
	failed  bool
}

func (s *desktopObserverPreparationAdapter) ExecCommand(ctx context.Context, target, command string, _ int) (*psandbox.ExecCommandResult, error) {
	if !strings.Contains(command, desktopObserverProxySource) {
		return desktopPreparationCommandResult(command), nil
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

// TestDesktopInputRecoversFromPhysicalDesktopRestart 观察进程重启后（unit 带
// Restart=on-failure，崩溃即自动拉起）物理身份必然变化。网关刻意拒绝在同一代次下
// 静默替换身份，因此必须换代重新激活：继续用同一代次重试，epoch 会永远停在已消失
// 的进程上，写授权再也签不出来，键鼠永久不可用且不可自愈（现网 bj-7 复现）。
func TestDesktopInputRecoversFromPhysicalDesktopRestart(t *testing.T) {
	l, _, ctx, session := desktopViewerFixture(t)
	session.mu.Lock()
	stale := session.generation
	session.inputPrepared, session.observerPrepared, session.preparing = false, false, true
	session.mu.Unlock()
	sb := l.sandboxAdapter.(*desktopSandboxStub)
	activations := []string{}
	sb.execFunc = func(command string) (*psandbox.ExecCommandResult, error) {
		output := ""
		if strings.Contains(command, "DESKTOP_TARGET_VERIFY") {
			output = desktopVerifyOutput(desktopTestIncarnation)
		}
		if strings.HasSuffix(command, " --epoch") {
			// 网关已记录本代次，但记录的是重启前那个已经消失的进程。
			output = fmt.Sprintf(`{"generation":%q}`, stale)
		}
		if strings.Contains(command, " --activate ") {
			activations = append(activations, command)
			if strings.Contains(command, " --activate "+stale+" "+stale+" ") {
				return &psandbox.ExecCommandResult{Status: "FAILED", ExitCode: 1}, nil
			}
		}
		return &psandbox.ExecCommandResult{Status: "SUCCESS", ExitCode: 0, Output: output}, nil
	}
	l.prepareDesktopResource(ctx, session, func() {})
	session.mu.Lock()
	ready, current := session.inputPrepared, session.generation
	session.mu.Unlock()
	if !ready {
		t.Fatal("a restarted desktop left input permanently unavailable")
	}
	if current == stale {
		t.Fatal("recovery must retire the generation fenced to the vanished desktop")
	}
	if len(activations) != 2 {
		t.Fatalf("expected one retry under a fresh generation, got %d activations", len(activations))
	}
	// 重试必须以旧代次作为 CAS 期望值，否则网关仍会拒绝。
	if !strings.Contains(activations[1], " --activate "+current+" "+stale+" "+desktopTestIncarnation) {
		t.Fatalf("retry lost the compare-and-swap expectation: %s", activations[1])
	}
}

func TestDesktopResourceInputWaitsForEpochActivation(t *testing.T) {
	for _, outcome := range []string{"success", "install-failed", "verify-failed", "epoch-invalid", "epoch-failed", "activate-failed", "owner-changed", "generation-changed", "late-activation", "incarnation-changed", "reverify-failed"} {
		t.Run(outcome, func(t *testing.T) {
			l, dao, ctx, session := desktopViewerFixture(t)
			session.mu.Lock()
			session.inputPrepared, session.observerPrepared, session.preparing = false, false, true
			session.mu.Unlock()
			sb := l.sandboxAdapter.(*desktopSandboxStub)
			commands := []string{}
			sb.execFunc = func(command string) (*psandbox.ExecCommandResult, error) {
				commands = append(commands, command)
				output := ""
				if len(commands) == 2 && outcome == "install-failed" {
					return nil, context.DeadlineExceeded
				}
				if strings.Contains(command, "DESKTOP_TARGET_VERIFY") {
					if outcome == "verify-failed" {
						return nil, context.DeadlineExceeded
					}
					output = desktopVerifyOutput(desktopTestIncarnation)
					if len(commands) == 6 {
						if outcome == "incarnation-changed" {
							output = desktopVerifyOutput(strings.Repeat("b", 64))
						}
						if outcome == "reverify-failed" {
							return nil, context.DeadlineExceeded
						}
					}
				}
				if strings.HasSuffix(command, " --epoch") {
					output = `{"generation":""}`
					if outcome == "epoch-invalid" {
						output = `{}`
					}
					if outcome == "epoch-failed" {
						return nil, context.DeadlineExceeded
					}
					if outcome == "generation-changed" {
						session.mu.Lock()
						session.generation = "22222222-2222-4222-8222-222222222222"
						session.mu.Unlock()
					}
				}
				if strings.Contains(command, " --activate ") {
					if outcome == "generation-changed" {
						t.Error("old generation dispatched activation after being fenced")
					}
					if l.desktopResourceResponse(session).State != transport.DesktopResourceStatePreparing {
						t.Error("prepared published before activation completion")
					}
					if !strings.Contains(command, session.generation+" - "+desktopTestIncarnation) {
						t.Error("activation missing generation or incarnation binding")
					}
					if outcome == "activate-failed" {
						return &psandbox.ExecCommandResult{Status: "FAILED", ExitCode: 1}, nil
					}
					if outcome == "owner-changed" {
						dao.change(session.sandboxID, "new-owner")
					}
					if outcome == "late-activation" {
						session.mu.Lock()
						session.generation = "22222222-2222-4222-8222-222222222222"
						session.mu.Unlock()
					}
				}
				return &psandbox.ExecCommandResult{Status: "SUCCESS", ExitCode: 0, Output: output}, nil
			}
			l.prepareDesktopResource(ctx, session, func() {})
			session.mu.Lock()
			ready := session.inputPrepared
			session.mu.Unlock()
			if ready != (outcome == "success") {
				t.Fatalf("inputPrepared=%v after %s", ready, outcome)
			}
			if outcome != "success" && l.desktopResourceResponse(session).State != transport.DesktopResourceStateFailed {
				t.Fatal("unknown epoch or stale activation published read-only Prepared")
			}
			if outcome == "success" && len(commands) != 6 {
				t.Fatalf("expected observer/install/verify/epoch/activate/reverify, got %d", len(commands))
			}
		})
	}
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
		if strings.Contains(command, "DESKTOP_TARGET_VERIFY") || strings.HasSuffix(command, " --epoch") {
			return desktopPreparationCommandResult(command), nil
		}
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
	// 过渡期仍回填旧字段：换机后必须是新机器的地址与新密码，绝不复用旧凭据。
	if !strings.Contains(next.WsURL, "sb-new-machine") || next.WsURL == first.WsURL || next.Password == first.Password {
		t.Fatal("legacy returned old Ready credentials after replacement")
	}
	if sb.ptyCallCount() != 2 {
		t.Fatal("legacy did not prepare new binding")
	}
}

// TestDesktopResourceObserverPrepareInheritsSessionAuth 回归（与 startDesktopInstall
// 同源）：prepareDesktopResource 的后台 worker 经 execDesktopInstallCommand →
// /sandboxes/{id}/tat/commands 下发 observer 准备命令，该 TAT endpoint 鉴权只认 ctx
// 透传的用户 session（无服务级凭据回退）。EnsureDesktopResource 构造 worker ctx 时
// 若漏传 SessionAuth，observer 准备会鉴权失败 → "desktop observation unavailable" →
// Failed。本测试断言后台 worker 的 TAT 下发带上了 parent 的 session，且最终收敛到
// observerPrepared。注意 provision/probe 走 PTY（X-API-Key），不经此 auth。
func TestDesktopResourceObserverPrepareInheritsSessionAuth(t *testing.T) {
	resetDesktopSessionsForTest()
	t.Setenv(desktopIngressDomainEnv, "")
	// provision 一次 PTY 直接 ProbeOK → Ready，随后 worker 走 observer 准备分支。
	sb := &desktopSandboxStub{ptyOutputs: [][]psandbox.PtyExecStreamEvent{
		ptyFinishEvents(desktopProbeOKMarker),
	}}
	sb.execFunc = func(command string) (*psandbox.ExecCommandResult, error) {
		return desktopPreparationCommandResult(command), nil
	}

	const wantAuth = "Bearer resource-session-token"
	const wantCookie = "lc_session=resource-session-token"
	l := &logic{instanceDao: &desktopResourceDAO{entity: *desktopTestEntity()}, sandboxAdapter: sb, logger: zap.NewNop()}
	// parent ctx 带上用户 session 鉴权（模拟真实 HTTP 请求链路）。
	ctx := pctx.NewContext(nil).
		WithUserID("user-desktop-1").
		WithSessionAuth(wantAuth, wantCookie)

	if _, err := l.EnsureDesktopResource(ctx, "ins-desktop-1"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	session := l.desktopSessionOf("ins-desktop-1")
	awaitDesktopWorker(t, session)

	session.mu.Lock()
	prepared := session.observerPrepared
	status := session.status
	reason := session.reason
	session.mu.Unlock()
	if !prepared || status != transport.DesktopSessionStatusReady {
		t.Fatalf("observer not prepared: prepared=%v status=%q reason=%q", prepared, status, reason)
	}

	auths := sb.execAuthsSnapshot()
	if len(auths) == 0 {
		t.Fatal("expected observer prepare ExecCommand (TAT) calls, got none")
	}
	// 核心断言：observer 准备的每次 TAT 下发都必须带上 parent 的 session 鉴权。
	for i, got := range auths {
		if got != wantAuth {
			t.Fatalf("observer prepare ExecCommand #%d ctx missing session auth: got %q, want %q", i, got, wantAuth)
		}
	}
}
