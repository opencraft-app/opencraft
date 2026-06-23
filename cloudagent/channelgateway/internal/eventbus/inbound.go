package eventbus

import (
	"context"
	"errors"
	"time"

	"cloudagent/channelgateway/internal/channel"
	"cloudagent/channelgateway/internal/store"
)

type InboundBus interface {
	PublishInbound(ctx context.Context, msg channel.Message) (string, error)
	RunInboundConsumers(ctx context.Context, accountID string, workers int, handler channel.InboundHandler) error
	Close() error
}

type InboundStore interface {
	InsertInboundMessage(ctx context.Context, rec store.MessageRecord) (bool, error)
	ListRecoverableInboundMessages(ctx context.Context, lease store.ChannelLease, limit int, staleAfter time.Duration) ([]store.MessageRecord, error)
	MarkInboundMessageFailed(ctx context.Context, lease store.ChannelLease, messageID, acpSessionID, detail string, retryAt time.Time) error
}

type InboundPublisher struct {
	Bus InboundBus
}

func (p InboundPublisher) HandleInbound(ctx context.Context, msg channel.Message) error {
	if p.Bus == nil {
		return errors.New("inbound event bus is nil")
	}
	_, err := p.Bus.PublishInbound(ctx, msg)
	return err
}
