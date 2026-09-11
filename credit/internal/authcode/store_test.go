package authcode

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

func newTestStore(t *testing.T, ttl time.Duration) (Store, *miniredis.Miniredis) {
	t.Helper()
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("start miniredis: %v", err)
	}
	t.Cleanup(mr.Close)
	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = client.Close() })
	return New(client, ttl), mr
}

func TestStoreIssueAndConsume(t *testing.T) {
	st, _ := newTestStore(t, DefaultTTL)
	code, err := st.Issue(context.Background(), &Ticket{
		UserID:   "usr-1",
		DealName: "deal-1",
	})
	if err != nil {
		t.Fatalf("Issue(): %v", err)
	}
	if len(code) != 36 || strings.Count(code, "-") != 4 {
		t.Fatalf("auth code shape = %q", code)
	}

	ticket, err := st.Consume(context.Background(), code)
	if err != nil {
		t.Fatalf("Consume(): %v", err)
	}
	if ticket.UserID != "usr-1" || ticket.DealName != "deal-1" || ticket.IssuedAt == 0 {
		t.Fatalf("ticket = %+v", ticket)
	}
}

func TestStoreRejectsInvalidTicket(t *testing.T) {
	st, _ := newTestStore(t, DefaultTTL)
	for _, ticket := range []*Ticket{
		nil,
		{DealName: "deal-1"},
		{UserID: "usr-1"},
	} {
		if _, err := st.Issue(context.Background(), ticket); err == nil {
			t.Fatalf("Issue(%+v) succeeded", ticket)
		}
	}
}

func TestStoreConsumeMissingOrAlreadyConsumedTicket(t *testing.T) {
	st, _ := newTestStore(t, DefaultTTL)
	for _, code := range []string{"", "missing"} {
		if _, err := st.Consume(context.Background(), code); !errors.Is(err, ErrTicketNotFound) {
			t.Fatalf("Consume(%q) error = %v", code, err)
		}
	}

	code, err := st.Issue(context.Background(), &Ticket{UserID: "usr-1", DealName: "deal-1"})
	if err != nil {
		t.Fatalf("Issue(): %v", err)
	}
	if _, err := st.Consume(context.Background(), code); err != nil {
		t.Fatalf("first Consume(): %v", err)
	}
	if _, err := st.Consume(context.Background(), code); !errors.Is(err, ErrTicketNotFound) {
		t.Fatalf("second Consume() error = %v", err)
	}
}

func TestStoreTicketExpires(t *testing.T) {
	st, mr := newTestStore(t, 10*time.Minute)
	code, err := st.Issue(context.Background(), &Ticket{UserID: "usr-1", DealName: "deal-1"})
	if err != nil {
		t.Fatalf("Issue(): %v", err)
	}
	mr.FastForward(10*time.Minute + time.Second)
	if _, err := st.Consume(context.Background(), code); !errors.Is(err, ErrTicketNotFound) {
		t.Fatalf("Consume() after expiry error = %v", err)
	}
}

func TestNewUsesDefaultTTL(t *testing.T) {
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("start miniredis: %v", err)
	}
	t.Cleanup(mr.Close)
	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = client.Close() })

	st := New(client, 0).(*redisStore)
	if st.ttl != DefaultTTL {
		t.Fatalf("ttl = %v, want %v", st.ttl, DefaultTTL)
	}
}
