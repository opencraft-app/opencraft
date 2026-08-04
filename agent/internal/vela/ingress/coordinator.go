// Package ingress turns realtime IM notifications into ordered, recoverable
// per-conversation Runtime deliveries without blocking the IM control loop.
package ingress

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/vela/im"
	velastate "github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/vela/state"
)

var (
	ErrInvalidConfig      = errors.New("Vela ingress coordinator 配置无效")
	ErrInvalidDisposition = errors.New("Vela ingress handler 返回了无效结果")
	ErrDiscoveryState     = errors.New("Vela ingress discovery 状态无效")
)

type MessageDisposition string

const (
	RuntimeAccepted MessageDisposition = "runtime_accepted"
	Consumed        MessageDisposition = "consumed"
)

type MessageResult struct {
	Disposition MessageDisposition
}

type Handler interface {
	HandleIngressMessage(context.Context, im.IncomingMessage) (MessageResult, error)
}

type HandlerFunc func(context.Context, im.IncomingMessage) (MessageResult, error)

func (f HandlerFunc) HandleIngressMessage(ctx context.Context, message im.IncomingMessage) (MessageResult, error) {
	return f(ctx, message)
}

type SubmitResult string

const (
	SubmitAccepted    SubmitResult = "accepted"
	SubmitNeedsResync SubmitResult = "needs_resync"
	SubmitRejected    SubmitResult = "rejected"
)

type Config struct {
	Handler         Handler
	Cursors         velastate.CursorStore
	MaxConcurrent   int
	QueueSize       int
	DeliveryTimeout time.Duration
	Now             func() time.Time
	ReportFailure   func(Failure)
}

type Failure struct {
	Message im.IncomingMessage
	Code    velastate.GapCode
	Err     error
}

type Coordinator struct {
	handler Handler
	cursors velastate.CursorStore
	timeout time.Duration
	now     func() time.Time
	report  func(Failure)
	queue   int
	sem     chan struct{}
	ctx     context.Context
	cancel  context.CancelFunc

	mu               sync.Mutex
	lanes            map[string]*conversationLane
	discovery        map[string][]im.IncomingMessage
	discoveryBlocked map[string]im.Conversation
	discovering      bool
	closed           bool
	work             sync.WaitGroup
}

type conversationLane struct {
	conversation im.Conversation
	messages     chan deliveryItem

	mu                 sync.Mutex
	blocked            bool
	pendingGap         velastate.GapCode
	recoveryGapVersion uint64
	generation         uint64
}

type deliveryItem struct {
	message  im.IncomingMessage
	done     chan error
	recovery bool
}

type handlerResult struct {
	generation uint64
	result     MessageResult
	err        error
}

func New(config Config) (*Coordinator, error) {
	if config.Handler == nil || config.Cursors == nil || config.MaxConcurrent < 1 ||
		config.QueueSize < 1 || config.DeliveryTimeout <= 0 {
		return nil, ErrInvalidConfig
	}
	now := config.Now
	if now == nil {
		now = time.Now
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &Coordinator{
		handler: config.Handler, cursors: config.Cursors, timeout: config.DeliveryTimeout,
		now: now, report: config.ReportFailure, queue: config.QueueSize,
		sem: make(chan struct{}, config.MaxConcurrent),
		ctx: ctx, cancel: cancel, lanes: make(map[string]*conversationLane),
		discovery:        make(map[string][]im.IncomingMessage),
		discoveryBlocked: make(map[string]im.Conversation),
	}, nil
}

func (c *Coordinator) Submit(message im.IncomingMessage) SubmitResult {
	if c == nil || !message.Ref.Conversation().Valid() || message.Ref.MessageID() == "" {
		return SubmitRejected
	}
	conversation := message.Ref.Conversation()
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return SubmitRejected
	}
	if c.discovering {
		key := conversationKey(conversation)
		if _, blocked := c.discoveryBlocked[key]; blocked {
			c.mu.Unlock()
			return SubmitNeedsResync
		}
		pending := c.discovery[key]
		if len(pending) >= c.queue {
			delete(c.discovery, key)
			c.discoveryBlocked[key] = conversation
			c.mu.Unlock()
			c.persistGap(conversation, &pending[0], velastate.GapQueueOverflow)
			c.reportFailure(message, velastate.GapQueueOverflow, velastate.ErrCursorInGap)
			return SubmitNeedsResync
		}
		c.discovery[key] = append(pending, message)
		c.mu.Unlock()
		return SubmitAccepted
	}
	lane := c.laneLocked(conversation, false)
	lane.mu.Lock()
	if lane.blocked {
		delete(c.lanes, conversationKey(conversation))
		lane.mu.Unlock()
		c.mu.Unlock()
		return SubmitNeedsResync
	}
	select {
	case lane.messages <- deliveryItem{message: message}:
		lane.mu.Unlock()
		c.mu.Unlock()
		return SubmitAccepted
	default:
		lane.blocked = true
		lane.pendingGap = velastate.GapQueueOverflow
		delete(c.lanes, conversationKey(conversation))
		lane.mu.Unlock()
		c.mu.Unlock()
		c.reportFailure(message, velastate.GapQueueOverflow, velastate.ErrCursorInGap)
		return SubmitNeedsResync
	}
}

// BeginDiscovery erects a global ordering barrier. Realtime notifications are
// retained only in bounded per-conversation memory until Tencent history has
// reached its frozen login snapshot.
func (c *Coordinator) BeginDiscovery() error {
	if c == nil {
		return ErrInvalidConfig
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed || c.discovering || len(c.discovery) != 0 || len(c.discoveryBlocked) != 0 {
		return ErrDiscoveryState
	}
	c.discovering = true
	return nil
}

func (c *Coordinator) EndDiscovery() error {
	if c == nil {
		return ErrInvalidConfig
	}
	c.mu.Lock()
	if c.closed || !c.discovering {
		c.mu.Unlock()
		return ErrDiscoveryState
	}
	pending := c.discovery
	c.discovery = make(map[string][]im.IncomingMessage)
	c.discoveryBlocked = make(map[string]im.Conversation)
	c.discovering = false
	c.mu.Unlock()
	for _, messages := range pending {
		for _, message := range messages {
			_ = c.Submit(message)
		}
	}
	return nil
}

// AbortDiscovery deliberately drops buffered bodies and leaves only durable
// gap markers. A later session must reconstruct them from Tencent history.
func (c *Coordinator) AbortDiscovery() error {
	if c == nil {
		return ErrInvalidConfig
	}
	c.mu.Lock()
	if !c.discovering {
		c.mu.Unlock()
		return nil
	}
	pending := c.discovery
	c.discovery = make(map[string][]im.IncomingMessage)
	c.discoveryBlocked = make(map[string]im.Conversation)
	c.discovering = false
	c.mu.Unlock()
	for _, messages := range pending {
		if len(messages) == 0 {
			continue
		}
		c.persistGap(messages[0].Ref.Conversation(), &messages[0], velastate.GapRecoveryStalled)
	}
	return nil
}

// Recover synchronously replays one Tencent history message through the same
// per-conversation lane. It may cross exactly the persisted gap generation
// observed when the lane is created; normal realtime Submit never may.
func (c *Coordinator) Recover(ctx context.Context, message im.IncomingMessage) error {
	if c == nil || ctx == nil || !message.Ref.Conversation().Valid() || message.Ref.MessageID() == "" {
		return ErrInvalidConfig
	}
	conversation := message.Ref.Conversation()
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return context.Canceled
	}
	lane := c.laneLocked(conversation, true)
	lane.mu.Lock()
	if lane.blocked {
		lane.mu.Unlock()
		c.mu.Unlock()
		return velastate.ErrCursorInGap
	}
	done := make(chan error, 1)
	select {
	case lane.messages <- deliveryItem{message: message, done: done, recovery: true}:
		lane.mu.Unlock()
		c.mu.Unlock()
	case <-ctx.Done():
		lane.mu.Unlock()
		c.mu.Unlock()
		return ctx.Err()
	}
	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (c *Coordinator) laneLocked(conversation im.Conversation, allowRecovery bool) *conversationLane {
	key := conversationKey(conversation)
	lane := c.lanes[key]
	if lane != nil {
		return lane
	}
	lane = &conversationLane{
		conversation: conversation,
		messages:     make(chan deliveryItem, c.queue),
	}
	if gap, inGap := c.cursors.Gap(conversation); inGap {
		if allowRecovery {
			lane.recoveryGapVersion = gap.Version
		} else {
			lane.blocked = true
		}
	}
	c.lanes[key] = lane
	c.work.Add(1)
	go c.runLane(lane)
	return lane
}

func (c *Coordinator) Close(ctx context.Context) error {
	if c == nil || ctx == nil {
		return ErrInvalidConfig
	}
	c.mu.Lock()
	if !c.closed {
		c.closed = true
		c.cancel()
	}
	c.mu.Unlock()
	done := make(chan struct{})
	go func() {
		c.work.Wait()
		close(done)
	}()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (c *Coordinator) runLane(lane *conversationLane) {
	defer func() {
		c.mu.Lock()
		key := conversationKey(lane.conversation)
		if c.lanes[key] == lane {
			delete(c.lanes, key)
		}
		c.mu.Unlock()
		c.work.Done()
	}()
	for {
		if code, blocked := lane.blockState(); blocked {
			if code != "" {
				c.persistGap(lane.conversation, nil, code)
			}
			return
		}
		select {
		case <-c.ctx.Done():
			return
		case item := <-lane.messages:
			message := item.message
			if code, blocked := lane.blockState(); blocked {
				if item.done != nil {
					item.done <- velastate.ErrCursorInGap
				}
				if code != "" {
					c.persistGap(lane.conversation, &message, code)
				}
				return
			}
			if c.alreadyConsumed(message.Ref) {
				if item.done != nil {
					item.done <- nil
				}
				continue
			}
			result, timedOut := c.invoke(lane, message)
			if timedOut {
				lane.block(velastate.GapRuntimeTimeout)
				c.persistGap(lane.conversation, &message, velastate.GapRuntimeTimeout)
				if item.done != nil {
					item.done <- context.DeadlineExceeded
				}
				c.detachLane(lane)
				if !item.recovery {
					c.reportFailure(message, velastate.GapRuntimeTimeout, context.DeadlineExceeded)
				}
				return
			}
			if result.err != nil || !validDisposition(result.result.Disposition) {
				lane.block(velastate.GapRuntimeFailed)
				c.persistGap(lane.conversation, &message, velastate.GapRuntimeFailed)
				if item.done != nil {
					if result.err != nil {
						item.done <- result.err
					} else {
						item.done <- ErrInvalidDisposition
					}
				}
				c.detachLane(lane)
				if !item.recovery {
					if result.err != nil {
						c.reportFailure(message, velastate.GapRuntimeFailed, result.err)
					} else {
						c.reportFailure(message, velastate.GapRuntimeFailed, ErrInvalidDisposition)
					}
				}
				return
			}
			expected, exists := c.cursors.Get(lane.conversation)
			var expectedPointer *velastate.MessageCursor
			if exists {
				expectedPointer = &expected
			}
			next := velastate.NewMessageCursor(message.Ref, c.now().UTC())
			gapVersion := lane.takeRecoveryGapVersion()
			var advanceErr error
			if gapVersion != 0 {
				advanceErr = c.cursors.RecoverAdvance(expectedPointer, gapVersion, next)
			} else {
				advanceErr = c.cursors.Advance(expectedPointer, next)
			}
			if advanceErr != nil {
				lane.block(velastate.GapCursorWriteFailed)
				c.persistGap(lane.conversation, &message, velastate.GapCursorWriteFailed)
				if item.done != nil {
					item.done <- advanceErr
				}
				c.detachLane(lane)
				if !item.recovery {
					c.reportFailure(message, velastate.GapCursorWriteFailed, advanceErr)
				}
				return
			}
			if item.done != nil {
				item.done <- nil
			}
		}
	}
}

func (c *Coordinator) invoke(lane *conversationLane, message im.IncomingMessage) (handlerResult, bool) {
	select {
	case c.sem <- struct{}{}:
	case <-c.ctx.Done():
		return handlerResult{err: c.ctx.Err()}, false
	}
	lane.mu.Lock()
	lane.generation++
	generation := lane.generation
	lane.mu.Unlock()
	callContext, cancel := context.WithTimeout(c.ctx, c.timeout)
	resultChannel := make(chan handlerResult, 1)
	go func() {
		result, err := c.handler.HandleIngressMessage(callContext, message)
		resultChannel <- handlerResult{generation: generation, result: result, err: err}
		<-c.sem
	}()
	select {
	case result := <-resultChannel:
		if callContext.Err() != nil || result.generation != generation {
			cancel()
			return result, true
		}
		cancel()
		return result, false
	case <-callContext.Done():
		cancel()
		return handlerResult{generation: generation, err: callContext.Err()}, true
	}
}

func (c *Coordinator) persistGap(
	conversation im.Conversation,
	firstUnconsumed *im.IncomingMessage,
	code velastate.GapCode,
) {
	expected, exists := c.cursors.Get(conversation)
	var expectedPointer *velastate.MessageCursor
	if exists {
		expectedPointer = &expected
	}
	var firstPointer *velastate.MessageCursor
	if firstUnconsumed != nil {
		first := velastate.NewMessageCursor(firstUnconsumed.Ref, c.now().UTC())
		firstPointer = &first
	}
	_, _ = c.cursors.MarkGap(conversation, expectedPointer, firstPointer, velastate.GapDiagnostic{
		Code: code, DetectedAt: c.now().UTC(),
	})
}

func (c *Coordinator) alreadyConsumed(reference im.MessageRef) bool {
	current, ok := c.cursors.Get(reference.Conversation())
	if !ok {
		return false
	}
	if current.MessageID == reference.MessageID() {
		return true
	}
	if reference.TimestampMS() < current.TimestampMS {
		return true
	}
	switch reference.Conversation().Kind() {
	case im.ConversationGroup, im.ConversationTopic:
		return reference.Sequence() <= current.Sequence
	default:
		return false
	}
}

func (c *Coordinator) reportFailure(message im.IncomingMessage, code velastate.GapCode, err error) {
	if c.report != nil {
		c.report(Failure{Message: message, Code: code, Err: err})
	}
}

func (c *Coordinator) detachLane(lane *conversationLane) {
	c.mu.Lock()
	key := conversationKey(lane.conversation)
	if c.lanes[key] == lane {
		delete(c.lanes, key)
	}
	c.mu.Unlock()
}

func (l *conversationLane) block(code velastate.GapCode) {
	l.mu.Lock()
	l.blocked = true
	l.pendingGap = code
	l.mu.Unlock()
}

func (l *conversationLane) blockState() (velastate.GapCode, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.pendingGap, l.blocked
}

func (l *conversationLane) takeRecoveryGapVersion() uint64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	version := l.recoveryGapVersion
	l.recoveryGapVersion = 0
	return version
}

func validDisposition(disposition MessageDisposition) bool {
	return disposition == RuntimeAccepted || disposition == Consumed
}

func conversationKey(conversation im.Conversation) string {
	return string(conversation.Kind()) + "\x00" + conversation.PeerUserID() + "\x00" +
		conversation.GroupID() + "\x00" + conversation.TopicID()
}
