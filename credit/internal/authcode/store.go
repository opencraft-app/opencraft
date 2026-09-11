package authcode

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

const (
	keyPrefix  = "credit:auth_code:"
	DefaultTTL = 10 * time.Minute
)

var (
	ErrTicketNotFound = errors.New("authcode: ticket not found or already consumed")
	consumeScript     = redis.NewScript(`
local raw = redis.call("GET", KEYS[1])
if not raw then return nil end
redis.call("DEL", KEYS[1])
return raw
`)
)

type Ticket struct {
	UserID   string `json:"user_id"`
	DealName string `json:"deal_name"`
	IssuedAt int64  `json:"issued_at"`
}

type Store interface {
	Issue(context.Context, *Ticket) (string, error)
	Consume(context.Context, string) (*Ticket, error)
}

type redisStore struct {
	client *redis.Client
	ttl    time.Duration
}

func New(client *redis.Client, ttl time.Duration) Store {
	if ttl <= 0 {
		ttl = DefaultTTL
	}
	return &redisStore{client: client, ttl: ttl}
}

func (s *redisStore) Issue(ctx context.Context, ticket *Ticket) (string, error) {
	if ticket == nil || strings.TrimSpace(ticket.UserID) == "" || strings.TrimSpace(ticket.DealName) == "" {
		return "", fmt.Errorf("authcode: ticket missing user_id or deal_name")
	}
	if ticket.IssuedAt == 0 {
		ticket.IssuedAt = time.Now().Unix()
	}
	raw, err := json.Marshal(ticket)
	if err != nil {
		return "", fmt.Errorf("authcode marshal: %w", err)
	}
	code := uuid.NewString()
	if err := s.client.Set(ctx, keyPrefix+code, raw, s.ttl).Err(); err != nil {
		return "", fmt.Errorf("authcode set: %w", err)
	}
	return code, nil
}

func (s *redisStore) Consume(ctx context.Context, code string) (*Ticket, error) {
	code = strings.TrimSpace(code)
	if code == "" {
		return nil, ErrTicketNotFound
	}
	raw, err := consumeScript.Run(ctx, s.client, []string{keyPrefix + code}).Text()
	if err != nil {
		if errors.Is(err, redis.Nil) {
			return nil, ErrTicketNotFound
		}
		return nil, fmt.Errorf("authcode consume: %w", err)
	}
	var ticket Ticket
	if err := json.Unmarshal([]byte(raw), &ticket); err != nil {
		return nil, fmt.Errorf("authcode unmarshal: %w", err)
	}
	return &ticket, nil
}
