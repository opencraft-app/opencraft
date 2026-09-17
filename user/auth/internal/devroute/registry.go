package devroute

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
)

var ErrRegistryNotFound = errors.New("developer route registration not found")

type StoredRegistration struct {
	UIN             string     `json:"uin"`
	UserID          string     `json:"userId"`
	BaseURL         string     `json:"baseUrl"`
	DeliveryMode    string     `json:"deliveryMode"`
	SourceIP        string     `json:"sourceIp"`
	Port            int        `json:"port"`
	TunnelHost      string     `json:"tunnelHost"`
	TunnelTokenHash string     `json:"tunnelTokenHash"`
	RenewedAt       time.Time  `json:"renewedAt"`
	TTLSeconds      int        `json:"ttlSeconds"`
	DisabledAt      *time.Time `json:"disabledAt,omitempty"`
}

type Registry interface {
	Ready(context.Context) error
	Get(context.Context, string) (StoredRegistration, error)
	Upsert(context.Context, StoredRegistration) error
	Disable(context.Context, string, time.Time) error
}

type MemoryRegistry struct {
	mu            sync.RWMutex
	registrations map[string]StoredRegistration
}

func NewMemoryRegistry() *MemoryRegistry {
	return &MemoryRegistry{registrations: map[string]StoredRegistration{}}
}

func (r *MemoryRegistry) Ready(context.Context) error { return nil }

func (r *MemoryRegistry) Get(_ context.Context, uin string) (StoredRegistration, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	registration, ok := r.registrations[strings.TrimSpace(uin)]
	if !ok {
		return StoredRegistration{}, ErrRegistryNotFound
	}
	return registration, nil
}

func (r *MemoryRegistry) Upsert(_ context.Context, registration StoredRegistration) error {
	registration = normalizeStoredRegistration(registration)
	registration.DisabledAt = nil
	r.mu.Lock()
	defer r.mu.Unlock()
	r.registrations[registration.UIN] = registration
	return nil
}

func (r *MemoryRegistry) Disable(_ context.Context, uin string, disabledAt time.Time) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	key := strings.TrimSpace(uin)
	registration, ok := r.registrations[key]
	if !ok {
		return ErrRegistryNotFound
	}
	disabledAt = disabledAt.UTC()
	registration.DisabledAt = &disabledAt
	r.registrations[key] = registration
	return nil
}

type MySQLRegistry struct{ db *sql.DB }

func NewMySQLRegistry(db *sql.DB) *MySQLRegistry { return &MySQLRegistry{db: db} }

func (r *MySQLRegistry) Ready(ctx context.Context) error {
	if r == nil || r.db == nil {
		return errors.New("developer route registry database is unavailable")
	}
	var registrations int64
	if err := r.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM developer_route_registrations").Scan(&registrations); err != nil {
		return fmt.Errorf("check developer route registry: %w", err)
	}
	return nil
}

func (r *MySQLRegistry) Get(ctx context.Context, uin string) (StoredRegistration, error) {
	if r == nil || r.db == nil {
		return StoredRegistration{}, errors.New("developer route registry database is unavailable")
	}
	var registration StoredRegistration
	var disabledAt sql.NullTime
	err := r.db.QueryRowContext(ctx, `
		SELECT uin, user_id, base_url, delivery_mode, source_ip, port,
		       tunnel_host, tunnel_token_hash, renewed_at, ttl_seconds, disabled_at
		FROM developer_route_registrations
		WHERE uin = ?
	`, strings.TrimSpace(uin)).Scan(
		&registration.UIN,
		&registration.UserID,
		&registration.BaseURL,
		&registration.DeliveryMode,
		&registration.SourceIP,
		&registration.Port,
		&registration.TunnelHost,
		&registration.TunnelTokenHash,
		&registration.RenewedAt,
		&registration.TTLSeconds,
		&disabledAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return StoredRegistration{}, ErrRegistryNotFound
	}
	if err != nil {
		return StoredRegistration{}, fmt.Errorf("get developer route registration: %w", err)
	}
	if disabledAt.Valid {
		registration.DisabledAt = &disabledAt.Time
	}
	return registration, nil
}

func (r *MySQLRegistry) Upsert(ctx context.Context, registration StoredRegistration) error {
	if r == nil || r.db == nil {
		return errors.New("developer route registry database is unavailable")
	}
	registration = normalizeStoredRegistration(registration)
	now := time.Now().UTC()
	_, err := r.db.ExecContext(ctx, `
		INSERT INTO developer_route_registrations (
			uin, user_id, base_url, delivery_mode, source_ip, port,
			tunnel_host, tunnel_token_hash, renewed_at, ttl_seconds,
			disabled_at, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
		ON DUPLICATE KEY UPDATE
			user_id = VALUES(user_id),
			base_url = VALUES(base_url),
			delivery_mode = VALUES(delivery_mode),
			source_ip = VALUES(source_ip),
			port = VALUES(port),
			tunnel_host = VALUES(tunnel_host),
			tunnel_token_hash = VALUES(tunnel_token_hash),
			renewed_at = VALUES(renewed_at),
			ttl_seconds = VALUES(ttl_seconds),
			disabled_at = NULL,
			updated_at = VALUES(updated_at)
	`,
		strings.TrimSpace(registration.UIN), strings.TrimSpace(registration.UserID),
		strings.TrimSpace(registration.BaseURL), strings.TrimSpace(registration.DeliveryMode),
		strings.TrimSpace(registration.SourceIP), registration.Port,
		strings.TrimSpace(registration.TunnelHost), strings.TrimSpace(registration.TunnelTokenHash),
		registration.RenewedAt.UTC(), registration.TTLSeconds, now, now,
	)
	if err != nil {
		return fmt.Errorf("upsert developer route registration: %w", err)
	}
	return nil
}

func (r *MySQLRegistry) Disable(ctx context.Context, uin string, disabledAt time.Time) error {
	if r == nil || r.db == nil {
		return errors.New("developer route registry database is unavailable")
	}
	result, err := r.db.ExecContext(ctx, `
		UPDATE developer_route_registrations
		SET disabled_at = ?, updated_at = ?
		WHERE uin = ?
	`, disabledAt.UTC(), disabledAt.UTC(), strings.TrimSpace(uin))
	if err != nil {
		return fmt.Errorf("disable developer route registration: %w", err)
	}
	if affected, _ := result.RowsAffected(); affected == 0 {
		return ErrRegistryNotFound
	}
	return nil
}

func normalizeStoredRegistration(registration StoredRegistration) StoredRegistration {
	registration.UIN = strings.TrimSpace(registration.UIN)
	registration.UserID = strings.TrimSpace(registration.UserID)
	registration.BaseURL = strings.TrimRight(strings.TrimSpace(registration.BaseURL), "/")
	registration.DeliveryMode = strings.ToLower(strings.TrimSpace(registration.DeliveryMode))
	registration.SourceIP = strings.TrimSpace(registration.SourceIP)
	registration.TunnelHost = strings.ToLower(strings.TrimSpace(registration.TunnelHost))
	registration.TunnelTokenHash = strings.ToLower(strings.TrimSpace(registration.TunnelTokenHash))
	registration.RenewedAt = registration.RenewedAt.UTC()
	if registration.DisabledAt != nil {
		disabledAt := registration.DisabledAt.UTC()
		registration.DisabledAt = &disabledAt
	}
	return registration
}
