package store

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"

	"github.com/go-sql-driver/mysql"

	"git.woa.com/wisp/mono/payment/internal/service"
)

type MySQLStore struct {
	db *sql.DB
}

func NewMySQLStore(dsn string) (*MySQLStore, error) {
	cfg, err := mysql.ParseDSN(strings.TrimSpace(dsn))
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
		return nil, fmt.Errorf("open mysql: %w", err)
	}
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, fmt.Errorf("ping mysql: %w", err)
	}
	return &MySQLStore{db: db}, nil
}

func (s *MySQLStore) Close() error {
	if s == nil || s.db == nil {
		return nil
	}
	return s.db.Close()
}

func (s *MySQLStore) CreateOrder(ctx context.Context, order *service.Order) error {
	_, err := s.db.ExecContext(ctx, `
INSERT INTO payment_orders (
	id, external_user_id, code, status, provider, provider_order_id, checkout_url, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		order.ID,
		order.ExternalUserID,
		order.Code,
		order.Status,
		order.Provider,
		nullIfEmpty(order.ProviderOrderID),
		nullIfEmpty(order.CheckoutURL),
		order.CreatedAt.UTC(),
		order.UpdatedAt.UTC(),
	)
	if err != nil {
		return fmt.Errorf("insert payment order: %w", err)
	}
	return nil
}

func (s *MySQLStore) GetOrderByID(ctx context.Context, orderID string) (*service.Order, error) {
	row := s.db.QueryRowContext(ctx, `
SELECT id, external_user_id, code, status, provider, provider_order_id, checkout_url, created_at, updated_at
FROM payment_orders
WHERE id = ?
LIMIT 1`, strings.TrimSpace(orderID))

	var (
		order                        service.Order
		providerOrderID, checkoutURL sql.NullString
	)
	if err := row.Scan(
		&order.ID,
		&order.ExternalUserID,
		&order.Code,
		&order.Status,
		&order.Provider,
		&providerOrderID,
		&checkoutURL,
		&order.CreatedAt,
		&order.UpdatedAt,
	); err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, fmt.Errorf("query payment order: %w", err)
	}
	if providerOrderID.Valid {
		order.ProviderOrderID = providerOrderID.String
	}
	if checkoutURL.Valid {
		order.CheckoutURL = checkoutURL.String
	}
	return &order, nil
}

func (s *MySQLStore) UpdateOrder(ctx context.Context, order *service.Order) error {
	_, err := s.db.ExecContext(ctx, `
UPDATE payment_orders
SET status = ?, provider_order_id = ?, checkout_url = ?, updated_at = ?
WHERE id = ?`,
		order.Status,
		nullIfEmpty(order.ProviderOrderID),
		nullIfEmpty(order.CheckoutURL),
		order.UpdatedAt.UTC(),
		order.ID,
	)
	if err != nil {
		return fmt.Errorf("update payment order: %w", err)
	}
	return nil
}

func nullIfEmpty(value string) any {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return strings.TrimSpace(value)
}
