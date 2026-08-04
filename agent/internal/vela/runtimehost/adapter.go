// Package runtimehost adapts Vela IM messages to the shared runtime catalog and
// single-Agent RuntimeActor without introducing a second transport aggregate.
package runtimehost

import (
	"context"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/runtimeactor"
	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/runtimeapi"
	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/vela/host"
	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/vela/im"
	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/vela/ingress"
	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/vela/platform"
	velastate "github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/vela/state"
	"github.com/google/uuid"
)

var (
	ErrInvalidConfig  = errors.New("Vela Runtime Adapter 配置无效")
	ErrSessionChanged = errors.New("Vela Runtime Session 身份或 Runtime 已变化")
	ErrSessionMissing = errors.New("Vela Runtime Session 尚未初始化")
)

type RuntimeActor interface {
	Start(context.Context, runtimeactor.StartCommand) error
	Deliver(context.Context, string, runtimeapi.Delivery) error
	DeliverDirect(context.Context, string, runtimeapi.Delivery) error
	Stop(context.Context, string) error
	Events() <-chan runtimeactor.Event
	AckEvent(uint64)
}

type CapabilityGateway interface {
	UpdateSession(platform.RuntimeSession) error
	RegisterMessage(im.IncomingMessage) (string, error)
	RuntimeEnvironment() map[string]string
}

type ReminderClient interface {
	ListAllReminderOccurrences(
		context.Context,
		platform.AccessToken,
	) ([]platform.ReminderOccurrence, error)
	AcknowledgeReminderOccurrence(
		context.Context,
		platform.AccessToken,
		string,
	) (platform.ReminderOccurrence, error)
}

type TaskClient interface {
	ListRuntimeTasks(context.Context, platform.AccessToken) ([]platform.Task, error)
}

type Config struct {
	AgentID          string
	StateDirectory   string
	WorkingDirectory string
	Actor            RuntimeActor
	Runtimes         runtimeapi.InternalRuntimeResolver
	Occurrences      *velastate.FileOccurrenceStore
	TaskDeliveries   *velastate.FileTaskDeliveryStore
	Gateway          CapabilityGateway
	ReminderClient   ReminderClient
	TaskClient       TaskClient
	ReminderInterval time.Duration
	Now              func() time.Time
	NewRuntimeEpoch  func() (string, error)
}

type Adapter struct {
	config       Config
	runtimeEpoch string

	mu            sync.Mutex
	runtimeMu     sync.Mutex
	session       *platform.RuntimeSession
	started       bool
	eventsDone    chan struct{}
	eventsStopped chan struct{}
	stopEvents    sync.Once

	reminderContext context.Context
	reminderCancel  context.CancelFunc
	reminderWake    chan struct{}
	reminderStopped chan struct{}
	reminderMu      sync.Mutex
}

var _ host.RuntimeAdapter = (*Adapter)(nil)
var _ ingress.Handler = (*Adapter)(nil)

func New(config Config) (*Adapter, error) {
	if config.ReminderInterval <= 0 {
		config.ReminderInterval = 30 * time.Second
	}
	if config.Now == nil {
		config.Now = time.Now
	}
	if config.NewRuntimeEpoch == nil {
		config.NewRuntimeEpoch = func() (string, error) {
			value, err := uuid.NewV7()
			if err != nil {
				return "", err
			}
			return value.String(), nil
		}
	}
	if strings.TrimSpace(config.AgentID) == "" ||
		!filepath.IsAbs(config.StateDirectory) ||
		!filepath.IsAbs(config.WorkingDirectory) ||
		config.Actor == nil ||
		config.Runtimes == nil {
		return nil, ErrInvalidConfig
	}
	stateDirectory := filepath.Clean(config.StateDirectory)
	var err error
	if config.Occurrences == nil {
		config.Occurrences, err = velastate.OpenOccurrenceStore(stateDirectory)
		if err != nil {
			return nil, err
		}
	}
	if config.TaskDeliveries == nil {
		config.TaskDeliveries, err = velastate.OpenTaskDeliveryStore(stateDirectory)
		if err != nil {
			return nil, err
		}
	}
	epoch, err := config.NewRuntimeEpoch()
	if err != nil || strings.TrimSpace(epoch) == "" {
		return nil, ErrInvalidConfig
	}
	if _, err := config.Occurrences.RecoverExecuting(epoch, config.Now().UTC()); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(config.WorkingDirectory, 0o700); err != nil {
		return nil, err
	}
	if err := os.Chmod(config.WorkingDirectory, 0o700); err != nil {
		return nil, err
	}
	reminderContext, reminderCancel := context.WithCancel(context.Background())
	adapter := &Adapter{
		config:          config,
		runtimeEpoch:    epoch,
		eventsDone:      make(chan struct{}),
		eventsStopped:   make(chan struct{}),
		reminderContext: reminderContext,
		reminderCancel:  reminderCancel,
		reminderWake:    make(chan struct{}, 1),
		reminderStopped: make(chan struct{}),
	}
	go adapter.runEvents()
	go adapter.runReminders()
	return adapter, nil
}

func (a *Adapter) UpdateSession(
	session platform.RuntimeSession,
) error {
	if a == nil || !validSessionForAgent(session, a.config.AgentID) {
		return ErrSessionChanged
	}
	if a.config.Gateway != nil {
		if err := a.config.Gateway.UpdateSession(session); err != nil {
			return err
		}
	}
	a.mu.Lock()
	if a.session != nil &&
		(a.session.Agent.ID != session.Agent.ID ||
			a.session.Agent.ServerID != session.Agent.ServerID ||
			a.session.Agent.UserID != session.Agent.UserID ||
			a.session.Agent.RuntimeKind != session.Agent.RuntimeKind ||
			a.session.Agent.RuntimeModel != session.Agent.RuntimeModel) {
		a.mu.Unlock()
		return ErrSessionChanged
	}
	copied := session
	copied.Agent.Capabilities = append(
		[]string(nil),
		session.Agent.Capabilities...,
	)
	a.session = &copied
	a.mu.Unlock()
	a.wakeReminders()
	return nil
}

func (a *Adapter) HandleIngressMessage(
	ctx context.Context,
	message im.IncomingMessage,
) (ingress.MessageResult, error) {
	if a == nil || ctx == nil {
		return ingress.MessageResult{}, ErrInvalidConfig
	}
	if isPlatformWakeHint(message) {
		// The Tencent CustomElem only accelerates reconciliation. The durable
		// occurrence fetched from the platform is the sole Runtime input.
		a.wakeReminders()
		return ingress.MessageResult{Disposition: ingress.Consumed}, nil
	}
	a.runtimeMu.Lock()
	defer a.runtimeMu.Unlock()
	a.mu.Lock()
	if a.session == nil {
		a.mu.Unlock()
		return ingress.MessageResult{}, wrapMessageFailure(
			host.FailureCodeMessageSessionMissing,
			ErrSessionMissing,
		)
	}
	session := *a.session
	started := a.started
	a.mu.Unlock()
	conversationKey, err := conversationKeyFor(
		message.Ref.Conversation(),
	)
	if err != nil || strings.TrimSpace(message.SenderUserID) == "" {
		return ingress.MessageResult{}, wrapMessageFailure(
			host.FailureCodeMessageEnvelopeInvalid,
			im.ErrInvalidMessageRef,
		)
	}
	visibleTarget := conversationKey
	if !shouldDispatch(session.Agent, message) {
		return ingress.MessageResult{Disposition: ingress.Consumed}, nil
	}
	if a.config.Gateway != nil {
		visibleTarget, err = a.config.Gateway.RegisterMessage(message)
		if err != nil {
			return ingress.MessageResult{}, wrapMessageFailure(
				host.FailureCodeGatewayRegisterFailed,
				err,
			)
		}
	}

	resolved, ok := a.config.Runtimes.ResolveInternalRuntime(
		session.Agent.RuntimeKind,
	)
	if !ok || resolved.LaunchPlanner == nil {
		return ingress.MessageResult{}, wrapMessageFailure(
			host.FailureCodeRuntimeUnavailable,
			runtimeactor.ErrUnknownRuntime,
		)
	}
	wakeMessage, err := encodeWakeMessage(
		visibleTarget,
		message,
	)
	if err != nil {
		return ingress.MessageResult{}, wrapMessageFailure(host.FailureCodeRuntimePlanFailed, err)
	}
	plan, err := resolved.LaunchPlanner.PlanLaunch(
		runtimeapi.LaunchInput{
			AgentID:     a.config.AgentID,
			Runtime:     resolved.ID,
			WakeMessage: wakeMessage,
		},
	)
	if err != nil {
		return ingress.MessageResult{}, wrapMessageFailure(host.FailureCodeRuntimePlanFailed, err)
	}

	operationCode := host.FailureCodeRuntimeDeliverFailed
	if !started {
		operationCode = host.FailureCodeRuntimeStartFailed
		err = a.config.Actor.Start(
			ctx,
			runtimeactor.StartCommand{
				AgentID:          a.config.AgentID,
				LaunchID:         a.runtimeEpoch,
				OperationID:      message.Ref.MessageID(),
				Runtime:          resolved.ID,
				WorkingDirectory: a.config.WorkingDirectory,
				Prompt:           plan.Prompt,
				StandingPrompt:   plan.StandingPrompt,
				Model:            session.Agent.RuntimeModel,
				Environment:      a.runtimeEnvironment(),
				RebindDelivery:   plan.RebindDelivery,
				// The Vela Host starts from exactly one live IM occurrence.
				// That occurrence is already materialized in Prompt. Forwarding
				// the planner's optional PostStartDelivery would replay
				// the same message after the first turn completes.
				PostStartDelivery: nil,
			},
		)
	} else {
		delivery := runtimeapi.Delivery{
			Text: messageText(message),
		}
		if plan.RebindDelivery != nil {
			delivery = *plan.RebindDelivery
		}
		err = a.config.Actor.DeliverDirect(
			ctx,
			a.runtimeEpoch,
			delivery,
		)
	}
	if err != nil {
		return ingress.MessageResult{}, wrapMessageFailure(operationCode, err)
	}
	a.mu.Lock()
	a.started = true
	a.mu.Unlock()
	return ingress.MessageResult{Disposition: ingress.RuntimeAccepted}, nil
}

func wrapMessageFailure(code host.FailureCode, cause error) error {
	return host.NewFailureError(
		host.FailureScopeMessage,
		code,
		true,
		cause,
	)
}

func (a *Adapter) Close(ctx context.Context) error {
	if a == nil {
		return nil
	}
	// Cancel background reconciliation before competing for the Runtime lock.
	// A reminder may already be waiting on that lock; signaling first ensures
	// it observes cancellation as soon as the active Runtime operation returns.
	a.requestBackgroundStop()
	a.runtimeMu.Lock()
	a.mu.Lock()
	started := a.started
	a.started = false
	a.mu.Unlock()
	var err error
	if started {
		err = a.config.Actor.Stop(ctx, a.runtimeEpoch)
	}
	a.runtimeMu.Unlock()
	a.waitBackgroundStopped()
	return err
}

func (a *Adapter) runEvents() {
	defer close(a.eventsStopped)
	events := a.config.Actor.Events()
	for {
		select {
		case event, ok := <-events:
			if !ok {
				return
			}
			a.reconcileActorEvent(event)
			a.config.Actor.AckEvent(event.EventID)
		case <-a.eventsDone:
			return
		}
	}
}

func (a *Adapter) reconcileActorEvent(event runtimeactor.Event) {
	if event.AgentID != a.config.AgentID ||
		event.LaunchID != a.runtimeEpoch {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if event.Kind == runtimeapi.EventStatus &&
		event.Status == "inactive" {
		a.started = false
	}
}

func (a *Adapter) requestBackgroundStop() {
	a.stopEvents.Do(func() {
		close(a.eventsDone)
		a.reminderCancel()
	})
}

func (a *Adapter) waitBackgroundStopped() {
	<-a.eventsStopped
	<-a.reminderStopped
}

func (a *Adapter) runtimeEnvironment() map[string]string {
	if a.config.Gateway == nil {
		return nil
	}
	source := a.config.Gateway.RuntimeEnvironment()
	environment := make(map[string]string, len(source))
	for key, value := range source {
		environment[key] = value
	}
	return environment
}

func validSessionForAgent(
	session platform.RuntimeSession,
	agentID string,
) bool {
	agent := session.Agent
	return agent.ID == agentID &&
		strings.TrimSpace(agent.ServerID) != "" &&
		strings.TrimSpace(agent.UserID) != "" &&
		strings.TrimSpace(agent.RuntimeKind) != "" &&
		(agent.ReplyPolicy == "mention_and_dm" ||
			agent.ReplyPolicy == "all_channel_messages" ||
			agent.ReplyPolicy == "dm_only")
}

func shouldDispatch(
	agent platform.AgentIdentity,
	message im.IncomingMessage,
) bool {
	if message.SenderUserID == agent.UserID {
		return false
	}
	switch message.Ref.Conversation().Kind() {
	case im.ConversationC2C:
		return true
	case im.ConversationGroup, im.ConversationTopic:
		switch agent.ReplyPolicy {
		case "all_channel_messages":
			return true
		case "mention_and_dm":
			for _, element := range message.Elements {
				if element.Type != im.ElementMention {
					continue
				}
				for _, userID := range element.UserIDs {
					if userID == agent.UserID {
						return true
					}
				}
			}
		}
	}
	return false
}

func conversationKeyFor(
	conversation im.Conversation,
) (string, error) {
	encode := base64.RawURLEncoding.EncodeToString
	switch conversation.Kind() {
	case im.ConversationC2C:
		return "c2c:" + encode(
			[]byte(conversation.PeerUserID()),
		), nil
	case im.ConversationGroup:
		return "group:" + encode(
			[]byte(conversation.GroupID()),
		), nil
	case im.ConversationTopic:
		return "topic:" +
			encode([]byte(conversation.GroupID())) +
			":" +
			encode([]byte(conversation.TopicID())), nil
	default:
		return "", im.ErrInvalidConversation
	}
}

func topicConversationForKey(
	key string,
) (im.Conversation, error) {
	const prefix = "topic:"
	parts := strings.Split(strings.TrimPrefix(key, prefix), ":")
	if !strings.HasPrefix(key, prefix) || len(parts) != 2 {
		return im.Conversation{}, im.ErrInvalidConversation
	}
	decode := base64.RawURLEncoding.DecodeString
	groupID, err := decode(parts[0])
	if err != nil {
		return im.Conversation{}, im.ErrInvalidConversation
	}
	topicID, err := decode(parts[1])
	if err != nil {
		return im.Conversation{}, im.ErrInvalidConversation
	}
	return im.NewTopicConversation(string(groupID), string(topicID))
}

func encodeWakeMessage(
	target string,
	message im.IncomingMessage,
) ([]byte, error) {
	channelType := "channel"
	switch message.Ref.Conversation().Kind() {
	case im.ConversationC2C:
		channelType = "dm"
	case im.ConversationTopic:
		channelType = "thread"
	}
	return common.Marshal(map[string]any{
		"message_id":   message.Ref.MessageID(),
		"id":           message.Ref.MessageID(),
		"seq":          message.Ref.Sequence(),
		"channel_type": channelType,
		"channel_name": target,
		"sender_name":  message.SenderUserID,
		"target":       target,
		"text":         messageText(message),
	})
}

func messageText(message im.IncomingMessage) string {
	parts := make([]string, 0, len(message.Elements))
	for _, element := range message.Elements {
		if element.Type == im.ElementText &&
			strings.TrimSpace(element.Text) != "" {
			parts = append(parts, strings.TrimSpace(element.Text))
		}
	}
	return strings.Join(parts, "\n")
}

func unixMillis(value int64) time.Time {
	return time.UnixMilli(value).UTC()
}
