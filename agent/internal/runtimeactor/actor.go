package runtimeactor

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/gatedsteering"
	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/runtimeapi"
)

var (
	ErrUnknownRuntime           = errors.New("Agent runtime is not registered")
	ErrStaleLaunch              = errors.New("Agent launch has been superseded")
	ErrAgentNotRunning          = errors.New("Agent is not running")
	ErrAgentIdle                = errors.New("Agent is idle and requires restart")
	ErrPendingFull              = errors.New("Agent pending delivery queue is full")
	ErrActorClosed              = errors.New("Runtime Actor is closed")
	ErrManagerClosed            = ErrActorClosed
	ErrAgentBoundary            = errors.New("Runtime Actor Agent boundary does not match")
	ErrActorRetiring            = errors.New("Runtime Actor is retiring")
	ErrTerminalRecoveryRequired = errors.New(
		"Agent terminal failure requires stop before restart",
	)
	ErrDirectDeliveryUnavailable = errors.New(
		"Agent runtime session cannot accept a direct delivery",
	)
)

const maxPendingDeliveries = 128

const runtimeErrorFingerprintFenceThreshold = 3

const rejectedIdleDeliveryRetryDelay = 15 * time.Second

type SleepFunc func(context.Context, time.Duration) error

type Options struct {
	AgentID        string
	Runtimes       runtimeapi.RuntimeResolver
	Coordinator    StartCoordinator
	RestartBackoff time.Duration
	Sleep          SleepFunc
	Now            func() time.Time
}

type StartCommand struct {
	AgentID           string
	LaunchID          string
	OperationID       string
	Runtime           string
	WorkingDirectory  string
	Prompt            string
	StandingPrompt    string
	SessionID         string
	Model             string
	ReasoningEffort   string
	ExecutionMode     string
	Environment       map[string]string
	RebindDelivery    *runtimeapi.Delivery
	PostStartDelivery *runtimeapi.Delivery
}

type Event struct {
	EventID         uint64 `json:"-"`
	AgentID         string `json:"agentId"`
	Runtime         string `json:"runtime"`
	Status          string `json:"status,omitempty"`
	ProgressVersion uint64 `json:"-"`
	runtimeapi.Event
}

type RuntimeProfile struct {
	AgentID          string
	LaunchID         string
	Runtime          string
	Model            string
	ReasoningEffort  string
	ExecutionMode    string
	WorkingDirectory string
	SessionID        string
	RuntimeHome      runtimeapi.RuntimeHomeInfo
}

type RuntimeProcessSnapshot struct {
	Liveness         runtimeapi.Liveness
	ProgressVersion  uint64
	SupportsStdin    bool
	BusyMode         runtimeapi.BusyDeliveryMode
	CompletionMode   runtimeapi.CompletionMode
	GatedPhase       string
	OutstandingTools int
	Compacting       bool
	ReviewKnown      bool
	Reviewing        bool
}

type StalledRecoveryResult struct {
	Handled bool
	Restart bool
}

type RetirementSnapshot struct {
	Version             uint64
	Retirable           bool
	HasCurrent          bool
	HasHandoff          bool
	HasErrorFence       bool
	HasPending          bool
	HasReservation      bool
	HasRetry            bool
	Terminal            bool
	BackgroundProducers int
	BufferedEvents      int
}

type record struct {
	jobToken          uint64
	launchID          string
	reservedLaunchID  string
	runtime           string
	session           runtimeapi.RuntimeSession
	profile           RuntimeProfile
	flushing          bool
	starting          bool
	idle              bool
	turnCompleted     bool
	readyForTransient bool
	restartFails      int
	cooldownUntil     time.Time
	pending           []runtimeapi.Delivery
	reserved          bool
	reserveRestart    bool
	recovering        bool
	retryScheduled    bool
	terminal          bool
	terminalError     string
	pendingHandoff    *pendingHandoff
	pendingStart      *StartCommand
	progressVersion   uint64
	lastTurnID        string
	steering          gatedsteering.State
	newDriver         runtimeapi.DriverFactory
	policy            runtimeapi.RuntimePolicy
}

type pendingHandoff struct {
	deliveries []runtimeapi.Delivery
}

type queuedStart struct {
	ctx      context.Context
	command  StartCommand
	result   chan error
	restart  bool
	jobToken uint64
}

type runtimeErrorFingerprintFence struct {
	fingerprint string
	attempts    int
	lastError   string
	launchID    string
}

type Actor struct {
	agentID     string
	runtimes    runtimeapi.RuntimeResolver
	sleep       SleepFunc
	now         func() time.Time
	backoff     time.Duration
	events      chan Event
	context     context.Context
	cancel      context.CancelFunc
	work        sync.WaitGroup
	closeOnce   sync.Once
	eventsOnce  sync.Once
	coordinator StartCoordinator
	ownsCoord   bool

	mu             sync.Mutex
	version        uint64
	nextJob        uint64
	nextEvent      uint64
	retiring       bool
	closed         bool
	producers      int
	outstanding    map[uint64]struct{}
	current        *record
	closingSession runtimeapi.RuntimeSession
	errorFence     *runtimeErrorFingerprintFence
	handoff        *pendingHandoff
}

func New(options Options) (*Actor, error) {
	agentID := strings.TrimSpace(options.AgentID)
	if agentID == "" {
		return nil, errors.New("Runtime Actor requires Agent identity")
	}
	runtimes := options.Runtimes
	if runtimes == nil {
		return nil, errors.New("Agent Actor requires at least one runtime driver")
	}
	sleep := options.Sleep
	if sleep == nil {
		sleep = sleepContext
	}
	now := options.Now
	if now == nil {
		now = time.Now
	}
	restartBackoff := options.RestartBackoff
	if restartBackoff <= 0 {
		restartBackoff = time.Second
	}
	managerContext, cancel := context.WithCancel(context.Background())
	coordinator := options.Coordinator
	ownsCoordinator := coordinator == nil
	if coordinator == nil {
		coordinator = newDirectCoordinator()
	}
	manager := &Actor{
		agentID:     agentID,
		runtimes:    runtimes,
		sleep:       sleep,
		now:         now,
		backoff:     restartBackoff,
		events:      make(chan Event, 512),
		context:     managerContext,
		cancel:      cancel,
		coordinator: coordinator,
		ownsCoord:   ownsCoordinator,
		outstanding: make(map[uint64]struct{}),
	}
	return manager, nil
}

func (m *Actor) Start(ctx context.Context, command StartCommand) error {
	if m == nil || ctx == nil {
		return ErrManagerClosed
	}
	if err := m.checkCommandAgent(command.AgentID); err != nil {
		return err
	}
	select {
	case <-m.context.Done():
		return ErrManagerClosed
	default:
	}
	if command.AgentID == "" || command.LaunchID == "" || command.Runtime == "" {
		return errors.New("Agent start requires Agent, launch, and runtime identity")
	}
	resolved, ok := m.runtimes.ResolveRuntime(command.Runtime)
	if !ok {
		return ErrUnknownRuntime
	}

	m.mu.Lock()
	existing := m.current
	if existing != nil && existing.session != nil {
		if existing.terminal && command.RebindDelivery != nil {
			m.mu.Unlock()
			return ErrTerminalRecoveryRequired
		}
		profile := runtimeProfileFromCommand(command)
		if sessionID := existing.session.SessionID(); sessionID != "" {
			profile.SessionID = sessionID
		} else if existing.profile.SessionID != "" {
			profile.SessionID = existing.profile.SessionID
		}
		profile.RuntimeHome = runtimeHomeInfo(existing.session)
		existing.launchID = command.LaunchID
		existing.reservedLaunchID = ""
		existing.runtime = command.Runtime
		existing.profile = profile
		delivery := command.RebindDelivery
		sessionID := profile.SessionID
		m.mu.Unlock()
		if sessionID != "" {
			m.emit(Event{
				AgentID: command.AgentID,
				Runtime: command.Runtime,
				Event: runtimeapi.Event{
					Kind:      runtimeapi.EventSession,
					SessionID: sessionID,
					LaunchID:  command.LaunchID,
				},
			})
		}
		if delivery != nil {
			err := m.Deliver(ctx, command.LaunchID, *delivery)
			if errors.Is(err, ErrAgentNotRunning) ||
				errors.Is(err, ErrStaleLaunch) ||
				errors.Is(err, ErrTerminalRecoveryRequired) {
				return err
			}
		}
		return nil
	}
	if existing != nil && existing.terminal {
		m.mu.Unlock()
		return ErrTerminalRecoveryRequired
	}
	var previous runtimeapi.RuntimeSession
	if existing != nil {
		previous = existing.session
	}
	reserved := existing != nil &&
		existing.launchID == command.LaunchID &&
		existing.reserved
	restart := existing != nil &&
		existing.launchID == command.LaunchID &&
		(existing.idle || existing.reserveRestart)
	if existing != nil &&
		existing.session == nil &&
		existing.starting &&
		!reserved &&
		!restart {
		pending := mergePendingStart(existing.pendingStart, command)
		existing.launchID = command.LaunchID
		existing.reservedLaunchID = ""
		existing.runtime = command.Runtime
		existing.profile = runtimeProfileFromCommand(command)
		existing.newDriver = resolved.NewDriver
		existing.policy = resolved.Policy
		existing.pendingStart = &pending
		m.mu.Unlock()
		return nil
	}
	if reserved {
		if command.SessionID == "" {
			command.SessionID = existing.profile.SessionID
		}
		existing.runtime = command.Runtime
		existing.profile = runtimeProfileFromCommand(command)
		existing.newDriver = resolved.NewDriver
		existing.policy = resolved.Policy
		existing.reserved = false
		existing.reserveRestart = false
		existing.starting = true
		existing.idle = false
		existing.turnCompleted = false
		existing.readyForTransient = false
		pending := command
		existing.pendingStart = &pending
		previous = nil
	} else if restart {
		if command.SessionID == "" {
			command.SessionID = existing.profile.SessionID
		}
		existing.runtime = command.Runtime
		existing.profile = runtimeProfileFromCommand(command)
		existing.newDriver = resolved.NewDriver
		existing.policy = resolved.Policy
		existing.starting = true
		existing.idle = false
		existing.turnCompleted = false
		existing.readyForTransient = false
		pending := command
		existing.pendingStart = &pending
	} else {
		handoff := m.handoff
		pending := command
		m.current = &record{
			launchID:       command.LaunchID,
			runtime:        command.Runtime,
			profile:        runtimeProfileFromCommand(command),
			starting:       true,
			pending:        deliveriesFromHandoff(handoff),
			pendingHandoff: handoff,
			pendingStart:   &pending,
			steering:       gatedsteering.Initial(),
			newDriver:      resolved.NewDriver,
			policy:         resolved.Policy,
		}
	}
	m.mu.Unlock()
	if previous != nil {
		stopCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_ = previous.Stop(stopCtx)
		cancel()
	}

	m.mu.Lock()
	current := m.current
	if current == nil {
		m.mu.Unlock()
		return ErrStaleLaunch
	}
	if current.jobToken == 0 {
		m.nextJob++
		current.jobToken = m.nextJob
	}
	jobToken := current.jobToken
	m.mu.Unlock()

	err := m.coordinator.Execute(
		ctx,
		StartJob{AgentID: command.AgentID, Token: jobToken},
		func(startCtx context.Context) error {
			if !m.beginProducer() {
				return ErrActorClosed
			}
			item := queuedStart{
				ctx:      startCtx,
				command:  command,
				result:   make(chan error, 1),
				restart:  restart,
				jobToken: jobToken,
			}
			m.startOne(item)
			return <-item.result
		},
	)
	if err != nil {
		m.failStart(jobToken, restart)
	}
	return err
}

func mergePendingStart(previous *StartCommand, next StartCommand) StartCommand {
	if previous == nil ||
		previous.RebindDelivery == nil ||
		next.RebindDelivery != nil {
		return next
	}
	next.Prompt = previous.Prompt
	delivery := *previous.RebindDelivery
	next.RebindDelivery = &delivery
	if previous.PostStartDelivery != nil {
		postStartDelivery := *previous.PostStartDelivery
		next.PostStartDelivery = &postStartDelivery
	}
	return next
}

func (m *Actor) Reserve(command StartCommand) error {
	if err := m.checkCommandAgent(command.AgentID); err != nil {
		return err
	}
	if command.AgentID == "" || command.LaunchID == "" || command.Runtime == "" {
		return errors.New("Agent start requires Agent, launch, and runtime identity")
	}
	resolved, ok := m.runtimes.ResolveRuntime(command.Runtime)
	if !ok {
		return ErrUnknownRuntime
	}

	m.mu.Lock()
	existing := m.current
	if existing != nil && existing.terminal {
		m.mu.Unlock()
		return ErrTerminalRecoveryRequired
	}
	if existing != nil && existing.launchID == command.LaunchID {
		switch {
		case existing.session != nil:
			m.mu.Unlock()
			return nil
		case existing.reserved || existing.starting:
			m.mu.Unlock()
			return nil
		case existing.idle:
			existing.newDriver = resolved.NewDriver
			existing.policy = resolved.Policy
			existing.reserved = true
			existing.reserveRestart = true
			existing.starting = true
			existing.idle = false
			m.mu.Unlock()
			return nil
		}
	}
	if existing != nil && existing.session != nil {
		existing.reservedLaunchID = command.LaunchID
		m.mu.Unlock()
		return nil
	}
	if existing != nil &&
		existing.session == nil &&
		(existing.reserved || existing.starting) {
		existing.reservedLaunchID = command.LaunchID
		m.mu.Unlock()
		return nil
	}

	var previous runtimeapi.RuntimeSession
	if existing != nil {
		previous = existing.session
	}
	handoff := m.handoff
	m.current = &record{
		launchID:       command.LaunchID,
		runtime:        command.Runtime,
		profile:        runtimeProfileFromCommand(command),
		starting:       true,
		reserved:       true,
		pending:        deliveriesFromHandoff(handoff),
		pendingHandoff: handoff,
		steering:       gatedsteering.Initial(),
		newDriver:      resolved.NewDriver,
		policy:         resolved.Policy,
	}
	m.mu.Unlock()

	if previous != nil {
		m.launchProducer(func() { stopRuntimeSession(previous) })
	}
	return nil
}

func (m *Actor) RetirementSnapshot() RetirementSnapshot {
	if m == nil {
		return RetirementSnapshot{Retirable: true}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	snapshot := RetirementSnapshot{Version: m.version}
	snapshot.BackgroundProducers = m.producers
	if current := m.current; current != nil {
		snapshot.HasCurrent = snapshot.HasCurrent || current.session != nil || current.idle || current.starting
		snapshot.HasPending = snapshot.HasPending || len(current.pending) != 0 || current.pendingStart != nil
		snapshot.HasReservation = snapshot.HasReservation || current.reserved || current.reservedLaunchID != ""
		snapshot.HasRetry = snapshot.HasRetry || current.retryScheduled || current.recovering
		snapshot.Terminal = snapshot.Terminal || current.terminal
	}
	snapshot.HasHandoff = m.handoff != nil
	snapshot.HasErrorFence = m.errorFence != nil
	snapshot.BufferedEvents = len(m.outstanding)
	snapshot.Retirable = !m.retiring &&
		!snapshot.HasCurrent &&
		!snapshot.HasHandoff &&
		!snapshot.HasErrorFence &&
		!snapshot.HasPending &&
		!snapshot.HasReservation &&
		!snapshot.HasRetry &&
		!snapshot.Terminal &&
		snapshot.BackgroundProducers == 0 &&
		snapshot.BufferedEvents == 0
	return snapshot
}

func (m *Actor) BeginRetire(version uint64) bool {
	if m == nil {
		return false
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.retiring || m.closed || m.version != version || m.current != nil || m.producers != 0 ||
		m.handoff != nil || m.errorFence != nil || len(m.outstanding) != 0 {
		return false
	}
	m.retiring = true
	m.version++
	return true
}

func (m *Actor) checkCommandAgent(agentID string) error {
	if m == nil {
		return ErrManagerClosed
	}
	m.mu.Lock()
	retiring := m.retiring
	closed := m.closed
	m.mu.Unlock()
	if closed {
		return ErrActorClosed
	}
	if retiring {
		return ErrActorRetiring
	}
	if strings.TrimSpace(agentID) != m.agentID {
		return ErrAgentBoundary
	}
	return nil
}

func (m *Actor) CancelReservation(launchID string) error {
	if launchID == "" {
		return errors.New("reservation cancellation requires launch identity")
	}
	m.mu.Lock()
	defer m.mu.Unlock()

	current := m.current
	if current == nil {
		return nil
	}
	if current.reservedLaunchID == launchID {
		current.reservedLaunchID = ""
		return nil
	}
	if current.launchID != launchID {
		return ErrStaleLaunch
	}
	if !current.reserved {
		return nil
	}
	if current.reserveRestart {
		current.reserved = false
		current.reserveRestart = false
		current.starting = false
		current.idle = true
		return nil
	}
	if current.session != nil {
		current.reserved = false
		current.starting = false
		return nil
	}
	m.current = nil
	return nil
}

func (m *Actor) Stop(ctx context.Context, launchID string) error {
	m.mu.Lock()
	m.errorFence = nil
	current := m.current
	if current == nil {
		m.mu.Unlock()
		return nil
	}
	if launchID != "" &&
		current.launchID != launchID &&
		current.reservedLaunchID != launchID {
		m.mu.Unlock()
		return ErrStaleLaunch
	}
	if current.terminal && len(current.pending) > 0 {
		m.handoff = &pendingHandoff{
			deliveries: append(
				[]runtimeapi.Delivery(nil),
				current.pending...,
			),
		}
	}
	m.current = nil
	session := current.session
	m.mu.Unlock()
	if session == nil {
		return nil
	}
	return session.Stop(ctx)
}

func (m *Actor) Deliver(ctx context.Context, launchID string, delivery runtimeapi.Delivery) error {
	agentID := m.agentID
	m.mu.Lock()
	current := m.current
	if current == nil {
		m.mu.Unlock()
		if delivery.Transient {
			return nil
		}
		return ErrAgentNotRunning
	}
	if launchID != "" &&
		current.launchID != launchID &&
		current.reservedLaunchID != launchID {
		m.mu.Unlock()
		return ErrStaleLaunch
	}
	if current.terminal {
		if delivery.Transient {
			m.mu.Unlock()
			return nil
		}
		if len(current.pending) >= maxPendingDeliveries {
			m.mu.Unlock()
			return ErrPendingFull
		}
		current.pending = append(current.pending, delivery)
		current.progressVersion++
		statusVersion := current.progressVersion
		current.progressVersion++
		errorVersion := current.progressVersion
		runtimeName := current.runtime
		detail := current.terminalError
		terminalLaunchID := current.launchID
		m.mu.Unlock()
		m.emit(Event{
			AgentID:         agentID,
			Runtime:         runtimeName,
			Status:          "inactive",
			ProgressVersion: statusVersion,
			Event: runtimeapi.Event{
				Kind:     runtimeapi.EventStatus,
				LaunchID: terminalLaunchID,
			},
		})
		m.emit(Event{
			AgentID:         agentID,
			Runtime:         runtimeName,
			ProgressVersion: errorVersion,
			Event: runtimeapi.Event{
				Kind:     runtimeapi.EventTerminalFailure,
				Text:     detail,
				LaunchID: terminalLaunchID,
			},
		})
		return nil
	}
	if current.session == nil || current.flushing {
		idle := current.idle
		inCooldown := idle && m.now().Before(current.cooldownUntil)
		if delivery.Transient && !inCooldown {
			m.mu.Unlock()
			if idle {
				return ErrAgentIdle
			}
			return nil
		}
		if len(current.pending) >= maxPendingDeliveries {
			m.mu.Unlock()
			return ErrPendingFull
		}
		current.pending = append(current.pending, delivery)
		m.mu.Unlock()
		if idle && !inCooldown {
			return ErrAgentIdle
		}
		return nil
	}
	if delivery.Transient &&
		!current.turnCompleted &&
		!current.readyForTransient {
		m.mu.Unlock()
		return nil
	}
	session := current.session
	effectiveLaunchID := current.launchID
	current.turnCompleted = false
	current.readyForTransient = false
	m.mu.Unlock()
	err := session.Deliver(ctx, delivery)
	if err == nil {
		return nil
	}
	disposition, rejected := runtimeapi.DeliveryRetryDisposition(err)
	if !rejected {
		return err
	}
	return m.restoreRejectedDelivery(
		agentID,
		effectiveLaunchID,
		session,
		delivery,
		disposition,
	)
}

// DeliverDirect succeeds only when the live RuntimeSession accepts the
// delivery during this call. It never transfers ownership to Actor.pending,
// which lets durable callers advance an external cursor without mistaking an
// in-memory buffer for Runtime acceptance.
func (m *Actor) DeliverDirect(
	ctx context.Context,
	launchID string,
	delivery runtimeapi.Delivery,
) error {
	if m == nil || ctx == nil {
		return ErrActorClosed
	}
	m.mu.Lock()
	current := m.current
	if current == nil {
		m.mu.Unlock()
		return ErrDirectDeliveryUnavailable
	}
	if launchID != "" && current.launchID != launchID {
		m.mu.Unlock()
		return ErrStaleLaunch
	}
	if current.session == nil || current.starting || current.flushing ||
		current.terminal || current.idle {
		m.mu.Unlock()
		return ErrDirectDeliveryUnavailable
	}
	if delivery.Transient && (!current.turnCompleted || !current.readyForTransient) {
		m.mu.Unlock()
		return ErrDirectDeliveryUnavailable
	}
	session := current.session
	current.turnCompleted = false
	current.readyForTransient = false
	m.mu.Unlock()
	return session.Deliver(ctx, delivery)
}

// QueueAccepted transfers a delivery that was already accepted by an outer
// lifecycle buffer into the current Runtime turn boundary. It intentionally
// preserves transient identity while bypassing the ordinary busy-transient
// drop: acceptance happened before the Runtime process existed.
func (m *Actor) QueueAccepted(
	launchID string,
	delivery runtimeapi.Delivery,
) error {
	agentID := m.agentID
	m.mu.Lock()
	current := m.current
	if current == nil {
		m.mu.Unlock()
		return ErrAgentNotRunning
	}
	if launchID != "" && current.launchID != launchID {
		m.mu.Unlock()
		return ErrStaleLaunch
	}
	if current.session == nil {
		idle := current.idle
		m.mu.Unlock()
		if idle {
			return ErrAgentIdle
		}
		return ErrAgentNotRunning
	}
	if len(current.pending) >= maxPendingDeliveries {
		m.mu.Unlock()
		return ErrPendingFull
	}
	current.pending = append(current.pending, delivery)
	current.flushing = true
	schedule := current.turnCompleted && !current.retryScheduled
	session := current.session
	effectiveLaunchID := current.launchID
	if schedule {
		current.retryScheduled = true
	}
	m.mu.Unlock()
	if schedule {
		m.launchProducer(func() {
			m.retryRejectedDelivery(agentID, effectiveLaunchID, session)
		})
	}
	return nil
}

func (m *Actor) restoreRejectedDelivery(
	agentID string,
	launchID string,
	session runtimeapi.RuntimeSession,
	delivery runtimeapi.Delivery,
	disposition runtimeapi.RetryDisposition,
) error {
	m.mu.Lock()
	current := m.current
	if current == nil || current.launchID != launchID || current.session != session {
		m.mu.Unlock()
		return ErrStaleLaunch
	}
	if len(current.pending) >= maxPendingDeliveries {
		m.mu.Unlock()
		return ErrPendingFull
	}
	current.pending = append(
		[]runtimeapi.Delivery{delivery},
		current.pending...,
	)
	current.flushing = true
	scheduleDelayed := disposition == runtimeapi.RetryDelayedIdle &&
		!current.retryScheduled
	retryNow := disposition == runtimeapi.RetryTurnBoundary &&
		current.turnCompleted &&
		!current.retryScheduled
	schedule := scheduleDelayed || retryNow
	if schedule {
		current.retryScheduled = true
	}
	m.mu.Unlock()
	if retryNow {
		m.launchProducer(func() {
			m.retryRejectedDelivery(agentID, launchID, session)
		})
	} else if scheduleDelayed {
		m.scheduleRejectedDeliveryRetry(agentID, launchID, session)
	}
	return nil
}

func (m *Actor) scheduleRejectedDeliveryRetry(
	agentID string,
	launchID string,
	session runtimeapi.RuntimeSession,
) {
	m.launchProducer(func() {
		if err := m.sleep(m.context, rejectedIdleDeliveryRetryDelay); err != nil {
			m.clearRejectedDeliveryRetry(agentID, launchID, session)
			return
		}
		m.retryRejectedDelivery(agentID, launchID, session)
	})
}

func (m *Actor) clearRejectedDeliveryRetry(
	agentID string,
	launchID string,
	session runtimeapi.RuntimeSession,
) {
	m.mu.Lock()
	defer m.mu.Unlock()
	current := m.current
	if current == nil || current.launchID != launchID || current.session != session {
		return
	}
	current.retryScheduled = false
}

func (m *Actor) retryRejectedDelivery(
	agentID string,
	launchID string,
	session runtimeapi.RuntimeSession,
) {
	m.mu.Lock()
	current := m.current
	if current == nil || current.launchID != launchID || current.session != session {
		m.mu.Unlock()
		return
	}
	if len(current.pending) == 0 {
		current.flushing = false
		current.retryScheduled = false
		m.mu.Unlock()
		return
	}
	delivery := current.pending[0]
	delivery.Mode = "idle"
	current.turnCompleted = false
	current.readyForTransient = false
	m.mu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	err := session.Deliver(ctx, delivery)
	cancel()

	m.mu.Lock()
	current = m.current
	if current == nil || current.launchID != launchID || current.session != session {
		m.mu.Unlock()
		return
	}
	if err == nil {
		if len(current.pending) > 0 {
			current.pending = current.pending[1:]
		}
		current.retryScheduled = false
		if len(current.pending) == 0 {
			current.flushing = false
		}
		m.mu.Unlock()
		return
	}
	disposition, rejected := runtimeapi.DeliveryRetryDisposition(err)
	current.retryScheduled = false
	schedule := rejected && disposition == runtimeapi.RetryDelayedIdle
	if schedule {
		current.retryScheduled = true
	}
	if !rejected {
		current.flushing = false
	}
	m.mu.Unlock()
	if schedule {
		m.scheduleRejectedDeliveryRetry(agentID, launchID, session)
	}
}

func (m *Actor) RecoverStalled(
	ctx context.Context,
	launchID string,
	delivery runtimeapi.Delivery,
) (StalledRecoveryResult, error) {
	agentID := m.agentID
	return m.recoverStalled(ctx, agentID, launchID, nil, delivery)
}

func (m *Actor) RecoverStalledAt(
	ctx context.Context,
	launchID string,
	expectedProgressVersion uint64,
	delivery runtimeapi.Delivery,
) (StalledRecoveryResult, error) {
	agentID := m.agentID
	return m.recoverStalled(
		ctx,
		agentID,
		launchID,
		&expectedProgressVersion,
		delivery,
	)
}

func (m *Actor) recoverStalled(
	ctx context.Context,
	agentID string,
	launchID string,
	expectedProgressVersion *uint64,
	delivery runtimeapi.Delivery,
) (StalledRecoveryResult, error) {
	m.mu.Lock()
	current := m.current
	if current == nil {
		m.mu.Unlock()
		return StalledRecoveryResult{}, ErrAgentNotRunning
	}
	if launchID != "" && current.launchID != launchID {
		m.mu.Unlock()
		return StalledRecoveryResult{}, ErrStaleLaunch
	}
	if expectedProgressVersion != nil &&
		current.progressVersion != *expectedProgressVersion {
		m.mu.Unlock()
		return StalledRecoveryResult{}, nil
	}
	if current.recovering {
		if len(current.pending) >= maxPendingDeliveries {
			m.mu.Unlock()
			return StalledRecoveryResult{Handled: true}, ErrPendingFull
		}
		current.pending = append(current.pending, delivery)
		m.mu.Unlock()
		return StalledRecoveryResult{Handled: true}, nil
	}
	if current.session == nil {
		m.mu.Unlock()
		return StalledRecoveryResult{}, nil
	}
	if !m.stalledRecoveryAllowed(current) {
		m.mu.Unlock()
		return StalledRecoveryResult{}, nil
	}
	if len(current.pending) >= maxPendingDeliveries {
		m.mu.Unlock()
		return StalledRecoveryResult{Handled: true}, ErrPendingFull
	}

	session := current.session
	runtimeName := current.runtime
	current.pending = append(current.pending, delivery)
	current.session = nil
	current.flushing = false
	current.starting = false
	current.idle = true
	current.turnCompleted = false
	current.readyForTransient = false
	current.recovering = true
	current.progressVersion++
	current.steering = gatedsteering.ExpectTermination(
		current.steering,
		"stalled_recovery",
	)
	progressVersion := current.progressVersion
	m.mu.Unlock()

	m.emit(Event{
		AgentID:         agentID,
		Runtime:         runtimeName,
		ProgressVersion: progressVersion,
		Event: runtimeapi.Event{
			Kind:       runtimeapi.EventRecovery,
			Text:       "Restarting stalled " + runtimeDisplayName(runtimeName) + " runtime for queued message",
			DetailKind: "stalled_recovery",
			LaunchID:   launchID,
		},
	})
	stopCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	_ = session.Stop(stopCtx)
	cancel()
	return StalledRecoveryResult{Handled: true, Restart: true}, nil
}

func (m *Actor) Events() <-chan Event {
	return m.events
}

func (m *Actor) emit(event Event) bool {
	m.mu.Lock()
	if m.retiring {
		m.mu.Unlock()
		return false
	}
	m.nextEvent++
	event.EventID = m.nextEvent
	m.outstanding[event.EventID] = struct{}{}
	m.version++
	m.mu.Unlock()
	select {
	case <-m.context.Done():
		m.AckEvent(event.EventID)
		return false
	case m.events <- event:
		return true
	}
}

func (m *Actor) AckEvent(eventID uint64) {
	if m == nil || eventID == 0 {
		return
	}
	m.mu.Lock()
	if _, ok := m.outstanding[eventID]; ok {
		delete(m.outstanding, eventID)
		m.version++
	}
	m.mu.Unlock()
}

func (m *Actor) Close(ctx context.Context) error {
	if m == nil {
		return nil
	}
	if ctx == nil {
		return ErrManagerClosed
	}
	m.closeOnce.Do(func() {
		m.mu.Lock()
		m.closed = true
		m.version++
		m.mu.Unlock()
		m.cancel()
	})
	var coordinatorErr error
	if m.ownsCoord {
		coordinatorErr = m.coordinator.Close(ctx)
	}
	m.mu.Lock()
	if m.closingSession == nil && m.current != nil {
		m.closingSession = m.current.session
	}
	session := m.closingSession
	m.current = nil
	m.errorFence = nil
	m.handoff = nil
	m.mu.Unlock()
	var sessionErr error
	if session != nil {
		sessionErr = session.Stop(ctx)
		if sessionErr == nil {
			m.mu.Lock()
			if m.closingSession == session {
				m.closingSession = nil
			}
			m.mu.Unlock()
		}
	}
	waited := make(chan struct{})
	go func() {
		m.work.Wait()
		close(waited)
	}()
	select {
	case <-waited:
		m.eventsOnce.Do(func() { close(m.events) })
		return errors.Join(coordinatorErr, sessionErr)
	case <-ctx.Done():
		return errors.Join(coordinatorErr, sessionErr, ctx.Err())
	}
}

func (m *Actor) Running() bool {
	if m == nil {
		return false
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	current := m.current
	return current != nil && current.session != nil
}

func (m *Actor) Profile() (RuntimeProfile, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if current := m.current; current != nil {
		if current.session == nil && !current.idle {
			return RuntimeProfile{}, false
		}
		return current.profile, true
	}
	return RuntimeProfile{}, false
}

func (m *Actor) Liveness(launchID string) runtimeapi.Liveness {
	return m.ProcessSnapshot(launchID).Liveness
}

func (m *Actor) ProcessSnapshot(
	launchID string,
) RuntimeProcessSnapshot {
	m.mu.Lock()
	current := m.current
	if current == nil ||
		(launchID != "" && current.launchID != launchID) ||
		current.session == nil {
		m.mu.Unlock()
		return RuntimeProcessSnapshot{Liveness: runtimeapi.LivenessUnknown}
	}
	session := current.session
	m.mu.Unlock()

	liveness := runtimeapi.LivenessUnknown
	prober, ok := session.(runtimeapi.LivenessProber)
	if ok {
		switch observed := prober.RuntimeLiveness(); observed {
		case runtimeapi.LivenessAlive, runtimeapi.LivenessDead:
			liveness = observed
		}
	}

	m.mu.Lock()
	current = m.current
	if current == nil ||
		current.session != session ||
		(launchID != "" && current.launchID != launchID) {
		m.mu.Unlock()
		return RuntimeProcessSnapshot{Liveness: runtimeapi.LivenessUnknown}
	}
	progressVersion := current.progressVersion
	snapshot := m.steeringSnapshot(current)
	m.mu.Unlock()
	return RuntimeProcessSnapshot{
		Liveness:         liveness,
		ProgressVersion:  progressVersion,
		SupportsStdin:    snapshot.SupportsStdin,
		BusyMode:         snapshot.BusyMode,
		CompletionMode:   snapshot.CompletionMode,
		GatedPhase:       snapshot.GatedPhase,
		OutstandingTools: snapshot.OutstandingTools,
		Compacting:       snapshot.Compacting,
		ReviewKnown:      snapshot.ReviewKnown,
		Reviewing:        snapshot.Reviewing,
	}
}

func (m *Actor) startOne(item queuedStart) {
	defer m.finishProducer()
	startContext, cancel := context.WithCancel(item.ctx)
	stopCancel := context.AfterFunc(m.context, cancel)
	defer func() {
		stopCancel()
		cancel()
	}()
	command := item.command
	m.mu.Lock()
	current := m.current
	if current == nil || current.jobToken != item.jobToken {
		m.mu.Unlock()
		item.result <- ErrStaleLaunch
		return
	}
	if current.pendingStart != nil {
		command = *current.pendingStart
		current.pendingStart = nil
	}
	if current.launchID != command.LaunchID {
		m.mu.Unlock()
		item.result <- ErrStaleLaunch
		return
	}
	startupConsumedPending := false
	if current.pendingHandoff != nil &&
		len(current.pending) > 0 &&
		command.Prompt == "Start." &&
		current.pending[0].Text != "" {
		command.Prompt = current.pending[0].Text
		startupConsumedPending = true
	}
	startedTurn := strings.TrimSpace(command.Prompt) != "" ||
		strings.TrimSpace(command.StandingPrompt) != ""
	newDriver := current.newDriver
	m.mu.Unlock()

	if newDriver == nil {
		err := fmt.Errorf("Runtime %q has no Driver factory", command.Runtime)
		m.failStart(item.jobToken, item.restart)
		item.result <- err
		return
	}
	driver, err := newDriver()
	if err != nil {
		m.failStart(item.jobToken, item.restart)
		item.result <- errors.New("Runtime Driver creation failed")
		return
	}
	if driver == nil {
		err := fmt.Errorf("Runtime %q factory returned nil Driver", command.Runtime)
		m.failStart(item.jobToken, item.restart)
		item.result <- err
		return
	}
	session, err := driver.Start(startContext, runtimeapi.StartRequest{
		AgentID:          command.AgentID,
		LaunchID:         command.LaunchID,
		WorkingDirectory: command.WorkingDirectory,
		Prompt:           command.Prompt,
		StandingPrompt:   command.StandingPrompt,
		SessionID:        command.SessionID,
		Model:            command.Model,
		ReasoningEffort:  command.ReasoningEffort,
		ExecutionMode:    command.ExecutionMode,
		Environment:      copyEnvironment(command.Environment),
	})
	if err != nil {
		m.failStart(item.jobToken, item.restart)
		item.result <- err
		return
	}
	if session == nil {
		err := fmt.Errorf("Runtime %q returned nil session", command.Runtime)
		m.failStart(item.jobToken, item.restart)
		item.result <- err
		return
	}
	if err := startContext.Err(); err != nil {
		stopCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_ = session.Stop(stopCtx)
		cancel()
		m.failStart(item.jobToken, item.restart)
		item.result <- err
		return
	}
	runtimeHome := runtimeHomeInfo(session)

	m.mu.Lock()
	current = m.current
	if current == nil || current.launchID != command.LaunchID {
		m.mu.Unlock()
		stopCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_ = session.Stop(stopCtx)
		cancel()
		item.result <- ErrStaleLaunch
		return
	}
	current.session = session
	current.starting = false
	current.idle = false
	current.turnCompleted = false
	current.lastTurnID = ""
	current.readyForTransient = false
	current.restartFails = 0
	current.cooldownUntil = time.Time{}
	current.recovering = false
	current.steering = gatedsteering.Initial()
	if sessionID := session.SessionID(); sessionID != "" {
		current.profile.SessionID = sessionID
	}
	current.profile.RuntimeHome = runtimeHome
	current.flushing = true
	pending := append([]runtimeapi.Delivery(nil), current.pending...)
	handoff := current.pendingHandoff
	if startupConsumedPending && len(pending) > 0 {
		pending = pending[1:]
	}
	current.pending = nil
	m.mu.Unlock()

	if startupConsumedPending {
		m.ackPendingHandoff(command.AgentID, handoff)
	}
	for {
		for index, delivery := range pending {
			if err := session.Deliver(startContext, delivery); err != nil {
				m.failDeliveryFlush(
					command.AgentID,
					command.LaunchID,
					session,
					item.restart,
					pending[index:],
				)
				stopCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				_ = session.Stop(stopCtx)
				cancel()
				item.result <- err
				return
			}
			startedTurn = true
			m.ackPendingHandoff(command.AgentID, handoff)
		}
		m.mu.Lock()
		current = m.current
		if current == nil || current.launchID != command.LaunchID || current.session != session {
			m.mu.Unlock()
			stopCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			_ = session.Stop(stopCtx)
			cancel()
			item.result <- ErrStaleLaunch
			return
		}
		if len(current.pending) == 0 {
			if command.PostStartDelivery != nil {
				postStartDelivery := *command.PostStartDelivery
				current.pending = append(current.pending, postStartDelivery)
				command.PostStartDelivery = nil
				current.flushing = true
			} else {
				current.flushing = false
				current.readyForTransient = !startedTurn
			}
			m.mu.Unlock()
			break
		}
		pending = append(pending[:0], current.pending...)
		current.pending = nil
		m.mu.Unlock()
	}
	if !m.beginProducer() {
		m.mu.Lock()
		if m.current != nil && m.current.session == session {
			m.current = nil
		}
		m.mu.Unlock()
		stopRuntimeSession(session)
		item.result <- ErrActorClosed
		return
	}
	go m.forward(command.AgentID, command.LaunchID, command.Runtime, session)
	item.result <- nil
}

func (m *Actor) ackPendingHandoff(agentID string, handoff *pendingHandoff) {
	if handoff == nil {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.handoff != handoff || len(handoff.deliveries) == 0 {
		return
	}
	handoff.deliveries = handoff.deliveries[1:]
	if len(handoff.deliveries) != 0 {
		return
	}
	m.handoff = nil
	if current := m.current; current != nil &&
		current.pendingHandoff == handoff {
		current.pendingHandoff = nil
	}
}

func (m *Actor) forward(agentID string, launchID string, runtimeName string, session runtimeapi.RuntimeSession) {
	defer m.finishProducer()
	events := session.Events()
eventLoop:
	for {
		var event runtimeapi.Event
		select {
		case <-m.context.Done():
			return
		case next, ok := <-events:
			if !ok {
				break eventLoop
			}
			event = next
		}
		m.mu.Lock()
		current := m.current
		active := current != nil && current.session == session
		effectiveLaunchID := launchID
		var progressVersion uint64
		var fingerprintFenced bool
		var stickyTerminal bool
		var retryAtTurnBoundary bool
		if active {
			effectiveLaunchID = current.launchID
			current.progressVersion++
			progressVersion = current.progressVersion
			current.steering = m.reduceSteering(current, event.Kind)
			if runtimeErrorFingerprintFenceResetEvent(event.Kind) {
				m.errorFence = nil
			}
			if event.Kind == runtimeapi.EventError {
				if runtimeapi.RuntimeErrorIsStickyTerminal(event.Text) {
					stickyTerminal = true
					current.session = nil
					current.flushing = false
					current.starting = false
					current.idle = false
					current.turnCompleted = false
					current.readyForTransient = false
					current.recovering = false
					current.retryScheduled = false
					current.terminal = true
					current.terminalError = event.Text
					m.errorFence = nil
				} else if detail, fenced := m.noteRuntimeErrorFingerprintFence(
					agentID,
					effectiveLaunchID,
					event.Text,
				); fenced {
					event.RuntimeErrorMessage = event.Text
					event.Text = detail
					fingerprintFenced = true
					m.current = nil
				}
			}
		}
		if active && event.Kind == runtimeapi.EventSession && event.SessionID != "" {
			current.profile.SessionID = event.SessionID
		}
		if active && event.TurnID != "" {
			current.lastTurnID = event.TurnID
		}
		if active && event.Kind == runtimeapi.EventTurnCompletion {
			current.turnCompleted = true
			current.readyForTransient = false
			if current.flushing &&
				len(current.pending) > 0 &&
				!current.retryScheduled {
				current.retryScheduled = true
				retryAtTurnBoundary = true
			}
		}
		m.mu.Unlock()
		if os.Getenv("RAFT_COMPUTER_GO_TRACE_CODEX_METHODS") == "1" &&
			event.Kind == runtimeapi.EventTurnCompletion {
			_, _ = fmt.Fprintf(
				os.Stderr,
				"agent manager event=%q active=%t\n",
				event.Kind,
				active,
			)
		}
		if !active {
			continue
		}
		if retryAtTurnBoundary {
			m.retryRejectedDelivery(agentID, effectiveLaunchID, session)
		}
		if (fingerprintFenced || stickyTerminal) &&
			!isLocalOnlyLaunchID(effectiveLaunchID) {
			event.LaunchID = ""
		} else {
			event.LaunchID = effectiveLaunchID
		}
		if fingerprintFenced || stickyTerminal {
			m.emit(Event{
				AgentID: agentID,
				Runtime: runtimeName,
				Status:  "inactive",
				Event: runtimeapi.Event{
					Kind:     runtimeapi.EventStatus,
					LaunchID: effectiveLaunchID,
				},
			})
		}
		m.emit(Event{
			AgentID:         agentID,
			Runtime:         runtimeName,
			ProgressVersion: progressVersion,
			Event:           event,
		})
		if fingerprintFenced || stickyTerminal {
			m.launchProducer(func() { stopRuntimeSession(session) })
			return
		}
	}
	m.finishSession(agentID, session)
}

func (m *Actor) finishSession(agentID string, session runtimeapi.RuntimeSession) {
	m.mu.Lock()
	current := m.current
	if current == nil || current.session != session {
		m.mu.Unlock()
		return
	}
	launchID := current.launchID
	if current.turnCompleted {
		durablePending := current.pending[:0]
		for _, delivery := range current.pending {
			if !delivery.Transient {
				durablePending = append(durablePending, delivery)
			}
		}
		clear(current.pending[len(durablePending):])
		current.pending = durablePending
		current.session = nil
		current.flushing = false
		current.starting = false
		current.idle = true
		current.retryScheduled = false
		m.mu.Unlock()
		return
	}
	runtimeName := current.runtime
	m.current = nil
	m.errorFence = nil
	m.mu.Unlock()
	m.emit(Event{
		AgentID: agentID,
		Runtime: runtimeName,
		Status:  "inactive",
		Event: runtimeapi.Event{
			Kind:     runtimeapi.EventStatus,
			LaunchID: launchID,
		},
	})
}

func (m *Actor) failDeliveryFlush(
	agentID string,
	launchID string,
	session runtimeapi.RuntimeSession,
	restart bool,
	remaining []runtimeapi.Delivery,
) {
	m.mu.Lock()
	defer m.mu.Unlock()

	current := m.current
	if current == nil || current.launchID != launchID || current.session != session {
		return
	}
	if !restart {
		m.current = nil
		return
	}

	pending := make([]runtimeapi.Delivery, 0, len(remaining)+len(current.pending))
	pending = append(pending, remaining...)
	pending = append(pending, current.pending...)
	current.pending = pending
	current.session = nil
	current.starting = false
	current.flushing = false
	current.idle = true
	current.restartFails++
	current.cooldownUntil = m.now().Add(m.restartDelay(current.restartFails))
	current.recovering = false
}

func (m *Actor) failStart(jobToken uint64, restart bool) {
	m.mu.Lock()
	defer m.mu.Unlock()

	current := m.current
	if current == nil || current.jobToken != jobToken {
		return
	}
	if !current.starting {
		return
	}
	if restart {
		current.session = nil
		current.starting = false
		current.flushing = false
		current.idle = true
		current.restartFails++
		current.cooldownUntil = m.now().Add(m.restartDelay(current.restartFails))
		current.recovering = false
		return
	}
	m.current = nil
}

func stopRuntimeSession(session runtimeapi.RuntimeSession) {
	stopCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = session.Stop(stopCtx)
}

func (m *Actor) restartDelay(attempt int) time.Duration {
	delay := m.backoff
	for current := 1; current < attempt && delay < 30*time.Second; current++ {
		delay *= 2
	}
	if delay > 30*time.Second {
		return 30 * time.Second
	}
	return delay
}

func runtimeProfileFromCommand(command StartCommand) RuntimeProfile {
	return RuntimeProfile{
		AgentID:          command.AgentID,
		LaunchID:         command.LaunchID,
		Runtime:          command.Runtime,
		Model:            command.Model,
		ReasoningEffort:  command.ReasoningEffort,
		ExecutionMode:    command.ExecutionMode,
		WorkingDirectory: command.WorkingDirectory,
		SessionID:        command.SessionID,
	}
}

func runtimeHomeInfo(session runtimeapi.RuntimeSession) runtimeapi.RuntimeHomeInfo {
	provider, ok := session.(runtimeapi.RuntimeHomeProvider)
	if !ok {
		return runtimeapi.RuntimeHomeInfo{}
	}
	return provider.RuntimeHomeInfo()
}

func copyEnvironment(input map[string]string) map[string]string {
	result := make(map[string]string, len(input))
	for key, value := range input {
		result[key] = value
	}
	return result
}

func deliveriesFromHandoff(handoff *pendingHandoff) []runtimeapi.Delivery {
	if handoff == nil {
		return nil
	}
	return append([]runtimeapi.Delivery(nil), handoff.deliveries...)
}

func runtimeDisplayName(runtimeName string) string {
	switch runtimeName {
	case "opencode":
		return "OpenCode"
	default:
		if runtimeName == "" {
			return "Agent"
		}
		return runtimeName
	}
}

func (m *Actor) stalledRecoveryAllowed(current *record) bool {
	policy := current.policy
	if !policy.SupportsStdin {
		return true
	}
	return policy.BusyMode == runtimeapi.BusyDeliveryDirect &&
		current.session != nil &&
		current.steering.OutstandingTools == 0
}

func (m *Actor) reduceSteering(
	current *record,
	kind runtimeapi.EventKind,
) gatedsteering.State {
	signal, ok := runtimeSteeringSignal(kind)
	if !ok {
		return gatedsteering.RecordEvent(current.steering, string(kind))
	}
	policy := m.runtimePolicy(current)
	decision := gatedsteering.Apply(current.steering, gatedsteering.Input{
		Signal:        signal,
		InboxLength:   len(current.pending),
		SupportsStdin: policy.SupportsStdin,
		HasSession:    current.session != nil,
	})
	return gatedsteering.RecordEvent(decision.State, string(kind))
}

func runtimeSteeringSignal(kind runtimeapi.EventKind) (gatedsteering.Signal, bool) {
	switch kind {
	case runtimeapi.EventThinking, runtimeapi.EventAssistantText:
		return gatedsteering.AssistantContinued, true
	case runtimeapi.EventToolCall:
		return gatedsteering.ToolCall, true
	case runtimeapi.EventToolOutput:
		return gatedsteering.ToolOutput, true
	case runtimeapi.EventCompactionStarted:
		return gatedsteering.CompactionStarted, true
	case runtimeapi.EventCompactionFinished:
		return gatedsteering.CompactionFinished, true
	case runtimeapi.EventReviewStarted:
		return gatedsteering.ReviewStarted, true
	case runtimeapi.EventReviewFinished:
		return gatedsteering.ReviewFinished, true
	case runtimeapi.EventTurnCompletion:
		return gatedsteering.TurnEnded, true
	case runtimeapi.EventError:
		return gatedsteering.RuntimeError, true
	default:
		return "", false
	}
}

func (m *Actor) runtimePolicy(current *record) runtimeapi.RuntimePolicy {
	if current == nil {
		return runtimeapi.RuntimePolicy{}
	}
	return current.policy
}

func (m *Actor) steeringSnapshot(current *record) RuntimeProcessSnapshot {
	policy := m.runtimePolicy(current)
	return RuntimeProcessSnapshot{
		SupportsStdin:    policy.SupportsStdin,
		BusyMode:         policy.BusyMode,
		CompletionMode:   policy.Completion,
		GatedPhase:       string(current.steering.Phase),
		OutstandingTools: current.steering.OutstandingTools,
		Compacting:       current.steering.Compacting,
		ReviewKnown:      current.steering.ReviewKnown,
		Reviewing:        current.steering.Reviewing,
	}
}

func runtimeErrorFingerprintFenceResetEvent(kind runtimeapi.EventKind) bool {
	switch kind {
	case runtimeapi.EventThinking,
		runtimeapi.EventAssistantText,
		runtimeapi.EventToolCall,
		runtimeapi.EventToolOutput,
		runtimeapi.EventCompactionFinished,
		runtimeapi.EventReviewFinished,
		runtimeapi.EventTurnCompletion:
		return true
	default:
		return false
	}
}

func (m *Actor) noteRuntimeErrorFingerprintFence(
	_ string,
	launchID string,
	message string,
) (string, bool) {
	if !runtimeapi.RuntimeErrorFingerprintFenceEligible(message) {
		return "", false
	}
	fingerprint := runtimeapi.FingerprintRuntimeError(message)
	state := runtimeErrorFingerprintFence{}
	if m.errorFence != nil {
		state = *m.errorFence
	}
	if state.fingerprint != fingerprint {
		state = runtimeErrorFingerprintFence{fingerprint: fingerprint}
	}
	state.attempts++
	state.lastError = message
	state.launchID = launchID
	m.errorFence = &state
	if state.attempts < runtimeErrorFingerprintFenceThreshold {
		return "", false
	}
	return "Runtime stopped after " +
		fmt.Sprintf("%d", state.attempts) +
		" repeated runtime errors with the same fingerprint (" +
		state.fingerprint +
		"). Last error: " +
		state.lastError +
		" Restart after the runtime/tooling issue is fixed.", true
}

func sleepContext(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func (m *Actor) beginProducer() bool {
	if m == nil {
		return false
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed || m.retiring {
		return false
	}
	m.producers++
	m.version++
	m.work.Add(1)
	return true
}

func (m *Actor) finishProducer() {
	m.mu.Lock()
	if m.producers > 0 {
		m.producers--
		m.version++
	}
	m.mu.Unlock()
	m.work.Done()
}

func (m *Actor) launchProducer(run func()) bool {
	if run == nil || !m.beginProducer() {
		return false
	}
	go func() {
		defer m.finishProducer()
		run()
	}()
	return true
}
