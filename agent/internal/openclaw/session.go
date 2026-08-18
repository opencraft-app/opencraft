package openclaw

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"sync"
	"time"

	"github.com/google/uuid"
	"velachat/agent/internal/runtimeapi"
)

const defaultSessionKey = "agent:main:main"

type runtimeSession struct {
	client      *gatewayClient
	launchID    string
	events      chan runtimeapi.Event
	done        chan struct{}
	stopOnce    sync.Once
	mu          sync.Mutex
	active      string
	text        map[string]string
	deferred    map[string][]chatEvent
	process     *os.Process
	processDone chan error
	profileHome string
}

type chatEvent struct {
	RunID     string `json:"runId"`
	State     string `json:"state"`
	DeltaText string `json:"deltaText"`
	Message   struct {
		Role    string `json:"role"`
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	} `json:"message"`
}

func newRuntimeSession(client *gatewayClient, launchID string) *runtimeSession {
	session := &runtimeSession{
		client: client, launchID: launchID,
		events:   make(chan runtimeapi.Event, 64),
		done:     make(chan struct{}),
		text:     make(map[string]string),
		deferred: make(map[string][]chatEvent),
	}
	go session.consume()
	return session
}

func (session *runtimeSession) Deliver(
	ctx context.Context,
	delivery runtimeapi.Delivery,
) error {
	session.mu.Lock()
	if session.active != "" {
		session.mu.Unlock()
		return errors.New("OpenClaw turn is already active")
	}
	session.mu.Unlock()
	frame, err := session.client.request(ctx, "chat.send", map[string]any{
		"sessionKey":     defaultSessionKey,
		"message":        delivery.Text,
		"deliver":        false,
		"idempotencyKey": uuid.NewString(),
	})
	if err != nil {
		return err
	}
	var accepted struct {
		RunID  string `json:"runId"`
		Status string `json:"status"`
	}
	if err := json.Unmarshal(frame.Payload, &accepted); err != nil ||
		accepted.RunID == "" || accepted.Status != "started" {
		return errors.New("OpenClaw chat.send did not start a run")
	}
	session.mu.Lock()
	session.active = accepted.RunID
	deferred := append([]chatEvent(nil), session.deferred[accepted.RunID]...)
	delete(session.deferred, accepted.RunID)
	session.mu.Unlock()
	for _, event := range deferred {
		session.handleChat(event)
	}
	return nil
}

func (session *runtimeSession) Stop(context.Context) error {
	session.stopOnce.Do(func() {
		_ = session.client.Close()
		if session.process != nil {
			_ = session.process.Signal(os.Interrupt)
		}
	})
	<-session.done
	if session.processDone != nil {
		select {
		case <-session.processDone:
		case <-time.After(2 * time.Second):
			if session.process != nil {
				_ = session.process.Kill()
			}
			<-session.processDone
		}
	}
	return nil
}

func (session *runtimeSession) Events() <-chan runtimeapi.Event { return session.events }

func (session *runtimeSession) SessionID() string { return defaultSessionKey }

func (session *runtimeSession) RuntimeHomeInfo() runtimeapi.RuntimeHomeInfo {
	return runtimeapi.RuntimeHomeInfo{
		ObservedDir:   session.profileHome,
		ConfiguredDir: session.profileHome,
		Explicit:      true,
	}
}

var _ runtimeapi.RuntimeHomeProvider = (*runtimeSession)(nil)

func (session *runtimeSession) consume() {
	defer close(session.done)
	defer close(session.events)
	for {
		select {
		case frame := <-session.client.events:
			if frame.Event != "chat" {
				continue
			}
			var event chatEvent
			if json.Unmarshal(frame.Payload, &event) == nil && event.RunID != "" {
				session.handleChat(event)
			}
		case <-session.client.done:
			for {
				select {
				case frame := <-session.client.events:
					if frame.Event == "chat" {
						var event chatEvent
						if json.Unmarshal(frame.Payload, &event) == nil && event.RunID != "" {
							session.handleChat(event)
						}
					}
				default:
					return
				}
			}
		}
	}
}

func (session *runtimeSession) handleChat(event chatEvent) {
	session.mu.Lock()
	if session.active != event.RunID {
		session.deferred[event.RunID] = append(session.deferred[event.RunID], event)
		session.mu.Unlock()
		return
	}
	if snapshot := event.assistantText(); snapshot != "" {
		session.text[event.RunID] = snapshot
	} else {
		session.text[event.RunID] += event.DeltaText
	}
	if event.State != "final" {
		session.mu.Unlock()
		return
	}
	text := session.text[event.RunID]
	delete(session.text, event.RunID)
	session.active = ""
	session.mu.Unlock()
	if text != "" {
		session.events <- runtimeapi.Event{
			Kind: runtimeapi.EventAssistantText,
			Text: text, LaunchID: session.launchID, TurnID: event.RunID,
		}
	}
	session.events <- runtimeapi.Event{
		Kind:     runtimeapi.EventTurnCompletion,
		LaunchID: session.launchID, TurnID: event.RunID,
	}
}

func (event chatEvent) assistantText() string {
	if event.Message.Role != "assistant" {
		return ""
	}
	var text string
	for _, block := range event.Message.Content {
		if block.Type == "text" {
			text += block.Text
		}
	}
	return text
}
