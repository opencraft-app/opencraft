package store

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"

	"github.com/go-sql-driver/mysql"

	"git.woa.com/wisp/mono/subscription/internal/service"
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

func (s *MySQLStore) GetPlanByCode(ctx context.Context, code string) (*service.Plan, error) {
	row := s.db.QueryRowContext(ctx, `
SELECT code, description, max_bot_count, created_at, updated_at
FROM subscription_plans
WHERE code = ?
LIMIT 1`, strings.TrimSpace(code))

	var plan service.Plan
	if err := row.Scan(
		&plan.Code,
		&plan.Description,
		&plan.MaxBotCount,
		&plan.CreatedAt,
		&plan.UpdatedAt,
	); err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, fmt.Errorf("query plan: %w", err)
	}
	return &plan, nil
}

func (s *MySQLStore) ListPlans(ctx context.Context) ([]service.Plan, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT code, description, max_bot_count, created_at, updated_at
FROM subscription_plans
ORDER BY code ASC`)
	if err != nil {
		return nil, fmt.Errorf("list plans: %w", err)
	}
	defer rows.Close()

	items := make([]service.Plan, 0)
	for rows.Next() {
		var plan service.Plan
		if err := rows.Scan(
			&plan.Code,
			&plan.Description,
			&plan.MaxBotCount,
			&plan.CreatedAt,
			&plan.UpdatedAt,
		); err != nil {
			return nil, fmt.Errorf("scan plan: %w", err)
		}
		items = append(items, plan)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate plans: %w", err)
	}
	return items, nil
}

func (s *MySQLStore) UpsertPlan(ctx context.Context, plan *service.Plan) error {
	_, err := s.db.ExecContext(ctx, `
INSERT INTO subscription_plans (
	code, description, max_bot_count, created_at, updated_at
) VALUES (?, ?, ?, ?, ?)
ON DUPLICATE KEY UPDATE
	description = VALUES(description),
	max_bot_count = VALUES(max_bot_count),
	updated_at = VALUES(updated_at)`,
		plan.Code,
		plan.Description,
		plan.MaxBotCount,
		plan.CreatedAt.UTC(),
		plan.UpdatedAt.UTC(),
	)
	if err != nil {
		return fmt.Errorf("upsert plan: %w", err)
	}
	return nil
}

func (s *MySQLStore) DeletePlan(ctx context.Context, code string) error {
	result, err := s.db.ExecContext(ctx, `DELETE FROM subscription_plans WHERE code = ?`, strings.TrimSpace(code))
	if err != nil {
		return fmt.Errorf("delete plan: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("delete plan rows affected: %w", err)
	}
	if affected == 0 {
		return fmt.Errorf("plan not found")
	}
	return nil
}

func (s *MySQLStore) GetCurrentByExternalUserID(ctx context.Context, externalUserID string) (*service.Subscription, error) {
	row := s.db.QueryRowContext(ctx, `
SELECT id, external_user_id, code, status, ai_gateway_plan_id, ai_gateway_subscription_id,
       current_period_start, current_period_end, source_order_id, created_at, updated_at
FROM subscriptions
WHERE external_user_id = ?
LIMIT 1`, strings.TrimSpace(externalUserID))

	var (
		record                           service.Subscription
		aiPlanID, aiSubID, sourceOrderID sql.NullString
		periodStart, periodEnd           sql.NullTime
	)
	if err := row.Scan(
		&record.ID,
		&record.ExternalUserID,
		&record.Code,
		&record.Status,
		&aiPlanID,
		&aiSubID,
		&periodStart,
		&periodEnd,
		&sourceOrderID,
		&record.CreatedAt,
		&record.UpdatedAt,
	); err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, fmt.Errorf("query subscription: %w", err)
	}
	record.AIGatewayPlanID = nullableString(aiPlanID)
	record.AIGatewaySubscriptionID = nullableString(aiSubID)
	record.SourceOrderID = nullableString(sourceOrderID)
	record.CurrentPeriodStart = nullableTime(periodStart)
	record.CurrentPeriodEnd = nullableTime(periodEnd)
	return &record, nil
}

func (s *MySQLStore) ListSubscriptions(ctx context.Context, filter service.AdminListFilter) ([]service.Subscription, error) {
	query := `
SELECT id, external_user_id, code, status, ai_gateway_plan_id, ai_gateway_subscription_id,
       current_period_start, current_period_end, source_order_id, created_at, updated_at
FROM subscriptions
WHERE 1=1`
	args := make([]any, 0, 8)

	if search := strings.TrimSpace(filter.Search); search != "" {
		query += ` AND (external_user_id LIKE ? OR code LIKE ? OR status LIKE ?)`
		like := "%" + search + "%"
		args = append(args, like, like, like)
	}
	if externalUserID := strings.TrimSpace(filter.ExternalUserID); externalUserID != "" {
		query += ` AND external_user_id = ?`
		args = append(args, externalUserID)
	}
	if status := strings.TrimSpace(filter.Status); status != "" {
		query += ` AND status = ?`
		args = append(args, status)
	}
	if code := strings.TrimSpace(filter.Code); code != "" {
		query += ` AND code = ?`
		args = append(args, code)
	}
	query += ` ORDER BY updated_at DESC`
	if filter.Limit > 0 {
		query += ` LIMIT ?`
		args = append(args, filter.Limit)
	}

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list subscriptions: %w", err)
	}
	defer rows.Close()

	items := make([]service.Subscription, 0)
	for rows.Next() {
		record, err := scanSubscription(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, record)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate subscriptions: %w", err)
	}
	return items, nil
}

func (s *MySQLStore) ListEventsByExternalUserID(ctx context.Context, externalUserID string, limit int) ([]service.SubscriptionEvent, error) {
	query := `
SELECT e.id, e.subscription_id, e.event_type, e.code, e.status, e.source_order_id, e.created_at
FROM subscription_events e
JOIN subscriptions s ON s.id = e.subscription_id
WHERE s.external_user_id = ?
ORDER BY e.created_at DESC`
	args := []any{strings.TrimSpace(externalUserID)}
	if limit > 0 {
		query += ` LIMIT ?`
		args = append(args, limit)
	}

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list subscription events: %w", err)
	}
	defer rows.Close()

	items := make([]service.SubscriptionEvent, 0)
	for rows.Next() {
		var record service.SubscriptionEvent
		var sourceOrderID sql.NullString
		if err := rows.Scan(
			&record.ID,
			&record.SubscriptionID,
			&record.EventType,
			&record.Code,
			&record.Status,
			&sourceOrderID,
			&record.CreatedAt,
		); err != nil {
			return nil, fmt.Errorf("scan subscription event: %w", err)
		}
		record.SourceOrderID = nullableString(sourceOrderID)
		items = append(items, record)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate subscription events: %w", err)
	}
	return items, nil
}

func (s *MySQLStore) UpsertCurrent(ctx context.Context, subscription *service.Subscription) error {
	_, err := s.db.ExecContext(ctx, `
INSERT INTO subscriptions (
	id, external_user_id, code, status, ai_gateway_plan_id, ai_gateway_subscription_id,
	current_period_start, current_period_end, source_order_id, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON DUPLICATE KEY UPDATE
	code = VALUES(code),
	status = VALUES(status),
	ai_gateway_plan_id = VALUES(ai_gateway_plan_id),
	ai_gateway_subscription_id = VALUES(ai_gateway_subscription_id),
	current_period_start = VALUES(current_period_start),
	current_period_end = VALUES(current_period_end),
	source_order_id = VALUES(source_order_id),
	updated_at = VALUES(updated_at)`,
		subscription.ID,
		subscription.ExternalUserID,
		subscription.Code,
		subscription.Status,
		nullIfEmpty(subscription.AIGatewayPlanID),
		nullIfEmpty(subscription.AIGatewaySubscriptionID),
		nullableTimeValue(subscription.CurrentPeriodStart),
		nullableTimeValue(subscription.CurrentPeriodEnd),
		nullIfEmpty(subscription.SourceOrderID),
		subscription.CreatedAt.UTC(),
		subscription.UpdatedAt.UTC(),
	)
	if err != nil {
		return fmt.Errorf("upsert subscription: %w", err)
	}
	return nil
}

func (s *MySQLStore) AppendEvent(ctx context.Context, event *service.SubscriptionEvent) error {
	_, err := s.db.ExecContext(ctx, `
INSERT INTO subscription_events (
	id, subscription_id, event_type, code, status, source_order_id, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		event.ID,
		event.SubscriptionID,
		event.EventType,
		event.Code,
		event.Status,
		nullIfEmpty(event.SourceOrderID),
		event.CreatedAt.UTC(),
	)
	if err != nil {
		return fmt.Errorf("insert subscription event: %w", err)
	}
	return nil
}

func scanSubscription(scanner interface {
	Scan(dest ...any) error
}) (service.Subscription, error) {
	var (
		record                           service.Subscription
		aiPlanID, aiSubID, sourceOrderID sql.NullString
		periodStart, periodEnd           sql.NullTime
	)
	if err := scanner.Scan(
		&record.ID,
		&record.ExternalUserID,
		&record.Code,
		&record.Status,
		&aiPlanID,
		&aiSubID,
		&periodStart,
		&periodEnd,
		&sourceOrderID,
		&record.CreatedAt,
		&record.UpdatedAt,
	); err != nil {
		return service.Subscription{}, fmt.Errorf("scan subscription: %w", err)
	}
	record.AIGatewayPlanID = nullableString(aiPlanID)
	record.AIGatewaySubscriptionID = nullableString(aiSubID)
	record.SourceOrderID = nullableString(sourceOrderID)
	record.CurrentPeriodStart = nullableTime(periodStart)
	record.CurrentPeriodEnd = nullableTime(periodEnd)
	return record, nil
}

func nullIfEmpty(value string) any {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return strings.TrimSpace(value)
}

func nullableString(value sql.NullString) string {
	if value.Valid {
		return value.String
	}
	return ""
}

func nullableTime(value sql.NullTime) *time.Time {
	if !value.Valid {
		return nil
	}
	ts := value.Time.UTC()
	return &ts
}

func nullableTimeValue(value *time.Time) any {
	if value == nil {
		return nil
	}
	return value.UTC()
}
