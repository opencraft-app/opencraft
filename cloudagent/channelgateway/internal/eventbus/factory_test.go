package eventbus

import (
	"context"
	"errors"
	"testing"
	"time"

	"cloudagent/channelgateway/internal/channel"
	"cloudagent/channelgateway/internal/store"
)

func TestNormalizeDriverDefaultsToDatabase(t *testing.T) {
	for _, input := range []string{"", "database", "db", "mysql"} {
		if got := NormalizeDriver(input); got != DriverDatabase {
			t.Fatalf("NormalizeDriver(%q)=%q, want %q", input, got, DriverDatabase)
		}
	}
	for _, input := range []string{"redis", "redis-streams", "redis_streams"} {
		if got := NormalizeDriver(input); got != DriverRedis {
			t.Fatalf("NormalizeDriver(%q)=%q, want %q", input, got, DriverRedis)
		}
	}
}

func TestNewInboundBusDefaultsToDatabase(t *testing.T) {
	ctx := context.Background()
	st, err := store.Open(ctx, t.TempDir()+"/channelgateway.db")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer st.Close()
	lease, err := st.AcquireChannelLease(ctx, "wecom-a", "owner-a", time.Minute)
	if err != nil {
		t.Fatalf("acquire lease: %v", err)
	}
	bus, driver, err := NewInboundBus(Options{
		Store: st,
		Lease: lease,
	})
	if err != nil {
		t.Fatalf("new inbound bus: %v", err)
	}
	defer bus.Close()
	if driver != DriverDatabase {
		t.Fatalf("driver=%q, want %q", driver, DriverDatabase)
	}
	if _, ok := bus.(*DatabaseBus); !ok {
		t.Fatalf("bus type=%T, want *DatabaseBus", bus)
	}
}

func TestNewInboundBusRejectsUnsupportedDriver(t *testing.T) {
	_, _, err := NewInboundBus(Options{Driver: "pulsar"})
	if !errors.Is(err, ErrUnsupportedDriver) {
		t.Fatalf("expected unsupported driver error, got %v", err)
	}
}

func TestInboundPublisherRejectsNilBus(t *testing.T) {
	err := (InboundPublisher{}).HandleInbound(context.Background(), channelMessage("msg-a"))
	if err == nil {
		t.Fatal("expected nil bus to be rejected")
	}
}

func channelMessage(id string) channel.Message {
	return channel.Message{
		ChannelAccountID:       "wecom-a",
		ChannelType:            channel.TypeWeCom,
		ExternalMessageID:      id,
		ExternalConversationID: "chat-a",
		Kind:                   channel.MessageText,
		Text:                   "hello",
	}
}
