package devroute

import (
	"context"
	"errors"
	"strings"
	"sync"
	"time"
)

var ErrNotFound = errors.New("developer route registration not found")

type State string

const (
	StateActive   State = "active"
	StateExpired  State = "expired"
	StateDisabled State = "disabled"

	DeliveryModeDirect    = "direct"
	DeliveryModeDevtunnel = "devtunnel"
)

type Registration struct {
	UIN          string
	UserID       string
	BaseURL      string
	DeliveryMode string
	SourceIP     string
	Port         int
	TunnelHost   string
	// TunnelTokenHash is the SHA-256 digest of the short-lived capability
	// returned once at registration time. The raw capability is never stored.
	TunnelTokenHash string
	RenewedAt       time.Time
	TTL             time.Duration
	DisabledAt      *time.Time
}

func (r Registration) State(now time.Time) State {
	if r.DisabledAt != nil {
		return StateDisabled
	}
	if r.TTL <= 0 || !now.Before(r.RenewedAt.Add(r.TTL)) {
		return StateExpired
	}
	return StateActive
}

type Store interface {
	Ready(ctx context.Context) error
	Get(ctx context.Context, uin string) (Registration, error)
	Upsert(ctx context.Context, registration Registration) error
	Disable(ctx context.Context, uin string, disabledAt time.Time) error
}

type MemoryStore struct {
	mu            sync.RWMutex
	registrations map[string]Registration
}

func NewMemoryStore() *MemoryStore {
	return &MemoryStore{registrations: map[string]Registration{}}
}

func (s *MemoryStore) Ready(_ context.Context) error {
	return nil
}

func (s *MemoryStore) Get(_ context.Context, uin string) (Registration, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	registration, ok := s.registrations[strings.TrimSpace(uin)]
	if !ok {
		return Registration{}, ErrNotFound
	}
	return registration, nil
}

func (s *MemoryStore) Upsert(_ context.Context, registration Registration) error {
	registration.UIN = strings.TrimSpace(registration.UIN)
	registration.UserID = strings.TrimSpace(registration.UserID)
	registration.BaseURL = strings.TrimRight(strings.TrimSpace(registration.BaseURL), "/")
	registration.DeliveryMode = strings.ToLower(strings.TrimSpace(registration.DeliveryMode))
	registration.SourceIP = strings.TrimSpace(registration.SourceIP)
	registration.TunnelHost = strings.ToLower(strings.TrimSpace(registration.TunnelHost))
	registration.TunnelTokenHash = strings.ToLower(strings.TrimSpace(registration.TunnelTokenHash))
	registration.DisabledAt = nil
	s.mu.Lock()
	defer s.mu.Unlock()
	s.registrations[registration.UIN] = registration
	return nil
}

func (s *MemoryStore) Disable(_ context.Context, uin string, disabledAt time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := strings.TrimSpace(uin)
	registration, ok := s.registrations[key]
	if !ok {
		return ErrNotFound
	}
	registration.DisabledAt = &disabledAt
	s.registrations[key] = registration
	return nil
}
