package gateway

import (
	"context"
	"database/sql"
	"fmt"
)

func (s *MySQLStore) ClaimSetProvisionRequest(ctx context.Context, input setProvisionClaimStoreInput) (SetProvisionRequest, bool, error) {
	result, err := s.db.ExecContext(ctx, `
		UPDATE llmgateway_set_provision_requests
		SET status = CASE WHEN status = ? THEN ? ELSE status END,
			attempt = CASE WHEN status = ? THEN attempt + 1 ELSE attempt END,
			claim_owner = ?, claim_token = ?, claim_lease_until = ?,
			last_status_at = CASE WHEN status = ? THEN ? ELSE last_status_at END,
			version = version + 1, updated_at = ?
		WHERE id = ? AND runtime_backend = ? AND writer_epoch = ? AND lifecycle_revision = ?
			AND status IN (?, ?, ?)
			AND (claim_token = '' OR claim_lease_until IS NULL OR claim_lease_until <= ?)
	`, SetProvisionStatusPending, SetProvisionStatusProvisioning,
		SetProvisionStatusPending, input.Owner, input.Token, input.LeaseUntil,
		SetProvisionStatusPending, input.Now, input.Now,
		input.ID, input.RuntimeBackend, input.WriterEpoch, input.LifecycleRevision,
		SetProvisionStatusPending, SetProvisionStatusProvisioning, SetProvisionStatusConfigured, input.Now)
	if err != nil {
		return SetProvisionRequest{}, false, err
	}
	affected, err := result.RowsAffected()
	if err != nil || affected == 0 {
		return SetProvisionRequest{}, false, err
	}
	request, ok, err := s.GetSetProvisionRequest(ctx, input.ID)
	return request, ok, err
}

func (s *MySQLStore) RenewSetProvisionClaim(ctx context.Context, input setProvisionLeaseStoreInput) (SetProvisionRequest, bool, error) {
	result, err := s.db.ExecContext(ctx, `
		UPDATE llmgateway_set_provision_requests
		SET claim_lease_until = ?, updated_at = ?
		WHERE id = ? AND runtime_backend = ? AND writer_epoch = ? AND lifecycle_revision = ?
			AND version = ? AND claim_token = ? AND claim_token <> '' AND claim_lease_until > ?
	`, input.LeaseUntil, input.Now, input.ID, input.RuntimeBackend, input.WriterEpoch,
		input.LifecycleRevision, input.ExpectedVersion, input.ClaimToken, input.Now)
	if err != nil {
		return SetProvisionRequest{}, false, err
	}
	return s.setProvisionRequestAfterMutation(ctx, input.ID, result)
}

func (s *MySQLStore) ReleaseSetProvisionClaim(ctx context.Context, input setProvisionLeaseStoreInput) (SetProvisionRequest, bool, error) {
	result, err := s.db.ExecContext(ctx, `
		UPDATE llmgateway_set_provision_requests
		SET claim_owner = '', claim_token = '', claim_lease_until = NULL,
			version = version + 1, updated_at = ?
		WHERE id = ? AND runtime_backend = ? AND writer_epoch = ? AND lifecycle_revision = ?
			AND version = ? AND claim_token = ? AND claim_token <> ''
	`, input.Now, input.ID, input.RuntimeBackend, input.WriterEpoch, input.LifecycleRevision,
		input.ExpectedVersion, input.ClaimToken)
	if err != nil {
		return SetProvisionRequest{}, false, err
	}
	return s.setProvisionRequestAfterMutation(ctx, input.ID, result)
}

func (s *MySQLStore) setProvisionRequestAfterMutation(ctx context.Context, id string, result sql.Result) (SetProvisionRequest, bool, error) {
	affected, err := result.RowsAffected()
	if err != nil || affected == 0 {
		return SetProvisionRequest{}, false, err
	}
	request, ok, err := s.GetSetProvisionRequest(ctx, id)
	return request, ok, err
}

func (s *MySQLStore) CommitSetProvisionFact(ctx context.Context, input setProvisionFactCommitStoreInput) (SetProvisionRequest, bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return SetProvisionRequest{}, false, err
	}
	defer func() { _ = tx.Rollback() }()
	adminFactHash := ""
	servingFactHash := ""
	if input.Fact.RuntimeGeneration > 0 {
		servingFactHash = input.Fact.DesiredHash
	} else {
		adminFactHash = input.Fact.DesiredHash
	}
	result, err := tx.ExecContext(ctx, `
		UPDATE llmgateway_set_provision_requests
		SET status = ?, cr_uid = COALESCE(NULLIF(?, ''), cr_uid),
			cr_generation = CASE WHEN ? > 0 THEN ? ELSE cr_generation END,
			runtime_secret_uid = COALESCE(NULLIF(?, ''), runtime_secret_uid),
			runtime_identity_digest = COALESCE(NULLIF(?, ''), runtime_identity_digest),
			bootstrap_job_uid = COALESCE(NULLIF(?, ''), bootstrap_job_uid),
			bootstrap_completed_at = COALESCE(?, bootstrap_completed_at),
			admin_fact_hash = COALESCE(NULLIF(?, ''), admin_fact_hash),
			serving_fact_hash = COALESCE(NULLIF(?, ''), serving_fact_hash),
			claim_owner = '', claim_token = '', claim_lease_until = NULL,
			version = version + 1, last_status_at = ?, updated_at = ?
		WHERE id = ? AND runtime_backend = ? AND writer_epoch = ? AND lifecycle_revision = ?
			AND status = ? AND version = ? AND claim_token = ? AND claim_lease_until > ?
	`, input.NextStatus, input.CRUID, input.CRGeneration, input.CRGeneration,
		input.RuntimeSecretUID, input.RuntimeIdentityDigest, input.BootstrapJobUID,
		nullableTime(input.BootstrapCompletedAt), adminFactHash, servingFactHash,
		input.Now, input.Now, input.ID, input.RuntimeBackend, input.WriterEpoch, input.LifecycleRevision,
		input.ExpectedStatus, input.ExpectedVersion, input.ClaimToken, input.Now)
	if err != nil {
		return SetProvisionRequest{}, false, err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return SetProvisionRequest{}, false, err
	}
	if affected == 0 {
		return SetProvisionRequest{}, false, nil
	}
	fact := input.Fact
	if fact.CreatedAt.IsZero() {
		fact.CreatedAt = input.Now
	}
	if fact.LastObservedAt.IsZero() {
		fact.LastObservedAt = input.Now
	}
	fact.UpdatedAt = input.Now
	if err := execCommitSetReconcileFact(ctx, tx, fact); err != nil {
		return SetProvisionRequest{}, false, err
	}
	if err := tx.Commit(); err != nil {
		return SetProvisionRequest{}, false, err
	}
	request, ok, err := s.GetSetProvisionRequest(ctx, input.ID)
	return request, ok, err
}

func (s *MySQLStore) AdvanceSetProvisionRequestForFact(ctx context.Context, input setProvisionFactAdvanceStoreInput) (SetProvisionRequest, bool, error) {
	hashColumn := "admin_fact_hash"
	if input.NextStatus == SetProvisionStatusManaged {
		hashColumn = "serving_fact_hash"
	}
	query := fmt.Sprintf(`
		UPDATE llmgateway_set_provision_requests
		SET status = ?, version = version + 1, last_status_at = ?, updated_at = ?
		WHERE id = ? AND runtime_backend = ? AND writer_epoch = ? AND lifecycle_revision = ?
			AND status = ? AND version = ? AND %s = ? AND %s <> ''
	`, hashColumn, hashColumn)
	result, err := s.db.ExecContext(ctx, query, input.NextStatus, input.Now, input.Now,
		input.ID, input.RuntimeBackend, input.WriterEpoch, input.LifecycleRevision,
		input.ExpectedStatus, input.ExpectedVersion, input.FactHash)
	if err != nil {
		return SetProvisionRequest{}, false, err
	}
	affected, err := result.RowsAffected()
	if err != nil || affected == 0 {
		return SetProvisionRequest{}, false, err
	}
	request, ok, err := s.GetSetProvisionRequest(ctx, input.ID)
	return request, ok, err
}

func execCommitSetReconcileFact(ctx context.Context, tx *sql.Tx, fact SetReconcileFact) error {
	_, err := tx.ExecContext(ctx, `
		INSERT INTO llmgateway_set_reconcile_facts (
			source, namespace_name, fleet, set_id, name, base_url, traffic_base_url, runtime_generation, runtime_image, shard_ref,
			sql_max_open_conns, sql_max_idle_conns, sql_max_lifetime_seconds,
			traffic_sql_max_open_conns, traffic_sql_max_idle_conns, traffic_sql_max_lifetime_seconds,
			subscription_write_concurrency,
			runtime_ha_status, runtime_ha_desired_replicas, runtime_ha_ready_replicas,
			runtime_ha_pdb_healthy, runtime_ha_topology_key, runtime_ha_error, runtime_ha_checked_at,
			desired_hash, status, last_error, last_observed_at, last_reconciled_at, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON DUPLICATE KEY UPDATE
			name = VALUES(name), base_url = VALUES(base_url), traffic_base_url = VALUES(traffic_base_url),
			runtime_generation = VALUES(runtime_generation), runtime_image = VALUES(runtime_image), shard_ref = VALUES(shard_ref),
			sql_max_open_conns = VALUES(sql_max_open_conns), sql_max_idle_conns = VALUES(sql_max_idle_conns),
			sql_max_lifetime_seconds = VALUES(sql_max_lifetime_seconds),
			traffic_sql_max_open_conns = VALUES(traffic_sql_max_open_conns),
			traffic_sql_max_idle_conns = VALUES(traffic_sql_max_idle_conns),
			traffic_sql_max_lifetime_seconds = VALUES(traffic_sql_max_lifetime_seconds),
			subscription_write_concurrency = VALUES(subscription_write_concurrency),
			runtime_ha_status = VALUES(runtime_ha_status), runtime_ha_desired_replicas = VALUES(runtime_ha_desired_replicas),
			runtime_ha_ready_replicas = VALUES(runtime_ha_ready_replicas), runtime_ha_pdb_healthy = VALUES(runtime_ha_pdb_healthy),
			runtime_ha_topology_key = VALUES(runtime_ha_topology_key), runtime_ha_error = VALUES(runtime_ha_error),
			runtime_ha_checked_at = VALUES(runtime_ha_checked_at), desired_hash = VALUES(desired_hash),
			status = VALUES(status), last_error = VALUES(last_error), last_observed_at = VALUES(last_observed_at),
			last_reconciled_at = VALUES(last_reconciled_at), updated_at = VALUES(updated_at)
	`, fact.Source, fact.Namespace, fact.Fleet, fact.SetID, fact.Name, fact.BaseURL, fact.TrafficBaseURL,
		fact.RuntimeGeneration, fact.RuntimeImage, fact.ShardRef,
		fact.SQLMaxOpenConns, fact.SQLMaxIdleConns, fact.SQLMaxLifetimeSeconds,
		fact.TrafficSQLMaxOpenConns, fact.TrafficSQLMaxIdleConns, fact.TrafficSQLMaxLifetimeSeconds,
		fact.SubscriptionWriteConcurrency, fact.RuntimeHAStatus, fact.RuntimeHADesiredReplicas,
		fact.RuntimeHAReadyReplicas, fact.RuntimeHAPDBHealthy, fact.RuntimeHATopologyKey,
		fact.RuntimeHAError, nullableTime(fact.RuntimeHACheckedAt), fact.DesiredHash, fact.Status,
		fact.LastError, fact.LastObservedAt, nullableTime(fact.LastReconciledAt), fact.CreatedAt, fact.UpdatedAt)
	return err
}
