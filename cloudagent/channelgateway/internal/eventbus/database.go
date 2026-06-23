package eventbus

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"time"

	"cloudagent/channelgateway/internal/channel"
	"cloudagent/channelgateway/internal/store"
)

type DatabaseBusConfig struct {
	Store        InboundStore
	Lease        store.ChannelLease
	PollInterval time.Duration
	StaleAfter   time.Duration
}

type DatabaseBus struct {
	store        InboundStore
	lease        store.ChannelLease
	pollInterval time.Duration
	staleAfter   time.Duration
}

func NewDatabaseBus(cfg DatabaseBusConfig) (*DatabaseBus, error) {
	if cfg.Store == nil {
		return nil, errors.New("database event bus store is required")
	}
	if cfg.Lease.ChannelAccountID == "" || cfg.Lease.OwnerID == "" || cfg.Lease.FencingToken <= 0 {
		return nil, errors.New("database event bus lease is required")
	}
	pollInterval := cfg.PollInterval
	if pollInterval <= 0 {
		pollInterval = time.Second
	}
	staleAfter := cfg.StaleAfter
	if staleAfter <= 0 {
		staleAfter = 30 * time.Second
	}
	return &DatabaseBus{
		store:        cfg.Store,
		lease:        cfg.Lease,
		pollInterval: pollInterval,
		staleAfter:   staleAfter,
	}, nil
}

func (b *DatabaseBus) Close() error {
	return nil
}

func (b *DatabaseBus) PublishInbound(ctx context.Context, msg channel.Message) (string, error) {
	payload, err := json.Marshal(msg)
	if err != nil {
		return "", err
	}
	inserted, err := b.store.InsertInboundMessage(ctx, store.MessageRecord{
		ChannelAccountID:       msg.ChannelAccountID,
		ChannelType:            string(msg.ChannelType),
		ExternalMessageID:      msg.ExternalMessageID,
		ExternalConversationID: msg.ExternalConversationID,
		Direction:              "inbound",
		Status:                 "received",
		PayloadJSON:            string(payload),
	})
	if err != nil {
		return "", err
	}
	log.Printf("channelgateway eventbus_trace action=inbound_published driver=database account_id=%s external_message_id=%s inserted=%t",
		logValue(msg.ChannelAccountID), logValue(msg.ExternalMessageID), inserted)
	return msg.ExternalMessageID, nil
}

func (b *DatabaseBus) RunInboundConsumers(ctx context.Context, accountID string, workers int, handler channel.InboundHandler) error {
	if handler == nil {
		return errors.New("inbound handler is nil")
	}
	if workers <= 0 {
		workers = 1
	}
	errCh := make(chan error, workers)
	for i := 0; i < workers; i++ {
		go func(worker int) {
			errCh <- b.runInboundConsumer(ctx, worker, handler)
		}(i)
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case err := <-errCh:
		return err
	}
}

func (b *DatabaseBus) runInboundConsumer(ctx context.Context, worker int, handler channel.InboundHandler) error {
	ticker := time.NewTicker(b.pollInterval)
	defer ticker.Stop()
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := b.consumeRecoverable(ctx, worker, handler); err != nil {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

func (b *DatabaseBus) consumeRecoverable(ctx context.Context, worker int, handler channel.InboundHandler) error {
	items, err := b.store.ListRecoverableInboundMessages(ctx, b.lease, 16, b.staleAfter)
	if err != nil {
		return err
	}
	for _, item := range items {
		var msg channel.Message
		if err := json.Unmarshal([]byte(item.PayloadJSON), &msg); err != nil {
			log.Printf("channelgateway eventbus_trace action=inbound_decode_failed driver=database worker=%d account_id=%s external_message_id=%s error=%s",
				worker, logValue(item.ChannelAccountID), logValue(item.ExternalMessageID), logValue(err.Error()))
			_ = b.store.MarkInboundMessageFailed(ctx, b.lease, item.MessageID, item.ACPSessionID, "decode inbound payload: "+err.Error(), time.Now().UTC().Add(time.Minute))
			continue
		}
		if msg.ChannelAccountID == "" {
			msg.ChannelAccountID = item.ChannelAccountID
		}
		if msg.ChannelType == "" {
			msg.ChannelType = channel.Type(item.ChannelType)
		}
		if msg.ExternalMessageID == "" {
			msg.ExternalMessageID = item.ExternalMessageID
		}
		if msg.ExternalConversationID == "" {
			msg.ExternalConversationID = item.ExternalConversationID
		}
		if err := handler.HandleInbound(ctx, msg); err != nil {
			log.Printf("channelgateway eventbus_trace action=inbound_handle_failed driver=database worker=%d account_id=%s external_message_id=%s error=%s",
				worker, logValue(item.ChannelAccountID), logValue(item.ExternalMessageID), logValue(err.Error()))
			continue
		}
		log.Printf("channelgateway eventbus_trace action=inbound_acked driver=database worker=%d account_id=%s external_message_id=%s",
			worker, logValue(item.ChannelAccountID), logValue(item.ExternalMessageID))
	}
	return nil
}
