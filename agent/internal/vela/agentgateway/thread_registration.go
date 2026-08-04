package agentgateway

import (
	"context"
	"errors"
	"os"
	"strings"
	"sync"

	rootstate "github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/state"
	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/vela/im"
	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/vela/platform"
)

const (
	pendingThreadRegistrationPath = "runtime/pending-thread-replies-v1.json"
	maximumPendingThreadReplies   = 1000
)

type pendingThreadRegistration struct {
	ID             string `json:"id"`
	ChannelID      string `json:"channelId"`
	ThreadID       string `json:"threadId"`
	MessageKind    string `json:"messageKind"`
	MessageID      string `json:"messageId"`
	GroupID        string `json:"groupId"`
	TopicID        string `json:"topicId,omitempty"`
	SenderUserID   string `json:"senderUserId,omitempty"`
	Sequence       int64  `json:"sequence"`
	Timestamp      int64  `json:"timestamp"`
	IdempotencyKey string `json:"idempotencyKey"`
}

type pendingThreadRegistrationFile struct {
	Version int                         `json:"version"`
	Items   []pendingThreadRegistration `json:"items"`
}

type pendingThreadState struct {
	mu    sync.Mutex
	items []pendingThreadRegistration
}

func loadPendingThreadRegistrations(
	store *rootstate.Store,
) ([]pendingThreadRegistration, error) {
	var file pendingThreadRegistrationFile
	if err := store.Read(pendingThreadRegistrationPath, &file); err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	if file.Version != 1 || len(file.Items) > maximumPendingThreadReplies {
		return nil, ErrInvalidConfig
	}
	seen := make(map[string]struct{}, len(file.Items))
	for _, item := range file.Items {
		if !validPendingThreadRegistration(item) {
			return nil, ErrInvalidConfig
		}
		if _, duplicate := seen[item.ID]; duplicate {
			return nil, ErrInvalidConfig
		}
		seen[item.ID] = struct{}{}
	}
	return file.Items, nil
}

func validPendingThreadRegistration(item pendingThreadRegistration) bool {
	return strings.TrimSpace(item.ID) != "" && validUUIDv7String(item.ChannelID) &&
		validUUIDv7String(item.ThreadID) && item.MessageKind == string(im.ConversationGroup) &&
		strings.TrimSpace(item.MessageID) != "" && strings.TrimSpace(item.GroupID) != "" &&
		item.Sequence >= 0 && item.Timestamp >= 0 &&
		strings.TrimSpace(item.IdempotencyKey) != ""
}

func (g *Gateway) enqueuePendingThreadRegistration(
	item pendingThreadRegistration,
) error {
	if !validPendingThreadRegistration(item) {
		return ErrInvalidConfig
	}
	g.pendingThreads.mu.Lock()
	defer g.pendingThreads.mu.Unlock()
	next := make([]pendingThreadRegistration, 0, len(g.pendingThreads.items)+1)
	for _, existing := range g.pendingThreads.items {
		if existing.ID == item.ID ||
			existing.ThreadID == item.ThreadID && existing.MessageID == item.MessageID {
			continue
		}
		next = append(next, existing)
	}
	next = append(next, item)
	if len(next) > maximumPendingThreadReplies {
		return ErrGatewayUnavailable
	}
	if err := g.persistPendingThreadRegistrations(next); err != nil {
		return err
	}
	g.pendingThreads.items = next
	return nil
}

func (g *Gateway) completePendingThreadRegistration(id string) error {
	g.pendingThreads.mu.Lock()
	defer g.pendingThreads.mu.Unlock()
	next := make([]pendingThreadRegistration, 0, len(g.pendingThreads.items))
	for _, item := range g.pendingThreads.items {
		if item.ID != id {
			next = append(next, item)
		}
	}
	if len(next) == len(g.pendingThreads.items) {
		return nil
	}
	if err := g.persistPendingThreadRegistrations(next); err != nil {
		return err
	}
	g.pendingThreads.items = next
	return nil
}

func (g *Gateway) persistPendingThreadRegistrations(
	items []pendingThreadRegistration,
) error {
	if len(items) == 0 {
		return g.store.Remove(pendingThreadRegistrationPath)
	}
	return g.store.Write(pendingThreadRegistrationPath, pendingThreadRegistrationFile{
		Version: 1, Items: items,
	})
}

func (g *Gateway) enrichPendingThreadRegistration(reference im.MessageRef) error {
	if g == nil || !reference.Conversation().Valid() || reference.Sequence() < 1 ||
		reference.TimestampMS() < 1 {
		return nil
	}
	conversation := reference.Conversation()
	g.pendingThreads.mu.Lock()
	defer g.pendingThreads.mu.Unlock()
	next := append([]pendingThreadRegistration(nil), g.pendingThreads.items...)
	changed := false
	for index := range next {
		item := &next[index]
		if item.MessageID != reference.MessageID() || item.GroupID != conversation.GroupID() ||
			item.TopicID != conversation.TopicID() || item.Sequence > 0 {
			continue
		}
		item.Sequence = reference.Sequence()
		item.Timestamp = reference.TimestampMS() / 1000
		changed = true
	}
	if !changed {
		return nil
	}
	if err := g.persistPendingThreadRegistrations(next); err != nil {
		return err
	}
	g.pendingThreads.items = next
	return nil
}

func (g *Gateway) drainPendingThreadRegistrations(ctx context.Context) error {
	if g == nil || ctx == nil {
		return nil
	}
	client, token, ok := g.runtimeTaskSession()
	if !ok {
		return nil
	}
	g.pendingThreads.mu.Lock()
	items := append([]pendingThreadRegistration(nil), g.pendingThreads.items...)
	g.pendingThreads.mu.Unlock()
	for _, item := range items {
		if item.Sequence < 1 || item.Timestamp < 1 {
			continue
		}
		_, err := client.RegisterRuntimeThreadReply(
			ctx, token, item.ChannelID, item.ThreadID,
			platform.ThreadMessageRef{
				Kind: item.MessageKind, MessageID: item.MessageID,
				GroupID: item.GroupID, TopicID: item.TopicID,
				SenderUserID: item.SenderUserID,
				Sequence:     item.Sequence, Timestamp: item.Timestamp,
			},
			item.IdempotencyKey,
		)
		if err != nil {
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				return err
			}
			continue
		}
		if err := g.completePendingThreadRegistration(item.ID); err != nil {
			return err
		}
	}
	return nil
}
