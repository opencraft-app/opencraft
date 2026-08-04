package app

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/runtimeactor"
	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/runtimecatalog"
	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/vela/agentgateway"
	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/vela/daemon"
	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/vela/host"
	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/vela/platform"
	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/vela/runtimehost"
	velastate "github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/vela/state"
)

// managedAgentFactory is the app-layer composition root for one AgentCell.
// AgentCell owns the attempt lifetime; this factory only constructs and hands
// off the Host and its private resources.
type managedAgentFactory struct {
	root       string
	stderr     io.Writer
	runtimes   *runtimecatalog.Snapshot
	governor   *daemon.LaunchGovernor
	sessions   *computerSessionManager
	client     *platform.Client
	transports host.TransportFactory
	gatewayHub *agentgateway.Hub
}

func (f *managedAgentFactory) Start(
	ctx context.Context,
	request daemon.AgentStartRequest,
) (daemon.AgentInstance, error) {
	assignment := request.Launch.Assignment
	provisionalFence := request.Launch.Fence
	if request.Lifetime == nil || request.Lease == nil {
		return nil, daemon.ErrInvalidRegistryConfig
	}
	lease, ok := request.Lease.Current()
	if !ok || lease.Epoch != provisionalFence.Epoch ||
		lease.Assignment.AgentID != assignment.AgentID ||
		lease.Assignment.ServerID != assignment.ServerID ||
		lease.Assignment.ConfigGeneration != assignment.ConfigGeneration ||
		lease.Assignment.CredentialVersion != assignment.CredentialVersion {
		return nil, daemon.ErrInvalidRegistryConfig
	}
	permit, err := f.governor.Acquire(
		ctx,
		daemon.LaunchAgentHost,
		daemon.LaunchIdentity{
			AgentID:  assignment.AgentID,
			LaunchID: provisionalFence.LaunchID,
		},
	)
	if err != nil {
		return nil, err
	}
	defer permit.Release()
	var predecessor *string
	if assignment.CurrentLaunch != nil {
		value := assignment.CurrentLaunch.LaunchID
		predecessor = &value
	}
	launchRequest := platform.ComputerAgentLaunchRequest{
		LaunchID: provisionalFence.LaunchID, PredecessorLaunchID: predecessor,
		AssignmentEpoch: lease.Epoch, AssignmentRevision: lease.Revision,
		ConfigGeneration:  assignment.ConfigGeneration,
		CredentialVersion: assignment.CredentialVersion,
	}
	computerSession, err := f.sessions.Current(ctx)
	if err != nil {
		return nil, err
	}
	allocated, err := f.allocateLaunch(
		ctx,
		computerSession.AccessToken,
		launchRequest,
		assignment,
	)
	if errors.Is(err, platform.ErrCredentialRejected) {
		f.sessions.Invalidate(computerSession.AccessToken)
	}
	if err != nil {
		return nil, err
	}
	fence := allocated.Fence.DaemonFence()
	observer := newManagedAgentObserver(
		f.client,
		f.sessions,
		request.Lease,
		fence,
		time.Now,
	)
	observer.Initialize(platform.ObservationCursor{
		AssignmentEpoch:  fence.Epoch,
		ConfigGeneration: fence.ConfigGeneration,
		Attempt:          fence.Attempt,
	})
	if err := observer.PublishAndWait(ctx, "starting", nil); err != nil {
		observer.cancel()
		return nil, daemon.NewAgentLifecycleError(
			"agent_observation_start_failed",
			!errors.Is(err, ErrManagedAgentObservationStale),
			err,
		)
	}
	agentDirectory := filepath.Join(f.root, "agents", assignment.AgentID)
	cursors, err := velastate.OpenFileCursorStore(agentDirectory)
	if err != nil {
		observer.Publish("error", stringPointer("agent_runtime_init_failed"))
		_ = observer.FlushAndClose(context.Background())
		return nil, err
	}
	runtimeActor, err := runtimeactor.New(runtimeactor.Options{
		AgentID: assignment.AgentID,
		Runtimes: &governedResolver{
			next:     f.runtimes,
			governor: f.governor,
			timeout:  60 * time.Second,
		},
	})
	if err != nil {
		observer.Publish("error", stringPointer("agent_runtime_init_failed"))
		_ = observer.FlushAndClose(context.Background())
		return nil, err
	}
	transportSlot := agentgateway.NewTransportSlot()
	gateway, err := f.registerGateway(assignment, fence, transportSlot)
	if err != nil {
		_ = runtimeActor.Close(context.Background())
		observer.Publish("error", stringPointer("agent_gateway_init_failed"))
		_ = observer.FlushAndClose(context.Background())
		return nil, err
	}
	workspaceDirectory, err := f.workspaceDirectory(assignment.AgentID)
	if err != nil {
		_ = gateway.Close(context.Background())
		_ = runtimeActor.Close(context.Background())
		observer.Publish("error", stringPointer("agent_runtime_init_failed"))
		_ = observer.FlushAndClose(context.Background())
		return nil, err
	}
	runtimeAdapter, err := runtimehost.New(runtimehost.Config{
		AgentID:          assignment.AgentID,
		StateDirectory:   agentDirectory,
		WorkingDirectory: workspaceDirectory,
		Actor:            runtimeActor,
		Runtimes:         f.runtimes,
		Gateway:          gateway,
		ReminderClient:   f.client,
		TaskClient:       f.client,
		NewRuntimeEpoch: func() (string, error) {
			return fence.LaunchID, nil
		},
	})
	if err != nil {
		_ = gateway.Close(context.Background())
		_ = runtimeActor.Close(context.Background())
		observer.Publish("error", stringPointer("agent_runtime_init_failed"))
		_ = observer.FlushAndClose(context.Background())
		return nil, err
	}
	baseTransportFactory := f.transports
	if baseTransportFactory == nil {
		baseTransportFactory = &gojaTransportFactory{}
	}
	ready := make(chan struct{})
	health := make(chan daemon.AgentHealth, 1)
	var readyOnce sync.Once
	agentHost, err := host.New(host.Config{
		Sessions: &managedAgentSessions{
			client:   f.client,
			sessions: f.sessions,
			lease:    request.Lease,
			fence:    allocated.Fence,
			initial:  allocated.Session,
		},
		Transports: &bindingTransportFactory{
			next: baseTransportFactory,
			slot: transportSlot,
		},
		Runtime:           runtimeAdapter,
		Cursors:           cursors,
		RefreshBefore:     5 * time.Minute,
		BackoffBase:       time.Second,
		BackoffMax:        30 * time.Second,
		MaxFailures:       8,
		ShutdownTimeout:   10 * time.Second,
		MaxInFlightEvents: 1,
		ReportFailure: func(report host.FailureReport) {
			writeHostFailure(f.stderr, report)
		},
		ReportStartup: func(stage host.StartupStage) {
			writeHostStartup(f.stderr, stage)
		},
		ReportReady: func() {
			readyOnce.Do(func() { close(ready) })
			publishAgentHealth(health, daemon.AgentHealth{Ready: true})
			observer.Publish("running", nil)
		},
		ReportUnready: func() {
			errorCode := "agent_im_reconnecting"
			observer.Publish("error", &errorCode)
			publishAgentHealth(health, daemon.AgentHealth{
				Ready:     false,
				ErrorCode: "agent_im_reconnecting",
			})
		},
	})
	if err != nil {
		_ = observer.FlushAndClose(context.Background())
		_ = gateway.Close(context.Background())
		_ = runtimeActor.Close(context.Background())
		return nil, err
	}
	instance := &managedAgentInstance{
		ready:    ready,
		health:   health,
		done:     make(chan struct{}),
		gateway:  gateway,
		actor:    runtimeActor,
		observer: observer,
		fence:    fence,
	}
	go func() {
		hostContext, cancelHost := context.WithCancel(request.Lifetime)
		defer cancelHost()
		hostResult := make(chan error, 1)
		go func() { hostResult <- agentHost.Run(hostContext) }()
		var hostErr error
		select {
		case hostErr = <-hostResult:
		case observationErr := <-observer.Fatal():
			cancelHost()
			<-hostResult
			hostErr = daemon.NewAgentLifecycleError(
				"agent_observation_stale",
				true,
				observationErr,
			)
		}
		if errors.Is(hostErr, platform.ErrCredentialRejected) {
			hostErr = daemon.NewAgentLifecycleError(
				"agent_credential_rejected",
				false,
				hostErr,
			)
		}
		instance.mu.Lock()
		instance.err = hostErr
		instance.mu.Unlock()
		if hostErr == nil {
			observer.Publish("stopped", nil)
		} else {
			errorCode := "agent_host_exited"
			observer.Publish("error", &errorCode)
		}
		close(instance.done)
		close(instance.health)
	}()
	return instance, nil
}

func (f *managedAgentFactory) workspaceDirectory(agentID string) (string, error) {
	agentID = strings.TrimSpace(agentID)
	if f == nil || !filepath.IsAbs(f.root) || agentID == "" ||
		filepath.Base(agentID) != agentID || agentID == "." || agentID == ".." {
		return "", daemon.ErrInvalidRegistryConfig
	}
	stateRoot := filepath.Clean(f.root)
	workspaceRoot := filepath.Join(stateRoot, "workspaces")
	if filepath.Base(stateRoot) == "state" {
		workspaceRoot = filepath.Join(filepath.Dir(stateRoot), "workspaces")
	}
	return filepath.Join(workspaceRoot, agentID), nil
}

func (f *managedAgentFactory) allocateLaunch(
	ctx context.Context,
	token platform.ComputerAccessToken,
	request platform.ComputerAgentLaunchRequest,
	assignment daemon.AgentAssignment,
) (platform.ComputerAgentLaunch, error) {
	delay := time.Second
	for {
		launch, err := f.client.CreateComputerAgentLaunch(
			ctx, token, request, assignment,
		)
		if err == nil || !platform.IsRetryable(err) {
			return launch, err
		}
		if retryAfter := platform.RetryAfter(err); retryAfter > delay {
			delay = retryAfter
		}
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return platform.ComputerAgentLaunch{}, ctx.Err()
		case <-timer.C:
		}
		if delay < 5*time.Second {
			delay *= 2
			if delay > 5*time.Second {
				delay = 5 * time.Second
			}
		}
	}
}

func (f *managedAgentFactory) registerGateway(
	assignment daemon.AgentAssignment,
	fence daemon.Fence,
	transportSlot *agentgateway.TransportSlot,
) (*agentgateway.Gateway, error) {
	if f == nil || f.gatewayHub == nil {
		return nil, agentgateway.ErrGatewayUnavailable
	}
	agentDirectory := filepath.Join(f.root, "agents", assignment.AgentID)
	executable, err := os.Executable()
	if err != nil {
		return nil, err
	}
	return f.gatewayHub.Register(agentgateway.Config{
		AgentID:        assignment.AgentID,
		ServerID:       assignment.ServerID,
		RuntimeEpoch:   fence.LaunchID,
		StateRoot:      agentDirectory,
		Executable:     executable,
		Transport:      transportSlot,
		PlatformClient: f.client,
	})
}

type managedAgentSessions struct {
	client      *platform.Client
	sessions    *computerSessionManager
	lease       daemon.AssignmentLeaseReader
	fence       platform.ComputerAgentLaunchFence
	initial     platform.RuntimeSession
	initialMu   sync.Mutex
	initialUsed bool
}

func (s *managedAgentSessions) CreateRuntimeSession(
	ctx context.Context,
) (platform.RuntimeSession, error) {
	s.initialMu.Lock()
	if !s.initialUsed {
		s.initialUsed = true
		initial := s.initial
		s.initialMu.Unlock()
		return initial, nil
	}
	s.initialMu.Unlock()
	lease, ok := s.lease.Current()
	if !ok || lease.Epoch != s.fence.AssignmentEpoch ||
		lease.Assignment.ConfigGeneration != s.fence.ConfigGeneration ||
		lease.Assignment.CredentialVersion != s.fence.CredentialVersion {
		return platform.RuntimeSession{}, daemon.ErrInvalidRegistryConfig
	}
	computerSession, err := s.sessions.Current(ctx)
	if err != nil {
		return platform.RuntimeSession{}, err
	}
	agentSession, err := s.client.RefreshComputerAgentLaunchSession(
		ctx,
		computerSession.AccessToken,
		s.fence,
		lease.Assignment,
	)
	if errors.Is(err, platform.ErrCredentialRejected) {
		s.sessions.Invalidate(computerSession.AccessToken)
		computerSession, sessionErr := s.sessions.Current(ctx)
		if sessionErr != nil {
			return platform.RuntimeSession{}, sessionErr
		}
		agentSession, err = s.client.RefreshComputerAgentLaunchSession(
			ctx,
			computerSession.AccessToken,
			s.fence,
			lease.Assignment,
		)
	}
	return agentSession, err
}

type managedAgentInstance struct {
	ready          <-chan struct{}
	health         chan daemon.AgentHealth
	done           chan struct{}
	gateway        *agentgateway.Gateway
	actor          *runtimeactor.Actor
	observer       *managedAgentObserver
	fence          daemon.Fence
	mu             sync.Mutex
	err            error
	revokeMu       sync.Mutex
	revoked        bool
	revokeErr      error
	cleanupMu      sync.Mutex
	actorClosed    bool
	observerClosed bool
}

func (i *managedAgentInstance) Fence() daemon.Fence { return i.fence }

func (i *managedAgentInstance) Ready() <-chan struct{} { return i.ready }

func (i *managedAgentInstance) Health() <-chan daemon.AgentHealth {
	return i.health
}

func (i *managedAgentInstance) Done() <-chan struct{} { return i.done }

func (i *managedAgentInstance) Err() error {
	i.mu.Lock()
	defer i.mu.Unlock()
	return i.err
}

func publishAgentHealth(
	destination chan daemon.AgentHealth,
	health daemon.AgentHealth,
) {
	select {
	case destination <- health:
		return
	default:
	}
	select {
	case <-destination:
	default:
	}
	select {
	case destination <- health:
	default:
	}
}

func (i *managedAgentInstance) Revoke(ctx context.Context) error {
	i.revokeMu.Lock()
	defer i.revokeMu.Unlock()
	if i.revoked {
		return i.revokeErr
	}
	if i.observer != nil {
		i.observer.Publish("stopping", nil)
	}
	i.revokeErr = i.gateway.Close(ctx)
	if i.revokeErr == nil {
		i.revoked = true
	}
	return i.revokeErr
}

func (i *managedAgentInstance) Close(ctx context.Context) error {
	if err := i.Revoke(ctx); err != nil {
		return err
	}
	select {
	case <-i.done:
	case <-ctx.Done():
		return ctx.Err()
	}
	return i.cleanup(ctx)
}

func (i *managedAgentInstance) cleanup(ctx context.Context) error {
	if ctx == nil {
		return context.Canceled
	}
	i.cleanupMu.Lock()
	defer i.cleanupMu.Unlock()
	closeContext, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	var result error
	if !i.actorClosed {
		if i.actor == nil {
			i.actorClosed = true
		} else if err := i.actor.Close(closeContext); err != nil {
			result = errors.Join(result, err)
		} else {
			i.actorClosed = true
		}
	}
	if !i.observerClosed {
		if i.observer == nil {
			i.observerClosed = true
		} else if err := i.observer.FlushAndClose(closeContext); err != nil {
			result = errors.Join(result, err)
		} else {
			i.observerClosed = true
		}
	}
	return result
}
