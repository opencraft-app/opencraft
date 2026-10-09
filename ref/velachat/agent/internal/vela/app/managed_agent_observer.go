package app

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/google/uuid"
	"velachat/agent/internal/vela/daemon"
	"velachat/agent/internal/vela/platform"
)

var ErrManagedAgentObservationStale = errors.New(
	"Agent Observation 已被服务端 fence 拒绝",
)

var errManagedAgentObservationSuperseded = errors.New(
	"Agent Observation 在发送前已被更新状态替代",
)

type pendingAgentObservation struct {
	id         string
	sequence   int64
	state      string
	errorCode  *string
	observed   time.Time
	completion chan error
}

// managedAgentObserver turns short-lived Host state into the durable,
// generation-fenced Computer observation protocol. It coalesces only states
// that have not started sending; an in-flight PUT keeps its stable ID and
// sequence across retries.
type managedAgentObserver struct {
	client   *platform.Client
	sessions *computerSessionManager
	lease    daemon.AssignmentLeaseReader
	fence    daemon.Fence
	now      func() time.Time

	ctx    context.Context
	cancel context.CancelFunc
	wake   chan struct{}
	done   chan struct{}
	fatal  chan error

	mu             sync.Mutex
	initialized    bool
	sequence       int64
	pending        *pendingAgentObservation
	sending        bool
	lastState      string
	lastErrorCode  string
	lastSuccessful string
	leaseSnapshot  daemon.AssignmentLeaseSnapshot
	hasLease       bool
}

func newManagedAgentObserver(
	client *platform.Client,
	sessions *computerSessionManager,
	lease daemon.AssignmentLeaseReader,
	fence daemon.Fence,
	now func() time.Time,
) *managedAgentObserver {
	ctx, cancel := context.WithCancel(context.Background())
	observer := &managedAgentObserver{
		client: client, sessions: sessions, lease: lease, fence: fence,
		now: now, ctx: ctx, cancel: cancel,
		wake: make(chan struct{}, 1), done: make(chan struct{}),
		fatal: make(chan error, 1),
	}
	go observer.run()
	return observer
}

func (o *managedAgentObserver) Fatal() <-chan error {
	if o == nil {
		return nil
	}
	return o.fatal
}

func (o *managedAgentObserver) Initialize(
	cursor platform.ObservationCursor,
) {
	if o == nil {
		return
	}
	o.mu.Lock()
	if lease, ok := o.lease.Current(); ok {
		o.leaseSnapshot = lease
		o.hasLease = true
	}
	if cursor.AssignmentEpoch == o.fence.Epoch &&
		cursor.ConfigGeneration == o.fence.ConfigGeneration &&
		cursor.Attempt == o.fence.Attempt &&
		cursor.Sequence > o.sequence {
		o.sequence = cursor.Sequence
	}
	o.initialized = true
	o.mu.Unlock()
	o.signal()
}

func (o *managedAgentObserver) Publish(state string, errorCode *string) {
	o.publish(state, errorCode, nil)
}

func (o *managedAgentObserver) PublishAndWait(
	ctx context.Context,
	state string,
	errorCode *string,
) error {
	if o == nil {
		return errors.New("Agent Observation 发布器不可用")
	}
	completion := make(chan error, 1)
	if !o.publish(state, errorCode, completion) {
		return nil
	}
	select {
	case err := <-completion:
		return err
	case <-o.done:
		select {
		case err := <-completion:
			return err
		default:
			return context.Canceled
		}
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (o *managedAgentObserver) publish(
	state string,
	errorCode *string,
	completion chan error,
) bool {
	if o == nil {
		return false
	}
	code := ""
	if errorCode != nil {
		code = *errorCode
	}
	o.mu.Lock()
	if state == o.lastState && code == o.lastErrorCode {
		o.mu.Unlock()
		return false
	}
	id, err := uuid.NewV7()
	if err != nil {
		o.mu.Unlock()
		completeObservation(completion, err)
		return true
	}
	if o.pending != nil {
		completeObservation(
			o.pending.completion,
			errManagedAgentObservationSuperseded,
		)
	}
	o.sequence++
	o.pending = &pendingAgentObservation{
		id: id.String(), sequence: o.sequence, state: state,
		errorCode: copyString(errorCode), observed: o.now().UTC(),
		completion: completion,
	}
	o.lastState = state
	o.lastErrorCode = code
	o.mu.Unlock()
	o.signal()
	return true
}

func (o *managedAgentObserver) FlushAndClose(ctx context.Context) error {
	if o == nil {
		return nil
	}
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		o.mu.Lock()
		// A launch that never obtained a Runtime Session has no observation
		// cursor and was never accepted by the platform. Its local stopping
		// projection therefore cannot be delivered and must not block a newer
		// assignment from starting.
		if !o.initialized {
			o.pending = nil
		}
		idle := o.pending == nil && !o.sending
		o.mu.Unlock()
		if idle {
			o.cancel()
			select {
			case <-o.done:
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

func (o *managedAgentObserver) run() {
	defer close(o.done)
	failures := 0
	for {
		select {
		case <-o.ctx.Done():
			return
		case <-o.wake:
		}
		for {
			o.mu.Lock()
			if !o.initialized || o.pending == nil {
				o.mu.Unlock()
				break
			}
			item := *o.pending
			o.pending = nil
			o.sending = true
			o.mu.Unlock()

			err := o.send(o.ctx, item)
			o.mu.Lock()
			o.sending = false
			if err == nil {
				o.lastSuccessful = item.state
				failures = 0
			} else if errors.Is(err, ErrManagedAgentObservationStale) {
				if o.pending != nil {
					completeObservation(
						o.pending.completion,
						ErrManagedAgentObservationStale,
					)
				}
				o.pending = nil
			} else if o.pending == nil {
				copy := item
				o.pending = &copy
				failures++
			} else {
				completeObservation(
					item.completion,
					errManagedAgentObservationSuperseded,
				)
			}
			o.mu.Unlock()
			if err == nil {
				completeObservation(item.completion, nil)
				continue
			}
			if errors.Is(err, ErrManagedAgentObservationStale) {
				completeObservation(
					item.completion,
					ErrManagedAgentObservationStale,
				)
				select {
				case o.fatal <- err:
				default:
				}
				return
			}
			if !waitObserverRetry(o.ctx, observationBackoff(failures)) {
				return
			}
			o.signal()
			break
		}
	}
}

func completeObservation(destination chan error, err error) {
	if destination == nil {
		return
	}
	select {
	case destination <- err:
	default:
	}
}

func (o *managedAgentObserver) send(
	ctx context.Context,
	item pendingAgentObservation,
) error {
	lease, ok := o.lease.Current()
	o.mu.Lock()
	if ok {
		o.leaseSnapshot = lease
		o.hasLease = true
	} else if o.hasLease {
		lease = o.leaseSnapshot
		ok = true
	}
	o.mu.Unlock()
	if !ok || lease.Epoch != o.fence.Epoch ||
		lease.Assignment.AgentID == "" ||
		lease.Assignment.ConfigGeneration != o.fence.ConfigGeneration {
		return daemon.ErrInvalidRegistryConfig
	}
	session, err := o.sessions.Current(ctx)
	if err != nil {
		return err
	}
	result, err := o.client.PutComputerAgentObservation(
		ctx,
		session.AccessToken,
		lease.Assignment.AgentID,
		item.id,
		platform.ComputerAgentObservation{
			AssignmentEpoch:    lease.Epoch,
			AssignmentRevision: lease.Revision,
			ConfigGeneration:   o.fence.ConfigGeneration,
			CredentialVersion:  lease.Assignment.CredentialVersion,
			Attempt:            o.fence.Attempt,
			Sequence:           item.sequence,
			LaunchID:           o.fence.LaunchID,
			State:              item.state,
			IMTransportState:   observationIMTransportState(item.state),
			ErrorCode:          copyString(item.errorCode),
			ObservedAt:         item.observed,
		},
	)
	if errors.Is(err, platform.ErrCredentialRejected) {
		o.sessions.Invalidate(session.AccessToken)
		return err
	}
	if err != nil {
		return err
	}
	if result.Stale {
		return ErrManagedAgentObservationStale
	}
	return nil
}

func observationIMTransportState(state string) string {
	switch state {
	case "starting":
		return "connecting"
	case "running":
		return "connected"
	case "stopping", "stopped":
		return "disconnected"
	case "error":
		return "error"
	default:
		return "unknown"
	}
}

func (o *managedAgentObserver) signal() {
	select {
	case o.wake <- struct{}{}:
	default:
	}
}

func copyString(value *string) *string {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func stringPointer(value string) *string { return &value }

func observationBackoff(failures int) time.Duration {
	switch failures {
	case 0, 1:
		return time.Second
	case 2:
		return 2 * time.Second
	case 3:
		return 5 * time.Second
	default:
		return 30 * time.Second
	}
}

func waitObserverRetry(ctx context.Context, delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}
