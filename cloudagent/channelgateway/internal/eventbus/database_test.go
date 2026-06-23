package eventbus

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"cloudagent/channelgateway/internal/channel"
	"cloudagent/channelgateway/internal/store"
)

type handlerFunc func(context.Context, channel.Message) error

func (fn handlerFunc) HandleInbound(ctx context.Context, msg channel.Message) error {
	return fn(ctx, msg)
}

func TestDatabaseBusPublishesAndConsumesInbound(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	st, err := store.Open(ctx, t.TempDir()+"/channelgateway.db")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer st.Close()
	lease, err := st.AcquireChannelLease(ctx, "wecom-a", "owner-a", time.Minute)
	if err != nil {
		t.Fatalf("acquire lease: %v", err)
	}
	bus, err := NewDatabaseBus(DatabaseBusConfig{
		Store:        st,
		Lease:        lease,
		PollInterval: 10 * time.Millisecond,
		StaleAfter:   time.Nanosecond,
	})
	if err != nil {
		t.Fatalf("new database bus: %v", err)
	}
	if _, err := bus.PublishInbound(ctx, channel.Message{
		ChannelAccountID:       "wecom-a",
		ChannelType:            channel.TypeWeCom,
		ExternalMessageID:      "msg-a",
		ExternalConversationID: "chat-a",
		Kind:                   channel.MessageText,
		Text:                   "hello",
	}); err != nil {
		t.Fatalf("publish inbound: %v", err)
	}
	handled := make(chan channel.Message, 1)
	var calls atomic.Int64
	go func() {
		_ = bus.RunInboundConsumers(ctx, "wecom-a", 1, handlerFunc(func(ctx context.Context, msg channel.Message) error {
			calls.Add(1)
			rec, claimed, err := st.ClaimInboundMessage(ctx, lease, msg.ExternalMessageID, time.Nanosecond)
			if err != nil {
				return err
			}
			if !claimed {
				return nil
			}
			if err := st.MarkInboundMessageDone(ctx, lease, rec.MessageID, "session-a"); err != nil {
				return err
			}
			handled <- msg
			return nil
		}))
	}()
	select {
	case msg := <-handled:
		if msg.ExternalMessageID != "msg-a" || msg.Text != "hello" {
			t.Fatalf("unexpected message: %#v", msg)
		}
	case <-ctx.Done():
		t.Fatal("timed out waiting for database bus consumer")
	}
	if got := calls.Load(); got != 1 {
		t.Fatalf("expected one handler call, got %d", got)
	}
}
