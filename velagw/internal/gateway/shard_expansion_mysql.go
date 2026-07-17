package gateway

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	mysql "github.com/go-sql-driver/mysql"
)

const shardExpansionSelectColumns = `
	id, idempotency_key, request_hash, shard_id, name, status, retry_status, failed_step,
	last_error, max_sets, redis_db_start, redis_db_limit, max_connections, reserved_connections,
	admin_sql_max_open_conns, traffic_sql_max_open_conns, subscription_write_concurrency,
	mysql_endpoint, redis_endpoint, secret_name, terraform_run, verification_evidence,
	fleet_projected_at, verified_at, version, created_at, updated_at`

func (s *MySQLStore) CreateShardExpansion(ctx context.Context, expansion ShardExpansion) (ShardExpansion, bool, error) {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO llmgateway_shard_expansions (
			id, idempotency_key, request_hash, shard_id, active_shard_id, name, status, retry_status, failed_step,
			last_error, max_sets, redis_db_start, redis_db_limit, max_connections, reserved_connections,
			admin_sql_max_open_conns, traffic_sql_max_open_conns, subscription_write_concurrency,
			mysql_endpoint, redis_endpoint, secret_name, terraform_run, verification_evidence,
			fleet_projected_at, verified_at, version, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, expansion.ID, expansion.IdempotencyKey, expansion.RequestHash, expansion.ShardID, expansion.ShardID,
		expansion.Name,
		expansion.Status, expansion.RetryStatus, expansion.FailedStep, expansion.LastError,
		expansion.MaxSets, expansion.RedisDBStart, expansion.RedisDBLimit,
		expansion.MaxConnections, expansion.ReservedConnections, expansion.AdminSQLMaxOpenConns,
		expansion.TrafficSQLMaxOpenConns, expansion.SubscriptionWriteConcurrency,
		expansion.MySQLEndpoint, expansion.RedisEndpoint, expansion.SecretName, expansion.TerraformRun,
		expansion.VerificationEvidence, nullableTime(expansion.FleetProjectedAt), nullableTime(expansion.VerifiedAt),
		expansion.Version, expansion.CreatedAt, expansion.UpdatedAt)
	if err == nil {
		return expansion, true, nil
	}
	var mysqlErr *mysql.MySQLError
	if !errors.As(err, &mysqlErr) || mysqlErr.Number != 1062 {
		return ShardExpansion{}, false, err
	}
	existing, ok, getErr := s.GetShardExpansionByIdempotencyKey(ctx, expansion.IdempotencyKey)
	if getErr != nil {
		return ShardExpansion{}, false, getErr
	}
	if !ok {
		if strings.Contains(mysqlErr.Message, "uk_llmgateway_shard_expansion_active_shard") {
			return ShardExpansion{}, false, ErrShardExpansionAlreadyActive
		}
		return ShardExpansion{}, false, err
	}
	return existing, false, nil
}

func (s *MySQLStore) GetShardExpansion(ctx context.Context, id string) (ShardExpansion, bool, error) {
	row := s.db.QueryRowContext(ctx, "SELECT "+shardExpansionSelectColumns+" FROM llmgateway_shard_expansions WHERE id = ?", id)
	expansion, err := scanShardExpansion(row)
	if errors.Is(err, sql.ErrNoRows) {
		return ShardExpansion{}, false, nil
	}
	return expansion, err == nil, err
}

func (s *MySQLStore) GetShardExpansionByIdempotencyKey(ctx context.Context, key string) (ShardExpansion, bool, error) {
	row := s.db.QueryRowContext(ctx, "SELECT "+shardExpansionSelectColumns+" FROM llmgateway_shard_expansions WHERE idempotency_key = ?", key)
	expansion, err := scanShardExpansion(row)
	if errors.Is(err, sql.ErrNoRows) {
		return ShardExpansion{}, false, nil
	}
	return expansion, err == nil, err
}

func (s *MySQLStore) ListShardExpansions(ctx context.Context, options ShardExpansionListOptions) ([]ShardExpansion, error) {
	query := "SELECT " + shardExpansionSelectColumns + " FROM llmgateway_shard_expansions"
	args := make([]any, 0, len(options.Statuses)+1)
	if len(options.Statuses) > 0 {
		placeholders := make([]string, 0, len(options.Statuses))
		for _, status := range options.Statuses {
			placeholders = append(placeholders, "?")
			args = append(args, strings.TrimSpace(status))
		}
		query += " WHERE status IN (" + strings.Join(placeholders, ",") + ")"
	}
	query += " ORDER BY created_at DESC"
	if options.Limit > 0 {
		query += " LIMIT ?"
		args = append(args, options.Limit)
	}
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []ShardExpansion{}
	for rows.Next() {
		expansion, err := scanShardExpansion(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, expansion)
	}
	return result, rows.Err()
}

func (s *MySQLStore) UpdateShardExpansion(ctx context.Context, expansion ShardExpansion, expectedVersion int64) (ShardExpansion, bool, error) {
	now := time.Now().UTC()
	var activeShardID any = expansion.ShardID
	if shardExpansionTerminal(expansion.Status) {
		activeShardID = nil
	}
	result, err := s.db.ExecContext(ctx, `
		UPDATE llmgateway_shard_expansions SET
			status = ?, retry_status = ?, failed_step = ?, last_error = ?,
			active_shard_id = ?,
			mysql_endpoint = ?, redis_endpoint = ?, secret_name = ?, terraform_run = ?,
			verification_evidence = ?, fleet_projected_at = ?, verified_at = ?,
			version = version + 1, updated_at = ?
		WHERE id = ? AND version = ?
	`, expansion.Status, expansion.RetryStatus, expansion.FailedStep, expansion.LastError, activeShardID,
		expansion.MySQLEndpoint, expansion.RedisEndpoint, expansion.SecretName, expansion.TerraformRun,
		expansion.VerificationEvidence, nullableTime(expansion.FleetProjectedAt), nullableTime(expansion.VerifiedAt),
		now, expansion.ID, expectedVersion)
	if err != nil {
		return ShardExpansion{}, false, err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return ShardExpansion{}, false, err
	}
	if affected == 0 {
		return ShardExpansion{}, false, nil
	}
	expansion.Version = expectedVersion + 1
	expansion.UpdatedAt = now
	return expansion, true, nil
}

func scanShardExpansion(row scanner) (ShardExpansion, error) {
	var expansion ShardExpansion
	var fleetProjectedAt, verifiedAt sql.NullTime
	err := row.Scan(
		&expansion.ID, &expansion.IdempotencyKey, &expansion.RequestHash, &expansion.ShardID,
		&expansion.Name, &expansion.Status, &expansion.RetryStatus, &expansion.FailedStep,
		&expansion.LastError, &expansion.MaxSets, &expansion.RedisDBStart, &expansion.RedisDBLimit,
		&expansion.MaxConnections, &expansion.ReservedConnections, &expansion.AdminSQLMaxOpenConns,
		&expansion.TrafficSQLMaxOpenConns, &expansion.SubscriptionWriteConcurrency,
		&expansion.MySQLEndpoint, &expansion.RedisEndpoint, &expansion.SecretName, &expansion.TerraformRun,
		&expansion.VerificationEvidence, &fleetProjectedAt, &verifiedAt, &expansion.Version,
		&expansion.CreatedAt, &expansion.UpdatedAt,
	)
	if fleetProjectedAt.Valid {
		expansion.FleetProjectedAt = fleetProjectedAt.Time.UTC()
	}
	if verifiedAt.Valid {
		expansion.VerifiedAt = verifiedAt.Time.UTC()
	}
	if err != nil {
		return ShardExpansion{}, fmt.Errorf("scan shard expansion: %w", err)
	}
	return expansion, nil
}
