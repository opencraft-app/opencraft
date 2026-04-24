package data

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"

	"github.com/go-sql-driver/mysql"
)

type User struct {
	ID             string    `json:"id"`
	Name           string    `json:"name"`
	Email          string    `json:"email,omitempty"`
	Phone          string    `json:"phone,omitempty"`
	InviteRequired bool      `json:"inviteRequired"`
	CreatedAt      time.Time `json:"createdAt"`
}

type Subscription struct {
	UserID      string    `json:"userId"`
	Tier        string    `json:"tier"`
	ConfirmedAt time.Time `json:"confirmedAt"`
}

type Sandbox struct {
	ID         string    `json:"id"`
	PoolID     string    `json:"poolId"`
	InstanceID string    `json:"instanceId"`
	CreatedAt  time.Time `json:"createdAt"`
}

type Provider interface {
	ListUsers(ctx context.Context) ([]User, error)
	GetUser(ctx context.Context, id string) (User, error)
	ListSubscriptions(ctx context.Context) ([]Subscription, error)
	ListSandboxes(ctx context.Context) ([]Sandbox, error)
}

type StaticProvider struct {
	UsersData         []User
	SubscriptionsData []Subscription
	SandboxesData     []Sandbox
}

func (p StaticProvider) ListUsers(_ context.Context) ([]User, error) {
	return append([]User(nil), p.UsersData...), nil
}

func (p StaticProvider) GetUser(_ context.Context, id string) (User, error) {
	for _, user := range p.UsersData {
		if user.ID == id {
			return user, nil
		}
	}
	return User{}, sql.ErrNoRows
}

func (p StaticProvider) ListSubscriptions(_ context.Context) ([]Subscription, error) {
	return append([]Subscription(nil), p.SubscriptionsData...), nil
}

func (p StaticProvider) ListSandboxes(_ context.Context) ([]Sandbox, error) {
	return append([]Sandbox(nil), p.SandboxesData...), nil
}

type MySQLProvider struct {
	authDB    *sql.DB
	sandboxDB *sql.DB
}

func NewMySQLProvider(authDSN string, sandboxDSN string) (*MySQLProvider, error) {
	authDB, err := openMySQL(authDSN)
	if err != nil {
		return nil, fmt.Errorf("open auth mysql: %w", err)
	}
	sandboxDB, err := openMySQL(sandboxDSN)
	if err != nil {
		_ = authDB.Close()
		return nil, fmt.Errorf("open sandbox mysql: %w", err)
	}
	return &MySQLProvider{authDB: authDB, sandboxDB: sandboxDB}, nil
}

func openMySQL(dsn string) (*sql.DB, error) {
	trimmed := strings.TrimSpace(dsn)
	if trimmed == "" {
		return nil, fmt.Errorf("dsn is required")
	}
	cfg, err := mysql.ParseDSN(trimmed)
	if err != nil {
		return nil, fmt.Errorf("parse mysql dsn: %w", err)
	}
	cfg.ParseTime = true
	cfg.Loc = time.UTC
	if cfg.Params == nil {
		cfg.Params = make(map[string]string)
	}
	cfg.Params["time_zone"] = "'+00:00'"
	db, err := sql.Open("mysql", cfg.FormatDSN())
	if err != nil {
		return nil, err
	}
	if err := db.Ping(); err != nil {
		_ = db.Close()
		return nil, err
	}
	return db, nil
}

func (p *MySQLProvider) ListUsers(ctx context.Context) ([]User, error) {
	rows, err := p.authDB.QueryContext(ctx, `
		SELECT id, name, COALESCE(email, ''), COALESCE(phone, ''), invite_required, created_at
		FROM users
		ORDER BY created_at DESC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var users []User
	for rows.Next() {
		var user User
		if err := rows.Scan(&user.ID, &user.Name, &user.Email, &user.Phone, &user.InviteRequired, &user.CreatedAt); err != nil {
			return nil, err
		}
		users = append(users, user)
	}
	return users, rows.Err()
}

func (p *MySQLProvider) GetUser(ctx context.Context, id string) (User, error) {
	var user User
	err := p.authDB.QueryRowContext(ctx, `
		SELECT id, name, COALESCE(email, ''), COALESCE(phone, ''), invite_required, created_at
		FROM users
		WHERE id = ?
	`, strings.TrimSpace(id)).Scan(&user.ID, &user.Name, &user.Email, &user.Phone, &user.InviteRequired, &user.CreatedAt)
	return user, err
}

func (p *MySQLProvider) ListSubscriptions(ctx context.Context) ([]Subscription, error) {
	rows, err := p.authDB.QueryContext(ctx, `
		SELECT user_id, tier, confirmed_at
		FROM subscriptions
		ORDER BY confirmed_at DESC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var subscriptions []Subscription
	for rows.Next() {
		var subscription Subscription
		if err := rows.Scan(&subscription.UserID, &subscription.Tier, &subscription.ConfirmedAt); err != nil {
			return nil, err
		}
		subscriptions = append(subscriptions, subscription)
	}
	return subscriptions, rows.Err()
}

func (p *MySQLProvider) ListSandboxes(ctx context.Context) ([]Sandbox, error) {
	rows, err := p.sandboxDB.QueryContext(ctx, `
		SELECT id, pool_id, instance_id, created_at
		FROM sandboxes
		ORDER BY created_at DESC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var sandboxes []Sandbox
	for rows.Next() {
		var sandbox Sandbox
		if err := rows.Scan(&sandbox.ID, &sandbox.PoolID, &sandbox.InstanceID, &sandbox.CreatedAt); err != nil {
			return nil, err
		}
		sandboxes = append(sandboxes, sandbox)
	}
	return sandboxes, rows.Err()
}
