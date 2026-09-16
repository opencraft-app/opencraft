package daemon

import (
	"context"
	"errors"
	"sync"
	"time"
)

type desiredAgent struct {
	assignment AgentAssignment
	epoch      string
	revision   int64
	lease      *AssignmentLease
}

type activeAgentAttempt struct {
	instance AgentInstance
	cancel   context.CancelFunc
	lease    *AssignmentLease
}

type attemptLifetime struct {
	context context.Context
	cancel  context.CancelFunc
}

func newAttemptLifetime(parent context.Context) *attemptLifetime {
	ctx, cancel := context.WithCancel(parent)
	return &attemptLifetime{context: ctx, cancel: cancel}
}

type agentLifecycleError struct {
	code      string
	retryable bool
	cause     error
}

func NewAgentLifecycleError(
	code string,
	retryable bool,
	cause error,
) error {
	if code == "" {
		code = "agent_lifecycle_failed"
	}
	return &agentLifecycleError{
		code:      code,
		retryable: retryable,
		cause:     cause,
	}
}

func (e *agentLifecycleError) Error() string {
	if e.cause != nil {
		return e.cause.Error()
	}
	return e.code
}

func (e *agentLifecycleError) Unwrap() error { return e.cause }

type agentCellConfig struct {
	agentID      string
	factory      AgentFactory
	retryDelay   func(int) time.Duration
	startTimeout time.Duration
}

type agentCell struct {
	config agentCellConfig
	ctx    context.Context
	cancel context.CancelFunc
	wake   chan struct{}
	done   chan struct{}

	mu       sync.RWMutex
	desired  *desiredAgent
	version  uint64
	status   AgentStatus
	closeErr error

	finalizers sync.WaitGroup
}

func newAgentCell(config agentCellConfig) *agentCell {
	ctx, cancel := context.WithCancel(context.Background())
	cell := &agentCell{
		config: config,
		ctx:    ctx,
		cancel: cancel,
		wake:   make(chan struct{}, 1),
		done:   make(chan struct{}),
		status: AgentStatus{
			AgentID:          config.agentID,
			Phase:            AgentPhaseAbsent,
			Health:           AgentHealthUnknown,
			State:            AgentStateAbsent,
			LastTransitionAt: time.Now().UTC(),
		},
	}
	go cell.run()
	return cell
}

func (c *agentCell) SetDesired(desired desiredAgent) {
	c.mu.Lock()
	changed := c.desired == nil ||
		c.desired.epoch != desired.epoch ||
		!assignmentsEqual(c.desired.assignment, desired.assignment)
	var staleLease *AssignmentLease
	if changed {
		if c.desired != nil {
			staleLease = c.desired.lease
		}
		desired.lease = NewAssignmentLease(
			desired.epoch,
			desired.revision,
			desired.assignment,
		)
	} else {
		desired.lease = c.desired.lease
		if !desired.lease.Advance(
			desired.epoch,
			desired.revision,
			desired.assignment,
		) {
			staleLease = desired.lease
			desired.lease = NewAssignmentLease(
				desired.epoch,
				desired.revision,
				desired.assignment,
			)
			changed = true
		}
	}
	copied := desired
	c.desired = &copied
	c.status.ServerID = desired.assignment.ServerID
	c.status.AssignmentEpoch = desired.epoch
	c.status.CredentialVersion = desired.assignment.CredentialVersion
	c.status.AssignmentRevision = desired.revision
	if changed {
		c.version++
	}
	c.mu.Unlock()
	staleLease.revoke()
	if changed {
		select {
		case c.wake <- struct{}{}:
		default:
		}
	}
}

func (c *agentCell) ClearDesired() {
	c.mu.Lock()
	changed := c.desired != nil
	var lease *AssignmentLease
	if c.desired != nil {
		lease = c.desired.lease
	}
	c.desired = nil
	if changed {
		c.version++
	}
	c.mu.Unlock()
	lease.revoke()
	if changed {
		select {
		case c.wake <- struct{}{}:
		default:
		}
	}
}

func (c *agentCell) Desired() (desiredAgent, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if c.desired == nil {
		return desiredAgent{}, false
	}
	return *c.desired, true
}

func (c *agentCell) Snapshot() AgentStatus {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.status
}

func (c *agentCell) Close(ctx context.Context) error {
	if c == nil {
		return nil
	}
	c.cancel()
	select {
	case <-c.done:
		return c.terminalCloseError()
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (c *agentCell) run() {
	defer func() {
		c.finalizers.Wait()
		close(c.done)
	}()
	var active *activeAgentAttempt
supervise:
	for {
		if active != nil {
			c.setState(AgentStateStopping, "", nil)
			if err := c.quiesceAttempt(active); err != nil {
				if !c.waitCloseFailure(err) {
					c.setState(AgentStateStopped, "agent_close_failed", nil)
					return
				}
				continue
			}
			active = nil
		}
		if c.ctx.Err() != nil {
			c.setState(AgentStateStopped, "", nil)
			return
		}
		desired, version, ok := c.currentDesired()
		if !ok {
			c.setState(AgentStateAbsent, "", nil)
			select {
			case <-c.ctx.Done():
				c.setState(AgentStateStopped, "", nil)
				return
			case <-c.wake:
				continue
			}
		}
		// SetDesired coalesces wake-ups. If this loop already observed the
		// latest immutable desired value, discard that corresponding wake so it
		// cannot spuriously restart the launch that is about to begin.
		select {
		case <-c.wake:
			desired, version, ok = c.currentDesired()
			if !ok {
				continue
			}
		default:
		}

		attempt := c.nextAttempt(desired.assignment.ConfigGeneration)
		launchID, err := newLaunchID()
		if err != nil {
			c.setState(AgentStateRetryWait, "launch_id_failed", nil)
			if !c.waitRetry(int(attempt)) {
				c.setState(AgentStateStopped, "", nil)
				return
			}
			continue
		}
		fence := Fence{
			Epoch:            desired.epoch,
			ConfigGeneration: desired.assignment.ConfigGeneration,
			Attempt:          attempt,
			LaunchID:         launchID,
		}
		c.setState(AgentStateStarting, "", &fence)
		startContext, cancelStart := context.WithTimeout(
			c.ctx,
			c.config.startTimeout,
		)
		lifetime := newAttemptLifetime(c.ctx)
		request := AgentStartRequest{
			Lifetime: lifetime.context,
			Launch: LaunchSpec{
				Assignment: desired.assignment,
				Fence:      fence,
			},
			Lease: desired.lease,
		}
		result := make(chan agentStartResult, 1)
		go c.startAttempt(startContext, request, result)
		var started agentStartResult
		interrupted := false
		shuttingDown := false
		select {
		case <-c.ctx.Done():
			cancelStart()
			lifetime.cancel()
			started = <-result
			interrupted = true
			shuttingDown = true
		case <-c.wake:
			cancelStart()
			lifetime.cancel()
			started = <-result
			interrupted = true
		case started = <-result:
			cancelStart()
		}
		if started.instance != nil {
			if source, ok := started.instance.(AgentFenceSource); ok {
				authoritative := source.Fence()
				if authoritative.Epoch != fence.Epoch ||
					authoritative.ConfigGeneration != fence.ConfigGeneration ||
					authoritative.LaunchID == "" ||
					authoritative.Attempt < 1 {
					started.err = NewAgentLifecycleError(
						"agent_launch_fence_invalid",
						false,
						ErrInvalidRegistryConfig,
					)
				} else {
					fence = authoritative
					c.setState(AgentStateStarting, "", &fence)
				}
			}
			active = &activeAgentAttempt{
				instance: started.instance,
				cancel:   lifetime.cancel,
				lease:    desired.lease,
			}
		}
		if interrupted {
			if active != nil {
				continue
			}
			if shuttingDown {
				c.setState(AgentStateStopped, "", nil)
				return
			}
			continue
		}
		if started.err != nil || active == nil {
			if active != nil {
				c.setState(AgentStateStopping, "", &fence)
				if err := c.quiesceAttempt(active); err != nil {
					if !c.waitCloseFailure(err) {
						c.setState(
							AgentStateStopped,
							"agent_close_failed",
							nil,
						)
						return
					}
					continue
				}
				active = nil
			}
			lifetime.cancel()
			if !c.waitFailure(
				started.err,
				"agent_start_failed",
				&fence,
				int(attempt),
			) {
				c.setState(AgentStateStopped, "", nil)
				return
			}
			continue
		}
		if c.changed(version) {
			continue
		}
		select {
		case <-c.ctx.Done():
			continue
		case <-c.wake:
			continue
		case <-active.instance.Done():
			instanceErr := active.instance.Err()
			if err := c.quiesceAttempt(active); err != nil {
				if !c.waitCloseFailure(err) {
					c.setState(AgentStateStopped, "agent_close_failed", nil)
					return
				}
				continue
			}
			active = nil
			if !c.waitFailure(
				instanceErr,
				"agent_host_exited",
				&fence,
				int(attempt),
			) {
				c.setState(AgentStateStopped, "", nil)
				return
			}
			continue
		case <-active.instance.Ready():
			select {
			case <-active.instance.Done():
				instanceErr := active.instance.Err()
				if err := c.quiesceAttempt(active); err != nil {
					if !c.waitCloseFailure(err) {
						c.setState(AgentStateStopped, "agent_close_failed", nil)
						return
					}
					continue
				}
				active = nil
				if !c.waitFailure(
					instanceErr,
					"agent_host_exited",
					&fence,
					int(attempt),
				) {
					c.setState(AgentStateStopped, "", nil)
					return
				}
				continue
			default:
			}
			c.setState(AgentStateRunning, "", &fence)
		}
		healthEvents := agentInstanceHealth(active.instance)
		for {
			select {
			case <-c.ctx.Done():
				continue supervise
			case <-c.wake:
				continue supervise
			case health, ok := <-healthEvents:
				if !ok {
					healthEvents = nil
					continue
				}
				c.setRuntimeHealth(health, &fence)
			case <-active.instance.Done():
				instanceErr := active.instance.Err()
				if err := c.quiesceAttempt(active); err != nil {
					if !c.waitCloseFailure(err) {
						c.setState(AgentStateStopped, "agent_close_failed", nil)
						return
					}
					continue supervise
				}
				active = nil
				if !c.waitFailure(
					instanceErr,
					"agent_host_exited",
					&fence,
					int(attempt),
				) {
					c.setState(AgentStateStopped, "", nil)
					return
				}
				continue supervise
			}
		}
	}
}

func agentInstanceHealth(instance AgentInstance) <-chan AgentHealth {
	source, ok := instance.(AgentHealthSource)
	if !ok {
		return nil
	}
	return source.Health()
}

func (c *agentCell) startAttempt(
	ctx context.Context,
	request AgentStartRequest,
	result chan<- agentStartResult,
) {
	instance, err := c.config.factory.Start(ctx, request)
	result <- agentStartResult{instance: instance, err: err}
}

func (c *agentCell) currentDesired() (desiredAgent, uint64, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if c.desired == nil {
		return desiredAgent{}, c.version, false
	}
	return *c.desired, c.version, true
}

func (c *agentCell) changed(version uint64) bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.version != version
}

func (c *agentCell) nextAttempt(generation int64) int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.status.ConfigGeneration = generation
	c.status.Attempt++
	return c.status.Attempt
}

func (c *agentCell) setState(
	state AgentState,
	errorCode string,
	fence *Fence,
) {
	phase, health := statusProjection(state)
	c.setProjection(state, phase, health, errorCode, fence)
}

func (c *agentCell) setRuntimeHealth(
	health AgentHealth,
	fence *Fence,
) {
	if health.Ready {
		c.setProjection(
			AgentStateRunning,
			AgentPhaseRunning,
			AgentHealthReady,
			"",
			fence,
		)
		return
	}
	errorCode := health.ErrorCode
	if errorCode == "" {
		errorCode = "agent_im_reconnecting"
	}
	c.setProjection(
		AgentStateRetryWait,
		AgentPhaseRunning,
		AgentHealthReconnecting,
		errorCode,
		fence,
	)
}

func (c *agentCell) setProjection(
	state AgentState,
	phase AgentPhase,
	health AgentHealthState,
	errorCode string,
	fence *Fence,
) {
	c.mu.Lock()
	defer c.mu.Unlock()
	changed := c.status.State != state ||
		c.status.Phase != phase ||
		c.status.Health != health ||
		c.status.ErrorCode != errorCode
	c.status.State = state
	c.status.Phase = phase
	c.status.Health = health
	c.status.ErrorCode = errorCode
	if changed {
		c.status.LastTransitionAt = time.Now().UTC()
	}
	if fence != nil {
		c.status.ConfigGeneration = fence.ConfigGeneration
		c.status.Attempt = fence.Attempt
		c.status.LaunchID = fence.LaunchID
	}
	if state == AgentStateAbsent || state == AgentStateStopped {
		c.status.LaunchID = ""
	}
	if state != AgentStateRetryWait {
		c.status.NextRetryAt = nil
	}
}

func statusProjection(state AgentState) (AgentPhase, AgentHealthState) {
	switch state {
	case AgentStateAbsent:
		return AgentPhaseAbsent, AgentHealthUnknown
	case AgentStateStarting:
		return AgentPhaseStarting, AgentHealthUnknown
	case AgentStateRunning:
		return AgentPhaseRunning, AgentHealthReady
	case AgentStateRetryWait:
		return AgentPhaseStarting, AgentHealthDegraded
	case AgentStateBlocked:
		return AgentPhaseStarting, AgentHealthBlocked
	case AgentStateStopping:
		return AgentPhaseStopping, AgentHealthUnknown
	case AgentStateStopped:
		return AgentPhaseStopped, AgentHealthUnknown
	default:
		return AgentPhaseAbsent, AgentHealthUnknown
	}
}

func (c *agentCell) waitRetry(failures int) bool {
	delay := c.config.retryDelay(failures)
	if delay < 0 {
		delay = 0
	}
	c.setNextRetryAt(time.Now().UTC().Add(delay))
	defer c.clearNextRetryAt()
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-c.ctx.Done():
		return false
	case <-c.wake:
		return true
	case <-timer.C:
		return true
	}
}

func (c *agentCell) setNextRetryAt(value time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	value = value.UTC()
	c.status.NextRetryAt = &value
}

func (c *agentCell) clearNextRetryAt() {
	c.mu.Lock()
	c.status.NextRetryAt = nil
	c.mu.Unlock()
}

func (c *agentCell) quiesceAttempt(active *activeAgentAttempt) error {
	if active == nil || active.instance == nil {
		return nil
	}
	revokeContext, cancel := context.WithTimeout(
		context.Background(),
		10*time.Second,
	)
	defer cancel()
	active.lease.revoke()
	revokeErr := active.instance.Revoke(revokeContext)
	active.cancel()
	if revokeErr != nil {
		return revokeErr
	}
	c.startFinalizer(active.instance)
	return nil
}

func (c *agentCell) startFinalizer(instance AgentInstance) {
	if instance == nil {
		return
	}
	c.finalizers.Add(1)
	go func() {
		defer c.finalizers.Done()
		failures := 0
		for {
			closeContext, cancel := context.WithTimeout(
				context.Background(),
				30*time.Second,
			)
			err := instance.Close(closeContext)
			cancel()
			if err == nil {
				return
			}
			failures++
			if c.ctx.Err() != nil {
				c.setTerminalCloseError(err)
				return
			}
			delay := c.config.retryDelay(failures)
			if delay < 0 {
				delay = 0
			}
			if delay > 30*time.Second {
				delay = 30 * time.Second
			}
			timer := time.NewTimer(delay)
			select {
			case <-c.ctx.Done():
				timer.Stop()
				c.setTerminalCloseError(err)
				return
			case <-timer.C:
			}
		}
	}()
}

func (c *agentCell) waitCloseFailure(err error) bool {
	c.setProjection(
		AgentStateRetryWait,
		AgentPhaseStopping,
		AgentHealthDegraded,
		"agent_close_failed",
		nil,
	)
	if c.ctx.Err() != nil {
		c.setTerminalCloseError(err)
		return false
	}
	if !c.waitRetry(1) {
		c.setTerminalCloseError(err)
		return false
	}
	return true
}

func (c *agentCell) setTerminalCloseError(err error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closeErr == nil {
		c.closeErr = err
	}
}

func (c *agentCell) terminalCloseError() error {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.closeErr
}

func (c *agentCell) waitFailure(
	err error,
	fallbackCode string,
	fence *Fence,
	failures int,
) bool {
	code := fallbackCode
	retryable := true
	var classified *agentLifecycleError
	if errors.As(err, &classified) {
		code = classified.code
		retryable = classified.retryable
	}
	if retryable {
		c.setState(AgentStateRetryWait, code, fence)
		return c.waitRetry(failures)
	}
	c.setState(AgentStateBlocked, code, fence)
	select {
	case <-c.ctx.Done():
		return false
	case <-c.wake:
		return true
	}
}

type agentStartResult struct {
	instance AgentInstance
	err      error
}
