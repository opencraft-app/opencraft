package gateway

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	mysql "github.com/go-sql-driver/mysql"
)

type MySQLStore struct {
	db *sql.DB
}

type MySQLStoreOptions struct {
	MaxOpenConns    int
	MaxIdleConns    int
	ConnMaxLifetime time.Duration
	ConnMaxIdleTime time.Duration
}

func NewMySQLStore(ctx context.Context, dsn string) (*MySQLStore, error) {
	return NewMySQLStoreWithOptions(ctx, dsn, MySQLStoreOptions{})
}

func NewMySQLStoreWithOptions(ctx context.Context, dsn string, options MySQLStoreOptions) (*MySQLStore, error) {
	normalized, err := normalizeMySQLDSN(dsn)
	if err != nil {
		return nil, err
	}
	db, err := sql.Open("mysql", normalized)
	if err != nil {
		return nil, err
	}
	configureMySQLPool(db, options)
	store := &MySQLStore{db: db}
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, err
	}
	if err := store.migrate(ctx); err != nil {
		_ = db.Close()
		return nil, err
	}
	return store, nil
}

func configureMySQLPool(db *sql.DB, options MySQLStoreOptions) {
	if db == nil {
		return
	}
	if options.MaxOpenConns > 0 {
		db.SetMaxOpenConns(options.MaxOpenConns)
	}
	if options.MaxIdleConns > 0 {
		maxIdle := options.MaxIdleConns
		if options.MaxOpenConns > 0 && maxIdle > options.MaxOpenConns {
			maxIdle = options.MaxOpenConns
		}
		db.SetMaxIdleConns(maxIdle)
	}
	if options.ConnMaxLifetime > 0 {
		db.SetConnMaxLifetime(options.ConnMaxLifetime)
	}
	if options.ConnMaxIdleTime > 0 {
		db.SetConnMaxIdleTime(options.ConnMaxIdleTime)
	}
}

func normalizeMySQLDSN(dsn string) (string, error) {
	cfg, err := mysql.ParseDSN(dsn)
	if err != nil {
		return "", err
	}
	cfg.ParseTime = true
	if cfg.Loc == nil {
		cfg.Loc = time.UTC
	}
	return cfg.FormatDSN(), nil
}

func (s *MySQLStore) Close() error {
	return s.db.Close()
}

func (s *MySQLStore) migrate(ctx context.Context) error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS llmgateway_sets (
			id VARCHAR(128) PRIMARY KEY,
			name VARCHAR(255) NOT NULL DEFAULT '',
			base_url TEXT NOT NULL,
			traffic_base_url TEXT NOT NULL,
			status VARCHAR(32) NOT NULL,
			setup BOOLEAN NOT NULL DEFAULT FALSE,
			admin_user_id BIGINT NOT NULL DEFAULT 0,
			admin_username VARCHAR(255) NOT NULL DEFAULT '',
			admin_role BIGINT NOT NULL DEFAULT 0,
			admin_status BIGINT NOT NULL DEFAULT 0,
			admin_group VARCHAR(255) NOT NULL DEFAULT '',
			admin_access_token TEXT NOT NULL,
			admin_totp_secret TEXT NOT NULL,
			max_users BIGINT NOT NULL DEFAULT 0,
			warn_users BIGINT NOT NULL DEFAULT 0,
			reserved_users BIGINT NOT NULL DEFAULT 0,
			observed_user_count BIGINT NOT NULL DEFAULT 0,
			capacity_updated_at DATETIME(6) NULL,
			shard_id VARCHAR(191) NOT NULL DEFAULT '',
			newapi_replicas BIGINT NOT NULL DEFAULT 0,
			sql_max_open_conns BIGINT NOT NULL DEFAULT 0,
			sql_max_idle_conns BIGINT NOT NULL DEFAULT 0,
			sql_max_lifetime_seconds BIGINT NOT NULL DEFAULT 0,
			traffic_sql_max_open_conns BIGINT NOT NULL DEFAULT 0,
			traffic_sql_max_idle_conns BIGINT NOT NULL DEFAULT 0,
			traffic_sql_max_lifetime_seconds BIGINT NOT NULL DEFAULT 0,
			subscription_write_concurrency BIGINT NOT NULL DEFAULT 0,
			admin_health_status VARCHAR(32) NOT NULL DEFAULT '',
			admin_health_consecutive_failures BIGINT NOT NULL DEFAULT 0,
			admin_health_error TEXT NOT NULL,
			admin_health_checked_at DATETIME(6) NULL,
			admin_health_last_success_at DATETIME(6) NULL,
			admin_writes_paused TINYINT(1) NOT NULL DEFAULT 0,
			admin_writes_pause_reason TEXT NOT NULL,
			admin_writes_paused_at DATETIME(6) NULL,
			admission_status VARCHAR(32) NOT NULL DEFAULT '',
			admission_error TEXT NOT NULL,
			admission_checked_at DATETIME(6) NULL,
			lifecycle_generation BIGINT NOT NULL DEFAULT 0,
			admin_image TEXT NOT NULL,
			active_runtime_generation BIGINT NOT NULL DEFAULT 0,
			route_revision BIGINT NOT NULL DEFAULT 0,
			created_at DATETIME(6) NOT NULL,
			updated_at DATETIME(6) NOT NULL,
			INDEX idx_llmgateway_sets_status (status),
			INDEX idx_llmgateway_sets_shard_id (shard_id)
		)`,
		`CREATE TABLE IF NOT EXISTS llmgateway_shards (
			id VARCHAR(191) PRIMARY KEY,
			name VARCHAR(255) NOT NULL DEFAULT '',
			kind VARCHAR(64) NOT NULL DEFAULT 'mysql',
			endpoint TEXT NOT NULL,
			redis_endpoint TEXT NOT NULL,
			secret_name VARCHAR(191) NOT NULL DEFAULT '',
			redis_db_start BIGINT NOT NULL DEFAULT 0,
			redis_db_limit BIGINT NOT NULL DEFAULT 0,
			status VARCHAR(32) NOT NULL DEFAULT 'active',
			max_connections BIGINT NOT NULL DEFAULT 0,
			reserved_connections BIGINT NOT NULL DEFAULT 0,
			warn_ratio DOUBLE NOT NULL DEFAULT 0.7,
			critical_ratio DOUBLE NOT NULL DEFAULT 0.85,
			max_sets BIGINT NOT NULL DEFAULT 0,
			admin_sql_max_open_conns BIGINT NOT NULL DEFAULT 0,
			admin_sql_max_idle_conns BIGINT NOT NULL DEFAULT 0,
			admin_sql_max_lifetime_seconds BIGINT NOT NULL DEFAULT 0,
			traffic_sql_max_open_conns BIGINT NOT NULL DEFAULT 0,
			traffic_sql_max_idle_conns BIGINT NOT NULL DEFAULT 0,
			traffic_sql_max_lifetime_seconds BIGINT NOT NULL DEFAULT 0,
			subscription_write_concurrency BIGINT NOT NULL DEFAULT 0,
			created_at DATETIME(6) NOT NULL,
			updated_at DATETIME(6) NOT NULL,
			INDEX idx_llmgateway_shards_status (status)
		)`,
		`CREATE TABLE IF NOT EXISTS llmgateway_shard_expansions (
			id VARCHAR(191) PRIMARY KEY,
			idempotency_key VARCHAR(191) NOT NULL,
			request_hash CHAR(64) NOT NULL,
			shard_id VARCHAR(128) NOT NULL,
			active_shard_id VARCHAR(128) NULL,
			name VARCHAR(255) NOT NULL,
			status VARCHAR(48) NOT NULL,
			retry_status VARCHAR(48) NOT NULL DEFAULT '',
			failed_step VARCHAR(64) NOT NULL DEFAULT '',
			last_error TEXT NOT NULL,
			max_sets BIGINT NOT NULL DEFAULT 0,
			redis_db_start BIGINT NOT NULL DEFAULT 0,
			redis_db_limit BIGINT NOT NULL DEFAULT 0,
			max_connections BIGINT NOT NULL DEFAULT 0,
			reserved_connections BIGINT NOT NULL DEFAULT 0,
			admin_sql_max_open_conns BIGINT NOT NULL DEFAULT 0,
			traffic_sql_max_open_conns BIGINT NOT NULL DEFAULT 0,
			subscription_write_concurrency BIGINT NOT NULL DEFAULT 0,
			mysql_endpoint TEXT NOT NULL,
			redis_endpoint TEXT NOT NULL,
			secret_name VARCHAR(191) NOT NULL DEFAULT '',
			terraform_run TEXT NOT NULL,
			verification_evidence TEXT NOT NULL,
			fleet_projected_at DATETIME(6) NULL,
			verified_at DATETIME(6) NULL,
			version BIGINT NOT NULL DEFAULT 1,
			created_at DATETIME(6) NOT NULL,
			updated_at DATETIME(6) NOT NULL,
			UNIQUE INDEX uk_llmgateway_shard_expansion_idempotency (idempotency_key),
			UNIQUE INDEX uk_llmgateway_shard_expansion_active_shard (active_shard_id),
			INDEX idx_llmgateway_shard_expansion_status_updated (status, updated_at),
			INDEX idx_llmgateway_shard_expansion_shard (shard_id)
		)`,
		`CREATE TABLE IF NOT EXISTS llmgateway_set_operation_leases (
			set_id VARCHAR(128) NOT NULL,
			operation_name VARCHAR(64) NOT NULL,
			slot_number BIGINT NOT NULL,
			owner VARCHAR(255) NOT NULL DEFAULT '',
			lifecycle_generation BIGINT NOT NULL DEFAULT 0,
			lease_until DATETIME(6) NULL,
			updated_at DATETIME(6) NOT NULL,
			PRIMARY KEY (set_id, operation_name, slot_number),
			INDEX idx_llmgateway_set_operation_lease_until (lease_until)
		)`,
		`CREATE TABLE IF NOT EXISTS llmgateway_set_reconcile_facts (
			source VARCHAR(64) NOT NULL,
			namespace_name VARCHAR(191) NOT NULL,
			fleet VARCHAR(191) NOT NULL,
			set_id VARCHAR(128) NOT NULL,
			name VARCHAR(255) NOT NULL DEFAULT '',
			base_url TEXT NOT NULL,
			traffic_base_url TEXT NOT NULL,
			runtime_generation BIGINT NOT NULL DEFAULT 0,
			runtime_image TEXT NULL,
			shard_ref VARCHAR(191) NOT NULL DEFAULT '',
			sql_max_open_conns BIGINT NOT NULL DEFAULT 0,
			sql_max_idle_conns BIGINT NOT NULL DEFAULT 0,
			sql_max_lifetime_seconds BIGINT NOT NULL DEFAULT 0,
			traffic_sql_max_open_conns BIGINT NOT NULL DEFAULT 0,
			traffic_sql_max_idle_conns BIGINT NOT NULL DEFAULT 0,
			traffic_sql_max_lifetime_seconds BIGINT NOT NULL DEFAULT 0,
			subscription_write_concurrency BIGINT NOT NULL DEFAULT 0,
			desired_hash CHAR(64) NOT NULL DEFAULT '',
			status VARCHAR(32) NOT NULL DEFAULT 'pending',
			last_error TEXT NOT NULL,
			last_observed_at DATETIME(6) NOT NULL,
			last_reconciled_at DATETIME(6) NULL,
			created_at DATETIME(6) NOT NULL,
			updated_at DATETIME(6) NOT NULL,
			PRIMARY KEY (source, namespace_name, fleet, set_id),
			INDEX idx_llmgateway_set_reconcile_status (status),
			INDEX idx_llmgateway_set_reconcile_set_id (set_id),
			INDEX idx_llmgateway_set_reconcile_updated_at (updated_at)
		)`,
		`CREATE TABLE IF NOT EXISTS llmgateway_set_provision_requests (
			id VARCHAR(191) PRIMARY KEY,
			source VARCHAR(64) NOT NULL,
			namespace_name VARCHAR(191) NOT NULL,
			fleet VARCHAR(191) NOT NULL,
			set_id VARCHAR(128) NOT NULL,
			shard_ref VARCHAR(191) NOT NULL DEFAULT '',
			database_name VARCHAR(191) NOT NULL DEFAULT '',
			redis_db VARCHAR(32) NOT NULL DEFAULT '',
			release_ring_id VARCHAR(191) NOT NULL DEFAULT '',
			release_id VARCHAR(191) NOT NULL DEFAULT '',
			release_image TEXT NULL,
			status VARCHAR(32) NOT NULL DEFAULT 'pending',
			reason TEXT NOT NULL,
			last_error TEXT NOT NULL,
			requested_users BIGINT NOT NULL DEFAULT 0,
			max_users_per_set BIGINT NOT NULL DEFAULT 0,
			last_status_at DATETIME(6) NULL,
			created_at DATETIME(6) NOT NULL,
			updated_at DATETIME(6) NOT NULL,
			UNIQUE INDEX uk_llmgateway_set_provision_target (source, namespace_name, fleet, set_id),
			INDEX idx_llmgateway_set_provision_status (status),
			INDEX idx_llmgateway_set_provision_fleet (source, namespace_name, fleet),
			INDEX idx_llmgateway_set_provision_updated_at (updated_at)
		)`,
		`CREATE TABLE IF NOT EXISTS llmgateway_set_runtime_leases (
			source VARCHAR(64) NOT NULL,
			namespace_name VARCHAR(191) NOT NULL,
			fleet VARCHAR(191) NOT NULL,
			set_id VARCHAR(128) NOT NULL,
			shard_ref VARCHAR(191) NOT NULL,
			database_name VARCHAR(191) NOT NULL,
			redis_db VARCHAR(32) NOT NULL,
			created_at DATETIME(6) NOT NULL,
			updated_at DATETIME(6) NOT NULL,
			PRIMARY KEY (source, namespace_name, fleet, set_id),
			UNIQUE INDEX uk_llmgateway_runtime_redis_db (source, namespace_name, fleet, shard_ref, redis_db),
			UNIQUE INDEX uk_llmgateway_runtime_database (source, namespace_name, fleet, database_name)
		)`,
		`CREATE TABLE IF NOT EXISTS llmgateway_set_runtimes (
			set_id VARCHAR(128) NOT NULL,
			generation BIGINT NOT NULL,
			release_id VARCHAR(191) NOT NULL DEFAULT '',
			image TEXT NOT NULL,
			traffic_base_url TEXT NOT NULL,
			status VARCHAR(32) NOT NULL,
			created_at DATETIME(6) NOT NULL,
			updated_at DATETIME(6) NOT NULL,
			PRIMARY KEY (set_id, generation),
			INDEX idx_llmgateway_set_runtime_status (set_id, status)
		)`,
		`CREATE TABLE IF NOT EXISTS llmgateway_set_upgrade_batches (
			id VARCHAR(191) PRIMARY KEY,
			rollout_id VARCHAR(191) NOT NULL DEFAULT '',
			ring_id VARCHAR(191) NOT NULL DEFAULT '',
			target_release_id VARCHAR(191) NOT NULL DEFAULT '',
			target_image TEXT NOT NULL,
			status VARCHAR(32) NOT NULL,
			max_parallel BIGINT NOT NULL DEFAULT 1,
			stop_on_failure TINYINT(1) NOT NULL DEFAULT 1,
			created_at DATETIME(6) NOT NULL,
			updated_at DATETIME(6) NOT NULL,
			INDEX idx_llmgateway_set_upgrade_batch_status (status, updated_at)
		)`,
		`CREATE TABLE IF NOT EXISTS llmgateway_set_upgrade_runs (
			id VARCHAR(191) PRIMARY KEY,
			batch_id VARCHAR(191) NOT NULL,
			set_id VARCHAR(128) NOT NULL,
			source VARCHAR(64) NOT NULL,
			namespace_name VARCHAR(191) NOT NULL,
			fleet VARCHAR(191) NOT NULL,
			target_image TEXT NOT NULL,
			from_release_id VARCHAR(191) NOT NULL DEFAULT '',
			target_release_id VARCHAR(191) NOT NULL DEFAULT '',
			sequence_no BIGINT NOT NULL DEFAULT 0,
			from_generation BIGINT NOT NULL,
			to_generation BIGINT NOT NULL,
			status VARCHAR(32) NOT NULL,
			consecutive_probe_successes BIGINT NOT NULL DEFAULT 0,
			consecutive_probe_failures BIGINT NOT NULL DEFAULT 0,
			drain_timeout_seconds BIGINT NOT NULL,
			rollback_window_seconds BIGINT NOT NULL,
			lease_owner VARCHAR(191) NOT NULL DEFAULT '',
			lease_until DATETIME(6) NULL,
			switched_at DATETIME(6) NULL,
			drain_deadline DATETIME(6) NULL,
			rollback_deadline DATETIME(6) NULL,
			rollback_requested TINYINT(1) NOT NULL DEFAULT 0,
			rollback_reason TEXT NOT NULL,
			master_upgraded_at DATETIME(6) NULL,
			compatibility_checked_at DATETIME(6) NULL,
			last_error TEXT NOT NULL,
			created_at DATETIME(6) NOT NULL,
			updated_at DATETIME(6) NOT NULL,
			INDEX idx_llmgateway_set_upgrade_run_batch (batch_id, created_at),
			INDEX idx_llmgateway_set_upgrade_run_set_status (set_id, status),
			INDEX idx_llmgateway_set_upgrade_run_status_lease (status, lease_until)
		)`,
		`CREATE TABLE IF NOT EXISTS llmgateway_newapi_releases (
			id VARCHAR(191) PRIMARY KEY,
			source VARCHAR(64) NOT NULL,
			namespace_name VARCHAR(191) NOT NULL,
			fleet VARCHAR(191) NOT NULL,
			version VARCHAR(191) NOT NULL,
			image TEXT NOT NULL,
			compatibility VARCHAR(64) NOT NULL,
			status VARCHAR(32) NOT NULL,
			created_at DATETIME(6) NOT NULL,
			updated_at DATETIME(6) NOT NULL,
			INDEX idx_llmgateway_release_scope (source, namespace_name, fleet, created_at)
		)`,
		`CREATE TABLE IF NOT EXISTS llmgateway_release_rings (
			id VARCHAR(191) PRIMARY KEY,
			source VARCHAR(64) NOT NULL,
			namespace_name VARCHAR(191) NOT NULL,
			fleet VARCHAR(191) NOT NULL,
			name VARCHAR(191) NOT NULL,
			ordinal BIGINT NOT NULL DEFAULT 0,
			serving_release_id VARCHAR(191) NOT NULL,
			target_release_id VARCHAR(191) NOT NULL DEFAULT '',
			status VARCHAR(32) NOT NULL,
			admission_enabled TINYINT(1) NOT NULL DEFAULT 0,
			max_parallel BIGINT NOT NULL DEFAULT 1,
			soak_seconds BIGINT NOT NULL DEFAULT 1800,
			created_at DATETIME(6) NOT NULL,
			updated_at DATETIME(6) NOT NULL,
			UNIQUE INDEX uk_llmgateway_release_ring_name (source, namespace_name, fleet, name),
			INDEX idx_llmgateway_release_ring_order (source, namespace_name, fleet, ordinal)
		)`,
		`CREATE TABLE IF NOT EXISTS llmgateway_release_rollouts (
			id VARCHAR(191) PRIMARY KEY,
			ring_id VARCHAR(191) NOT NULL,
			target_release_id VARCHAR(191) NOT NULL,
			batch_id VARCHAR(191) NOT NULL,
			status VARCHAR(32) NOT NULL,
			total_sets BIGINT NOT NULL DEFAULT 0,
			completed_sets BIGINT NOT NULL DEFAULT 0,
			failed_sets BIGINT NOT NULL DEFAULT 0,
			current_set_id VARCHAR(128) NOT NULL DEFAULT '',
			campaign_id VARCHAR(191) NOT NULL DEFAULT '',
			campaign_sequence BIGINT NOT NULL DEFAULT 0,
			soak_started_at DATETIME(6) NULL,
			soak_deadline DATETIME(6) NULL,
			last_gate_checked_at DATETIME(6) NULL,
			last_gate_error TEXT NOT NULL,
			created_at DATETIME(6) NOT NULL,
			updated_at DATETIME(6) NOT NULL,
			UNIQUE INDEX uk_llmgateway_release_rollout_batch (batch_id),
			INDEX idx_llmgateway_release_rollout_campaign (campaign_id, campaign_sequence),
			INDEX idx_llmgateway_release_rollout_ring (ring_id, created_at)
		)`,
		`CREATE TABLE IF NOT EXISTS llmgateway_release_campaigns (
			id VARCHAR(191) PRIMARY KEY,
			source VARCHAR(64) NOT NULL,
			namespace_name VARCHAR(191) NOT NULL,
			fleet VARCHAR(191) NOT NULL,
			target_release_id VARCHAR(191) NOT NULL,
			status VARCHAR(32) NOT NULL,
			current_ring_id VARCHAR(191) NOT NULL DEFAULT '',
			current_rollout_id VARCHAR(191) NOT NULL DEFAULT '',
			total_rings BIGINT NOT NULL DEFAULT 0,
			completed_rings BIGINT NOT NULL DEFAULT 0,
			last_error TEXT NOT NULL,
			created_at DATETIME(6) NOT NULL,
			updated_at DATETIME(6) NOT NULL,
			INDEX idx_llmgateway_release_campaign_scope (source, namespace_name, fleet, status, created_at)
		)`,
		`CREATE TABLE IF NOT EXISTS llmgateway_release_campaign_scopes (
			source VARCHAR(64) NOT NULL,
			namespace_name VARCHAR(191) NOT NULL,
			fleet VARCHAR(191) NOT NULL,
			active_campaign_id VARCHAR(191) NOT NULL DEFAULT '',
			updated_at DATETIME(6) NOT NULL,
			PRIMARY KEY (source, namespace_name, fleet)
		)`,
		`CREATE TABLE IF NOT EXISTS llmgateway_release_campaign_rings (
			campaign_id VARCHAR(191) NOT NULL,
			sequence_no BIGINT NOT NULL,
			ring_id VARCHAR(191) NOT NULL,
			status VARCHAR(32) NOT NULL,
			rollout_id VARCHAR(191) NOT NULL DEFAULT '',
			last_error TEXT NOT NULL,
			created_at DATETIME(6) NOT NULL,
			updated_at DATETIME(6) NOT NULL,
			PRIMARY KEY (campaign_id, sequence_no),
			UNIQUE INDEX uk_llmgateway_release_campaign_ring (campaign_id, ring_id)
		)`,
		`CREATE TABLE IF NOT EXISTS llmgateway_set_runtime_route_outbox (
			id VARCHAR(191) PRIMARY KEY,
			set_id VARCHAR(128) NOT NULL,
			route_revision BIGINT NOT NULL,
			snapshot_json TEXT NOT NULL,
			status VARCHAR(32) NOT NULL,
			attempts BIGINT NOT NULL DEFAULT 0,
			last_error TEXT NOT NULL,
			created_at DATETIME(6) NOT NULL,
			updated_at DATETIME(6) NOT NULL,
			UNIQUE INDEX uk_llmgateway_set_route_revision (set_id, route_revision),
			INDEX idx_llmgateway_set_route_outbox_status (status, updated_at)
		)`,
		`CREATE TABLE IF NOT EXISTS llmgateway_tenants (
			external_user_id VARCHAR(191) PRIMARY KEY,
			backend VARCHAR(32) NOT NULL DEFAULT 'pending',
			set_id VARCHAR(128) NOT NULL DEFAULT '',
			status VARCHAR(32) NOT NULL DEFAULT 'active',
			source VARCHAR(64) NOT NULL DEFAULT '',
			display_name VARCHAR(255) NOT NULL DEFAULT '',
			created_at DATETIME(6) NOT NULL,
			updated_at DATETIME(6) NOT NULL,
			INDEX idx_llmgateway_tenants_backend (backend),
			INDEX idx_llmgateway_tenants_set_id (set_id),
			INDEX idx_llmgateway_tenants_status (status),
			INDEX idx_llmgateway_tenants_updated_at (updated_at, external_user_id),
			INDEX idx_llmgateway_tenants_backend_page (backend, updated_at, external_user_id),
			INDEX idx_llmgateway_tenants_set_page (set_id, updated_at, external_user_id),
			INDEX idx_llmgateway_tenants_backend_status (backend, status)
		)`,
		`CREATE TABLE IF NOT EXISTS llmgateway_tenant_statistics (
			id VARCHAR(32) PRIMARY KEY,
			total BIGINT NOT NULL DEFAULT 0,
			new_total BIGINT NOT NULL DEFAULT 0,
			pending_total BIGINT NOT NULL DEFAULT 0,
			active_total BIGINT NOT NULL DEFAULT 0,
			disabled_total BIGINT NOT NULL DEFAULT 0,
			deleted_total BIGINT NOT NULL DEFAULT 0,
			generated_at DATETIME(6) NULL,
			updated_at DATETIME(6) NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS llmgateway_user_bindings (
			external_user_id VARCHAR(191) PRIMARY KEY,
			set_id VARCHAR(128) NOT NULL,
			upstream_user_id BIGINT NOT NULL DEFAULT 0,
			username VARCHAR(64) NOT NULL,
			password VARCHAR(255) NOT NULL,
			last_plan_id VARCHAR(191) NOT NULL DEFAULT '',
			last_extended_period_end DATETIME(6) NULL,
			provision_status VARCHAR(32) NOT NULL DEFAULT 'allocated',
			last_provision_error TEXT NULL,
			created_at DATETIME(6) NOT NULL,
			updated_at DATETIME(6) NOT NULL,
			INDEX idx_llmgateway_user_bindings_set_id (set_id),
			INDEX idx_llmgateway_user_bindings_provision_status (provision_status),
			INDEX idx_llmgateway_user_bindings_username_user (username, external_user_id)
		)`,
		`CREATE TABLE IF NOT EXISTS llmgateway_api_key_bindings (
			external_key_id VARCHAR(128) PRIMARY KEY,
			external_key VARCHAR(512) NOT NULL DEFAULT '',
			external_key_hash CHAR(64) NOT NULL,
			secret_hash CHAR(64) NOT NULL DEFAULT '',
			key_version TINYINT UNSIGNED NOT NULL DEFAULT 0,
			route_slot BIGINT UNSIGNED NOT NULL DEFAULT 0,
			purpose VARCHAR(32) NULL,
			set_id VARCHAR(128) NOT NULL,
			user_id VARCHAR(191) NOT NULL,
			upstream_key TEXT NOT NULL,
			upstream_key_id BIGINT NOT NULL DEFAULT 0,
			status VARCHAR(32) NOT NULL DEFAULT 'legacy_disabled',
			last_error TEXT NULL,
			created_at DATETIME(6) NOT NULL,
			updated_at DATETIME(6) NULL,
			UNIQUE INDEX uk_llmgateway_api_key_hash (external_key_hash),
			UNIQUE INDEX uk_llmgateway_api_key_user_purpose (user_id, purpose),
			INDEX idx_llmgateway_api_key_user_id (user_id),
			INDEX idx_llmgateway_api_key_set_id (set_id),
			INDEX idx_llmgateway_api_key_status_updated (status, updated_at),
			INDEX idx_llmgateway_api_key_route_slot (route_slot, external_key_id)
		)`,
		`CREATE TABLE IF NOT EXISTS llmgateway_user_llm_settings (
			external_user_id VARCHAR(191) PRIMARY KEY,
			routing_mode VARCHAR(32) NOT NULL,
			byok_group VARCHAR(191) NOT NULL DEFAULT '',
			byok_upstream_key TEXT NOT NULL,
			byok_upstream_key_id BIGINT NOT NULL DEFAULT 0,
			providers_json MEDIUMTEXT NOT NULL,
			last_synced_at DATETIME(6) NULL,
			last_sync_error TEXT NOT NULL,
			created_at DATETIME(6) NOT NULL,
			updated_at DATETIME(6) NOT NULL,
			INDEX idx_llmgateway_user_llm_settings_routing_mode (routing_mode),
			INDEX idx_llmgateway_user_llm_settings_updated_at (updated_at)
		)`,
		`CREATE TABLE IF NOT EXISTS llmgateway_byok_sync_tasks (
			external_user_id VARCHAR(191) PRIMARY KEY,
			set_id VARCHAR(128) NOT NULL DEFAULT '',
			status VARCHAR(32) NOT NULL DEFAULT 'pending',
			requested_version BIGINT NOT NULL DEFAULT 0,
			processing_version BIGINT NOT NULL DEFAULT 0,
			applied_version BIGINT NOT NULL DEFAULT 0,
			attempts BIGINT NOT NULL DEFAULT 0,
			lease_owner VARCHAR(191) NOT NULL DEFAULT '',
			lease_until DATETIME(6) NULL,
			next_run_at DATETIME(6) NULL,
			last_started_at DATETIME(6) NULL,
			last_finished_at DATETIME(6) NULL,
			last_error TEXT NOT NULL,
			created_at DATETIME(6) NOT NULL,
			updated_at DATETIME(6) NOT NULL,
			INDEX idx_llmgateway_byok_sync_status_next (status, next_run_at),
			INDEX idx_llmgateway_byok_sync_set_status (set_id, status),
			INDEX idx_llmgateway_byok_sync_lease (lease_until)
		)`,
		`CREATE TABLE IF NOT EXISTS llmgateway_group_ratio_desired (
			set_id VARCHAR(128) NOT NULL,
			group_name VARCHAR(191) NOT NULL,
			ratio DOUBLE NOT NULL DEFAULT 0,
			source_type VARCHAR(32) NOT NULL,
			source_id VARCHAR(191) NOT NULL,
			external_user_id VARCHAR(191) NULL,
			created_at DATETIME(6) NOT NULL,
			updated_at DATETIME(6) NOT NULL,
			PRIMARY KEY (set_id, group_name),
			UNIQUE INDEX uk_llmgateway_group_ratio_user (external_user_id),
			INDEX idx_llmgateway_group_ratio_source (set_id, source_type),
			INDEX idx_llmgateway_group_ratio_updated (updated_at)
		)`,
		`CREATE TABLE IF NOT EXISTS llmgateway_group_ratio_apply_states (
			set_id VARCHAR(128) PRIMARY KEY,
			desired_version BIGINT NOT NULL DEFAULT 0,
			applied_version BIGINT NOT NULL DEFAULT 0,
			desired_fingerprint CHAR(64) NOT NULL DEFAULT '',
			applied_fingerprint CHAR(64) NOT NULL DEFAULT '',
			status VARCHAR(32) NOT NULL DEFAULT 'pending',
			last_error TEXT NOT NULL,
			last_applied_at DATETIME(6) NULL,
			created_at DATETIME(6) NOT NULL,
			updated_at DATETIME(6) NOT NULL,
			INDEX idx_llmgateway_group_ratio_apply_status (status, set_id),
			INDEX idx_llmgateway_group_ratio_apply_updated (updated_at)
		)`,
		`INSERT IGNORE INTO llmgateway_group_ratio_desired (
			set_id, group_name, ratio, source_type, source_id, external_user_id, created_at, updated_at
		)
		SELECT bindings.set_id, settings.byok_group, 0, 'byok', settings.external_user_id,
			settings.external_user_id, settings.created_at, UTC_TIMESTAMP(6)
		FROM llmgateway_user_llm_settings settings
		JOIN llmgateway_user_bindings bindings ON bindings.external_user_id = settings.external_user_id
		JOIN llmgateway_sets managed_sets ON managed_sets.id = bindings.set_id
		WHERE managed_sets.status = 'active'
			AND managed_sets.setup = TRUE
			AND managed_sets.admin_user_id > 0
			AND managed_sets.admin_access_token <> ''
			AND LEFT(settings.byok_group, 5) = 'byok_'
			AND settings.providers_json LIKE '%"enabled":true%'`,
		`INSERT IGNORE INTO llmgateway_group_ratio_apply_states (
			set_id, desired_version, applied_version, desired_fingerprint, applied_fingerprint,
			status, last_error, last_applied_at, created_at, updated_at
		)
		SELECT DISTINCT set_id, 1, 0, '', '', 'pending', '', NULL, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6)
		FROM llmgateway_group_ratio_desired`,
		`CREATE TABLE IF NOT EXISTS llmgateway_tenant_observation_tasks (
			external_user_id VARCHAR(191) PRIMARY KEY,
			set_id VARCHAR(128) NOT NULL DEFAULT '',
			status VARCHAR(32) NOT NULL DEFAULT 'pending',
			priority BIGINT NOT NULL DEFAULT 10,
			requested_version BIGINT NOT NULL DEFAULT 0,
			processing_version BIGINT NOT NULL DEFAULT 0,
			applied_version BIGINT NOT NULL DEFAULT 0,
			attempts BIGINT NOT NULL DEFAULT 0,
			lease_owner VARCHAR(191) NOT NULL DEFAULT '',
			lease_until DATETIME(6) NULL,
			next_run_at DATETIME(6) NULL,
			last_started_at DATETIME(6) NULL,
			last_finished_at DATETIME(6) NULL,
			last_error TEXT NOT NULL,
			created_at DATETIME(6) NOT NULL,
			updated_at DATETIME(6) NOT NULL,
			INDEX idx_llmgateway_observation_task_status_next (status, next_run_at),
			INDEX idx_llmgateway_observation_task_priority_next (priority, next_run_at),
			INDEX idx_llmgateway_observation_task_set_status (set_id, status),
			INDEX idx_llmgateway_observation_task_lease (lease_until)
		)`,
		`CREATE TABLE IF NOT EXISTS llmgateway_plans (
			id VARCHAR(191) PRIMARY KEY,
			name VARCHAR(255) NOT NULL,
			monthly_tokens BIGINT NOT NULL DEFAULT 0,
			period_value BIGINT NOT NULL DEFAULT 1,
			period_unit VARCHAR(32) NOT NULL DEFAULT 'months',
			is_active BOOLEAN NOT NULL DEFAULT TRUE,
			fingerprint VARCHAR(64) NOT NULL,
			created_at DATETIME(6) NOT NULL,
			updated_at DATETIME(6) NOT NULL,
			INDEX idx_llmgateway_plans_active (is_active)
		)`,
		`CREATE TABLE IF NOT EXISTS llmgateway_set_plans (
			plan_id VARCHAR(191) NOT NULL,
			set_id VARCHAR(128) NOT NULL,
			upstream_plan_id BIGINT NOT NULL DEFAULT 0,
			status VARCHAR(32) NOT NULL DEFAULT 'pending',
			attempts BIGINT NOT NULL DEFAULT 0,
			last_error TEXT NOT NULL,
			synced_at DATETIME(6) NULL,
			created_at DATETIME(6) NOT NULL,
			updated_at DATETIME(6) NOT NULL,
			PRIMARY KEY (plan_id, set_id),
			INDEX idx_llmgateway_set_plans_set_status (set_id, status),
			INDEX idx_llmgateway_set_plans_status_updated (status, updated_at)
		)`,
		`CREATE TABLE IF NOT EXISTS llmgateway_plan_periods (
			plan_id VARCHAR(191) NOT NULL,
			period_value BIGINT NOT NULL,
			period_unit VARCHAR(32) NOT NULL,
			created_at DATETIME(6) NOT NULL,
			updated_at DATETIME(6) NOT NULL,
			PRIMARY KEY (plan_id, period_value, period_unit)
		)`,
		`CREATE TABLE IF NOT EXISTS llmgateway_set_plan_periods (
			plan_id VARCHAR(191) NOT NULL,
			period_value BIGINT NOT NULL,
			period_unit VARCHAR(32) NOT NULL,
			set_id VARCHAR(128) NOT NULL,
			upstream_plan_id BIGINT NOT NULL DEFAULT 0,
			status VARCHAR(32) NOT NULL DEFAULT 'pending',
			attempts BIGINT NOT NULL DEFAULT 0,
			last_error TEXT NOT NULL,
			synced_at DATETIME(6) NULL,
			created_at DATETIME(6) NOT NULL,
			updated_at DATETIME(6) NOT NULL,
			PRIMARY KEY (plan_id, period_value, period_unit, set_id),
			INDEX idx_llmgateway_set_plan_periods_set_status (set_id, status),
			INDEX idx_llmgateway_set_plan_periods_status_updated (status, updated_at)
		)`,
		`DROP TABLE IF EXISTS llmgateway_plan_mappings`,
		`CREATE TABLE IF NOT EXISTS llmgateway_subscription_period_overlays (
			external_user_id VARCHAR(191) PRIMARY KEY,
			set_id VARCHAR(128) NOT NULL DEFAULT '',
			period_end DATETIME(6) NOT NULL,
			created_at DATETIME(6) NOT NULL,
			updated_at DATETIME(6) NOT NULL,
			INDEX idx_llmgateway_period_overlay_set_id (set_id),
			INDEX idx_llmgateway_period_overlay_period_end (period_end)
		)`,
		`CREATE TABLE IF NOT EXISTS llmgateway_subscription_idempotencies (
			idempotency_key VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
			request_hash BINARY(32) NOT NULL,
			status TINYINT UNSIGNED NOT NULL,
			last_error VARCHAR(1024) NOT NULL DEFAULT '',
			created_at DATETIME(6) NOT NULL,
			updated_at DATETIME(6) NOT NULL,
			PRIMARY KEY (idempotency_key),
			INDEX idx_subscription_idempotencies_status_updated_at (status, updated_at)
		)`,
		`CREATE TABLE IF NOT EXISTS llmgateway_admin_commands (
			id VARCHAR(191) PRIMARY KEY,
			dedupe_key VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
			set_id VARCHAR(128) NOT NULL,
			external_user_id VARCHAR(191) NOT NULL DEFAULT '',
			kind VARCHAR(64) NOT NULL,
			payload_json MEDIUMTEXT NOT NULL,
			status VARCHAR(32) NOT NULL DEFAULT 'pending',
			attempts BIGINT NOT NULL DEFAULT 0,
			lease_owner VARCHAR(191) NOT NULL DEFAULT '',
			lease_until DATETIME(6) NULL,
			next_run_at DATETIME(6) NULL,
			result_json MEDIUMTEXT NOT NULL,
			last_error TEXT NOT NULL,
			created_at DATETIME(6) NOT NULL,
			updated_at DATETIME(6) NOT NULL,
			UNIQUE INDEX uk_llmgateway_admin_command_dedupe (dedupe_key),
			INDEX idx_llmgateway_admin_command_due (status, next_run_at),
			INDEX idx_llmgateway_admin_command_set_status (set_id, status),
			INDEX idx_llmgateway_admin_command_lease (lease_until)
		)`,
		`CREATE TABLE IF NOT EXISTS llmgateway_user_assignments (
			external_user_id VARCHAR(191) PRIMARY KEY,
			backend VARCHAR(32) NOT NULL,
			set_id VARCHAR(128) NOT NULL DEFAULT '',
			migrated_at DATETIME(6) NULL,
			created_at DATETIME(6) NOT NULL,
			updated_at DATETIME(6) NOT NULL,
			INDEX idx_llmgateway_user_assignments_backend (backend),
			INDEX idx_llmgateway_user_assignments_set_id (set_id)
		)`,
		`CREATE TABLE IF NOT EXISTS llmgateway_tenant_observations (
			external_user_id VARCHAR(191) PRIMARY KEY,
			backend VARCHAR(32) NOT NULL DEFAULT '',
			set_id VARCHAR(128) NOT NULL DEFAULT '',
			upstream_user_id BIGINT NOT NULL DEFAULT 0,
			username VARCHAR(64) NOT NULL DEFAULT '',
			current_plan_id VARCHAR(191) NOT NULL DEFAULT '',
			last_applied_plan_id VARCHAR(191) NOT NULL DEFAULT '',
			subscription_status VARCHAR(64) NOT NULL DEFAULT '',
			has_active_subscription BOOLEAN NOT NULL DEFAULT FALSE,
			token_balance BIGINT NOT NULL DEFAULT 0,
			credit_available BIGINT NOT NULL DEFAULT 0,
			credit_status VARCHAR(64) NOT NULL DEFAULT '',
			credit_error TEXT NOT NULL,
			unlimited BOOLEAN NOT NULL DEFAULT FALSE,
			period_start VARCHAR(64) NOT NULL DEFAULT '',
			period_end VARCHAR(64) NOT NULL DEFAULT '',
			source VARCHAR(64) NOT NULL DEFAULT '',
			observed_at DATETIME(6) NOT NULL,
			created_at DATETIME(6) NOT NULL,
			updated_at DATETIME(6) NOT NULL,
			INDEX idx_llmgateway_tenant_observations_set_id (set_id),
			INDEX idx_llmgateway_tenant_observations_plan (current_plan_id),
			INDEX idx_llmgateway_tenant_observations_observed_at (observed_at)
		)`,
		`CREATE TABLE IF NOT EXISTS llmgateway_channel_specs (
			id VARCHAR(191) PRIMARY KEY,
			name VARCHAR(255) NOT NULL,
			type BIGINT NOT NULL DEFAULT 0,
			provider_key TEXT NOT NULL,
			key_hash CHAR(64) NOT NULL DEFAULT '',
			base_url TEXT NOT NULL,
			models TEXT NOT NULL,
			group_name VARCHAR(191) NOT NULL DEFAULT 'default',
			model_mapping TEXT NOT NULL,
			priority BIGINT NOT NULL DEFAULT 0,
			weight BIGINT UNSIGNED NOT NULL DEFAULT 0,
			status VARCHAR(32) NOT NULL,
			setting TEXT NOT NULL,
			param_override TEXT NOT NULL,
			header_override TEXT NOT NULL,
			remark TEXT NOT NULL,
			auto_ban BIGINT NULL,
			tag VARCHAR(191) NOT NULL DEFAULT '',
			other_value TEXT NOT NULL,
			status_code_mapping TEXT NOT NULL,
			other_settings TEXT NOT NULL,
			openai_organization TEXT NOT NULL,
			test_model TEXT NOT NULL,
			is_multi_key BOOLEAN NOT NULL DEFAULT FALSE,
			multi_key_mode VARCHAR(32) NOT NULL DEFAULT '',
			fingerprint CHAR(64) NOT NULL DEFAULT '',
			desired_remote_name VARCHAR(512) NOT NULL DEFAULT '',
			created_at DATETIME(6) NOT NULL,
			updated_at DATETIME(6) NOT NULL,
			INDEX idx_llmgateway_channel_specs_status (status)
		)`,
		`CREATE TABLE IF NOT EXISTS llmgateway_channel_sync_states (
			channel_id VARCHAR(191) NOT NULL,
			set_id VARCHAR(128) NOT NULL,
			remote_channel_id BIGINT NOT NULL DEFAULT 0,
			status VARCHAR(32) NOT NULL,
			last_error TEXT NOT NULL,
			desired_fingerprint CHAR(64) NOT NULL DEFAULT '',
			applied_fingerprint CHAR(64) NOT NULL DEFAULT '',
			remote_fingerprint CHAR(64) NOT NULL DEFAULT '',
			last_applied_key_hash CHAR(64) NOT NULL DEFAULT '',
			last_synced_at DATETIME(6) NULL,
			last_checked_at DATETIME(6) NULL,
			created_at DATETIME(6) NOT NULL,
			updated_at DATETIME(6) NOT NULL,
			PRIMARY KEY (channel_id, set_id),
			INDEX idx_llmgateway_channel_sync_status (status),
			INDEX idx_llmgateway_channel_sync_set_id (set_id)
		)`,
		`CREATE TABLE IF NOT EXISTS llmgateway_channel_bundles (
			id VARCHAR(191) PRIMARY KEY,
			name VARCHAR(255) NOT NULL,
			description TEXT NOT NULL,
			source_set_id VARCHAR(128) NOT NULL DEFAULT '',
			spec_json MEDIUMTEXT NOT NULL,
			fingerprint CHAR(64) NOT NULL DEFAULT '',
			created_at DATETIME(6) NOT NULL,
			updated_at DATETIME(6) NOT NULL,
			INDEX idx_llmgateway_channel_bundles_source_set_id (source_set_id),
			INDEX idx_llmgateway_channel_bundles_fingerprint (fingerprint)
		)`,
		`CREATE TABLE IF NOT EXISTS llmgateway_channel_bundle_sync_states (
			bundle_id VARCHAR(191) NOT NULL,
			set_id VARCHAR(128) NOT NULL,
			status VARCHAR(32) NOT NULL,
			last_error TEXT NOT NULL,
			desired_fingerprint CHAR(64) NOT NULL DEFAULT '',
			actual_fingerprint CHAR(64) NOT NULL DEFAULT '',
			applied_fingerprint CHAR(64) NOT NULL DEFAULT '',
			diff_json MEDIUMTEXT NOT NULL,
			remote_resources_json MEDIUMTEXT NOT NULL,
			last_synced_at DATETIME(6) NULL,
			last_checked_at DATETIME(6) NULL,
			created_at DATETIME(6) NOT NULL,
			updated_at DATETIME(6) NOT NULL,
			PRIMARY KEY (bundle_id, set_id),
			INDEX idx_llmgateway_channel_bundle_sync_status (status),
			INDEX idx_llmgateway_channel_bundle_sync_set_id (set_id)
		)`,
		`CREATE TABLE IF NOT EXISTS llmgateway_channel_bundle_revisions (
			revision_id VARCHAR(191) NOT NULL,
			bundle_id VARCHAR(191) NOT NULL,
			version BIGINT NOT NULL DEFAULT 0,
			name VARCHAR(255) NOT NULL,
			description TEXT NOT NULL,
			source_set_id VARCHAR(128) NOT NULL DEFAULT '',
			spec_json MEDIUMTEXT NOT NULL,
			fingerprint CHAR(64) NOT NULL DEFAULT '',
			created_at DATETIME(6) NOT NULL,
			PRIMARY KEY (bundle_id, revision_id),
			UNIQUE INDEX uk_llmgateway_channel_bundle_revision_version (bundle_id, version),
			INDEX idx_llmgateway_channel_bundle_revision_created (bundle_id, created_at)
		)`,
		`CREATE TABLE IF NOT EXISTS llmgateway_channel_bundle_releases (
			id VARCHAR(191) PRIMARY KEY,
			bundle_id VARCHAR(191) NOT NULL,
			revision_id VARCHAR(191) NOT NULL DEFAULT '',
			fingerprint CHAR(64) NOT NULL DEFAULT '',
			status VARCHAR(32) NOT NULL,
			force_drift BOOLEAN NOT NULL DEFAULT FALSE,
			stop_on_failure BOOLEAN NOT NULL DEFAULT TRUE,
			triggered_by VARCHAR(191) NOT NULL DEFAULT '',
			last_error TEXT NOT NULL,
			items_json MEDIUMTEXT NOT NULL,
			created_at DATETIME(6) NOT NULL,
			started_at DATETIME(6) NULL,
			finished_at DATETIME(6) NULL,
			INDEX idx_llmgateway_channel_bundle_release_bundle (bundle_id, created_at),
			INDEX idx_llmgateway_channel_bundle_release_status (status)
		)`,
		`CREATE TABLE IF NOT EXISTS llmgateway_channel_bundle_locks (
			bundle_id VARCHAR(191) PRIMARY KEY,
			owner VARCHAR(191) NOT NULL,
			purpose VARCHAR(64) NOT NULL DEFAULT '',
			lease_until DATETIME(6) NOT NULL,
			created_at DATETIME(6) NOT NULL,
			updated_at DATETIME(6) NOT NULL,
			INDEX idx_llmgateway_channel_bundle_lock_lease_until (lease_until)
		)`,
		`CREATE TABLE IF NOT EXISTS llmgateway_worker_jobs (
			name VARCHAR(191) PRIMARY KEY,
			kind VARCHAR(191) NOT NULL DEFAULT '',
			enabled BOOLEAN NOT NULL DEFAULT TRUE,
			interval_seconds BIGINT NOT NULL DEFAULT 0,
			status VARCHAR(32) NOT NULL DEFAULT 'idle',
			lease_owner VARCHAR(191) NOT NULL DEFAULT '',
			lease_until DATETIME(6) NULL,
			last_started_at DATETIME(6) NULL,
			last_finished_at DATETIME(6) NULL,
			last_success_at DATETIME(6) NULL,
			next_run_at DATETIME(6) NULL,
			scan_cursor TEXT NOT NULL,
			last_error TEXT NOT NULL,
			failure_count BIGINT NOT NULL DEFAULT 0,
			created_at DATETIME(6) NOT NULL,
			updated_at DATETIME(6) NOT NULL,
			INDEX idx_llmgateway_worker_jobs_next_run (enabled, next_run_at),
			INDEX idx_llmgateway_worker_jobs_status (status)
		)`,
		`CREATE TABLE IF NOT EXISTS llmgateway_worker_job_runs (
			id VARCHAR(191) PRIMARY KEY,
			job_name VARCHAR(191) NOT NULL,
			owner VARCHAR(191) NOT NULL DEFAULT '',
			status VARCHAR(32) NOT NULL,
			started_at DATETIME(6) NOT NULL,
			finished_at DATETIME(6) NULL,
			error TEXT NOT NULL,
			detail TEXT NOT NULL,
			INDEX idx_llmgateway_worker_job_runs_job (job_name, started_at),
			INDEX idx_llmgateway_worker_job_runs_status (status)
		)`,
		`CREATE TABLE IF NOT EXISTS llmgateway_tenant_deletion_jobs (
			id VARCHAR(191) PRIMARY KEY,
			status VARCHAR(32) NOT NULL,
			selector_type VARCHAR(32) NOT NULL,
			selector_value VARCHAR(191) NOT NULL DEFAULT '',
			selector_user_ids_json MEDIUMTEXT NOT NULL,
			snapshot_at DATETIME(6) NOT NULL,
			materialization_cursor VARCHAR(191) NOT NULL DEFAULT '',
			target_count BIGINT NOT NULL DEFAULT 0,
			target_digest CHAR(64) NOT NULL DEFAULT '',
			claimed_count BIGINT NOT NULL DEFAULT 0,
			success_count BIGINT NOT NULL DEFAULT 0,
			failure_count BIGINT NOT NULL DEFAULT 0,
			last_error TEXT NOT NULL,
			version BIGINT NOT NULL DEFAULT 1,
			idempotency_key VARCHAR(191) NOT NULL DEFAULT '',
			created_at DATETIME(6) NOT NULL,
			updated_at DATETIME(6) NOT NULL,
			INDEX idx_llmgateway_tenant_deletion_status_updated (status, updated_at),
			INDEX idx_llmgateway_tenant_deletion_idempotency (idempotency_key)
		)`,
		`CREATE TABLE IF NOT EXISTS llmgateway_tenant_deletion_targets (
			job_id VARCHAR(191) NOT NULL,
			external_user_id VARCHAR(191) NOT NULL,
			set_id VARCHAR(128) NOT NULL DEFAULT '',
			status VARCHAR(32) NOT NULL DEFAULT 'pending',
			attempts BIGINT NOT NULL DEFAULT 0,
			lease_owner VARCHAR(191) NOT NULL DEFAULT '',
			lease_until DATETIME(6) NULL,
			last_error TEXT NOT NULL,
			created_at DATETIME(6) NOT NULL,
			updated_at DATETIME(6) NOT NULL,
			PRIMARY KEY (job_id, external_user_id),
			INDEX idx_llmgateway_tenant_delete_target_job_status (job_id, status, external_user_id),
			INDEX idx_llmgateway_tenant_delete_target_set_status (set_id, status)
		)`,
		`CREATE TABLE IF NOT EXISTS llmgateway_tenant_deletion_claims (
			external_user_id VARCHAR(191) PRIMARY KEY,
			job_id VARCHAR(191) NOT NULL,
			created_at DATETIME(6) NOT NULL,
			INDEX idx_llmgateway_tenant_delete_claim_job (job_id, external_user_id)
		)`,
		`CREATE TABLE IF NOT EXISTS llmgateway_set_decommission_jobs (
			id VARCHAR(191) PRIMARY KEY,
			set_id VARCHAR(128) NOT NULL,
			status VARCHAR(32) NOT NULL,
			previous_set_status VARCHAR(32) NOT NULL DEFAULT 'active',
			lifecycle_generation BIGINT NOT NULL,
			expected_digest CHAR(64) NOT NULL,
			idempotency_key VARCHAR(191) NOT NULL,
			cascade_tenants TINYINT(1) NOT NULL DEFAULT 0,
			allow_orphan TINYINT(1) NOT NULL DEFAULT 0,
			attempt BIGINT NOT NULL DEFAULT 0,
			claim_owner VARCHAR(191) NOT NULL DEFAULT '',
			claim_token VARCHAR(191) NOT NULL DEFAULT '',
			claim_lease_until DATETIME(6) NULL,
			lease_fingerprint CHAR(64) NOT NULL DEFAULT '',
			capability_hash CHAR(64) NOT NULL DEFAULT '',
			job_uid VARCHAR(191) NOT NULL DEFAULT '',
			version BIGINT NOT NULL DEFAULT 1,
			last_error TEXT NOT NULL,
			created_at DATETIME(6) NOT NULL,
			updated_at DATETIME(6) NOT NULL,
			UNIQUE INDEX uk_llmgateway_set_decommission_idempotency (idempotency_key),
			INDEX idx_llmgateway_set_decommission_set_status (set_id, status),
			INDEX idx_llmgateway_set_decommission_status_updated (status, updated_at)
		)`,
	}
	for _, stmt := range statements {
		if _, err := s.db.ExecContext(ctx, stmt); err != nil {
			return err
		}
	}
	if err := s.migrateTenantListIndexes(ctx); err != nil {
		return err
	}
	if err := s.migrateAPIKeyRecoveryColumns(ctx); err != nil {
		return err
	}
	if err := s.migrateUserBindingProvisionColumns(ctx); err != nil {
		return err
	}
	if err := s.migrateSetSecureVerificationColumns(ctx); err != nil {
		return err
	}
	if err := s.migrateSetCapacityColumns(ctx); err != nil {
		return err
	}
	if err := s.migrateSetShardColumns(ctx); err != nil {
		return err
	}
	if err := s.migrateSetRuntimeConfigColumns(ctx); err != nil {
		return err
	}
	if err := s.migrateSetAdminHealthColumns(ctx); err != nil {
		return err
	}
	if err := s.migrateShardRuntimeColumns(ctx); err != nil {
		return err
	}
	if err := s.migrateShardExpansionColumns(ctx); err != nil {
		return err
	}
	if err := s.migrateSetEndpointColumns(ctx); err != nil {
		return err
	}
	if err := s.migrateSetUpgradeColumns(ctx); err != nil {
		return err
	}
	if err := s.migrateSetUpgradeRunColumns(ctx); err != nil {
		return err
	}
	if err := s.migrateReleaseRingColumns(ctx); err != nil {
		return err
	}
	if err := s.migrateSetAdmissionColumns(ctx); err != nil {
		return err
	}
	if err := s.migrateDeletionLifecycleColumns(ctx); err != nil {
		return err
	}
	if err := s.migrateWorkerJobCursorColumn(ctx); err != nil {
		return err
	}
	if err := s.migrateChannelSpecDesiredColumns(ctx); err != nil {
		return err
	}
	if err := s.migrateSetRuntimeLeases(ctx); err != nil {
		return err
	}
	if err := s.backfillTenants(ctx); err != nil {
		return err
	}
	if err := s.migrateTenantBackendSemantics(ctx); err != nil {
		return err
	}
	return nil
}

func (s *MySQLStore) migrateShardExpansionColumns(ctx context.Context) error {
	if err := s.ensureMySQLColumn(ctx, "llmgateway_shard_expansions", "active_shard_id", "VARCHAR(128) NULL"); err != nil {
		return err
	}
	return s.ensureMySQLUniqueIndex(ctx, "llmgateway_shard_expansions", "uk_llmgateway_shard_expansion_active_shard", "active_shard_id")
}

func (s *MySQLStore) migrateAPIKeyRecoveryColumns(ctx context.Context) error {
	if err := s.ensureMySQLColumn(ctx, "llmgateway_api_key_bindings", "external_key", "VARCHAR(512) NOT NULL DEFAULT ''"); err != nil {
		return err
	}
	if err := s.ensureMySQLColumn(ctx, "llmgateway_api_key_bindings", "purpose", "VARCHAR(32) NULL"); err != nil {
		return err
	}
	columns := []struct {
		name       string
		definition string
	}{
		{"secret_hash", "CHAR(64) NOT NULL DEFAULT ''"},
		{"key_version", "TINYINT UNSIGNED NOT NULL DEFAULT 0"},
		{"route_slot", "BIGINT UNSIGNED NOT NULL DEFAULT 0"},
		{"status", "VARCHAR(32) NOT NULL DEFAULT 'legacy_disabled'"},
		{"last_error", "TEXT NULL"},
		{"updated_at", "DATETIME(6) NULL"},
	}
	for _, column := range columns {
		if err := s.ensureMySQLColumn(ctx, "llmgateway_api_key_bindings", column.name, column.definition); err != nil {
			return err
		}
	}
	if err := s.ensureMySQLUniqueIndex(ctx, "llmgateway_api_key_bindings", "uk_llmgateway_api_key_user_purpose", "user_id, purpose"); err != nil {
		return err
	}
	if err := s.ensureMySQLIndex(ctx, "llmgateway_api_key_bindings", "idx_llmgateway_api_key_status_updated", "status, updated_at"); err != nil {
		return err
	}
	return s.ensureMySQLIndex(ctx, "llmgateway_api_key_bindings", "idx_llmgateway_api_key_route_slot", "route_slot, external_key_id")
}

func (s *MySQLStore) migrateTenantBackendSemantics(ctx context.Context) error {
	if err := s.ensureMySQLColumn(ctx, "llmgateway_tenant_statistics", "pending_total", "BIGINT NOT NULL DEFAULT 0"); err != nil {
		return err
	}
	for _, table := range []string{"llmgateway_tenants", "llmgateway_user_assignments", "llmgateway_tenant_observations"} {
		if _, err := s.db.ExecContext(ctx, "UPDATE "+table+" SET backend = ? WHERE backend = ?", UserBackendPending, "old"); err != nil {
			return err
		}
	}
	var defaultValue sql.NullString
	if err := s.db.QueryRowContext(ctx, `
		SELECT COLUMN_DEFAULT
		FROM information_schema.COLUMNS
		WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'llmgateway_tenants' AND COLUMN_NAME = 'backend'
	`).Scan(&defaultValue); err != nil {
		return err
	}
	if defaultValue.Valid && defaultValue.String == UserBackendPending {
		return nil
	}
	_, err := s.db.ExecContext(ctx, "ALTER TABLE llmgateway_tenants MODIFY backend VARCHAR(32) NOT NULL DEFAULT 'pending'")
	return err
}

func (s *MySQLStore) migrateDeletionLifecycleColumns(ctx context.Context) error {
	if err := s.ensureMySQLColumn(ctx, "llmgateway_sets", "lifecycle_generation", "BIGINT NOT NULL DEFAULT 0"); err != nil {
		return err
	}
	if err := s.ensureMySQLColumn(ctx, "llmgateway_set_operation_leases", "lifecycle_generation", "BIGINT NOT NULL DEFAULT 0"); err != nil {
		return err
	}
	columns := []struct {
		name       string
		definition string
	}{
		{"previous_set_status", "VARCHAR(32) NOT NULL DEFAULT 'active'"},
		{"attempt", "BIGINT NOT NULL DEFAULT 0"},
		{"claim_owner", "VARCHAR(191) NOT NULL DEFAULT ''"},
		{"claim_token", "VARCHAR(191) NOT NULL DEFAULT ''"},
		{"claim_lease_until", "DATETIME(6) NULL"},
		{"lease_fingerprint", "CHAR(64) NOT NULL DEFAULT ''"},
		{"capability_hash", "CHAR(64) NOT NULL DEFAULT ''"},
		{"job_uid", "VARCHAR(191) NOT NULL DEFAULT ''"},
		{"cascade_tenants", "TINYINT(1) NOT NULL DEFAULT 0"},
		{"allow_orphan", "TINYINT(1) NOT NULL DEFAULT 0"},
	}
	for _, column := range columns {
		if err := s.ensureMySQLColumn(ctx, "llmgateway_set_decommission_jobs", column.name, column.definition); err != nil {
			return err
		}
	}
	return nil
}

func (s *MySQLStore) migrateShardRuntimeColumns(ctx context.Context) error {
	columns := []struct {
		name       string
		definition string
	}{
		{name: "max_sets", definition: "BIGINT NOT NULL DEFAULT 0"},
		{name: "admin_sql_max_open_conns", definition: "BIGINT NOT NULL DEFAULT 0"},
		{name: "admin_sql_max_idle_conns", definition: "BIGINT NOT NULL DEFAULT 0"},
		{name: "admin_sql_max_lifetime_seconds", definition: "BIGINT NOT NULL DEFAULT 0"},
		{name: "traffic_sql_max_open_conns", definition: "BIGINT NOT NULL DEFAULT 0"},
		{name: "traffic_sql_max_idle_conns", definition: "BIGINT NOT NULL DEFAULT 0"},
		{name: "traffic_sql_max_lifetime_seconds", definition: "BIGINT NOT NULL DEFAULT 0"},
		{name: "subscription_write_concurrency", definition: "BIGINT NOT NULL DEFAULT 0"},
		{name: "redis_endpoint", definition: "TEXT NULL"},
		{name: "secret_name", definition: "VARCHAR(191) NOT NULL DEFAULT ''"},
		{name: "redis_db_start", definition: "BIGINT NOT NULL DEFAULT 0"},
		{name: "redis_db_limit", definition: "BIGINT NOT NULL DEFAULT 0"},
	}
	for _, column := range columns {
		if err := s.ensureMySQLColumn(ctx, "llmgateway_shards", column.name, column.definition); err != nil {
			return err
		}
	}
	return nil
}

func (s *MySQLStore) migrateSetEndpointColumns(ctx context.Context) error {
	if err := s.ensureMySQLColumn(ctx, "llmgateway_sets", "traffic_base_url", "TEXT NULL"); err != nil {
		return err
	}
	if err := s.ensureMySQLColumn(ctx, "llmgateway_set_reconcile_facts", "traffic_base_url", "TEXT NULL"); err != nil {
		return err
	}
	if err := s.ensureMySQLColumn(ctx, "llmgateway_set_reconcile_facts", "runtime_generation", "BIGINT NOT NULL DEFAULT 0"); err != nil {
		return err
	}
	return s.ensureMySQLColumn(ctx, "llmgateway_set_reconcile_facts", "runtime_image", "TEXT NULL")
}

func (s *MySQLStore) migrateSetUpgradeColumns(ctx context.Context) error {
	columns := []struct {
		name       string
		definition string
	}{
		{name: "admin_image", definition: "TEXT NULL"},
		{name: "active_runtime_generation", definition: "BIGINT NOT NULL DEFAULT 0"},
		{name: "route_revision", definition: "BIGINT NOT NULL DEFAULT 0"},
		{name: "admin_writes_paused", definition: "TINYINT(1) NOT NULL DEFAULT 0"},
		{name: "admin_writes_pause_reason", definition: "TEXT NULL"},
		{name: "admin_writes_paused_at", definition: "DATETIME(6) NULL"},
	}
	for _, column := range columns {
		if err := s.ensureMySQLColumn(ctx, "llmgateway_sets", column.name, column.definition); err != nil {
			return err
		}
	}
	return nil
}

func (s *MySQLStore) migrateSetUpgradeRunColumns(ctx context.Context) error {
	columns := []struct {
		name       string
		definition string
	}{
		{name: "rollback_requested", definition: "TINYINT(1) NOT NULL DEFAULT 0"},
		{name: "rollback_reason", definition: "TEXT NULL"},
		{name: "master_upgraded_at", definition: "DATETIME(6) NULL"},
		{name: "compatibility_checked_at", definition: "DATETIME(6) NULL"},
	}
	for _, column := range columns {
		if err := s.ensureMySQLColumn(ctx, "llmgateway_set_upgrade_runs", column.name, column.definition); err != nil {
			return err
		}
	}
	return nil
}

func (s *MySQLStore) migrateReleaseRingColumns(ctx context.Context) error {
	columns := []struct {
		table      string
		name       string
		definition string
	}{
		{"llmgateway_sets", "release_ring_id", "VARCHAR(191) NOT NULL DEFAULT ''"},
		{"llmgateway_sets", "current_release_id", "VARCHAR(191) NOT NULL DEFAULT ''"},
		{"llmgateway_sets", "target_release_id", "VARCHAR(191) NOT NULL DEFAULT ''"},
		{"llmgateway_set_runtimes", "release_id", "VARCHAR(191) NOT NULL DEFAULT ''"},
		{"llmgateway_set_upgrade_batches", "rollout_id", "VARCHAR(191) NOT NULL DEFAULT ''"},
		{"llmgateway_set_upgrade_batches", "ring_id", "VARCHAR(191) NOT NULL DEFAULT ''"},
		{"llmgateway_set_upgrade_batches", "target_release_id", "VARCHAR(191) NOT NULL DEFAULT ''"},
		{"llmgateway_set_upgrade_runs", "from_release_id", "VARCHAR(191) NOT NULL DEFAULT ''"},
		{"llmgateway_set_upgrade_runs", "target_release_id", "VARCHAR(191) NOT NULL DEFAULT ''"},
		{"llmgateway_set_upgrade_runs", "sequence_no", "BIGINT NOT NULL DEFAULT 0"},
		{"llmgateway_set_provision_requests", "release_ring_id", "VARCHAR(191) NOT NULL DEFAULT ''"},
		{"llmgateway_set_provision_requests", "release_id", "VARCHAR(191) NOT NULL DEFAULT ''"},
		{"llmgateway_set_provision_requests", "release_image", "TEXT NULL"},
		{"llmgateway_release_rollouts", "soak_started_at", "DATETIME(6) NULL"},
		{"llmgateway_release_rollouts", "soak_deadline", "DATETIME(6) NULL"},
		{"llmgateway_release_rollouts", "last_gate_checked_at", "DATETIME(6) NULL"},
		{"llmgateway_release_rollouts", "last_gate_error", "TEXT NULL"},
		{"llmgateway_release_rollouts", "campaign_id", "VARCHAR(191) NOT NULL DEFAULT ''"},
		{"llmgateway_release_rollouts", "campaign_sequence", "BIGINT NOT NULL DEFAULT 0"},
	}
	for _, column := range columns {
		if err := s.ensureMySQLColumn(ctx, column.table, column.name, column.definition); err != nil {
			return err
		}
	}
	return s.ensureMySQLIndex(ctx, "llmgateway_release_rollouts", "idx_llmgateway_release_rollout_campaign", "campaign_id, campaign_sequence")
}

func (s *MySQLStore) migrateSetRuntimeLeases(ctx context.Context) error {
	if err := s.failOnDuplicateRuntimeLeaseSourceRows(ctx); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO llmgateway_set_runtime_leases (
			source, namespace_name, fleet, set_id, shard_ref, database_name, redis_db, created_at, updated_at
		)
		SELECT r.source, r.namespace_name, r.fleet, r.set_id, r.shard_ref, r.database_name, r.redis_db, MIN(r.created_at), MAX(r.updated_at)
		FROM llmgateway_set_provision_requests r
		WHERE r.source <> '' AND r.namespace_name <> '' AND r.fleet <> '' AND r.set_id <> ''
			AND r.shard_ref <> '' AND r.database_name <> '' AND r.redis_db <> ''
			AND LOWER(TRIM(r.status)) NOT IN ('error', 'cancelled')
				AND NOT EXISTS (
					SELECT 1
					FROM llmgateway_set_runtime_leases l
					WHERE l.source = r.source AND l.namespace_name = r.namespace_name AND l.fleet = r.fleet
						AND l.set_id = r.set_id
				)
				AND NOT EXISTS (
					SELECT 1
					FROM llmgateway_set_runtime_leases l
					WHERE l.source = r.source AND l.namespace_name = r.namespace_name AND l.fleet = r.fleet
						AND l.shard_ref = r.shard_ref AND l.redis_db = r.redis_db
				)
				AND NOT EXISTS (
					SELECT 1
					FROM llmgateway_set_runtime_leases l
					WHERE l.source = r.source AND l.namespace_name = r.namespace_name AND l.fleet = r.fleet
						AND l.database_name = r.database_name
				)
			GROUP BY r.source, r.namespace_name, r.fleet, r.set_id, r.shard_ref, r.database_name, r.redis_db
		`)
	return err
}

func (s *MySQLStore) failOnDuplicateRuntimeLeaseSourceRows(ctx context.Context) error {
	var setID, leases string
	err := s.db.QueryRowContext(ctx, `
		SELECT set_id, GROUP_CONCAT(DISTINCT CONCAT(shard_ref, ':', redis_db, ':', database_name) ORDER BY shard_ref, redis_db, database_name SEPARATOR ',')
		FROM llmgateway_set_provision_requests
		WHERE source <> '' AND namespace_name <> '' AND fleet <> '' AND set_id <> ''
			AND shard_ref <> '' AND database_name <> '' AND redis_db <> ''
			AND LOWER(TRIM(status)) NOT IN ('error', 'cancelled')
		GROUP BY source, namespace_name, fleet, set_id
		HAVING COUNT(DISTINCT CONCAT(shard_ref, ':', redis_db, ':', database_name)) > 1
		LIMIT 1
	`).Scan(&setID, &leases)
	if err == nil {
		return fmt.Errorf("duplicate runtime lease source rows for set %s: leases %s", setID, leases)
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}

	var shardRef, redisDB, setIDs string
	err = s.db.QueryRowContext(ctx, `
		SELECT shard_ref, redis_db, GROUP_CONCAT(DISTINCT set_id ORDER BY set_id SEPARATOR ',')
		FROM llmgateway_set_provision_requests
		WHERE source <> '' AND namespace_name <> '' AND fleet <> '' AND set_id <> ''
			AND shard_ref <> '' AND database_name <> '' AND redis_db <> ''
			AND LOWER(TRIM(status)) NOT IN ('error', 'cancelled')
		GROUP BY source, namespace_name, fleet, shard_ref, redis_db
		HAVING COUNT(DISTINCT set_id) > 1
		LIMIT 1
	`).Scan(&shardRef, &redisDB, &setIDs)
	if err == nil {
		return fmt.Errorf("duplicate runtime lease source rows for redis db %s on shard %s: sets %s", redisDB, shardRef, setIDs)
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}

	var databaseName string
	err = s.db.QueryRowContext(ctx, `
		SELECT database_name, GROUP_CONCAT(DISTINCT set_id ORDER BY set_id SEPARATOR ',')
		FROM llmgateway_set_provision_requests
		WHERE source <> '' AND namespace_name <> '' AND fleet <> '' AND set_id <> ''
			AND shard_ref <> '' AND database_name <> '' AND redis_db <> ''
			AND LOWER(TRIM(status)) NOT IN ('error', 'cancelled')
		GROUP BY source, namespace_name, fleet, database_name
		HAVING COUNT(DISTINCT set_id) > 1
		LIMIT 1
	`).Scan(&databaseName, &setIDs)
	if err == nil {
		return fmt.Errorf("duplicate runtime lease source rows for database %s: sets %s", databaseName, setIDs)
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	return nil
}

func (s *MySQLStore) migrateSetAdmissionColumns(ctx context.Context) error {
	for _, column := range []struct {
		name       string
		definition string
	}{
		{name: "admission_status", definition: "VARCHAR(32) NOT NULL DEFAULT ''"},
		{name: "admission_error", definition: "TEXT NOT NULL"},
		{name: "admission_checked_at", definition: "DATETIME(6) NULL"},
	} {
		if err := s.ensureMySQLColumn(ctx, "llmgateway_sets", column.name, column.definition); err != nil {
			return err
		}
	}
	return nil
}

func (s *MySQLStore) migrateSetShardColumns(ctx context.Context) error {
	for _, column := range []struct {
		name       string
		definition string
	}{
		{name: "shard_id", definition: "VARCHAR(191) NOT NULL DEFAULT ''"},
		{name: "newapi_replicas", definition: "BIGINT NOT NULL DEFAULT 0"},
		{name: "sql_max_open_conns", definition: "BIGINT NOT NULL DEFAULT 0"},
		{name: "sql_max_idle_conns", definition: "BIGINT NOT NULL DEFAULT 0"},
	} {
		if err := s.ensureMySQLColumn(ctx, "llmgateway_sets", column.name, column.definition); err != nil {
			return err
		}
	}
	return s.ensureMySQLIndex(ctx, "llmgateway_sets", "idx_llmgateway_sets_shard_id", "shard_id")
}

func (s *MySQLStore) migrateSetRuntimeConfigColumns(ctx context.Context) error {
	columns := []struct {
		name       string
		definition string
	}{
		{name: "sql_max_lifetime_seconds", definition: "BIGINT NOT NULL DEFAULT 0"},
		{name: "traffic_sql_max_open_conns", definition: "BIGINT NOT NULL DEFAULT 0"},
		{name: "traffic_sql_max_idle_conns", definition: "BIGINT NOT NULL DEFAULT 0"},
		{name: "traffic_sql_max_lifetime_seconds", definition: "BIGINT NOT NULL DEFAULT 0"},
		{name: "subscription_write_concurrency", definition: "BIGINT NOT NULL DEFAULT 0"},
	}
	for _, table := range []string{"llmgateway_sets", "llmgateway_set_reconcile_facts"} {
		for _, column := range columns {
			if err := s.ensureMySQLColumn(ctx, table, column.name, column.definition); err != nil {
				return err
			}
		}
	}
	for _, column := range []struct {
		name       string
		definition string
	}{
		{name: "sql_max_open_conns", definition: "BIGINT NOT NULL DEFAULT 0"},
		{name: "sql_max_idle_conns", definition: "BIGINT NOT NULL DEFAULT 0"},
	} {
		if err := s.ensureMySQLColumn(ctx, "llmgateway_set_reconcile_facts", column.name, column.definition); err != nil {
			return err
		}
	}
	return nil
}

func (s *MySQLStore) migrateSetAdminHealthColumns(ctx context.Context) error {
	for _, column := range []struct {
		name       string
		definition string
	}{
		{name: "admin_health_status", definition: "VARCHAR(32) NOT NULL DEFAULT ''"},
		{name: "admin_health_consecutive_failures", definition: "BIGINT NOT NULL DEFAULT 0"},
		{name: "admin_health_error", definition: "TEXT NOT NULL"},
		{name: "admin_health_checked_at", definition: "DATETIME(6) NULL"},
		{name: "admin_health_last_success_at", definition: "DATETIME(6) NULL"},
	} {
		if err := s.ensureMySQLColumn(ctx, "llmgateway_sets", column.name, column.definition); err != nil {
			return err
		}
	}
	return nil
}

func (s *MySQLStore) migrateSetSecureVerificationColumns(ctx context.Context) error {
	return s.ensureMySQLColumn(ctx, "llmgateway_sets", "admin_totp_secret", "TEXT NOT NULL")
}

func (s *MySQLStore) migrateSetCapacityColumns(ctx context.Context) error {
	for _, column := range []struct {
		name       string
		definition string
	}{
		{name: "max_users", definition: "BIGINT NOT NULL DEFAULT 0"},
		{name: "warn_users", definition: "BIGINT NOT NULL DEFAULT 0"},
		{name: "reserved_users", definition: "BIGINT NOT NULL DEFAULT 0"},
		{name: "observed_user_count", definition: "BIGINT NOT NULL DEFAULT 0"},
		{name: "capacity_updated_at", definition: "DATETIME(6) NULL"},
	} {
		if err := s.ensureMySQLColumn(ctx, "llmgateway_sets", column.name, column.definition); err != nil {
			return err
		}
	}
	return nil
}

func (s *MySQLStore) migrateWorkerJobCursorColumn(ctx context.Context) error {
	return s.ensureMySQLColumn(ctx, "llmgateway_worker_jobs", "scan_cursor", "TEXT NULL")
}

func (s *MySQLStore) migrateChannelSpecDesiredColumns(ctx context.Context) error {
	for _, column := range []struct {
		name       string
		definition string
	}{
		{name: "auto_ban", definition: "BIGINT NULL"},
		{name: "tag", definition: "VARCHAR(191) NOT NULL DEFAULT ''"},
		{name: "other_value", definition: "TEXT NOT NULL"},
		{name: "status_code_mapping", definition: "TEXT NOT NULL"},
		{name: "other_settings", definition: "TEXT NOT NULL"},
		{name: "openai_organization", definition: "TEXT NOT NULL"},
		{name: "test_model", definition: "TEXT NOT NULL"},
		{name: "is_multi_key", definition: "BOOLEAN NOT NULL DEFAULT FALSE"},
		{name: "multi_key_mode", definition: "VARCHAR(32) NOT NULL DEFAULT ''"},
	} {
		if err := s.ensureMySQLColumn(ctx, "llmgateway_channel_specs", column.name, column.definition); err != nil {
			return err
		}
	}
	return nil
}

func (s *MySQLStore) migrateUserBindingProvisionColumns(ctx context.Context) error {
	if err := s.ensureMySQLColumn(ctx, "llmgateway_user_bindings", "provision_status", "VARCHAR(32) NOT NULL DEFAULT 'allocated'"); err != nil {
		return err
	}
	if err := s.ensureMySQLColumn(ctx, "llmgateway_user_bindings", "last_provision_error", "TEXT NULL"); err != nil {
		return err
	}
	if err := s.ensureMySQLIndex(ctx, "llmgateway_user_bindings", "idx_llmgateway_user_bindings_provision_status", "provision_status"); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx, `
		UPDATE llmgateway_user_bindings
		SET provision_status = 'user_ready'
		WHERE upstream_user_id > 0 AND provision_status = 'allocated'
	`)
	return err
}

func (s *MySQLStore) ensureMySQLColumn(ctx context.Context, table string, column string, definition string) error {
	var count int
	if err := s.db.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM information_schema.COLUMNS
		WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?
	`, table, column).Scan(&count); err != nil {
		return err
	}
	if count > 0 {
		return nil
	}
	_, err := s.db.ExecContext(ctx, "ALTER TABLE "+table+" ADD COLUMN "+column+" "+definition)
	return err
}

func (s *MySQLStore) ensureMySQLIndex(ctx context.Context, table string, index string, column string) error {
	var count int
	if err := s.db.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM information_schema.STATISTICS
		WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?
	`, table, index).Scan(&count); err != nil {
		return err
	}
	if count > 0 {
		return nil
	}
	_, err := s.db.ExecContext(ctx, "ALTER TABLE "+table+" ADD INDEX "+index+" ("+column+")")
	return err
}

func (s *MySQLStore) ensureMySQLUniqueIndex(ctx context.Context, table string, index string, columns string) error {
	var count int
	if err := s.db.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM information_schema.STATISTICS
		WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?
	`, table, index).Scan(&count); err != nil {
		return err
	}
	if count > 0 {
		return nil
	}
	_, err := s.db.ExecContext(ctx, "ALTER TABLE "+table+" ADD UNIQUE INDEX "+index+" ("+columns+")")
	return err
}

type mysqlIndexSpec struct {
	Table   string
	Name    string
	Columns []string
}

func tenantListCompositeIndexes() []mysqlIndexSpec {
	return []mysqlIndexSpec{
		{Table: "llmgateway_tenants", Name: "idx_llmgateway_tenants_backend_page", Columns: []string{"backend", "updated_at", "external_user_id"}},
		{Table: "llmgateway_tenants", Name: "idx_llmgateway_tenants_set_page", Columns: []string{"set_id", "updated_at", "external_user_id"}},
		{Table: "llmgateway_tenants", Name: "idx_llmgateway_tenants_backend_status", Columns: []string{"backend", "status"}},
		{Table: "llmgateway_user_bindings", Name: "idx_llmgateway_user_bindings_username_user", Columns: []string{"username", "external_user_id"}},
	}
}

func (s *MySQLStore) migrateTenantListIndexes(ctx context.Context) error {
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()

	const lockName = "llmgateway-schema-migration"
	var acquired sql.NullInt64
	if err := conn.QueryRowContext(ctx, `SELECT GET_LOCK(?, 60)`, lockName).Scan(&acquired); err != nil {
		return fmt.Errorf("acquire tenant index migration lock: %w", err)
	}
	if !acquired.Valid || acquired.Int64 != 1 {
		return fmt.Errorf("acquire tenant index migration lock: timed out")
	}
	defer func() {
		releaseCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		_, _ = conn.ExecContext(releaseCtx, `SELECT RELEASE_LOCK(?)`, lockName)
	}()

	for _, index := range tenantListCompositeIndexes() {
		if err := ensureMySQLCompositeIndexOnConn(ctx, conn, index); err != nil {
			return err
		}
	}
	return nil
}

func ensureMySQLCompositeIndexOnConn(ctx context.Context, conn *sql.Conn, index mysqlIndexSpec) error {
	var count int
	if err := conn.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM information_schema.STATISTICS
		WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?
	`, index.Table, index.Name).Scan(&count); err != nil {
		return err
	}
	if count > 0 {
		return nil
	}
	statement, err := mysqlCompositeIndexDDL(index)
	if err != nil {
		return err
	}
	if _, err := conn.ExecContext(ctx, statement); err != nil {
		return fmt.Errorf("create mysql index %s: %w", index.Name, err)
	}
	return nil
}

func mysqlCompositeIndexDDL(index mysqlIndexSpec) (string, error) {
	if !validMySQLIdentifier(index.Table) || !validMySQLIdentifier(index.Name) || len(index.Columns) == 0 {
		return "", fmt.Errorf("invalid mysql index specification: %+v", index)
	}
	columns := make([]string, 0, len(index.Columns))
	for _, column := range index.Columns {
		if !validMySQLIdentifier(column) {
			return "", fmt.Errorf("invalid mysql index column %q", column)
		}
		columns = append(columns, "`"+column+"`")
	}
	return "ALTER TABLE `" + index.Table + "` ADD INDEX `" + index.Name + "` (" + strings.Join(columns, ",") + "), ALGORITHM=INPLACE, LOCK=NONE", nil
}

func validMySQLIdentifier(value string) bool {
	if value == "" {
		return false
	}
	for _, char := range value {
		if (char < 'a' || char > 'z') && (char < 'A' || char > 'Z') && (char < '0' || char > '9') && char != '_' {
			return false
		}
	}
	return true
}

func (s *MySQLStore) backfillTenants(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT IGNORE INTO llmgateway_tenants (
			external_user_id, backend, set_id, status, source, display_name, created_at, updated_at
		)
		SELECT
			t.external_user_id,
			CASE
				WHEN a.external_user_id IS NOT NULL THEN a.backend
				WHEN b.external_user_id IS NOT NULL THEN 'new'
				WHEN o.backend <> '' THEN o.backend
				ELSE 'pending'
			END AS backend,
			CASE
				WHEN a.external_user_id IS NOT NULL AND a.backend = 'new' THEN a.set_id
				WHEN b.external_user_id IS NOT NULL THEN b.set_id
				WHEN o.backend = 'new' THEN o.set_id
				ELSE ''
			END AS set_id,
			'active' AS status,
			CASE
				WHEN a.external_user_id IS NOT NULL THEN 'backfill-assignment'
				WHEN b.external_user_id IS NOT NULL THEN 'backfill-binding'
				ELSE 'backfill-observation'
			END AS source,
			'' AS display_name,
			COALESCE(a.created_at, b.created_at, o.created_at, UTC_TIMESTAMP(6)) AS created_at,
			COALESCE(a.updated_at, b.updated_at, o.updated_at, UTC_TIMESTAMP(6)) AS updated_at
		FROM (
			SELECT external_user_id FROM llmgateway_user_bindings
			UNION
			SELECT external_user_id FROM llmgateway_user_assignments
			UNION
			SELECT external_user_id FROM llmgateway_tenant_observations
		) t
		LEFT JOIN llmgateway_user_bindings b ON b.external_user_id = t.external_user_id
		LEFT JOIN llmgateway_user_assignments a ON a.external_user_id = t.external_user_id
		LEFT JOIN llmgateway_tenant_observations o ON o.external_user_id = t.external_user_id
	`)
	return err
}

func (s *MySQLStore) SaveSet(ctx context.Context, set Set) error {
	now := time.Now().UTC()
	if existing, ok, err := s.GetSet(ctx, set.ID); err != nil {
		return err
	} else if ok {
		set.CreatedAt = existing.CreatedAt
		if !set.Setup && set.AdminUserID == 0 && set.AdminAccessToken == "" {
			set.Setup = existing.Setup
			set.AdminUserID = existing.AdminUserID
			set.AdminUsername = existing.AdminUsername
			set.AdminRole = existing.AdminRole
			set.AdminStatus = existing.AdminStatus
			set.AdminGroup = existing.AdminGroup
			set.AdminAccessToken = existing.AdminAccessToken
		}
		if set.AdminTOTPSecret == "" {
			set.AdminTOTPSecret = existing.AdminTOTPSecret
		}
		if set.CapacityUpdatedAt.IsZero() && set.ObservedUserCount == 0 && !existing.CapacityUpdatedAt.IsZero() {
			set.ObservedUserCount = existing.ObservedUserCount
			set.CapacityUpdatedAt = existing.CapacityUpdatedAt
		}
		if set.ShardID == "" {
			set.ShardID = existing.ShardID
		}
		if set.NewAPIReplicas == 0 {
			set.NewAPIReplicas = existing.NewAPIReplicas
		}
		if set.SQLMaxOpenConns == 0 {
			set.SQLMaxOpenConns = existing.SQLMaxOpenConns
		}
		if set.SQLMaxIdleConns == 0 {
			set.SQLMaxIdleConns = existing.SQLMaxIdleConns
		}
		if set.SQLMaxLifetimeSeconds == 0 {
			set.SQLMaxLifetimeSeconds = existing.SQLMaxLifetimeSeconds
		}
		if set.TrafficSQLMaxOpenConns == 0 {
			set.TrafficSQLMaxOpenConns = existing.TrafficSQLMaxOpenConns
		}
		if set.TrafficSQLMaxIdleConns == 0 {
			set.TrafficSQLMaxIdleConns = existing.TrafficSQLMaxIdleConns
		}
		if set.TrafficSQLMaxLifetimeSeconds == 0 {
			set.TrafficSQLMaxLifetimeSeconds = existing.TrafficSQLMaxLifetimeSeconds
		}
		if set.SubscriptionWriteConcurrency == 0 {
			set.SubscriptionWriteConcurrency = existing.SubscriptionWriteConcurrency
		}
		healthExplicit := set.AdminHealthStatus != "" || !set.AdminHealthCheckedAt.IsZero()
		if !healthExplicit {
			set.AdminHealthStatus = existing.AdminHealthStatus
			set.AdminHealthConsecutiveFailures = existing.AdminHealthConsecutiveFailures
			set.AdminHealthError = existing.AdminHealthError
			set.AdminHealthCheckedAt = existing.AdminHealthCheckedAt
			set.AdminHealthLastSuccessAt = existing.AdminHealthLastSuccessAt
		}
		if set.TrafficBaseURL == "" {
			set.TrafficBaseURL = existing.TrafficBaseURL
		}
		if set.AdmissionStatus == "" {
			set.AdmissionStatus = existing.AdmissionStatus
		}
		admissionExplicit := set.AdmissionStatus != "" || !set.AdmissionCheckedAt.IsZero()
		if set.AdmissionError == "" && !admissionExplicit {
			set.AdmissionError = existing.AdmissionError
		}
		if set.AdmissionCheckedAt.IsZero() {
			set.AdmissionCheckedAt = existing.AdmissionCheckedAt
		}
		if set.LifecycleGeneration < existing.LifecycleGeneration {
			set.LifecycleGeneration = existing.LifecycleGeneration
		}
		if set.AdminImage == "" {
			set.AdminImage = existing.AdminImage
		}
		if set.ReleaseRingID == "" {
			set.ReleaseRingID = existing.ReleaseRingID
		}
		if set.CurrentReleaseID == "" {
			set.CurrentReleaseID = existing.CurrentReleaseID
		}
		if set.TargetReleaseID == "" {
			set.TargetReleaseID = existing.TargetReleaseID
		}
		if set.ActiveRuntimeGeneration == 0 {
			set.ActiveRuntimeGeneration = existing.ActiveRuntimeGeneration
		}
		if set.RouteRevision < existing.RouteRevision {
			set.RouteRevision = existing.RouteRevision
		}
		set.AdminWritesPaused = existing.AdminWritesPaused
		set.AdminWritesPauseReason = existing.AdminWritesPauseReason
		set.AdminWritesPausedAt = existing.AdminWritesPausedAt
	}
	if set.CreatedAt.IsZero() {
		set.CreatedAt = now
	}
	set.UpdatedAt = now
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO llmgateway_sets (
			id, name, base_url, traffic_base_url, status, setup, admin_user_id, admin_username,
			admin_role, admin_status, admin_group, admin_access_token, admin_totp_secret,
			max_users, warn_users, reserved_users, observed_user_count, capacity_updated_at,
			shard_id, newapi_replicas, sql_max_open_conns, sql_max_idle_conns, sql_max_lifetime_seconds,
			traffic_sql_max_open_conns, traffic_sql_max_idle_conns, traffic_sql_max_lifetime_seconds,
			subscription_write_concurrency,
			admin_health_status, admin_health_consecutive_failures, admin_health_error,
			admin_health_checked_at, admin_health_last_success_at,
			admin_writes_paused, admin_writes_pause_reason, admin_writes_paused_at,
			admission_status, admission_error, admission_checked_at, lifecycle_generation,
			admin_image, release_ring_id, current_release_id, target_release_id,
			active_runtime_generation, route_revision, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON DUPLICATE KEY UPDATE
			name = VALUES(name),
			base_url = VALUES(base_url),
			traffic_base_url = VALUES(traffic_base_url),
			status = VALUES(status),
			setup = VALUES(setup),
			admin_user_id = VALUES(admin_user_id),
			admin_username = VALUES(admin_username),
			admin_role = VALUES(admin_role),
			admin_status = VALUES(admin_status),
			admin_group = VALUES(admin_group),
			admin_access_token = VALUES(admin_access_token),
			admin_totp_secret = VALUES(admin_totp_secret),
			max_users = VALUES(max_users),
			warn_users = VALUES(warn_users),
			reserved_users = VALUES(reserved_users),
			observed_user_count = VALUES(observed_user_count),
			capacity_updated_at = VALUES(capacity_updated_at),
			shard_id = VALUES(shard_id),
			newapi_replicas = VALUES(newapi_replicas),
			sql_max_open_conns = VALUES(sql_max_open_conns),
			sql_max_idle_conns = VALUES(sql_max_idle_conns),
			sql_max_lifetime_seconds = VALUES(sql_max_lifetime_seconds),
			traffic_sql_max_open_conns = VALUES(traffic_sql_max_open_conns),
			traffic_sql_max_idle_conns = VALUES(traffic_sql_max_idle_conns),
			traffic_sql_max_lifetime_seconds = VALUES(traffic_sql_max_lifetime_seconds),
			subscription_write_concurrency = VALUES(subscription_write_concurrency),
			admin_health_status = VALUES(admin_health_status),
			admin_health_consecutive_failures = VALUES(admin_health_consecutive_failures),
			admin_health_error = VALUES(admin_health_error),
			admin_health_checked_at = VALUES(admin_health_checked_at),
			admin_health_last_success_at = VALUES(admin_health_last_success_at),
			admission_status = VALUES(admission_status),
			admission_error = VALUES(admission_error),
			admission_checked_at = VALUES(admission_checked_at),
			lifecycle_generation = GREATEST(lifecycle_generation, VALUES(lifecycle_generation)),
			admin_image = VALUES(admin_image),
			release_ring_id = VALUES(release_ring_id),
			current_release_id = VALUES(current_release_id),
			target_release_id = VALUES(target_release_id),
			active_runtime_generation = GREATEST(active_runtime_generation, VALUES(active_runtime_generation)),
			route_revision = GREATEST(route_revision, VALUES(route_revision)),
			updated_at = VALUES(updated_at)
	`, set.ID, set.Name, set.BaseURL, set.TrafficBaseURL, set.Status, set.Setup, set.AdminUserID, set.AdminUsername,
		set.AdminRole, set.AdminStatus, set.AdminGroup, set.AdminAccessToken, set.AdminTOTPSecret,
		set.MaxUsers, set.WarnUsers, set.ReservedUsers, set.ObservedUserCount, nullableTime(set.CapacityUpdatedAt),
		set.ShardID, set.NewAPIReplicas, set.SQLMaxOpenConns, set.SQLMaxIdleConns, set.SQLMaxLifetimeSeconds,
		set.TrafficSQLMaxOpenConns, set.TrafficSQLMaxIdleConns, set.TrafficSQLMaxLifetimeSeconds,
		set.SubscriptionWriteConcurrency,
		set.AdminHealthStatus, set.AdminHealthConsecutiveFailures, set.AdminHealthError,
		nullableTime(set.AdminHealthCheckedAt), nullableTime(set.AdminHealthLastSuccessAt),
		set.AdminWritesPaused, set.AdminWritesPauseReason, nullableTime(set.AdminWritesPausedAt),
		set.AdmissionStatus, set.AdmissionError, nullableTime(set.AdmissionCheckedAt), set.LifecycleGeneration,
		set.AdminImage, set.ReleaseRingID, set.CurrentReleaseID, set.TargetReleaseID,
		set.ActiveRuntimeGeneration, set.RouteRevision, set.CreatedAt, set.UpdatedAt)
	return err
}

func (s *MySQLStore) SetAdminWritesPaused(ctx context.Context, setID string, paused bool, reason string, now time.Time) error {
	pausedAt := any(nil)
	if paused {
		pausedAt = now.UTC()
	} else {
		reason = ""
	}
	result, err := s.db.ExecContext(ctx, `
		UPDATE llmgateway_sets
		SET admin_writes_paused = ?, admin_writes_pause_reason = ?, admin_writes_paused_at = ?, updated_at = ?
		WHERE id = ?
	`, paused, strings.TrimSpace(reason), pausedAt, now.UTC(), strings.TrimSpace(setID))
	if err != nil {
		return err
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if rows == 0 {
		return fmt.Errorf("set %q not found", setID)
	}
	return nil
}

func (s *MySQLStore) GetSet(ctx context.Context, id string) (Set, bool, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT id, name, base_url, COALESCE(traffic_base_url, ''), status, setup, admin_user_id, admin_username,
			admin_role, admin_status, admin_group, admin_access_token, admin_totp_secret,
			max_users, warn_users, reserved_users, observed_user_count, capacity_updated_at,
			shard_id, newapi_replicas, sql_max_open_conns, sql_max_idle_conns, sql_max_lifetime_seconds,
			traffic_sql_max_open_conns, traffic_sql_max_idle_conns, traffic_sql_max_lifetime_seconds,
			subscription_write_concurrency,
			admin_health_status, admin_health_consecutive_failures, admin_health_error,
			admin_health_checked_at, admin_health_last_success_at,
			admin_writes_paused, admin_writes_pause_reason, admin_writes_paused_at,
			admission_status, admission_error, admission_checked_at, lifecycle_generation,
			COALESCE(admin_image, ''), release_ring_id, current_release_id, target_release_id,
			active_runtime_generation, route_revision, created_at, updated_at
		FROM llmgateway_sets WHERE id = ?
	`, id)
	set, err := scanSet(row)
	if errors.Is(err, sql.ErrNoRows) {
		return Set{}, false, nil
	}
	if err != nil {
		return Set{}, false, err
	}
	return set, true, nil
}

func (s *MySQLStore) ListSets(ctx context.Context) ([]Set, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, name, base_url, COALESCE(traffic_base_url, ''), status, setup, admin_user_id, admin_username,
			admin_role, admin_status, admin_group, admin_access_token, admin_totp_secret,
			max_users, warn_users, reserved_users, observed_user_count, capacity_updated_at,
			shard_id, newapi_replicas, sql_max_open_conns, sql_max_idle_conns, sql_max_lifetime_seconds,
			traffic_sql_max_open_conns, traffic_sql_max_idle_conns, traffic_sql_max_lifetime_seconds,
			subscription_write_concurrency,
			admin_health_status, admin_health_consecutive_failures, admin_health_error,
			admin_health_checked_at, admin_health_last_success_at,
			admin_writes_paused, admin_writes_pause_reason, admin_writes_paused_at,
			admission_status, admission_error, admission_checked_at, lifecycle_generation,
			COALESCE(admin_image, ''), release_ring_id, current_release_id, target_release_id,
			active_runtime_generation, route_revision, created_at, updated_at
		FROM llmgateway_sets ORDER BY id
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var sets []Set
	for rows.Next() {
		set, err := scanSet(rows)
		if err != nil {
			return nil, err
		}
		sets = append(sets, set)
	}
	return sets, rows.Err()
}

func (s *MySQLStore) SaveShard(ctx context.Context, shard Shard) error {
	now := time.Now().UTC()
	if existing, ok, err := s.GetShard(ctx, shard.ID); err != nil {
		return err
	} else if ok {
		shard.CreatedAt = existing.CreatedAt
	}
	if shard.CreatedAt.IsZero() {
		shard.CreatedAt = now
	}
	shard.UpdatedAt = now
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO llmgateway_shards (
			id, name, kind, endpoint, redis_endpoint, secret_name, redis_db_start, redis_db_limit,
			status, max_connections, reserved_connections,
			warn_ratio, critical_ratio, max_sets,
			admin_sql_max_open_conns, admin_sql_max_idle_conns, admin_sql_max_lifetime_seconds,
			traffic_sql_max_open_conns, traffic_sql_max_idle_conns, traffic_sql_max_lifetime_seconds,
			subscription_write_concurrency, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON DUPLICATE KEY UPDATE
			name = VALUES(name),
			kind = VALUES(kind),
			endpoint = VALUES(endpoint),
			redis_endpoint = VALUES(redis_endpoint),
			secret_name = VALUES(secret_name),
			redis_db_start = VALUES(redis_db_start),
			redis_db_limit = VALUES(redis_db_limit),
			status = VALUES(status),
			max_connections = VALUES(max_connections),
			reserved_connections = VALUES(reserved_connections),
			warn_ratio = VALUES(warn_ratio),
			critical_ratio = VALUES(critical_ratio),
			max_sets = VALUES(max_sets),
			admin_sql_max_open_conns = VALUES(admin_sql_max_open_conns),
			admin_sql_max_idle_conns = VALUES(admin_sql_max_idle_conns),
			admin_sql_max_lifetime_seconds = VALUES(admin_sql_max_lifetime_seconds),
			traffic_sql_max_open_conns = VALUES(traffic_sql_max_open_conns),
			traffic_sql_max_idle_conns = VALUES(traffic_sql_max_idle_conns),
			traffic_sql_max_lifetime_seconds = VALUES(traffic_sql_max_lifetime_seconds),
			subscription_write_concurrency = VALUES(subscription_write_concurrency),
			updated_at = VALUES(updated_at)
	`, shard.ID, shard.Name, shard.Kind, shard.Endpoint, shard.RedisEndpoint, shard.SecretName, shard.RedisDBStart, shard.RedisDBLimit,
		shard.Status, shard.MaxConnections, shard.ReservedConnections,
		shard.WarnRatio, shard.CriticalRatio, shard.MaxSets,
		shard.AdminSQLMaxOpenConns, shard.AdminSQLMaxIdleConns, shard.AdminSQLMaxLifetimeSeconds,
		shard.TrafficSQLMaxOpenConns, shard.TrafficSQLMaxIdleConns, shard.TrafficSQLMaxLifetimeSeconds,
		shard.SubscriptionWriteConcurrency, shard.CreatedAt, shard.UpdatedAt)
	return err
}

func (s *MySQLStore) GetShard(ctx context.Context, id string) (Shard, bool, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT id, name, kind, endpoint, COALESCE(redis_endpoint, ''), secret_name, redis_db_start, redis_db_limit,
			status, max_connections, reserved_connections,
			warn_ratio, critical_ratio, max_sets,
			admin_sql_max_open_conns, admin_sql_max_idle_conns, admin_sql_max_lifetime_seconds,
			traffic_sql_max_open_conns, traffic_sql_max_idle_conns, traffic_sql_max_lifetime_seconds,
			subscription_write_concurrency, created_at, updated_at
		FROM llmgateway_shards WHERE id = ?
	`, id)
	shard, err := scanShard(row)
	if errors.Is(err, sql.ErrNoRows) {
		return Shard{}, false, nil
	}
	if err != nil {
		return Shard{}, false, err
	}
	return shard, true, nil
}

func (s *MySQLStore) ListShards(ctx context.Context) ([]Shard, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, name, kind, endpoint, COALESCE(redis_endpoint, ''), secret_name, redis_db_start, redis_db_limit,
			status, max_connections, reserved_connections,
			warn_ratio, critical_ratio, max_sets,
			admin_sql_max_open_conns, admin_sql_max_idle_conns, admin_sql_max_lifetime_seconds,
			traffic_sql_max_open_conns, traffic_sql_max_idle_conns, traffic_sql_max_lifetime_seconds,
			subscription_write_concurrency, created_at, updated_at
		FROM llmgateway_shards ORDER BY id
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var shards []Shard
	for rows.Next() {
		shard, err := scanShard(rows)
		if err != nil {
			return nil, err
		}
		shards = append(shards, shard)
	}
	return shards, rows.Err()
}

func (s *MySQLStore) IncrementSetObservedUserCount(ctx context.Context, setID string, delta int) error {
	if strings.TrimSpace(setID) == "" || delta == 0 {
		return nil
	}
	now := time.Now().UTC()
	result, err := s.db.ExecContext(ctx, `
		UPDATE llmgateway_sets
		SET observed_user_count = CASE
				WHEN observed_user_count + ? < 0 THEN 0
				ELSE observed_user_count + ?
			END,
			capacity_updated_at = ?,
			updated_at = ?
		WHERE id = ?
	`, delta, delta, now, now, setID)
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected == 0 {
		return fmt.Errorf("set %q not found", setID)
	}
	return nil
}

func (s *MySQLStore) TryReserveSetUserSlot(ctx context.Context, setID string) (bool, error) {
	if strings.TrimSpace(setID) == "" {
		return false, fmt.Errorf("set id is required")
	}
	now := time.Now().UTC()
	result, err := s.db.ExecContext(ctx, `
		UPDATE llmgateway_sets
		SET observed_user_count = observed_user_count + 1,
			capacity_updated_at = ?,
			updated_at = ?
		WHERE id = ?
			AND status = 'active'
			AND setup = TRUE
			AND admin_user_id > 0
			AND admin_access_token <> ''
			AND admission_status = 'passed'
			AND (
				max_users <= 0
				OR observed_user_count < CASE
					WHEN max_users - reserved_users < 0 THEN 0
					ELSE max_users - reserved_users
				END
			)
	`, now, now, setID)
	if err != nil {
		return false, err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return false, err
	}
	return affected > 0, nil
}

func (s *MySQLStore) SaveSetReconcileFact(ctx context.Context, fact SetReconcileFact) error {
	now := time.Now().UTC()
	if existing, ok, err := s.GetSetReconcileFact(ctx, fact.Source, fact.Namespace, fact.Fleet, fact.SetID); err != nil {
		return err
	} else if ok {
		fact.CreatedAt = existing.CreatedAt
	}
	if fact.CreatedAt.IsZero() {
		fact.CreatedAt = now
	}
	if fact.LastObservedAt.IsZero() {
		fact.LastObservedAt = now
	}
	fact.UpdatedAt = now
	var lastReconciledAt any
	if !fact.LastReconciledAt.IsZero() {
		lastReconciledAt = fact.LastReconciledAt
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO llmgateway_set_reconcile_facts (
			source, namespace_name, fleet, set_id, name, base_url, traffic_base_url, runtime_generation, runtime_image, shard_ref,
			sql_max_open_conns, sql_max_idle_conns, sql_max_lifetime_seconds,
			traffic_sql_max_open_conns, traffic_sql_max_idle_conns, traffic_sql_max_lifetime_seconds,
			subscription_write_concurrency, desired_hash,
			status, last_error, last_observed_at, last_reconciled_at, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON DUPLICATE KEY UPDATE
			name = VALUES(name),
			base_url = VALUES(base_url),
			traffic_base_url = VALUES(traffic_base_url),
			runtime_generation = VALUES(runtime_generation),
			runtime_image = VALUES(runtime_image),
			shard_ref = VALUES(shard_ref),
			sql_max_open_conns = VALUES(sql_max_open_conns),
			sql_max_idle_conns = VALUES(sql_max_idle_conns),
			sql_max_lifetime_seconds = VALUES(sql_max_lifetime_seconds),
			traffic_sql_max_open_conns = VALUES(traffic_sql_max_open_conns),
			traffic_sql_max_idle_conns = VALUES(traffic_sql_max_idle_conns),
			traffic_sql_max_lifetime_seconds = VALUES(traffic_sql_max_lifetime_seconds),
			subscription_write_concurrency = VALUES(subscription_write_concurrency),
			desired_hash = VALUES(desired_hash),
			status = VALUES(status),
			last_error = VALUES(last_error),
			last_observed_at = VALUES(last_observed_at),
			last_reconciled_at = VALUES(last_reconciled_at),
			updated_at = VALUES(updated_at)
	`, fact.Source, fact.Namespace, fact.Fleet, fact.SetID, fact.Name, fact.BaseURL, fact.TrafficBaseURL, fact.RuntimeGeneration, fact.RuntimeImage, fact.ShardRef,
		fact.SQLMaxOpenConns, fact.SQLMaxIdleConns, fact.SQLMaxLifetimeSeconds,
		fact.TrafficSQLMaxOpenConns, fact.TrafficSQLMaxIdleConns, fact.TrafficSQLMaxLifetimeSeconds,
		fact.SubscriptionWriteConcurrency, fact.DesiredHash,
		fact.Status, fact.LastError, fact.LastObservedAt, lastReconciledAt, fact.CreatedAt, fact.UpdatedAt)
	return err
}

func (s *MySQLStore) GetSetReconcileFact(ctx context.Context, source string, namespace string, fleet string, setID string) (SetReconcileFact, bool, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT source, namespace_name, fleet, set_id, name, base_url, COALESCE(traffic_base_url, ''), runtime_generation, COALESCE(runtime_image, ''), shard_ref,
			sql_max_open_conns, sql_max_idle_conns, sql_max_lifetime_seconds,
			traffic_sql_max_open_conns, traffic_sql_max_idle_conns, traffic_sql_max_lifetime_seconds,
			subscription_write_concurrency, desired_hash,
			status, last_error, last_observed_at, last_reconciled_at, created_at, updated_at
		FROM llmgateway_set_reconcile_facts
		WHERE source = ? AND namespace_name = ? AND fleet = ? AND set_id = ?
	`, source, namespace, fleet, setID)
	fact, err := scanSetReconcileFact(row)
	if errors.Is(err, sql.ErrNoRows) {
		return SetReconcileFact{}, false, nil
	}
	if err != nil {
		return SetReconcileFact{}, false, err
	}
	return fact, true, nil
}

func (s *MySQLStore) ListSetReconcileFacts(ctx context.Context, opts SetReconcileFactListOptions) ([]SetReconcileFact, error) {
	query := `
		SELECT source, namespace_name, fleet, set_id, name, base_url, COALESCE(traffic_base_url, ''), runtime_generation, COALESCE(runtime_image, ''), shard_ref,
			sql_max_open_conns, sql_max_idle_conns, sql_max_lifetime_seconds,
			traffic_sql_max_open_conns, traffic_sql_max_idle_conns, traffic_sql_max_lifetime_seconds,
			subscription_write_concurrency, desired_hash,
			status, last_error, last_observed_at, last_reconciled_at, created_at, updated_at
		FROM llmgateway_set_reconcile_facts`
	where := []string{}
	args := []any{}
	if opts.Source != "" {
		where = append(where, "source = ?")
		args = append(args, opts.Source)
	}
	if opts.Namespace != "" {
		where = append(where, "namespace_name = ?")
		args = append(args, opts.Namespace)
	}
	if opts.Fleet != "" {
		where = append(where, "fleet = ?")
		args = append(args, opts.Fleet)
	}
	if opts.Status != "" {
		where = append(where, "status = ?")
		args = append(args, opts.Status)
	}
	if len(where) > 0 {
		query += " WHERE " + strings.Join(where, " AND ")
	}
	query += " ORDER BY source, namespace_name, fleet, set_id"
	if opts.Limit > 0 {
		query += " LIMIT ?"
		args = append(args, opts.Limit)
	}
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	facts := []SetReconcileFact{}
	for rows.Next() {
		fact, err := scanSetReconcileFact(rows)
		if err != nil {
			return nil, err
		}
		facts = append(facts, fact)
	}
	return facts, rows.Err()
}

func (s *MySQLStore) SaveSetProvisionRequest(ctx context.Context, request SetProvisionRequest) error {
	now := time.Now().UTC()
	if existing, ok, err := s.GetSetProvisionRequest(ctx, request.ID); err != nil {
		return err
	} else if ok {
		request.CreatedAt = existing.CreatedAt
	}
	if request.CreatedAt.IsZero() {
		request.CreatedAt = now
	}
	if request.LastStatusAt.IsZero() {
		request.LastStatusAt = now
	}
	request.UpdatedAt = now
	if setRuntimeLeaseComplete(request) {
		tx, err := s.db.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		if err := s.saveSetRuntimeLeaseTx(ctx, tx, SetRuntimeLeaseFromProvisionRequest(request)); err != nil {
			_ = tx.Rollback()
			return err
		}
		if err := execSaveSetProvisionRequest(ctx, tx, request); err != nil {
			_ = tx.Rollback()
			return err
		}
		return tx.Commit()
	}
	if err := execSaveSetProvisionRequest(ctx, s.db, request); err != nil {
		return err
	}
	if !setProvisionStatusRequiresRuntimeLease(request.Status) {
		_, err := s.CleanupStaleSetRuntimeLeases(ctx)
		return err
	}
	return nil
}

type provisionRequestExecer interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}

func execSaveSetProvisionRequest(ctx context.Context, execer provisionRequestExecer, request SetProvisionRequest) error {
	_, err := execer.ExecContext(ctx, `
		INSERT INTO llmgateway_set_provision_requests (
			id, source, namespace_name, fleet, set_id, shard_ref, database_name, redis_db,
			release_ring_id, release_id, release_image,
			status, reason, last_error, requested_users, max_users_per_set,
			last_status_at, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON DUPLICATE KEY UPDATE
			shard_ref = VALUES(shard_ref),
			database_name = VALUES(database_name),
			redis_db = VALUES(redis_db),
			release_ring_id = VALUES(release_ring_id),
			release_id = VALUES(release_id),
			release_image = VALUES(release_image),
			status = VALUES(status),
			reason = VALUES(reason),
			last_error = VALUES(last_error),
			requested_users = VALUES(requested_users),
			max_users_per_set = VALUES(max_users_per_set),
			last_status_at = VALUES(last_status_at),
			updated_at = VALUES(updated_at)
	`, request.ID, request.Source, request.Namespace, request.Fleet, request.SetID, request.ShardRef,
		request.DatabaseName, request.RedisDB, request.ReleaseRingID, request.ReleaseID, request.ReleaseImage,
		request.Status, request.Reason, request.LastError,
		request.RequestedUsers, request.MaxUsersPerSet, nullableTime(request.LastStatusAt), request.CreatedAt, request.UpdatedAt)
	return err
}

func (s *MySQLStore) SaveSetRuntimeLease(ctx context.Context, lease SetRuntimeLease) error {
	if !setRuntimeLeaseStructComplete(lease) {
		return nil
	}
	now := time.Now().UTC()
	if lease.CreatedAt.IsZero() {
		lease.CreatedAt = now
	}
	if lease.UpdatedAt.IsZero() {
		lease.UpdatedAt = now
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	if err := s.saveSetRuntimeLeaseTx(ctx, tx, lease); err != nil {
		_ = tx.Rollback()
		return err
	}
	return tx.Commit()
}

func (s *MySQLStore) ListSetRuntimeLeases(ctx context.Context, opts SetRuntimeLeaseListOptions) ([]SetRuntimeLease, error) {
	query := `
		SELECT source, namespace_name, fleet, set_id, shard_ref, database_name, redis_db, created_at, updated_at
		FROM llmgateway_set_runtime_leases`
	where := []string{}
	args := []any{}
	if opts.Source != "" {
		where = append(where, "source = ?")
		args = append(args, opts.Source)
	}
	if opts.Namespace != "" {
		where = append(where, "namespace_name = ?")
		args = append(args, opts.Namespace)
	}
	if opts.Fleet != "" {
		where = append(where, "fleet = ?")
		args = append(args, opts.Fleet)
	}
	if len(where) > 0 {
		query += " WHERE " + strings.Join(where, " AND ")
	}
	query += " ORDER BY source, namespace_name, fleet, set_id"
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	leases := []SetRuntimeLease{}
	for rows.Next() {
		var lease SetRuntimeLease
		if err := rows.Scan(
			&lease.Source,
			&lease.Namespace,
			&lease.Fleet,
			&lease.SetID,
			&lease.ShardRef,
			&lease.DatabaseName,
			&lease.RedisDB,
			&lease.CreatedAt,
			&lease.UpdatedAt,
		); err != nil {
			return nil, err
		}
		leases = append(leases, lease)
	}
	return leases, rows.Err()
}

func (s *MySQLStore) CleanupStaleSetRuntimeLeases(ctx context.Context) (int, error) {
	result, err := s.db.ExecContext(ctx, `
		DELETE leases
		FROM llmgateway_set_runtime_leases leases
		LEFT JOIN llmgateway_sets managed_sets ON managed_sets.id = leases.set_id
		LEFT JOIN llmgateway_set_provision_requests open_requests
			ON open_requests.source = leases.source
			AND open_requests.namespace_name = leases.namespace_name
			AND open_requests.fleet = leases.fleet
			AND open_requests.set_id = leases.set_id
			AND LOWER(TRIM(open_requests.status)) NOT IN ('error', 'cancelled')
		LEFT JOIN llmgateway_set_provision_requests any_requests
			ON any_requests.source = leases.source
			AND any_requests.namespace_name = leases.namespace_name
			AND any_requests.fleet = leases.fleet
			AND any_requests.set_id = leases.set_id
		WHERE open_requests.id IS NULL
			AND (managed_sets.id IS NULL OR any_requests.id IS NOT NULL)
	`)
	if err != nil {
		return 0, err
	}
	count, err := result.RowsAffected()
	return int(count), err
}

func (s *MySQLStore) saveSetRuntimeLeaseTx(ctx context.Context, tx *sql.Tx, lease SetRuntimeLease) error {
	var existing SetRuntimeLease
	err := tx.QueryRowContext(ctx, `
		SELECT set_id, shard_ref, database_name, redis_db
		FROM llmgateway_set_runtime_leases
		WHERE source = ? AND namespace_name = ? AND fleet = ? AND set_id = ?
	`, lease.Source, lease.Namespace, lease.Fleet, lease.SetID).Scan(
		&existing.SetID,
		&existing.ShardRef,
		&existing.DatabaseName,
		&existing.RedisDB,
	)
	if err == nil {
		if strings.TrimSpace(existing.ShardRef) != strings.TrimSpace(lease.ShardRef) ||
			strings.TrimSpace(existing.RedisDB) != strings.TrimSpace(lease.RedisDB) ||
			strings.TrimSpace(existing.DatabaseName) != strings.TrimSpace(lease.DatabaseName) {
			return fmt.Errorf("runtime lease for set %s already points to shard %s redis db %s database %s", lease.SetID, existing.ShardRef, existing.RedisDB, existing.DatabaseName)
		}
		_, err = tx.ExecContext(ctx, `
			UPDATE llmgateway_set_runtime_leases
			SET updated_at = ?
			WHERE source = ? AND namespace_name = ? AND fleet = ? AND set_id = ?
		`, lease.UpdatedAt, lease.Source, lease.Namespace, lease.Fleet, lease.SetID)
		return err
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	_, err = tx.ExecContext(ctx, `
		INSERT INTO llmgateway_set_runtime_leases (
			source, namespace_name, fleet, set_id, shard_ref, database_name, redis_db, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, lease.Source, lease.Namespace, lease.Fleet, lease.SetID, lease.ShardRef, lease.DatabaseName, lease.RedisDB, lease.CreatedAt, lease.UpdatedAt)
	if err == nil {
		return nil
	}
	if !isMySQLDuplicateKeyError(err) {
		return err
	}
	return s.describeSetRuntimeLeaseConflictTx(ctx, tx, lease, err)
}

func (s *MySQLStore) describeSetRuntimeLeaseConflictTx(ctx context.Context, tx *sql.Tx, lease SetRuntimeLease, duplicateErr error) error {
	var setID string
	err := tx.QueryRowContext(ctx, `
		SELECT set_id
		FROM llmgateway_set_runtime_leases
		WHERE source = ? AND namespace_name = ? AND fleet = ?
			AND shard_ref = ? AND redis_db = ? AND set_id <> ?
		LIMIT 1
	`, lease.Source, lease.Namespace, lease.Fleet, lease.ShardRef, lease.RedisDB, lease.SetID).Scan(&setID)
	if err == nil {
		return fmt.Errorf("redis db %s on shard %s is already leased by set %s", lease.RedisDB, lease.ShardRef, setID)
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if duplicateKeyName(duplicateErr) == "uk_llmgateway_runtime_redis_db" {
		return fmt.Errorf("redis db %s on shard %s is already leased by another set", lease.RedisDB, lease.ShardRef)
	}
	err = tx.QueryRowContext(ctx, `
		SELECT set_id
		FROM llmgateway_set_runtime_leases
		WHERE source = ? AND namespace_name = ? AND fleet = ?
			AND database_name = ? AND set_id <> ?
		LIMIT 1
	`, lease.Source, lease.Namespace, lease.Fleet, lease.DatabaseName, lease.SetID).Scan(&setID)
	if err == nil {
		return fmt.Errorf("database %s is already leased by set %s", lease.DatabaseName, setID)
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if duplicateKeyName(duplicateErr) == "uk_llmgateway_runtime_database" {
		return fmt.Errorf("database %s is already leased by another set", lease.DatabaseName)
	}
	return fmt.Errorf("runtime lease conflict for set %s", lease.SetID)
}

func duplicateKeyName(err error) string {
	var mysqlErr *mysql.MySQLError
	if !errors.As(err, &mysqlErr) {
		return ""
	}
	message := mysqlErr.Message
	start := strings.LastIndex(message, "for key '")
	if start < 0 {
		return ""
	}
	start += len("for key '")
	end := strings.Index(message[start:], "'")
	if end < 0 {
		return ""
	}
	key := message[start : start+end]
	if dot := strings.LastIndex(key, "."); dot >= 0 {
		key = key[dot+1:]
	}
	return key
}

func (s *MySQLStore) GetSetProvisionRequest(ctx context.Context, id string) (SetProvisionRequest, bool, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT id, source, namespace_name, fleet, set_id, shard_ref, database_name, redis_db,
			release_ring_id, release_id, COALESCE(release_image, ''),
			status, reason, last_error, requested_users, max_users_per_set,
			last_status_at, created_at, updated_at
		FROM llmgateway_set_provision_requests
		WHERE id = ?
	`, id)
	request, err := scanSetProvisionRequest(row)
	if errors.Is(err, sql.ErrNoRows) {
		return SetProvisionRequest{}, false, nil
	}
	if err != nil {
		return SetProvisionRequest{}, false, err
	}
	return request, true, nil
}

func (s *MySQLStore) ListSetProvisionRequests(ctx context.Context, opts SetProvisionRequestListOptions) ([]SetProvisionRequest, error) {
	query := `
		SELECT id, source, namespace_name, fleet, set_id, shard_ref, database_name, redis_db,
			release_ring_id, release_id, COALESCE(release_image, ''),
			status, reason, last_error, requested_users, max_users_per_set,
			last_status_at, created_at, updated_at
		FROM llmgateway_set_provision_requests`
	where := []string{}
	args := []any{}
	if opts.Source != "" {
		where = append(where, "source = ?")
		args = append(args, opts.Source)
	}
	if opts.Namespace != "" {
		where = append(where, "namespace_name = ?")
		args = append(args, opts.Namespace)
	}
	if opts.Fleet != "" {
		where = append(where, "fleet = ?")
		args = append(args, opts.Fleet)
	}
	if opts.SetID != "" {
		where = append(where, "set_id = ?")
		args = append(args, opts.SetID)
	}
	if opts.Status != "" {
		where = append(where, "status = ?")
		args = append(args, opts.Status)
	}
	if len(where) > 0 {
		query += " WHERE " + strings.Join(where, " AND ")
	}
	query += " ORDER BY updated_at DESC, source, namespace_name, fleet, set_id"
	if opts.Limit > 0 {
		query += " LIMIT ?"
		args = append(args, opts.Limit)
	}
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	requests := []SetProvisionRequest{}
	for rows.Next() {
		request, err := scanSetProvisionRequest(rows)
		if err != nil {
			return nil, err
		}
		requests = append(requests, request)
	}
	return requests, rows.Err()
}

func (s *MySQLStore) SaveTenant(ctx context.Context, tenant Tenant) error {
	rawStatus := strings.TrimSpace(tenant.Status)
	rawSource := strings.TrimSpace(tenant.Source)
	rawDisplayName := strings.TrimSpace(tenant.DisplayName)
	tenant, err := normalizeTenant(tenant)
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	if existing, ok, err := s.GetTenant(ctx, tenant.ExternalUserID); err != nil {
		return err
	} else if ok {
		tenant.CreatedAt = existing.CreatedAt
		if rawStatus == "" {
			tenant.Status = existing.Status
		}
		if rawSource == "" {
			tenant.Source = existing.Source
		}
		if rawDisplayName == "" {
			tenant.DisplayName = existing.DisplayName
		}
	} else if tenant.CreatedAt.IsZero() {
		tenant.CreatedAt = now
	}
	tenant.UpdatedAt = now
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := rejectDeletingTenantWriteTx(ctx, tx, tenant.ExternalUserID); err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `
		INSERT INTO llmgateway_tenants (
			external_user_id, backend, set_id, status, source, display_name, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON DUPLICATE KEY UPDATE
			backend = VALUES(backend),
			set_id = VALUES(set_id),
			status = VALUES(status),
			source = VALUES(source),
			display_name = VALUES(display_name),
			updated_at = VALUES(updated_at)
	`, tenant.ExternalUserID, tenant.Backend, tenant.SetID, tenant.Status, tenant.Source, tenant.DisplayName, tenant.CreatedAt, tenant.UpdatedAt)
	if err != nil {
		return err
	}
	return tx.Commit()
}

func rejectDeletingTenantWriteTx(ctx context.Context, tx *sql.Tx, externalUserID string) error {
	var status string
	err := tx.QueryRowContext(ctx, `SELECT status FROM llmgateway_tenants WHERE external_user_id = ? FOR UPDATE`, strings.TrimSpace(externalUserID)).Scan(&status)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if status == TenantStatusDeleting || status == TenantStatusDeleted {
		return fmt.Errorf("%w: tenant %s is %s", ErrTenantInactive, externalUserID, status)
	}
	return nil
}

func (s *MySQLStore) GetTenant(ctx context.Context, externalUserID string) (Tenant, bool, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT external_user_id, backend, set_id, status, source, display_name, created_at, updated_at
		FROM llmgateway_tenants WHERE external_user_id = ?
	`, externalUserID)
	tenant, err := scanTenant(row)
	if errors.Is(err, sql.ErrNoRows) {
		return Tenant{}, false, nil
	}
	if err != nil {
		return Tenant{}, false, err
	}
	return tenant, true, nil
}

func (s *MySQLStore) SaveUserBinding(ctx context.Context, binding UserBinding) error {
	now := time.Now().UTC()
	if existing, ok, err := s.GetUserBinding(ctx, binding.ExternalUserID); err != nil {
		return err
	} else if ok {
		binding.CreatedAt = existing.CreatedAt
		if strings.TrimSpace(binding.ProvisionStatus) == "" {
			binding.ProvisionStatus = existing.ProvisionStatus
		}
	}
	if binding.CreatedAt.IsZero() {
		binding.CreatedAt = now
	}
	binding.UpdatedAt = now
	binding = normalizeUserBinding(binding)
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := rejectDeletingTenantWriteTx(ctx, tx, binding.ExternalUserID); err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `
		INSERT INTO llmgateway_user_bindings (
			external_user_id, set_id, upstream_user_id, username, password, last_plan_id,
			last_extended_period_end, provision_status, last_provision_error, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON DUPLICATE KEY UPDATE
			set_id = VALUES(set_id),
			upstream_user_id = VALUES(upstream_user_id),
			username = VALUES(username),
			password = VALUES(password),
			last_plan_id = VALUES(last_plan_id),
			last_extended_period_end = VALUES(last_extended_period_end),
			provision_status = VALUES(provision_status),
			last_provision_error = VALUES(last_provision_error),
			updated_at = VALUES(updated_at)
	`, binding.ExternalUserID, binding.SetID, binding.UpstreamUserID, binding.Username, binding.Password,
		binding.LastPlanID, nullableTime(binding.LastExtendedPeriodEnd), binding.ProvisionStatus,
		binding.LastProvisionError, binding.CreatedAt, binding.UpdatedAt)
	if err != nil {
		return err
	}
	return tx.Commit()
}

func (s *MySQLStore) GetUserBinding(ctx context.Context, externalUserID string) (UserBinding, bool, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT external_user_id, set_id, upstream_user_id, username, password, last_plan_id,
			last_extended_period_end, provision_status, last_provision_error, created_at, updated_at
		FROM llmgateway_user_bindings WHERE external_user_id = ?
	`, externalUserID)
	binding, err := scanUserBinding(row)
	if errors.Is(err, sql.ErrNoRows) {
		return UserBinding{}, false, nil
	}
	if err != nil {
		return UserBinding{}, false, err
	}
	return binding, true, nil
}

func (s *MySQLStore) CountUserBindingsBySet(ctx context.Context) (map[string]int, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT set_id, COUNT(*)
		FROM llmgateway_user_bindings
		WHERE set_id <> ''
		GROUP BY set_id
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	counts := map[string]int{}
	for rows.Next() {
		var setID string
		var count int
		if err := rows.Scan(&setID, &count); err != nil {
			return nil, err
		}
		counts[setID] = count
	}
	return counts, rows.Err()
}

func (s *MySQLStore) ListTenants(ctx context.Context, opts TenantListOptions) (TenantListResult, error) {
	opts = normalizeTenantListOptions(opts)
	if err := validateTenantListOptions(opts); err != nil {
		return TenantListResult{}, err
	}
	if opts.Keyword != "" {
		return s.listTenantsBySearch(ctx, opts)
	}
	return s.listTenantInventory(ctx, opts)
}

func (s *MySQLStore) listTenantInventory(ctx context.Context, opts TenantListOptions) (TenantListResult, error) {
	whereSQL, args := tenantInventoryWhereSQL(opts)
	if opts.Cursor != "" {
		cursor, err := decodeTenantCursor(opts.Cursor, opts)
		if err != nil {
			return TenantListResult{}, err
		}
		updatedAt, err := cursor.inventoryUpdatedAt()
		if err != nil {
			return TenantListResult{}, err
		}
		whereSQL = appendTenantWhereClause(whereSQL, `(t.updated_at < ? OR (t.updated_at = ? AND t.external_user_id < ?))`)
		args = append(args, updatedAt, updatedAt, cursor.UserID)
	}
	items, err := s.queryTenantSummaries(ctx, whereSQL, args, `t.updated_at DESC, t.external_user_id DESC`, opts.Limit+1, opts.Offset)
	if err != nil {
		return TenantListResult{}, err
	}
	return s.finishTenantList(ctx, opts, items)
}

func (s *MySQLStore) listTenantsBySearch(ctx context.Context, opts TenantListOptions) (TenantListResult, error) {
	cursor := tenantListCursor{Phase: tenantSearchPhaseUserID}
	if opts.Cursor != "" {
		decoded, err := decodeTenantCursor(opts.Cursor, opts)
		if err != nil {
			return TenantListResult{}, err
		}
		cursor = decoded
	}

	desired := opts.Offset + opts.Limit + 1
	items := make([]TenantSummary, 0, desired)
	if cursor.Phase == tenantSearchPhaseUserID {
		userItems, err := s.queryTenantSearchUserIDPhase(ctx, opts, cursor.UserID, desired)
		if err != nil {
			return TenantListResult{}, err
		}
		items = append(items, userItems...)
	}
	if len(items) < desired {
		username := ""
		userID := ""
		if cursor.Phase == tenantSearchPhaseUsername {
			username = cursor.Username
			userID = cursor.UserID
		}
		usernameItems, err := s.queryTenantSearchUsernamePhase(ctx, opts, username, userID, desired-len(items))
		if err != nil {
			return TenantListResult{}, err
		}
		items = append(items, usernameItems...)
	}
	if opts.Offset > len(items) {
		items = nil
	} else if opts.Offset > 0 {
		items = items[opts.Offset:]
	}
	return s.finishTenantList(ctx, opts, items)
}

func (s *MySQLStore) queryTenantSearchUserIDPhase(ctx context.Context, opts TenantListOptions, afterUserID string, limit int) ([]TenantSummary, error) {
	predicate, args := tenantSearchPredicate("t.external_user_id", opts.Keyword)
	statusPredicate, statusArgs := tenantStatusPredicate(opts)
	whereSQL := " WHERE " + predicate + " AND " + statusPredicate
	args = append(args, statusArgs...)
	if afterUserID != "" {
		whereSQL += " AND t.external_user_id > ?"
		args = append(args, afterUserID)
	}
	return s.queryTenantSummaries(ctx, whereSQL, args, `t.external_user_id ASC`, limit, 0)
}

func (s *MySQLStore) queryTenantSearchUsernamePhase(ctx context.Context, opts TenantListOptions, afterUsername string, afterUserID string, limit int) ([]TenantSummary, error) {
	usernamePredicate, args := tenantSearchPredicate("b.username", opts.Keyword)
	userIDPredicate, userIDArgs := tenantSearchPredicate("t.external_user_id", opts.Keyword)
	statusPredicate, statusArgs := tenantStatusPredicate(opts)
	whereSQL := " WHERE " + usernamePredicate + " AND NOT (" + userIDPredicate + ") AND " + statusPredicate
	args = append(args, userIDArgs...)
	args = append(args, statusArgs...)
	if afterUsername != "" || afterUserID != "" {
		whereSQL += " AND (b.username > ? OR (b.username = ? AND t.external_user_id > ?))"
		args = append(args, afterUsername, afterUsername, afterUserID)
	}
	return s.queryTenantSummaries(ctx, whereSQL, args, `b.username ASC, t.external_user_id ASC`, limit, 0)
}

func (s *MySQLStore) queryTenantSummaries(ctx context.Context, whereSQL string, args []any, orderSQL string, limit int, offset int) ([]TenantSummary, error) {
	queryArgs := append([]any{}, args...)
	queryArgs = append(queryArgs, limit, offset)
	rows, err := s.db.QueryContext(ctx, tenantSummarySelectSQL()+tenantSummaryBaseSQL()+whereSQL+" ORDER BY "+orderSQL+" LIMIT ? OFFSET ?", queryArgs...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]TenantSummary, 0, limit)
	for rows.Next() {
		item, err := scanTenantSummary(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return items, nil
}

func (s *MySQLStore) finishTenantList(ctx context.Context, opts TenantListOptions, items []TenantSummary) (TenantListResult, error) {
	hasMore := len(items) > opts.Limit
	if hasMore {
		items = items[:opts.Limit]
	}
	if err := s.populateTenantKeyCounts(ctx, items); err != nil {
		return TenantListResult{}, err
	}
	total, err := s.countTenants(ctx, opts)
	if err != nil {
		return TenantListResult{}, err
	}
	nextCursor := ""
	if hasMore && len(items) > 0 {
		if opts.Keyword == "" {
			nextCursor = encodeTenantInventoryCursor(items[len(items)-1], opts)
		} else {
			nextCursor = encodeTenantSearchCursor(items[len(items)-1], opts)
		}
	}
	return TenantListResult{
		Items:      items,
		Total:      total,
		Limit:      opts.Limit,
		Offset:     opts.Offset,
		NextCursor: nextCursor,
		HasMore:    hasMore,
	}, nil
}

func (s *MySQLStore) populateTenantKeyCounts(ctx context.Context, items []TenantSummary) error {
	if len(items) == 0 {
		return nil
	}
	placeholders := make([]string, 0, len(items))
	args := make([]any, 0, len(items))
	for _, item := range items {
		placeholders = append(placeholders, "?")
		args = append(args, item.UserID)
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT user_id, COUNT(*)
		FROM llmgateway_api_key_bindings
		WHERE user_id IN (`+strings.Join(placeholders, ",")+`)
		GROUP BY user_id
	`, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	counts := make(map[string]int, len(items))
	for rows.Next() {
		var userID string
		var count int
		if err := rows.Scan(&userID, &count); err != nil {
			return err
		}
		counts[userID] = count
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for index := range items {
		items[index].KeyCount = counts[items[index].UserID]
	}
	return nil
}

func (s *MySQLStore) countTenants(ctx context.Context, opts TenantListOptions) (*int, error) {
	if !opts.IncludeTotal {
		return nil, nil
	}
	query := `SELECT COUNT(*) FROM llmgateway_tenants t`
	whereSQL := ""
	args := []any{}
	if opts.Keyword != "" {
		query += ` LEFT JOIN llmgateway_user_bindings b ON b.external_user_id = t.external_user_id`
		userIDPredicate, userIDArgs := tenantSearchPredicate("t.external_user_id", opts.Keyword)
		usernamePredicate, usernameArgs := tenantSearchPredicate("b.username", opts.Keyword)
		statusPredicate, statusArgs := tenantStatusPredicate(opts)
		whereSQL = " WHERE (" + userIDPredicate + " OR " + usernamePredicate + ") AND " + statusPredicate
		args = append(args, userIDArgs...)
		args = append(args, usernameArgs...)
		args = append(args, statusArgs...)
	} else {
		whereSQL, args = tenantInventoryWhereSQL(opts)
	}
	var total int
	if err := s.db.QueryRowContext(ctx, query+whereSQL, args...).Scan(&total); err != nil {
		return nil, err
	}
	return &total, nil
}

func (s *MySQLStore) GetTenantStatistics(ctx context.Context) (TenantStatistics, bool, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT total, new_total, pending_total, active_total, disabled_total, deleted_total,
			generated_at, updated_at
		FROM llmgateway_tenant_statistics
		WHERE id = 'global'
	`)
	var stats TenantStatistics
	var generatedAt sql.NullTime
	if err := row.Scan(
		&stats.Total,
		&stats.NewTotal,
		&stats.PendingTotal,
		&stats.ActiveTotal,
		&stats.DisabledTotal,
		&stats.DeletedTotal,
		&generatedAt,
		&stats.UpdatedAt,
	); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return TenantStatistics{}, false, nil
		}
		return TenantStatistics{}, false, err
	}
	if generatedAt.Valid {
		stats.GeneratedAt = generatedAt.Time.UTC()
	}
	stats.UpdatedAt = stats.UpdatedAt.UTC()
	return stats, true, nil
}

func (s *MySQLStore) RefreshTenantStatistics(ctx context.Context, jobName string, owner string, generatedAt time.Time) (bool, error) {
	jobName = strings.TrimSpace(jobName)
	owner = strings.TrimSpace(owner)
	if jobName == "" || owner == "" {
		return false, fmt.Errorf("tenant statistics job and owner are required")
	}
	if generatedAt.IsZero() {
		generatedAt = time.Now().UTC()
	}
	stats := TenantStatistics{GeneratedAt: generatedAt.UTC(), UpdatedAt: generatedAt.UTC()}
	rows, err := s.db.QueryContext(ctx, `
		SELECT backend, status, COUNT(*)
		FROM llmgateway_tenants FORCE INDEX (idx_llmgateway_tenants_backend_status)
		GROUP BY backend, status
	`)
	if err != nil {
		return false, err
	}
	for rows.Next() {
		var backend string
		var status string
		var count int64
		if err := rows.Scan(&backend, &status, &count); err != nil {
			_ = rows.Close()
			return false, err
		}
		if status == TenantStatusDeleted {
			stats.DeletedTotal += count
			continue
		}
		stats.Total += count
		switch backend {
		case UserBackendNew:
			stats.NewTotal += count
		case UserBackendPending:
			stats.PendingTotal += count
		}
		switch status {
		case TenantStatusActive:
			stats.ActiveTotal += count
		case TenantStatusDisabled:
			stats.DisabledTotal += count
		}
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return false, err
	}
	if err := rows.Close(); err != nil {
		return false, err
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	var leaseOwner string
	var status string
	var leaseCurrent bool
	if err := tx.QueryRowContext(ctx, `
		SELECT lease_owner, status, lease_until > UTC_TIMESTAMP(6)
		FROM llmgateway_worker_jobs
		WHERE name = ?
		FOR UPDATE
	`, jobName).Scan(&leaseOwner, &status, &leaseCurrent); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return false, nil
		}
		return false, err
	}
	if leaseOwner != owner || status != WorkerJobStatusRunning || !leaseCurrent {
		return false, nil
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO llmgateway_tenant_statistics (
			id, total, new_total, pending_total, active_total, disabled_total, deleted_total,
			generated_at, updated_at
		) VALUES ('global', ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6))
		ON DUPLICATE KEY UPDATE
			total = VALUES(total),
			new_total = VALUES(new_total),
			pending_total = VALUES(pending_total),
			active_total = VALUES(active_total),
			disabled_total = VALUES(disabled_total),
			deleted_total = VALUES(deleted_total),
			generated_at = VALUES(generated_at),
			updated_at = VALUES(updated_at)
	`, stats.Total, stats.NewTotal, stats.PendingTotal, stats.ActiveTotal, stats.DisabledTotal, stats.DeletedTotal, stats.GeneratedAt); err != nil {
		return false, err
	}
	if err := tx.Commit(); err != nil {
		return false, err
	}
	return true, nil
}

func (s *MySQLStore) SaveAPIKeyBinding(ctx context.Context, binding APIKeyBinding) error {
	if binding.ExternalKey == "" {
		return fmt.Errorf("external key is required")
	}
	if binding.ExternalKeyID == "" {
		binding.ExternalKeyID = "key-" + hashExternalKey(binding.ExternalKey)[:24]
	}
	lookup := parseTrafficRouteLookup(binding.ExternalKey)
	if lookup.Valid {
		binding.ExternalKeyID = lookup.ExternalKeyID
		binding.ExternalKeyHash = lookup.ExternalKeyHash
		binding.SecretHash = lookup.SecretHash
		binding.KeyVersion = lookup.Version
		binding.RouteSlot = lookup.RouteSlot
	}
	if binding.CreatedAt.IsZero() {
		binding.CreatedAt = time.Now().UTC()
	}
	if binding.UpdatedAt.IsZero() {
		binding.UpdatedAt = binding.CreatedAt
	}
	if binding.Status == "" {
		binding.Status = APIKeyStatusActive
	}
	hash := hashExternalKey(binding.ExternalKey)
	binding.ExternalKeyHash = hash
	return retryMySQLTransientLock(ctx, func() error {
		tx, err := s.db.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		defer tx.Rollback()
		if err := rejectDeletingTenantWriteTx(ctx, tx, binding.UserID); err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `
		INSERT INTO llmgateway_api_key_bindings (
			external_key_id, external_key, external_key_hash, secret_hash, key_version, route_slot,
			purpose, set_id, user_id, upstream_key, upstream_key_id, status, last_error, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, NULLIF(?, ''), ?, ?, ?, ?, ?, NULLIF(?, ''), ?, ?)
		ON DUPLICATE KEY UPDATE
			external_key_id = VALUES(external_key_id),
			external_key = VALUES(external_key),
			external_key_hash = VALUES(external_key_hash),
			secret_hash = VALUES(secret_hash),
			key_version = VALUES(key_version),
			route_slot = VALUES(route_slot),
			purpose = VALUES(purpose),
			set_id = VALUES(set_id),
			user_id = VALUES(user_id),
			upstream_key = VALUES(upstream_key),
			upstream_key_id = VALUES(upstream_key_id),
			status = VALUES(status),
			last_error = VALUES(last_error),
			created_at = VALUES(created_at),
			updated_at = VALUES(updated_at)
	`, binding.ExternalKeyID, binding.ExternalKey, hash, binding.SecretHash, binding.KeyVersion, binding.RouteSlot,
			binding.Purpose, binding.SetID, binding.UserID, binding.UpstreamKey, binding.UpstreamKeyID,
			binding.Status, binding.LastError, binding.CreatedAt, binding.UpdatedAt)
		if err != nil {
			return err
		}
		return tx.Commit()
	})
}

func (s *MySQLStore) ReserveAPIKeyBinding(ctx context.Context, binding APIKeyBinding) error {
	var err error
	binding, err = prepareAPIKeyReservation(binding)
	if err != nil {
		return err
	}
	if binding.CreatedAt.IsZero() {
		binding.CreatedAt = time.Now().UTC()
	}
	if binding.UpdatedAt.IsZero() {
		binding.UpdatedAt = binding.CreatedAt
	}
	return retryMySQLTransientLock(ctx, func() error {
		tx, err := s.db.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		defer tx.Rollback()
		if err := rejectDeletingTenantWriteTx(ctx, tx, binding.UserID); err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `
			INSERT INTO llmgateway_api_key_bindings (
				external_key_id, external_key, external_key_hash, secret_hash, key_version, route_slot,
				purpose, set_id, user_id, upstream_key, upstream_key_id, status, last_error, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, NULLIF(?, ''), ?, ?, '', 0, ?, NULL, ?, ?)
		`, binding.ExternalKeyID, binding.ExternalKey, binding.ExternalKeyHash, binding.SecretHash, binding.KeyVersion, binding.RouteSlot,
			binding.Purpose, binding.SetID, binding.UserID, APIKeyStatusReserved, binding.CreatedAt, binding.UpdatedAt)
		if err != nil {
			return classifyAPIKeyReservationError(err)
		}
		return tx.Commit()
	})
}

func (s *MySQLStore) TransitionAPIKeyBinding(ctx context.Context, keyID, expectedStatus, nextStatus, upstreamKey string, upstreamKeyID int, lastError string, updatedAt time.Time) (APIKeyBinding, error) {
	if updatedAt.IsZero() {
		updatedAt = time.Now().UTC()
	}
	result, err := s.db.ExecContext(ctx, `
		UPDATE llmgateway_api_key_bindings
		SET status = ?,
			upstream_key = CASE WHEN ? = '' THEN upstream_key ELSE ? END,
			upstream_key_id = CASE WHEN ? <= 0 THEN upstream_key_id ELSE ? END,
			last_error = NULLIF(?, ''),
			updated_at = ?
		WHERE external_key_id = ? AND status = ?
	`, nextStatus, upstreamKey, upstreamKey, upstreamKeyID, upstreamKeyID, lastError, updatedAt, keyID, expectedStatus)
	if err != nil {
		return APIKeyBinding{}, err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return APIKeyBinding{}, err
	}
	if affected != 1 {
		return APIKeyBinding{}, fmt.Errorf("%w: key=%s expected=%s", ErrAPIKeyStateConflict, keyID, expectedStatus)
	}
	binding, ok, err := s.GetAPIKeyBindingByExternalKeyID(ctx, keyID)
	if err != nil {
		return APIKeyBinding{}, err
	}
	if !ok {
		return APIKeyBinding{}, fmt.Errorf("external api key %q disappeared after transition", keyID)
	}
	return binding, nil
}

func (s *MySQLStore) ListAPIKeyBindingsByStatus(ctx context.Context, status string, limit int) ([]APIKeyBinding, error) {
	if limit <= 0 || limit > 1000 {
		limit = 100
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT external_key_id, external_key, external_key_hash, secret_hash, key_version, route_slot,
			purpose, set_id, user_id, upstream_key, upstream_key_id, status, last_error, created_at, updated_at
		FROM llmgateway_api_key_bindings
		WHERE status = ?
		ORDER BY updated_at, external_key_id
		LIMIT ?
	`, status, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	bindings := make([]APIKeyBinding, 0)
	for rows.Next() {
		binding, err := scanAPIKeyBinding(rows)
		if err != nil {
			return nil, err
		}
		bindings = append(bindings, binding)
	}
	return bindings, rows.Err()
}

func (s *MySQLStore) GetAPIKeyBindingByExternalKey(ctx context.Context, externalKey string) (APIKeyBinding, bool, error) {
	hash := hashExternalKey(externalKey)
	row := s.db.QueryRowContext(ctx, `
		SELECT external_key_id, external_key, external_key_hash, secret_hash, key_version, route_slot,
			purpose, set_id, user_id, upstream_key, upstream_key_id, status, last_error, created_at, updated_at
		FROM llmgateway_api_key_bindings WHERE external_key_hash = ? AND status = ?
	`, hash, APIKeyStatusActive)
	binding, err := scanAPIKeyBinding(row)
	if errors.Is(err, sql.ErrNoRows) {
		return APIKeyBinding{}, false, nil
	}
	if err != nil {
		return APIKeyBinding{}, false, err
	}
	binding.ExternalKey = externalKey
	binding.ExternalKeyHash = hash
	return binding, true, nil
}

func (s *MySQLStore) GetAPIKeyBindingByExternalKeyID(ctx context.Context, keyID string) (APIKeyBinding, bool, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT external_key_id, external_key, external_key_hash, secret_hash, key_version, route_slot,
			purpose, set_id, user_id, upstream_key, upstream_key_id, status, last_error, created_at, updated_at
		FROM llmgateway_api_key_bindings WHERE external_key_id = ?
	`, keyID)
	binding, err := scanAPIKeyBinding(row)
	if errors.Is(err, sql.ErrNoRows) {
		return APIKeyBinding{}, false, nil
	}
	if err != nil {
		return APIKeyBinding{}, false, err
	}
	return binding, true, nil
}

func (s *MySQLStore) DeleteAPIKeyBindingByExternalKeyID(ctx context.Context, keyID string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM llmgateway_api_key_bindings WHERE external_key_id = ?`, keyID)
	return err
}

func (s *MySQLStore) SaveUserLLMSettings(ctx context.Context, settings UserLLMSettings) error {
	if strings.TrimSpace(settings.ExternalUserID) == "" {
		return fmt.Errorf("external user id is required")
	}
	rawProviders, err := json.Marshal(settings.Providers)
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	if existing, ok, err := s.GetUserLLMSettings(ctx, settings.ExternalUserID); err != nil {
		return err
	} else if ok {
		settings.CreatedAt = existing.CreatedAt
	} else if settings.CreatedAt.IsZero() {
		settings.CreatedAt = now
	}
	settings.UpdatedAt = now
	var lastSyncedAt any
	if !settings.LastSyncedAt.IsZero() {
		lastSyncedAt = settings.LastSyncedAt.UTC()
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := rejectDeletingTenantWriteTx(ctx, tx, settings.ExternalUserID); err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `
		INSERT INTO llmgateway_user_llm_settings (
			external_user_id, routing_mode, byok_group, byok_upstream_key,
			byok_upstream_key_id, providers_json, last_synced_at, last_sync_error,
			created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON DUPLICATE KEY UPDATE
			routing_mode = VALUES(routing_mode),
			byok_group = VALUES(byok_group),
			byok_upstream_key = VALUES(byok_upstream_key),
			byok_upstream_key_id = VALUES(byok_upstream_key_id),
			providers_json = VALUES(providers_json),
			last_synced_at = VALUES(last_synced_at),
			last_sync_error = VALUES(last_sync_error),
			updated_at = VALUES(updated_at)
	`, settings.ExternalUserID, settings.Routing.Mode, settings.BYOKGroup, settings.BYOKUpstreamKey,
		settings.BYOKUpstreamKeyID, string(rawProviders), lastSyncedAt, settings.LastSyncError,
		settings.CreatedAt, settings.UpdatedAt)
	if err != nil {
		return err
	}
	return tx.Commit()
}

func (s *MySQLStore) GetUserLLMSettings(ctx context.Context, externalUserID string) (UserLLMSettings, bool, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT external_user_id, routing_mode, byok_group, byok_upstream_key,
			byok_upstream_key_id, providers_json, last_synced_at, last_sync_error,
			created_at, updated_at
		FROM llmgateway_user_llm_settings WHERE external_user_id = ?
	`, externalUserID)
	settings, err := scanUserLLMSettings(row)
	if errors.Is(err, sql.ErrNoRows) {
		return UserLLMSettings{}, false, nil
	}
	if err != nil {
		return UserLLMSettings{}, false, err
	}
	return settings, true, nil
}

func (s *MySQLStore) SavePlanMapping(ctx context.Context, plan PlanMapping) error {
	entitlement, err := normalizePlan(Plan{
		ID: plan.ID, Name: plan.Name, MonthlyTokens: plan.MonthlyTokens,
		PeriodValue: plan.PeriodValue, PeriodUnit: plan.PeriodUnit, IsActive: plan.IsActive,
	})
	if err != nil {
		return err
	}
	if err := s.SavePlan(ctx, entitlement); err != nil {
		return err
	}
	for setID, upstreamPlanID := range plan.UpstreamPlanIDs {
		if upstreamPlanID > 0 {
			if err := s.SaveSetPlan(ctx, SetPlan{PlanID: plan.ID, SetID: setID, UpstreamPlanID: upstreamPlanID, Status: SetPlanStatusReady, SyncedAt: time.Now().UTC()}); err != nil {
				return err
			}
		}
	}
	if plan.UpstreamPlanID > 0 && plan.SetID != "" {
		return s.SaveSetPlan(ctx, SetPlan{PlanID: plan.ID, SetID: plan.SetID, UpstreamPlanID: plan.UpstreamPlanID, Status: SetPlanStatusReady, SyncedAt: time.Now().UTC()})
	}
	return nil
}

func (s *MySQLStore) GetPlanMapping(ctx context.Context, id string) (PlanMapping, bool, error) {
	plan, ok, err := s.GetPlan(ctx, id)
	if err != nil || !ok {
		return PlanMapping{}, ok, err
	}
	states, err := s.ListSetPlans(ctx, SetPlanListOptions{PlanID: id})
	if err != nil {
		return PlanMapping{}, false, err
	}
	mapping := PlanMapping{
		ID: plan.ID, Name: plan.Name, MonthlyTokens: plan.MonthlyTokens,
		PeriodValue: plan.PeriodValue, PeriodUnit: plan.PeriodUnit, IsActive: plan.IsActive,
		UpstreamPlanIDs: map[string]int{}, CreatedAt: plan.CreatedAt, UpdatedAt: plan.UpdatedAt,
	}
	for _, state := range states {
		if state.Status == SetPlanStatusReady && state.UpstreamPlanID > 0 {
			mapping.UpstreamPlanIDs[state.SetID] = state.UpstreamPlanID
		}
	}
	return mapping, true, nil
}

func (s *MySQLStore) ListPlanMappings(ctx context.Context) ([]PlanMapping, error) {
	plans, err := s.ListPlans(ctx)
	if err != nil {
		return nil, err
	}
	mappings := make([]PlanMapping, 0, len(plans))
	for _, plan := range plans {
		mapping, _, err := s.GetPlanMapping(ctx, plan.ID)
		if err != nil {
			return nil, err
		}
		mappings = append(mappings, mapping)
	}
	return mappings, nil
}

func (s *MySQLStore) SavePlan(ctx context.Context, plan Plan) error {
	var err error
	plan, err = normalizePlan(plan)
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	if plan.CreatedAt.IsZero() {
		plan.CreatedAt = now
	}
	plan.UpdatedAt = now
	result, err := s.db.ExecContext(ctx, `
		INSERT IGNORE INTO llmgateway_plans (
			id, name, monthly_tokens, period_value, period_unit, is_active,
			fingerprint, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, plan.ID, plan.Name, plan.MonthlyTokens, plan.PeriodValue, plan.PeriodUnit,
		plan.IsActive, plan.Fingerprint, plan.CreatedAt, plan.UpdatedAt)
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil || affected > 0 {
		return err
	}
	existing, ok, err := s.GetPlan(ctx, plan.ID)
	if err != nil {
		return err
	}
	if !ok || existing.Fingerprint != plan.Fingerprint {
		return ErrPlanImmutableConflict
	}
	return nil
}

func (s *MySQLStore) GetPlan(ctx context.Context, id string) (Plan, bool, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT id, name, monthly_tokens, period_value, period_unit, is_active,
			fingerprint, created_at, updated_at
		FROM llmgateway_plans WHERE id = ?
	`, id)
	plan, err := scanPlan(row)
	if errors.Is(err, sql.ErrNoRows) {
		return Plan{}, false, nil
	}
	if err != nil {
		return Plan{}, false, err
	}
	return plan, true, nil
}

func (s *MySQLStore) ListPlans(ctx context.Context) ([]Plan, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, name, monthly_tokens, period_value, period_unit, is_active,
			fingerprint, created_at, updated_at
		FROM llmgateway_plans ORDER BY id
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	plans := make([]Plan, 0)
	for rows.Next() {
		plan, err := scanPlan(rows)
		if err != nil {
			return nil, err
		}
		plans = append(plans, plan)
	}
	return plans, rows.Err()
}

func (s *MySQLStore) SaveSetPlan(ctx context.Context, state SetPlan) error {
	if state.PlanID == "" || state.SetID == "" {
		return fmt.Errorf("plan id and set id are required")
	}
	now := time.Now().UTC()
	if state.CreatedAt.IsZero() {
		state.CreatedAt = now
	}
	if state.Status == "" {
		state.Status = SetPlanStatusPending
	}
	state.UpdatedAt = now
	var syncedAt any
	if !state.SyncedAt.IsZero() {
		syncedAt = state.SyncedAt.UTC()
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO llmgateway_set_plans (
			plan_id, set_id, upstream_plan_id, status, attempts, last_error,
			synced_at, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON DUPLICATE KEY UPDATE
			upstream_plan_id = VALUES(upstream_plan_id),
			status = VALUES(status),
			attempts = VALUES(attempts),
			last_error = VALUES(last_error),
			synced_at = VALUES(synced_at),
			updated_at = VALUES(updated_at)
	`, state.PlanID, state.SetID, state.UpstreamPlanID, state.Status, state.Attempts,
		state.LastError, syncedAt, state.CreatedAt, state.UpdatedAt)
	return err
}

func (s *MySQLStore) GetSetPlan(ctx context.Context, planID string, setID string) (SetPlan, bool, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT plan_id, set_id, upstream_plan_id, status, attempts, last_error,
			synced_at, created_at, updated_at
		FROM llmgateway_set_plans WHERE plan_id = ? AND set_id = ?
	`, planID, setID)
	state, err := scanSetPlan(row)
	if errors.Is(err, sql.ErrNoRows) {
		return SetPlan{}, false, nil
	}
	if err != nil {
		return SetPlan{}, false, err
	}
	return state, true, nil
}

func (s *MySQLStore) ListSetPlans(ctx context.Context, options SetPlanListOptions) ([]SetPlan, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT plan_id, set_id, upstream_plan_id, status, attempts, last_error,
			synced_at, created_at, updated_at
		FROM llmgateway_set_plans ORDER BY plan_id, set_id
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	allowed := make(map[string]struct{}, len(options.Statuses))
	for _, status := range options.Statuses {
		allowed[status] = struct{}{}
	}
	states := make([]SetPlan, 0)
	for rows.Next() {
		state, err := scanSetPlan(rows)
		if err != nil {
			return nil, err
		}
		if options.PlanID != "" && state.PlanID != options.PlanID {
			continue
		}
		if options.SetID != "" && state.SetID != options.SetID {
			continue
		}
		if len(allowed) > 0 {
			if _, ok := allowed[state.Status]; !ok {
				continue
			}
		}
		states = append(states, state)
		if options.Limit > 0 && len(states) >= options.Limit {
			break
		}
	}
	return states, rows.Err()
}

func (s *MySQLStore) SavePlanPeriod(ctx context.Context, period PlanPeriod) error {
	period, err := normalizePlanPeriod(period)
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	if period.CreatedAt.IsZero() {
		period.CreatedAt = now
	}
	period.UpdatedAt = now
	_, err = s.db.ExecContext(ctx, `
		INSERT INTO llmgateway_plan_periods (plan_id, period_value, period_unit, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?)
		ON DUPLICATE KEY UPDATE updated_at = VALUES(updated_at)
	`, period.PlanID, period.PeriodValue, period.PeriodUnit, period.CreatedAt, period.UpdatedAt)
	return err
}

func (s *MySQLStore) GetPlanPeriod(ctx context.Context, planID string, periodValue int, periodUnit string) (PlanPeriod, bool, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT plan_id, period_value, period_unit, created_at, updated_at
		FROM llmgateway_plan_periods WHERE plan_id = ? AND period_value = ? AND period_unit = ?
	`, strings.TrimSpace(planID), periodValue, normalizePeriodUnit(periodUnit))
	var period PlanPeriod
	err := row.Scan(&period.PlanID, &period.PeriodValue, &period.PeriodUnit, &period.CreatedAt, &period.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return PlanPeriod{}, false, nil
	}
	return period, err == nil, err
}

func (s *MySQLStore) ListPlanPeriods(ctx context.Context, planID string) ([]PlanPeriod, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT plan_id, period_value, period_unit, created_at, updated_at
		FROM llmgateway_plan_periods ORDER BY plan_id, period_unit, period_value
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	periods := make([]PlanPeriod, 0)
	for rows.Next() {
		var period PlanPeriod
		if err := rows.Scan(&period.PlanID, &period.PeriodValue, &period.PeriodUnit, &period.CreatedAt, &period.UpdatedAt); err != nil {
			return nil, err
		}
		if planID == "" || period.PlanID == planID {
			periods = append(periods, period)
		}
	}
	return periods, rows.Err()
}

func (s *MySQLStore) SaveSetPlanPeriod(ctx context.Context, state SetPlanPeriod) error {
	period, err := normalizePlanPeriod(PlanPeriod{PlanID: state.PlanID, PeriodValue: state.PeriodValue, PeriodUnit: state.PeriodUnit})
	if err != nil || strings.TrimSpace(state.SetID) == "" {
		return fmt.Errorf("plan id, positive period, and set id are required")
	}
	state.PlanID, state.PeriodValue, state.PeriodUnit = period.PlanID, period.PeriodValue, period.PeriodUnit
	now := time.Now().UTC()
	if state.CreatedAt.IsZero() {
		state.CreatedAt = now
	}
	if state.Status == "" {
		state.Status = SetPlanStatusPending
	}
	state.UpdatedAt = now
	var syncedAt any
	if !state.SyncedAt.IsZero() {
		syncedAt = state.SyncedAt.UTC()
	}
	_, err = s.db.ExecContext(ctx, `
		INSERT INTO llmgateway_set_plan_periods (
			plan_id, period_value, period_unit, set_id, upstream_plan_id, status,
			attempts, last_error, synced_at, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON DUPLICATE KEY UPDATE upstream_plan_id=VALUES(upstream_plan_id), status=VALUES(status),
			attempts=VALUES(attempts), last_error=VALUES(last_error), synced_at=VALUES(synced_at), updated_at=VALUES(updated_at)
	`, state.PlanID, state.PeriodValue, state.PeriodUnit, state.SetID, state.UpstreamPlanID,
		state.Status, state.Attempts, state.LastError, syncedAt, state.CreatedAt, state.UpdatedAt)
	return err
}

func (s *MySQLStore) GetSetPlanPeriod(ctx context.Context, planID string, periodValue int, periodUnit string, setID string) (SetPlanPeriod, bool, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT plan_id, period_value, period_unit, set_id, upstream_plan_id, status,
			attempts, last_error, synced_at, created_at, updated_at
		FROM llmgateway_set_plan_periods
		WHERE plan_id=? AND period_value=? AND period_unit=? AND set_id=?
	`, strings.TrimSpace(planID), periodValue, normalizePeriodUnit(periodUnit), strings.TrimSpace(setID))
	state, err := scanSetPlanPeriod(row)
	if errors.Is(err, sql.ErrNoRows) {
		return SetPlanPeriod{}, false, nil
	}
	return state, err == nil, err
}

func (s *MySQLStore) ListSetPlanPeriods(ctx context.Context, options SetPlanPeriodListOptions) ([]SetPlanPeriod, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT plan_id, period_value, period_unit, set_id, upstream_plan_id, status,
			attempts, last_error, synced_at, created_at, updated_at
		FROM llmgateway_set_plan_periods ORDER BY plan_id, period_unit, period_value, set_id
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	allowed := map[string]struct{}{}
	for _, status := range options.Statuses {
		allowed[status] = struct{}{}
	}
	states := make([]SetPlanPeriod, 0)
	for rows.Next() {
		state, err := scanSetPlanPeriod(rows)
		if err != nil {
			return nil, err
		}
		if options.PlanID != "" && state.PlanID != options.PlanID {
			continue
		}
		if options.SetID != "" && state.SetID != options.SetID {
			continue
		}
		if len(allowed) > 0 {
			if _, ok := allowed[state.Status]; !ok {
				continue
			}
		}
		states = append(states, state)
		if options.Limit > 0 && len(states) >= options.Limit {
			break
		}
	}
	return states, rows.Err()
}

func (s *MySQLStore) SaveSubscriptionPeriodOverlay(ctx context.Context, overlay SubscriptionPeriodOverlay) error {
	if overlay.ExternalUserID == "" {
		return fmt.Errorf("external user id is required")
	}
	now := time.Now().UTC()
	if overlay.CreatedAt.IsZero() {
		overlay.CreatedAt = now
	}
	overlay.UpdatedAt = now
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := rejectDeletingTenantWriteTx(ctx, tx, overlay.ExternalUserID); err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `
		INSERT INTO llmgateway_subscription_period_overlays (
			external_user_id, set_id, period_end, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?)
		ON DUPLICATE KEY UPDATE
			set_id = VALUES(set_id),
			period_end = VALUES(period_end),
			updated_at = VALUES(updated_at)
	`, overlay.ExternalUserID, overlay.SetID, overlay.PeriodEnd.UTC(), overlay.CreatedAt, overlay.UpdatedAt)
	if err != nil {
		return err
	}
	return tx.Commit()
}

func (s *MySQLStore) GetSubscriptionPeriodOverlay(ctx context.Context, externalUserID string) (SubscriptionPeriodOverlay, bool, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT external_user_id, set_id, period_end, created_at, updated_at
		FROM llmgateway_subscription_period_overlays WHERE external_user_id = ?
	`, externalUserID)
	overlay, err := scanSubscriptionPeriodOverlay(row)
	if errors.Is(err, sql.ErrNoRows) {
		return SubscriptionPeriodOverlay{}, false, nil
	}
	if err != nil {
		return SubscriptionPeriodOverlay{}, false, err
	}
	return overlay, true, nil
}

func (s *MySQLStore) DeleteSubscriptionPeriodOverlay(ctx context.Context, externalUserID string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM llmgateway_subscription_period_overlays WHERE external_user_id = ?`, externalUserID)
	return err
}

func (s *MySQLStore) SaveUserAssignment(ctx context.Context, assignment UserAssignment) error {
	assignment.ExternalUserID = strings.TrimSpace(assignment.ExternalUserID)
	assignment.Backend = strings.TrimSpace(strings.ToLower(assignment.Backend))
	assignment.SetID = strings.TrimSpace(assignment.SetID)
	now := time.Now().UTC()
	if assignment.CreatedAt.IsZero() {
		assignment.CreatedAt = now
	}
	assignment.UpdatedAt = now
	tenant, err := normalizeTenant(Tenant{
		ExternalUserID: assignment.ExternalUserID,
		Backend:        assignment.Backend,
		SetID:          assignment.SetID,
		Status:         TenantStatusActive,
		Source:         "assignment",
		CreatedAt:      assignment.CreatedAt,
		UpdatedAt:      assignment.UpdatedAt,
	})
	if err != nil {
		return err
	}
	if existing, ok, err := s.GetTenant(ctx, tenant.ExternalUserID); err != nil {
		return err
	} else if ok {
		tenant.CreatedAt = existing.CreatedAt
		if existing.Status != "" {
			tenant.Status = existing.Status
		}
		tenant.Source = firstNonEmpty(existing.Source, tenant.Source)
		tenant.DisplayName = existing.DisplayName
	}
	assignment.Backend = tenant.Backend
	assignment.SetID = tenant.SetID
	return retryMySQLTransientLock(ctx, func() error {
		tx, err := s.db.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		defer tx.Rollback()
		if err := rejectDeletingTenantWriteTx(ctx, tx, assignment.ExternalUserID); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, `
				INSERT INTO llmgateway_user_assignments (
				external_user_id, backend, set_id, migrated_at, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?)
			ON DUPLICATE KEY UPDATE
				backend = VALUES(backend),
				set_id = VALUES(set_id),
				migrated_at = VALUES(migrated_at),
				updated_at = VALUES(updated_at)
			`, assignment.ExternalUserID, assignment.Backend, assignment.SetID, nullableTime(assignment.MigratedAt), assignment.CreatedAt, assignment.UpdatedAt); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, `
				INSERT INTO llmgateway_tenants (
					external_user_id, backend, set_id, status, source, display_name, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				ON DUPLICATE KEY UPDATE
					backend = VALUES(backend),
					set_id = VALUES(set_id),
					status = VALUES(status),
					source = VALUES(source),
					display_name = VALUES(display_name),
					updated_at = VALUES(updated_at)
			`, tenant.ExternalUserID, tenant.Backend, tenant.SetID, tenant.Status, tenant.Source, tenant.DisplayName, tenant.CreatedAt, tenant.UpdatedAt); err != nil {
			return err
		}
		return tx.Commit()
	})
}

func (s *MySQLStore) GetUserAssignment(ctx context.Context, externalUserID string) (UserAssignment, bool, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT external_user_id, backend, set_id, migrated_at, created_at, updated_at
		FROM llmgateway_user_assignments WHERE external_user_id = ?
	`, externalUserID)
	assignment, err := scanUserAssignment(row)
	if errors.Is(err, sql.ErrNoRows) {
		return UserAssignment{}, false, nil
	}
	if err != nil {
		return UserAssignment{}, false, err
	}
	return assignment, true, nil
}

func (s *MySQLStore) SaveTenantObservation(ctx context.Context, observation TenantObservation) error {
	if observation.ExternalUserID == "" {
		return fmt.Errorf("external user id is required")
	}
	now := time.Now().UTC()
	if existing, ok, err := s.GetTenantObservation(ctx, observation.ExternalUserID); err != nil {
		return err
	} else if ok {
		observation.CreatedAt = existing.CreatedAt
	} else if observation.CreatedAt.IsZero() {
		observation.CreatedAt = now
	}
	if observation.ObservedAt.IsZero() {
		observation.ObservedAt = now
	}
	observation.UpdatedAt = now
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := rejectDeletingTenantWriteTx(ctx, tx, observation.ExternalUserID); err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `
		INSERT INTO llmgateway_tenant_observations (
			external_user_id, backend, set_id, upstream_user_id, username, current_plan_id,
			last_applied_plan_id, subscription_status, has_active_subscription, token_balance,
			credit_available, credit_status, credit_error, unlimited, period_start, period_end,
			source, observed_at, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON DUPLICATE KEY UPDATE
			backend = VALUES(backend),
			set_id = VALUES(set_id),
			upstream_user_id = VALUES(upstream_user_id),
			username = VALUES(username),
			current_plan_id = VALUES(current_plan_id),
			last_applied_plan_id = VALUES(last_applied_plan_id),
			subscription_status = VALUES(subscription_status),
			has_active_subscription = VALUES(has_active_subscription),
			token_balance = VALUES(token_balance),
			credit_available = VALUES(credit_available),
			credit_status = VALUES(credit_status),
			credit_error = VALUES(credit_error),
			unlimited = VALUES(unlimited),
			period_start = VALUES(period_start),
			period_end = VALUES(period_end),
			source = VALUES(source),
			observed_at = VALUES(observed_at),
			updated_at = VALUES(updated_at)
	`, observation.ExternalUserID, observation.Backend, observation.SetID, observation.UpstreamUserID,
		observation.Username, observation.CurrentPlanID, observation.LastAppliedPlanID, observation.SubscriptionStatus,
		observation.HasActiveSubscription, observation.TokenBalance, observation.CreditAvailable, observation.CreditStatus,
		observation.CreditError, observation.Unlimited, observation.PeriodStart, observation.PeriodEnd, observation.Source,
		observation.ObservedAt.UTC(), observation.CreatedAt, observation.UpdatedAt)
	if err != nil {
		return err
	}
	return tx.Commit()
}

func (s *MySQLStore) GetTenantObservation(ctx context.Context, externalUserID string) (TenantObservation, bool, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT external_user_id, backend, set_id, upstream_user_id, username, current_plan_id,
			last_applied_plan_id, subscription_status, has_active_subscription, token_balance,
			credit_available, credit_status, credit_error, unlimited, period_start, period_end,
			source, observed_at, created_at, updated_at
		FROM llmgateway_tenant_observations WHERE external_user_id = ?
	`, externalUserID)
	observation, err := scanTenantObservation(row)
	if errors.Is(err, sql.ErrNoRows) {
		return TenantObservation{}, false, nil
	}
	if err != nil {
		return TenantObservation{}, false, err
	}
	return observation, true, nil
}

func (s *MySQLStore) SaveChannelSpec(ctx context.Context, spec ChannelSpec) error {
	if spec.ID == "" {
		return fmt.Errorf("channel id is required")
	}
	now := time.Now().UTC()
	if existing, ok, err := s.GetChannelSpec(ctx, spec.ID); err != nil {
		return err
	} else if ok {
		spec.CreatedAt = existing.CreatedAt
	} else if spec.CreatedAt.IsZero() {
		spec.CreatedAt = now
	}
	spec.UpdatedAt = now
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO llmgateway_channel_specs (
			id, name, type, provider_key, key_hash, base_url, models, group_name,
			model_mapping, priority, weight, status, setting, param_override,
			header_override, remark, auto_ban, tag, other_value, status_code_mapping,
			other_settings, openai_organization, test_model, is_multi_key, multi_key_mode,
			fingerprint, desired_remote_name, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON DUPLICATE KEY UPDATE
			name = VALUES(name),
			type = VALUES(type),
			provider_key = VALUES(provider_key),
			key_hash = VALUES(key_hash),
			base_url = VALUES(base_url),
			models = VALUES(models),
			group_name = VALUES(group_name),
			model_mapping = VALUES(model_mapping),
			priority = VALUES(priority),
			weight = VALUES(weight),
			status = VALUES(status),
			setting = VALUES(setting),
			param_override = VALUES(param_override),
			header_override = VALUES(header_override),
			remark = VALUES(remark),
			auto_ban = VALUES(auto_ban),
			tag = VALUES(tag),
			other_value = VALUES(other_value),
			status_code_mapping = VALUES(status_code_mapping),
			other_settings = VALUES(other_settings),
			openai_organization = VALUES(openai_organization),
			test_model = VALUES(test_model),
			is_multi_key = VALUES(is_multi_key),
			multi_key_mode = VALUES(multi_key_mode),
			fingerprint = VALUES(fingerprint),
			desired_remote_name = VALUES(desired_remote_name),
			updated_at = VALUES(updated_at)
	`, spec.ID, spec.Name, spec.Type, spec.Key, spec.KeyHash, spec.BaseURL, spec.Models, spec.Group,
		spec.ModelMapping, spec.Priority, spec.Weight, spec.Status, spec.Setting, spec.ParamOverride,
		spec.HeaderOverride, spec.Remark, spec.AutoBan, spec.Tag, spec.Other, spec.StatusCodeMapping,
		spec.OtherSettings, spec.OpenAIOrganization, spec.TestModel, spec.IsMultiKey, spec.MultiKeyMode,
		spec.Fingerprint, spec.DesiredRemoteName, spec.CreatedAt, spec.UpdatedAt)
	return err
}

func (s *MySQLStore) GetChannelSpec(ctx context.Context, id string) (ChannelSpec, bool, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT id, name, type, provider_key, key_hash, base_url, models, group_name,
			model_mapping, priority, weight, status, setting, param_override,
			header_override, remark, auto_ban, tag, other_value, status_code_mapping,
			other_settings, openai_organization, test_model, is_multi_key, multi_key_mode,
			fingerprint, desired_remote_name, created_at, updated_at
		FROM llmgateway_channel_specs WHERE id = ?
	`, id)
	spec, err := scanChannelSpec(row)
	if errors.Is(err, sql.ErrNoRows) {
		return ChannelSpec{}, false, nil
	}
	if err != nil {
		return ChannelSpec{}, false, err
	}
	return spec, true, nil
}

func (s *MySQLStore) ListChannelSpecs(ctx context.Context) ([]ChannelSpec, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, name, type, provider_key, key_hash, base_url, models, group_name,
			model_mapping, priority, weight, status, setting, param_override,
			header_override, remark, auto_ban, tag, other_value, status_code_mapping,
			other_settings, openai_organization, test_model, is_multi_key, multi_key_mode,
			fingerprint, desired_remote_name, created_at, updated_at
		FROM llmgateway_channel_specs ORDER BY id
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var specs []ChannelSpec
	for rows.Next() {
		spec, err := scanChannelSpec(rows)
		if err != nil {
			return nil, err
		}
		specs = append(specs, spec)
	}
	return specs, rows.Err()
}

func (s *MySQLStore) SaveChannelSyncState(ctx context.Context, state ChannelSyncState) error {
	if state.ChannelID == "" || state.SetID == "" {
		return fmt.Errorf("channel id and set id are required")
	}
	now := time.Now().UTC()
	if existing, ok, err := s.GetChannelSyncState(ctx, state.ChannelID, state.SetID); err != nil {
		return err
	} else if ok {
		state.CreatedAt = existing.CreatedAt
	} else if state.CreatedAt.IsZero() {
		state.CreatedAt = now
	}
	state.UpdatedAt = now
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO llmgateway_channel_sync_states (
			channel_id, set_id, remote_channel_id, status, last_error, desired_fingerprint,
			applied_fingerprint, remote_fingerprint, last_applied_key_hash,
			last_synced_at, last_checked_at, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON DUPLICATE KEY UPDATE
			remote_channel_id = VALUES(remote_channel_id),
			status = VALUES(status),
			last_error = VALUES(last_error),
			desired_fingerprint = VALUES(desired_fingerprint),
			applied_fingerprint = VALUES(applied_fingerprint),
			remote_fingerprint = VALUES(remote_fingerprint),
			last_applied_key_hash = VALUES(last_applied_key_hash),
			last_synced_at = VALUES(last_synced_at),
			last_checked_at = VALUES(last_checked_at),
			updated_at = VALUES(updated_at)
	`, state.ChannelID, state.SetID, state.RemoteChannelID, state.Status, state.LastError, state.DesiredFingerprint,
		state.AppliedFingerprint, state.RemoteFingerprint, state.LastAppliedKeyHash,
		nullableTime(state.LastSyncedAt), nullableTime(state.LastCheckedAt), state.CreatedAt, state.UpdatedAt)
	return err
}

func (s *MySQLStore) GetChannelSyncState(ctx context.Context, channelID string, setID string) (ChannelSyncState, bool, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT channel_id, set_id, remote_channel_id, status, last_error, desired_fingerprint,
			applied_fingerprint, remote_fingerprint, last_applied_key_hash,
			last_synced_at, last_checked_at, created_at, updated_at
		FROM llmgateway_channel_sync_states WHERE channel_id = ? AND set_id = ?
	`, channelID, setID)
	state, err := scanChannelSyncState(row)
	if errors.Is(err, sql.ErrNoRows) {
		return ChannelSyncState{}, false, nil
	}
	if err != nil {
		return ChannelSyncState{}, false, err
	}
	return state, true, nil
}

func (s *MySQLStore) ListChannelSyncStates(ctx context.Context, channelID string) ([]ChannelSyncState, error) {
	query := `
		SELECT channel_id, set_id, remote_channel_id, status, last_error, desired_fingerprint,
			applied_fingerprint, remote_fingerprint, last_applied_key_hash,
			last_synced_at, last_checked_at, created_at, updated_at
		FROM llmgateway_channel_sync_states`
	args := []any{}
	if channelID != "" {
		query += ` WHERE channel_id = ?`
		args = append(args, channelID)
	}
	query += ` ORDER BY channel_id, set_id`
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var states []ChannelSyncState
	for rows.Next() {
		state, err := scanChannelSyncState(rows)
		if err != nil {
			return nil, err
		}
		states = append(states, state)
	}
	return states, rows.Err()
}

func (s *MySQLStore) SaveChannelBundle(ctx context.Context, bundle ChannelBundle) error {
	if bundle.ID == "" {
		return fmt.Errorf("channel bundle id is required")
	}
	specJSON, err := marshalChannelBundleSpecForStorage(bundle.Spec)
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	if existing, ok, err := s.GetChannelBundle(ctx, bundle.ID); err != nil {
		return err
	} else if ok {
		bundle.CreatedAt = existing.CreatedAt
	} else if bundle.CreatedAt.IsZero() {
		bundle.CreatedAt = now
	}
	bundle.UpdatedAt = now
	_, err = s.db.ExecContext(ctx, `
		INSERT INTO llmgateway_channel_bundles (
			id, name, description, source_set_id, spec_json, fingerprint, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON DUPLICATE KEY UPDATE
			name = VALUES(name),
			description = VALUES(description),
			source_set_id = VALUES(source_set_id),
			spec_json = VALUES(spec_json),
			fingerprint = VALUES(fingerprint),
			updated_at = VALUES(updated_at)
	`, bundle.ID, bundle.Name, bundle.Description, bundle.SourceSetID, specJSON, bundle.Fingerprint, bundle.CreatedAt, bundle.UpdatedAt)
	return err
}

func (s *MySQLStore) GetChannelBundle(ctx context.Context, id string) (ChannelBundle, bool, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT id, name, description, source_set_id, spec_json, fingerprint, created_at, updated_at
		FROM llmgateway_channel_bundles WHERE id = ?
	`, id)
	bundle, err := scanChannelBundle(row)
	if errors.Is(err, sql.ErrNoRows) {
		return ChannelBundle{}, false, nil
	}
	if err != nil {
		return ChannelBundle{}, false, err
	}
	return bundle, true, nil
}

func (s *MySQLStore) ListChannelBundles(ctx context.Context) ([]ChannelBundle, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, name, description, source_set_id, spec_json, fingerprint, created_at, updated_at
		FROM llmgateway_channel_bundles ORDER BY id
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	bundles := make([]ChannelBundle, 0)
	for rows.Next() {
		bundle, err := scanChannelBundle(rows)
		if err != nil {
			return nil, err
		}
		bundles = append(bundles, bundle)
	}
	return bundles, rows.Err()
}

func (s *MySQLStore) SaveChannelBundleSyncState(ctx context.Context, state ChannelBundleSyncState) error {
	if state.BundleID == "" || state.SetID == "" {
		return fmt.Errorf("channel bundle id and set id are required")
	}
	now := time.Now().UTC()
	if existing, ok, err := s.GetChannelBundleSyncState(ctx, state.BundleID, state.SetID); err != nil {
		return err
	} else if ok {
		state.CreatedAt = existing.CreatedAt
	} else if state.CreatedAt.IsZero() {
		state.CreatedAt = now
	}
	state.UpdatedAt = now
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO llmgateway_channel_bundle_sync_states (
			bundle_id, set_id, status, last_error, desired_fingerprint, actual_fingerprint,
			applied_fingerprint, diff_json, remote_resources_json,
			last_synced_at, last_checked_at, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON DUPLICATE KEY UPDATE
			status = VALUES(status),
			last_error = VALUES(last_error),
			desired_fingerprint = VALUES(desired_fingerprint),
			actual_fingerprint = VALUES(actual_fingerprint),
			applied_fingerprint = VALUES(applied_fingerprint),
			diff_json = VALUES(diff_json),
			remote_resources_json = VALUES(remote_resources_json),
			last_synced_at = VALUES(last_synced_at),
			last_checked_at = VALUES(last_checked_at),
			updated_at = VALUES(updated_at)
	`, state.BundleID, state.SetID, state.Status, state.LastError, state.DesiredFingerprint, state.ActualFingerprint,
		state.AppliedFingerprint, state.DiffJSON, state.RemoteResourcesJSON,
		nullableTime(state.LastSyncedAt), nullableTime(state.LastCheckedAt), state.CreatedAt, state.UpdatedAt)
	return err
}

func (s *MySQLStore) GetChannelBundleSyncState(ctx context.Context, bundleID string, setID string) (ChannelBundleSyncState, bool, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT bundle_id, set_id, status, last_error, desired_fingerprint, actual_fingerprint,
			applied_fingerprint, diff_json, remote_resources_json,
			last_synced_at, last_checked_at, created_at, updated_at
		FROM llmgateway_channel_bundle_sync_states WHERE bundle_id = ? AND set_id = ?
	`, bundleID, setID)
	state, err := scanChannelBundleSyncState(row)
	if errors.Is(err, sql.ErrNoRows) {
		return ChannelBundleSyncState{}, false, nil
	}
	if err != nil {
		return ChannelBundleSyncState{}, false, err
	}
	return state, true, nil
}

func (s *MySQLStore) ListChannelBundleSyncStates(ctx context.Context, bundleID string) ([]ChannelBundleSyncState, error) {
	query := `
		SELECT bundle_id, set_id, status, last_error, desired_fingerprint, actual_fingerprint,
			applied_fingerprint, diff_json, remote_resources_json,
			last_synced_at, last_checked_at, created_at, updated_at
		FROM llmgateway_channel_bundle_sync_states`
	args := []any{}
	if bundleID != "" {
		query += ` WHERE bundle_id = ?`
		args = append(args, bundleID)
	}
	query += ` ORDER BY bundle_id, set_id`
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	states := make([]ChannelBundleSyncState, 0)
	for rows.Next() {
		state, err := scanChannelBundleSyncState(rows)
		if err != nil {
			return nil, err
		}
		states = append(states, state)
	}
	return states, rows.Err()
}

type scanner interface {
	Scan(dest ...any) error
}

func scanSet(row scanner) (Set, error) {
	var set Set
	var capacityUpdatedAt sql.NullTime
	var adminHealthCheckedAt sql.NullTime
	var adminHealthLastSuccessAt sql.NullTime
	var adminWritesPauseReason sql.NullString
	var adminWritesPausedAt sql.NullTime
	var admissionCheckedAt sql.NullTime
	var adminImage sql.NullString
	err := row.Scan(&set.ID, &set.Name, &set.BaseURL, &set.TrafficBaseURL, &set.Status, &set.Setup, &set.AdminUserID, &set.AdminUsername,
		&set.AdminRole, &set.AdminStatus, &set.AdminGroup, &set.AdminAccessToken, &set.AdminTOTPSecret,
		&set.MaxUsers, &set.WarnUsers, &set.ReservedUsers, &set.ObservedUserCount, &capacityUpdatedAt,
		&set.ShardID, &set.NewAPIReplicas, &set.SQLMaxOpenConns, &set.SQLMaxIdleConns, &set.SQLMaxLifetimeSeconds,
		&set.TrafficSQLMaxOpenConns, &set.TrafficSQLMaxIdleConns, &set.TrafficSQLMaxLifetimeSeconds,
		&set.SubscriptionWriteConcurrency,
		&set.AdminHealthStatus, &set.AdminHealthConsecutiveFailures, &set.AdminHealthError,
		&adminHealthCheckedAt, &adminHealthLastSuccessAt,
		&set.AdminWritesPaused, &adminWritesPauseReason, &adminWritesPausedAt,
		&set.AdmissionStatus, &set.AdmissionError, &admissionCheckedAt, &set.LifecycleGeneration,
		&adminImage, &set.ReleaseRingID, &set.CurrentReleaseID, &set.TargetReleaseID,
		&set.ActiveRuntimeGeneration, &set.RouteRevision, &set.CreatedAt, &set.UpdatedAt)
	set.AdminWritesPauseReason = adminWritesPauseReason.String
	set.AdminImage = adminImage.String
	if capacityUpdatedAt.Valid {
		set.CapacityUpdatedAt = capacityUpdatedAt.Time.UTC()
	}
	if admissionCheckedAt.Valid {
		set.AdmissionCheckedAt = admissionCheckedAt.Time.UTC()
	}
	if adminHealthCheckedAt.Valid {
		set.AdminHealthCheckedAt = adminHealthCheckedAt.Time.UTC()
	}
	if adminHealthLastSuccessAt.Valid {
		set.AdminHealthLastSuccessAt = adminHealthLastSuccessAt.Time.UTC()
	}
	if adminWritesPausedAt.Valid {
		set.AdminWritesPausedAt = adminWritesPausedAt.Time.UTC()
	}
	return set, err
}

func scanShard(row scanner) (Shard, error) {
	var shard Shard
	err := row.Scan(
		&shard.ID,
		&shard.Name,
		&shard.Kind,
		&shard.Endpoint,
		&shard.RedisEndpoint,
		&shard.SecretName,
		&shard.RedisDBStart,
		&shard.RedisDBLimit,
		&shard.Status,
		&shard.MaxConnections,
		&shard.ReservedConnections,
		&shard.WarnRatio,
		&shard.CriticalRatio,
		&shard.MaxSets,
		&shard.AdminSQLMaxOpenConns,
		&shard.AdminSQLMaxIdleConns,
		&shard.AdminSQLMaxLifetimeSeconds,
		&shard.TrafficSQLMaxOpenConns,
		&shard.TrafficSQLMaxIdleConns,
		&shard.TrafficSQLMaxLifetimeSeconds,
		&shard.SubscriptionWriteConcurrency,
		&shard.CreatedAt,
		&shard.UpdatedAt,
	)
	return shard, err
}

func scanSetReconcileFact(row scanner) (SetReconcileFact, error) {
	var fact SetReconcileFact
	var lastReconciledAt sql.NullTime
	err := row.Scan(
		&fact.Source,
		&fact.Namespace,
		&fact.Fleet,
		&fact.SetID,
		&fact.Name,
		&fact.BaseURL,
		&fact.TrafficBaseURL,
		&fact.RuntimeGeneration,
		&fact.RuntimeImage,
		&fact.ShardRef,
		&fact.SQLMaxOpenConns,
		&fact.SQLMaxIdleConns,
		&fact.SQLMaxLifetimeSeconds,
		&fact.TrafficSQLMaxOpenConns,
		&fact.TrafficSQLMaxIdleConns,
		&fact.TrafficSQLMaxLifetimeSeconds,
		&fact.SubscriptionWriteConcurrency,
		&fact.DesiredHash,
		&fact.Status,
		&fact.LastError,
		&fact.LastObservedAt,
		&lastReconciledAt,
		&fact.CreatedAt,
		&fact.UpdatedAt,
	)
	if err != nil {
		return SetReconcileFact{}, err
	}
	if lastReconciledAt.Valid {
		fact.LastReconciledAt = lastReconciledAt.Time.UTC()
	}
	fact.LastObservedAt = fact.LastObservedAt.UTC()
	fact.CreatedAt = fact.CreatedAt.UTC()
	fact.UpdatedAt = fact.UpdatedAt.UTC()
	return fact, nil
}

func scanSetProvisionRequest(row scanner) (SetProvisionRequest, error) {
	var request SetProvisionRequest
	var lastStatusAt sql.NullTime
	err := row.Scan(
		&request.ID,
		&request.Source,
		&request.Namespace,
		&request.Fleet,
		&request.SetID,
		&request.ShardRef,
		&request.DatabaseName,
		&request.RedisDB,
		&request.ReleaseRingID,
		&request.ReleaseID,
		&request.ReleaseImage,
		&request.Status,
		&request.Reason,
		&request.LastError,
		&request.RequestedUsers,
		&request.MaxUsersPerSet,
		&lastStatusAt,
		&request.CreatedAt,
		&request.UpdatedAt,
	)
	if err != nil {
		return SetProvisionRequest{}, err
	}
	if lastStatusAt.Valid {
		request.LastStatusAt = lastStatusAt.Time.UTC()
	}
	request.CreatedAt = request.CreatedAt.UTC()
	request.UpdatedAt = request.UpdatedAt.UTC()
	return request, nil
}

func scanTenant(row scanner) (Tenant, error) {
	var tenant Tenant
	err := row.Scan(
		&tenant.ExternalUserID,
		&tenant.Backend,
		&tenant.SetID,
		&tenant.Status,
		&tenant.Source,
		&tenant.DisplayName,
		&tenant.CreatedAt,
		&tenant.UpdatedAt,
	)
	if err != nil {
		return Tenant{}, err
	}
	tenant.CreatedAt = tenant.CreatedAt.UTC()
	tenant.UpdatedAt = tenant.UpdatedAt.UTC()
	return tenant, nil
}

func scanUserBinding(row scanner) (UserBinding, error) {
	var binding UserBinding
	var lastExtended sql.NullTime
	var lastProvisionError sql.NullString
	err := row.Scan(&binding.ExternalUserID, &binding.SetID, &binding.UpstreamUserID, &binding.Username, &binding.Password,
		&binding.LastPlanID, &lastExtended, &binding.ProvisionStatus, &lastProvisionError, &binding.CreatedAt, &binding.UpdatedAt)
	if lastExtended.Valid {
		binding.LastExtendedPeriodEnd = lastExtended.Time.UTC()
	}
	if lastProvisionError.Valid {
		binding.LastProvisionError = lastProvisionError.String
	}
	return normalizeUserBinding(binding), err
}

func scanAPIKeyBinding(row scanner) (APIKeyBinding, error) {
	var binding APIKeyBinding
	var purpose sql.NullString
	var lastError sql.NullString
	var updatedAt sql.NullTime
	var routeSlot uint64
	err := row.Scan(
		&binding.ExternalKeyID,
		&binding.ExternalKey,
		&binding.ExternalKeyHash,
		&binding.SecretHash,
		&binding.KeyVersion,
		&routeSlot,
		&purpose,
		&binding.SetID,
		&binding.UserID,
		&binding.UpstreamKey,
		&binding.UpstreamKeyID,
		&binding.Status,
		&lastError,
		&binding.CreatedAt,
		&updatedAt,
	)
	if purpose.Valid {
		binding.Purpose = purpose.String
	}
	if lastError.Valid {
		binding.LastError = lastError.String
	}
	if updatedAt.Valid {
		binding.UpdatedAt = updatedAt.Time.UTC()
	}
	binding.RouteSlot = uint32(routeSlot)
	return binding, err
}

func scanUserLLMSettings(row scanner) (UserLLMSettings, error) {
	var settings UserLLMSettings
	var routingMode string
	var rawProviders string
	var lastSyncedAt sql.NullTime
	err := row.Scan(
		&settings.ExternalUserID,
		&routingMode,
		&settings.BYOKGroup,
		&settings.BYOKUpstreamKey,
		&settings.BYOKUpstreamKeyID,
		&rawProviders,
		&lastSyncedAt,
		&settings.LastSyncError,
		&settings.CreatedAt,
		&settings.UpdatedAt,
	)
	if err != nil {
		return UserLLMSettings{}, err
	}
	settings.Routing = UserLLMRouting{Mode: routingMode}
	if strings.TrimSpace(rawProviders) != "" {
		if err := json.Unmarshal([]byte(rawProviders), &settings.Providers); err != nil {
			return UserLLMSettings{}, err
		}
	}
	if lastSyncedAt.Valid {
		settings.LastSyncedAt = lastSyncedAt.Time.UTC()
	}
	settings.CreatedAt = settings.CreatedAt.UTC()
	settings.UpdatedAt = settings.UpdatedAt.UTC()
	return settings, nil
}

func scanBYOKSyncTask(row scanner) (BYOKSyncTask, error) {
	var task BYOKSyncTask
	var leaseUntil sql.NullTime
	var nextRunAt sql.NullTime
	var lastStartedAt sql.NullTime
	var lastFinishedAt sql.NullTime
	err := row.Scan(
		&task.ExternalUserID,
		&task.SetID,
		&task.Status,
		&task.RequestedVersion,
		&task.ProcessingVersion,
		&task.AppliedVersion,
		&task.Attempts,
		&task.LeaseOwner,
		&leaseUntil,
		&nextRunAt,
		&lastStartedAt,
		&lastFinishedAt,
		&task.LastError,
		&task.CreatedAt,
		&task.UpdatedAt,
	)
	if err != nil {
		return BYOKSyncTask{}, err
	}
	if leaseUntil.Valid {
		task.LeaseUntil = leaseUntil.Time.UTC()
	}
	if nextRunAt.Valid {
		task.NextRunAt = nextRunAt.Time.UTC()
	}
	if lastStartedAt.Valid {
		task.LastStartedAt = lastStartedAt.Time.UTC()
	}
	if lastFinishedAt.Valid {
		task.LastFinishedAt = lastFinishedAt.Time.UTC()
	}
	task.CreatedAt = task.CreatedAt.UTC()
	task.UpdatedAt = task.UpdatedAt.UTC()
	return task, nil
}

func scanPlanMapping(row scanner) (PlanMapping, error) {
	var plan PlanMapping
	var rawPlanIDs string
	err := row.Scan(&plan.ID, &plan.Name, &plan.MonthlyTokens, &plan.PeriodValue, &plan.PeriodUnit, &plan.IsActive,
		&plan.SetID, &plan.UpstreamPlanID, &rawPlanIDs, &plan.CreatedAt, &plan.UpdatedAt)
	if err != nil {
		return PlanMapping{}, err
	}
	if rawPlanIDs != "" && rawPlanIDs != "null" {
		if err := json.Unmarshal([]byte(rawPlanIDs), &plan.UpstreamPlanIDs); err != nil {
			return PlanMapping{}, err
		}
	}
	return plan, nil
}

func scanPlan(row scanner) (Plan, error) {
	var plan Plan
	err := row.Scan(&plan.ID, &plan.Name, &plan.MonthlyTokens, &plan.PeriodValue,
		&plan.PeriodUnit, &plan.IsActive, &plan.Fingerprint, &plan.CreatedAt, &plan.UpdatedAt)
	if err != nil {
		return Plan{}, err
	}
	plan.CreatedAt = plan.CreatedAt.UTC()
	plan.UpdatedAt = plan.UpdatedAt.UTC()
	return plan, nil
}

func scanSetPlan(row scanner) (SetPlan, error) {
	var state SetPlan
	var syncedAt sql.NullTime
	err := row.Scan(&state.PlanID, &state.SetID, &state.UpstreamPlanID, &state.Status,
		&state.Attempts, &state.LastError, &syncedAt, &state.CreatedAt, &state.UpdatedAt)
	if err != nil {
		return SetPlan{}, err
	}
	if syncedAt.Valid {
		state.SyncedAt = syncedAt.Time.UTC()
	}
	state.CreatedAt = state.CreatedAt.UTC()
	state.UpdatedAt = state.UpdatedAt.UTC()
	return state, nil
}

func scanSetPlanPeriod(row scanner) (SetPlanPeriod, error) {
	var state SetPlanPeriod
	var syncedAt sql.NullTime
	err := row.Scan(&state.PlanID, &state.PeriodValue, &state.PeriodUnit, &state.SetID,
		&state.UpstreamPlanID, &state.Status, &state.Attempts, &state.LastError,
		&syncedAt, &state.CreatedAt, &state.UpdatedAt)
	if syncedAt.Valid {
		state.SyncedAt = syncedAt.Time.UTC()
	}
	return state, err
}

func scanSubscriptionPeriodOverlay(row scanner) (SubscriptionPeriodOverlay, error) {
	var overlay SubscriptionPeriodOverlay
	err := row.Scan(&overlay.ExternalUserID, &overlay.SetID, &overlay.PeriodEnd, &overlay.CreatedAt, &overlay.UpdatedAt)
	if err == nil {
		overlay.PeriodEnd = overlay.PeriodEnd.UTC()
	}
	return overlay, err
}

func scanUserAssignment(row scanner) (UserAssignment, error) {
	var assignment UserAssignment
	var migratedAt sql.NullTime
	err := row.Scan(&assignment.ExternalUserID, &assignment.Backend, &assignment.SetID, &migratedAt, &assignment.CreatedAt, &assignment.UpdatedAt)
	if migratedAt.Valid {
		assignment.MigratedAt = migratedAt.Time.UTC()
	}
	return assignment, err
}

func scanTenantObservation(row scanner) (TenantObservation, error) {
	var observation TenantObservation
	err := row.Scan(
		&observation.ExternalUserID,
		&observation.Backend,
		&observation.SetID,
		&observation.UpstreamUserID,
		&observation.Username,
		&observation.CurrentPlanID,
		&observation.LastAppliedPlanID,
		&observation.SubscriptionStatus,
		&observation.HasActiveSubscription,
		&observation.TokenBalance,
		&observation.CreditAvailable,
		&observation.CreditStatus,
		&observation.CreditError,
		&observation.Unlimited,
		&observation.PeriodStart,
		&observation.PeriodEnd,
		&observation.Source,
		&observation.ObservedAt,
		&observation.CreatedAt,
		&observation.UpdatedAt,
	)
	if err != nil {
		return TenantObservation{}, err
	}
	observation.ObservedAt = observation.ObservedAt.UTC()
	observation.CreatedAt = observation.CreatedAt.UTC()
	observation.UpdatedAt = observation.UpdatedAt.UTC()
	return observation, nil
}

func scanChannelSpec(row scanner) (ChannelSpec, error) {
	var spec ChannelSpec
	err := row.Scan(
		&spec.ID,
		&spec.Name,
		&spec.Type,
		&spec.Key,
		&spec.KeyHash,
		&spec.BaseURL,
		&spec.Models,
		&spec.Group,
		&spec.ModelMapping,
		&spec.Priority,
		&spec.Weight,
		&spec.Status,
		&spec.Setting,
		&spec.ParamOverride,
		&spec.HeaderOverride,
		&spec.Remark,
		&spec.AutoBan,
		&spec.Tag,
		&spec.Other,
		&spec.StatusCodeMapping,
		&spec.OtherSettings,
		&spec.OpenAIOrganization,
		&spec.TestModel,
		&spec.IsMultiKey,
		&spec.MultiKeyMode,
		&spec.Fingerprint,
		&spec.DesiredRemoteName,
		&spec.CreatedAt,
		&spec.UpdatedAt,
	)
	return spec, err
}

func scanChannelSyncState(row scanner) (ChannelSyncState, error) {
	var state ChannelSyncState
	var lastSyncedAt sql.NullTime
	var lastCheckedAt sql.NullTime
	err := row.Scan(
		&state.ChannelID,
		&state.SetID,
		&state.RemoteChannelID,
		&state.Status,
		&state.LastError,
		&state.DesiredFingerprint,
		&state.AppliedFingerprint,
		&state.RemoteFingerprint,
		&state.LastAppliedKeyHash,
		&lastSyncedAt,
		&lastCheckedAt,
		&state.CreatedAt,
		&state.UpdatedAt,
	)
	if err != nil {
		return ChannelSyncState{}, err
	}
	if lastSyncedAt.Valid {
		state.LastSyncedAt = lastSyncedAt.Time.UTC()
	}
	if lastCheckedAt.Valid {
		state.LastCheckedAt = lastCheckedAt.Time.UTC()
	}
	return state, nil
}

func scanChannelBundle(row scanner) (ChannelBundle, error) {
	var bundle ChannelBundle
	var rawSpec string
	err := row.Scan(
		&bundle.ID,
		&bundle.Name,
		&bundle.Description,
		&bundle.SourceSetID,
		&rawSpec,
		&bundle.Fingerprint,
		&bundle.CreatedAt,
		&bundle.UpdatedAt,
	)
	if err != nil {
		return ChannelBundle{}, err
	}
	if rawSpec != "" {
		spec, err := unmarshalChannelBundleSpecFromStorage(rawSpec)
		if err != nil {
			return ChannelBundle{}, err
		}
		bundle.Spec = spec
	}
	bundle.CreatedAt = bundle.CreatedAt.UTC()
	bundle.UpdatedAt = bundle.UpdatedAt.UTC()
	return bundle, nil
}

func scanChannelBundleSyncState(row scanner) (ChannelBundleSyncState, error) {
	var state ChannelBundleSyncState
	var lastSyncedAt sql.NullTime
	var lastCheckedAt sql.NullTime
	err := row.Scan(
		&state.BundleID,
		&state.SetID,
		&state.Status,
		&state.LastError,
		&state.DesiredFingerprint,
		&state.ActualFingerprint,
		&state.AppliedFingerprint,
		&state.DiffJSON,
		&state.RemoteResourcesJSON,
		&lastSyncedAt,
		&lastCheckedAt,
		&state.CreatedAt,
		&state.UpdatedAt,
	)
	if err != nil {
		return ChannelBundleSyncState{}, err
	}
	if lastSyncedAt.Valid {
		state.LastSyncedAt = lastSyncedAt.Time.UTC()
	}
	if lastCheckedAt.Valid {
		state.LastCheckedAt = lastCheckedAt.Time.UTC()
	}
	state.CreatedAt = state.CreatedAt.UTC()
	state.UpdatedAt = state.UpdatedAt.UTC()
	return state, nil
}

type channelBundleSpecStorage struct {
	Version  int                           `json:"version"`
	Kind     string                        `json:"kind"`
	Options  []channelBundleOptionStorage  `json:"options,omitempty"`
	Channels []channelBundleChannelStorage `json:"channels"`
}

type channelBundleOptionStorage struct {
	Key   string `json:"key"`
	Value any    `json:"value"`
}

type channelBundleChannelStorage struct {
	ID                 string `json:"id"`
	Name               string `json:"name"`
	Type               int    `json:"type"`
	Key                string `json:"key,omitempty"`
	KeyHash            string `json:"key_hash,omitempty"`
	BaseURL            string `json:"base_url"`
	Models             string `json:"models"`
	Group              string `json:"group"`
	ModelMapping       string `json:"model_mapping,omitempty"`
	Priority           int64  `json:"priority,omitempty"`
	Weight             uint   `json:"weight,omitempty"`
	Status             string `json:"status"`
	Setting            string `json:"setting,omitempty"`
	ParamOverride      string `json:"param_override,omitempty"`
	HeaderOverride     string `json:"header_override,omitempty"`
	Remark             string `json:"remark,omitempty"`
	AutoBan            *int   `json:"auto_ban,omitempty"`
	Tag                string `json:"tag,omitempty"`
	Other              string `json:"other,omitempty"`
	StatusCodeMapping  string `json:"status_code_mapping,omitempty"`
	OtherSettings      string `json:"settings,omitempty"`
	OpenAIOrganization string `json:"openai_organization,omitempty"`
	TestModel          string `json:"test_model,omitempty"`
	IsMultiKey         bool   `json:"is_multi_key,omitempty"`
	MultiKeyMode       string `json:"multi_key_mode,omitempty"`
}

func marshalChannelBundleSpecForStorage(spec ChannelBundleSpec) (string, error) {
	payload := channelBundleSpecStorage{
		Version:  spec.Version,
		Kind:     spec.Kind,
		Options:  make([]channelBundleOptionStorage, 0, len(spec.Options)),
		Channels: make([]channelBundleChannelStorage, 0, len(spec.Channels)),
	}
	for _, option := range spec.Options {
		payload.Options = append(payload.Options, channelBundleOptionStorage{
			Key:   option.Key,
			Value: option.Value,
		})
	}
	for _, channel := range spec.Channels {
		payload.Channels = append(payload.Channels, channelBundleChannelStorage{
			ID:                 channel.ID,
			Name:               channel.Name,
			Type:               channel.Type,
			Key:                channel.Key,
			KeyHash:            channel.KeyHash,
			BaseURL:            channel.BaseURL,
			Models:             channel.Models,
			Group:              channel.Group,
			ModelMapping:       channel.ModelMapping,
			Priority:           channel.Priority,
			Weight:             channel.Weight,
			Status:             channel.Status,
			Setting:            channel.Setting,
			ParamOverride:      channel.ParamOverride,
			HeaderOverride:     channel.HeaderOverride,
			Remark:             channel.Remark,
			AutoBan:            cloneIntPointer(channel.AutoBan),
			Tag:                channel.Tag,
			Other:              channel.Other,
			StatusCodeMapping:  channel.StatusCodeMapping,
			OtherSettings:      channel.OtherSettings,
			OpenAIOrganization: channel.OpenAIOrganization,
			TestModel:          channel.TestModel,
			IsMultiKey:         channel.IsMultiKey,
			MultiKeyMode:       channel.MultiKeyMode,
		})
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

func unmarshalChannelBundleSpecFromStorage(raw string) (ChannelBundleSpec, error) {
	var payload channelBundleSpecStorage
	if err := json.Unmarshal([]byte(raw), &payload); err != nil {
		return ChannelBundleSpec{}, err
	}
	spec := ChannelBundleSpec{
		Version:  payload.Version,
		Kind:     payload.Kind,
		Options:  make([]ChannelBundleOption, 0, len(payload.Options)),
		Channels: make([]ChannelBundleChannel, 0, len(payload.Channels)),
	}
	for _, option := range payload.Options {
		spec.Options = append(spec.Options, ChannelBundleOption{
			Key:   option.Key,
			Value: option.Value,
		})
	}
	for _, channel := range payload.Channels {
		spec.Channels = append(spec.Channels, ChannelBundleChannel{
			ID:                 channel.ID,
			Name:               channel.Name,
			Type:               channel.Type,
			Key:                channel.Key,
			KeyHash:            channel.KeyHash,
			BaseURL:            channel.BaseURL,
			Models:             channel.Models,
			Group:              channel.Group,
			ModelMapping:       channel.ModelMapping,
			Priority:           channel.Priority,
			Weight:             channel.Weight,
			Status:             channel.Status,
			Setting:            channel.Setting,
			ParamOverride:      channel.ParamOverride,
			HeaderOverride:     channel.HeaderOverride,
			Remark:             channel.Remark,
			AutoBan:            cloneIntPointer(channel.AutoBan),
			Tag:                channel.Tag,
			Other:              channel.Other,
			StatusCodeMapping:  channel.StatusCodeMapping,
			OtherSettings:      channel.OtherSettings,
			OpenAIOrganization: channel.OpenAIOrganization,
			TestModel:          channel.TestModel,
			IsMultiKey:         channel.IsMultiKey,
			MultiKeyMode:       channel.MultiKeyMode,
		})
	}
	return spec, nil
}

func scanTenantSummary(row scanner) (TenantSummary, error) {
	var item TenantSummary
	var migratedAt sql.NullTime
	var observedAt sql.NullTime
	var createdAt sql.NullTime
	var updatedAt sql.NullTime
	err := row.Scan(
		&item.UserID,
		&item.Backend,
		&item.SetID,
		&item.Status,
		&item.Source,
		&item.DisplayName,
		&item.UpstreamUserID,
		&item.Username,
		&item.LastPlanID,
		&item.ProvisionStatus,
		&item.LastProvisionError,
		&item.KeyCount,
		&item.ObservedPlanID,
		&item.ObservedCreditAvailable,
		&item.ObservedCreditStatus,
		&item.ObservedSubscriptionStatus,
		&observedAt,
		&item.AssignmentStatus,
		&migratedAt,
		&createdAt,
		&updatedAt,
	)
	if err != nil {
		return TenantSummary{}, err
	}
	if migratedAt.Valid {
		item.MigratedAt = migratedAt.Time.UTC()
	}
	if observedAt.Valid {
		item.ObservedAt = observedAt.Time.UTC()
	}
	if createdAt.Valid {
		item.CreatedAt = createdAt.Time.UTC()
	}
	if updatedAt.Valid {
		item.UpdatedAt = updatedAt.Time.UTC()
	}
	return item, nil
}

func tenantSummarySelectSQL() string {
	return `SELECT
		t.external_user_id AS user_id,
		t.backend AS backend,
		t.set_id AS set_id,
		t.status AS status,
		t.source AS source,
		t.display_name AS display_name,
		COALESCE(b.upstream_user_id, 0) AS upstream_user_id,
		COALESCE(b.username, '') AS username,
		COALESCE(b.last_plan_id, '') AS last_plan_id,
		COALESCE(b.provision_status, '') AS provision_status,
		COALESCE(b.last_provision_error, '') AS last_provision_error,
		0 AS key_count,
		COALESCE(o.current_plan_id, '') AS observed_plan_id,
		COALESCE(o.credit_available, 0) AS observed_credit_available,
		COALESCE(o.credit_status, '') AS observed_credit_status,
		COALESCE(o.subscription_status, '') AS observed_subscription_status,
		o.observed_at,
		CASE
			WHEN a.external_user_id IS NOT NULL THEN 'explicit'
			WHEN b.external_user_id IS NOT NULL THEN 'bound_unassigned'
			ELSE 'tenant'
		END AS assignment_status,
		a.migrated_at,
		t.created_at AS created_at,
		t.updated_at AS updated_at `
}

func tenantSummaryBaseSQL() string {
	return `FROM llmgateway_tenants t
		LEFT JOIN llmgateway_user_bindings b ON b.external_user_id = t.external_user_id
		LEFT JOIN llmgateway_user_assignments a ON a.external_user_id = t.external_user_id
		LEFT JOIN llmgateway_tenant_observations o ON o.external_user_id = t.external_user_id`
}

func tenantInventoryWhereSQL(opts TenantListOptions) (string, []any) {
	statusPredicate, statusArgs := tenantStatusPredicate(opts)
	clauses := []string{statusPredicate}
	args := append([]any{}, statusArgs...)
	if opts.Backend != "" {
		clauses = append(clauses, "t.backend = ?")
		args = append(args, opts.Backend)
	}
	if opts.SetID != "" {
		clauses = append(clauses, "t.set_id = ?")
		args = append(args, opts.SetID)
	}
	return " WHERE " + strings.Join(clauses, " AND "), args
}

func tenantStatusPredicate(opts TenantListOptions) (string, []any) {
	if opts.Status != "" {
		return "t.status = ?", []any{opts.Status}
	}
	return "t.status <> ?", []any{TenantStatusDeleted}
}

func appendTenantWhereClause(whereSQL string, clause string) string {
	if strings.TrimSpace(whereSQL) == "" {
		return " WHERE " + clause
	}
	return whereSQL + " AND " + clause
}

func tenantSearchPredicate(column string, keyword string) (string, []any) {
	if len(keyword) <= 2 {
		return column + " = ?", []any{keyword}
	}
	return column + ` LIKE ? ESCAPE '\\'`, []any{tenantSearchLikePattern(keyword)}
}

func tenantSearchLikePattern(keyword string) string {
	escaped := strings.NewReplacer(
		`\`, `\\`,
		`%`, `\%`,
		`_`, `\_`,
	).Replace(keyword)
	return escaped + "%"
}

func nullableTime(t time.Time) any {
	if t.IsZero() {
		return nil
	}
	return t.UTC()
}

func retryMySQLTransientLock(ctx context.Context, fn func() error) error {
	var err error
	for attempt := 0; attempt < 3; attempt++ {
		if attempt > 0 {
			timer := time.NewTimer(time.Duration(attempt*25) * time.Millisecond)
			select {
			case <-timer.C:
			case <-ctx.Done():
				timer.Stop()
				return ctx.Err()
			}
		}
		err = fn()
		if !isMySQLTransientLockError(err) {
			return err
		}
	}
	return err
}

func isMySQLTransientLockError(err error) bool {
	if err == nil {
		return false
	}
	var mysqlErr *mysql.MySQLError
	if errors.As(err, &mysqlErr) {
		return mysqlErr.Number == 1213 || mysqlErr.Number == 1205
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "error 1213") ||
		strings.Contains(message, "deadlock found") ||
		strings.Contains(message, "try restarting transaction") ||
		strings.Contains(message, "error 1205") ||
		strings.Contains(message, "lock wait timeout")
}

func isMySQLDuplicateKeyError(err error) bool {
	if err == nil {
		return false
	}
	var mysqlErr *mysql.MySQLError
	if errors.As(err, &mysqlErr) {
		return mysqlErr.Number == 1062
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "error 1062") || strings.Contains(message, "duplicate entry")
}

func classifyAPIKeyReservationError(err error) error {
	if !isMySQLDuplicateKeyError(err) {
		return err
	}
	message := strings.ToLower(err.Error())
	switch {
	case strings.Contains(message, "uk_llmgateway_api_key_user_purpose"):
		return fmt.Errorf("%w: %v", ErrAPIKeyPurposeConflict, err)
	case strings.Contains(message, "primary"), strings.Contains(message, "uk_llmgateway_api_key_hash"):
		return fmt.Errorf("%w: %v", ErrAPIKeyRandomCollision, err)
	default:
		return fmt.Errorf("external api key reservation duplicate: %w", err)
	}
}
