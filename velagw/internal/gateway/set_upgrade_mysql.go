package gateway

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
)

const setUpgradeRunColumns = `id, batch_id, set_id, source, namespace_name, fleet, target_image,
	from_release_id, target_release_id, sequence_no,
	from_generation, to_generation, lifecycle_generation, status, consecutive_probe_successes, consecutive_probe_failures,
	drain_timeout_seconds, rollback_window_seconds, lease_owner, lease_until, switched_at,
	drain_deadline, rollback_deadline, rollback_requested, rollback_reason,
	master_upgraded_at, compatibility_checked_at, last_error, created_at, updated_at`

func (s *MySQLStore) SaveSetRuntime(ctx context.Context, runtime SetRuntime) error {
	if strings.TrimSpace(runtime.SetID) == "" || runtime.Generation < 0 {
		return fmt.Errorf("set runtime requires set_id and non-negative generation")
	}
	now := time.Now().UTC()
	if runtime.CreatedAt.IsZero() {
		runtime.CreatedAt = now
	}
	runtime.UpdatedAt = now
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO llmgateway_set_runtimes (set_id, generation, release_id, image, traffic_base_url, status, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`, runtime.SetID, runtime.Generation, runtime.ReleaseID, runtime.Image, runtime.TrafficBaseURL, runtime.Status, runtime.CreatedAt, runtime.UpdatedAt)
	if isMySQLDuplicateKeyError(err) {
		return fmt.Errorf("set runtime %s generation %d is immutable", runtime.SetID, runtime.Generation)
	}
	return err
}

func (s *MySQLStore) InitializeSetRuntime(ctx context.Context, setID string, generation int64, image, trafficBaseURL string, now time.Time) (SetRuntimeRouteSnapshot, bool, error) {
	setID = strings.TrimSpace(setID)
	image = strings.TrimSpace(image)
	trafficBaseURL = strings.TrimRight(strings.TrimSpace(trafficBaseURL), "/")
	if setID == "" || generation < 0 || image == "" || trafficBaseURL == "" {
		return SetRuntimeRouteSnapshot{}, false, fmt.Errorf("initial set runtime requires set_id, non-negative generation, image and traffic url")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return SetRuntimeRouteSnapshot{}, false, err
	}
	defer tx.Rollback()
	var status, baseURL, declaredTrafficBaseURL string
	var activeGeneration, lastGeneration, routeRevision int64
	var updatedAt time.Time
	if err := tx.QueryRowContext(ctx, `
		SELECT status, base_url, traffic_base_url, active_runtime_generation, last_runtime_generation, route_revision, updated_at
		FROM llmgateway_sets WHERE id=? FOR UPDATE
	`, setID).Scan(&status, &baseURL, &declaredTrafficBaseURL, &activeGeneration, &lastGeneration, &routeRevision, &updatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return SetRuntimeRouteSnapshot{}, false, fmt.Errorf("set %q not found", setID)
		}
		return SetRuntimeRouteSnapshot{}, false, err
	}
	if activeGeneration == 0 && routeRevision > 0 {
		legacy := SetRuntime{SetID: setID, Generation: 0}
		if err := tx.QueryRowContext(ctx, `
			SELECT image,traffic_base_url FROM llmgateway_set_runtimes
			WHERE set_id=? AND generation=0 FOR UPDATE
		`, setID).Scan(&legacy.Image, &legacy.TrafficBaseURL); err != nil {
			return SetRuntimeRouteSnapshot{}, false, fmt.Errorf("load generation 0 runtime for set %q: %w", setID, err)
		}
		if !canAdoptObservedSetRuntime(Set{BaseURL: baseURL, TrafficBaseURL: declaredTrafficBaseURL}, legacy, trafficBaseURL) {
			return SetRuntimeRouteSnapshot{}, false, fmt.Errorf("set %q generation 0 route does not match observed generation %d", setID, generation)
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO llmgateway_set_runtimes (set_id,generation,release_id,image,traffic_base_url,status,created_at,updated_at)
			VALUES (?,?,?,?,?,?,?,?)
		`, setID, generation, "", image, trafficBaseURL, SetRuntimeStatusActive, now, now); err != nil {
			if isMySQLDuplicateKeyError(err) {
				return SetRuntimeRouteSnapshot{}, false, fmt.Errorf("set runtime %s generation %d is immutable", setID, generation)
			}
			return SetRuntimeRouteSnapshot{}, false, err
		}
		if _, err := tx.ExecContext(ctx, `
			UPDATE llmgateway_set_runtimes SET status=?,updated_at=? WHERE set_id=? AND generation=0
		`, SetRuntimeStatusRetired, now, setID); err != nil {
			return SetRuntimeRouteSnapshot{}, false, err
		}
		routeRevision++
		if _, err := tx.ExecContext(ctx, `
			UPDATE llmgateway_sets SET active_runtime_generation=?,
				last_runtime_generation=GREATEST(last_runtime_generation,?), route_revision=?,
				admin_image=?, traffic_base_url=?, updated_at=? WHERE id=?
		`, generation, generation, routeRevision, image, trafficBaseURL, now, setID); err != nil {
			return SetRuntimeRouteSnapshot{}, false, err
		}
		snapshot := SetRuntimeRouteSnapshot{
			SetID: setID, RuntimeGeneration: generation, RouteRevision: routeRevision,
			TrafficBaseURL: trafficBaseURL, Enabled: status == SetStatusActive, SwitchedAt: now,
		}
		if err := insertSetRuntimeRouteOutboxTx(ctx, tx, snapshot, now); err != nil {
			return SetRuntimeRouteSnapshot{}, false, err
		}
		if err := tx.Commit(); err != nil {
			return SetRuntimeRouteSnapshot{}, false, err
		}
		return snapshot, true, nil
	}
	if routeRevision > 0 {
		var runtimeURL string
		if err := tx.QueryRowContext(ctx, `
			SELECT traffic_base_url FROM llmgateway_set_runtimes WHERE set_id=? AND generation=?
		`, setID, activeGeneration).Scan(&runtimeURL); err != nil {
			return SetRuntimeRouteSnapshot{}, false, fmt.Errorf("load active runtime for set %q: %w", setID, err)
		}
		return SetRuntimeRouteSnapshot{
			SetID: setID, RuntimeGeneration: activeGeneration, RouteRevision: routeRevision,
			TrafficBaseURL: runtimeURL, Enabled: status == SetStatusActive, SwitchedAt: updatedAt.UTC(),
		}, false, nil
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE llmgateway_sets SET active_runtime_generation=?, last_runtime_generation=GREATEST(last_runtime_generation,?), route_revision=1,
			admin_image=?, traffic_base_url=?, updated_at=? WHERE id=?
	`, generation, generation, image, trafficBaseURL, now, setID); err != nil {
		return SetRuntimeRouteSnapshot{}, false, err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO llmgateway_set_runtimes (set_id,generation,release_id,image,traffic_base_url,status,created_at,updated_at)
		VALUES (?,?,?,?,?,?,?,?)
	`, setID, generation, "", image, trafficBaseURL, SetRuntimeStatusActive, now, now); err != nil {
		return SetRuntimeRouteSnapshot{}, false, err
	}
	snapshot := SetRuntimeRouteSnapshot{
		SetID: setID, RuntimeGeneration: generation, RouteRevision: 1,
		TrafficBaseURL: trafficBaseURL, Enabled: status == SetStatusActive, SwitchedAt: now,
	}
	if err := insertSetRuntimeRouteOutboxTx(ctx, tx, snapshot, now); err != nil {
		return SetRuntimeRouteSnapshot{}, false, err
	}
	if err := tx.Commit(); err != nil {
		return SetRuntimeRouteSnapshot{}, false, err
	}
	return snapshot, true, nil
}

func (s *MySQLStore) GetSetRuntime(ctx context.Context, setID string, generation int64) (SetRuntime, bool, error) {
	runtime, err := scanSetRuntime(s.db.QueryRowContext(ctx, `
		SELECT set_id, generation, release_id, image, traffic_base_url, status, created_at, updated_at
		FROM llmgateway_set_runtimes WHERE set_id=? AND generation=?
	`, setID, generation))
	if errors.Is(err, sql.ErrNoRows) {
		return SetRuntime{}, false, nil
	}
	return runtime, err == nil, err
}

func (s *MySQLStore) ListSetRuntimes(ctx context.Context, setID string) ([]SetRuntime, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT set_id, generation, release_id, image, traffic_base_url, status, created_at, updated_at
		FROM llmgateway_set_runtimes WHERE set_id=? ORDER BY generation
	`, setID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []SetRuntime
	for rows.Next() {
		runtime, err := scanSetRuntime(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, runtime)
	}
	return result, rows.Err()
}

func (s *MySQLStore) TransitionSetTrafficState(ctx context.Context, setID, status string, now time.Time) (Set, SetRuntimeRouteSnapshot, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Set{}, SetRuntimeRouteSnapshot{}, err
	}
	defer tx.Rollback()
	var currentStatus string
	var activeGeneration, routeRevision int64
	if err := tx.QueryRowContext(ctx, `
		SELECT status,active_runtime_generation,route_revision
		FROM llmgateway_sets WHERE id=? FOR UPDATE
	`, setID).Scan(&currentStatus, &activeGeneration, &routeRevision); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Set{}, SetRuntimeRouteSnapshot{}, fmt.Errorf("set %q not found", setID)
		}
		return Set{}, SetRuntimeRouteSnapshot{}, err
	}
	if currentStatus == status {
		if err := tx.Commit(); err != nil {
			return Set{}, SetRuntimeRouteSnapshot{}, err
		}
		set, ok, err := s.GetSet(ctx, setID)
		if err != nil || !ok {
			return Set{}, SetRuntimeRouteSnapshot{}, err
		}
		return set, SetRuntimeRouteSnapshot{}, nil
	}
	var trafficBaseURL string
	if err := tx.QueryRowContext(ctx, `
		SELECT traffic_base_url FROM llmgateway_set_runtimes
		WHERE set_id=? AND generation=? FOR UPDATE
	`, setID, activeGeneration).Scan(&trafficBaseURL); err != nil {
		return Set{}, SetRuntimeRouteSnapshot{}, fmt.Errorf("load active runtime for set %q: %w", setID, err)
	}
	routeRevision++
	if routeRevision <= 0 {
		routeRevision = 1
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE llmgateway_sets SET status=?,route_revision=?,updated_at=? WHERE id=?
	`, status, routeRevision, now, setID); err != nil {
		return Set{}, SetRuntimeRouteSnapshot{}, err
	}
	snapshot := SetRuntimeRouteSnapshot{
		SetID: setID, RuntimeGeneration: activeGeneration, RouteRevision: routeRevision,
		TrafficBaseURL: trafficBaseURL, Enabled: status != SetStatusDisabled, SwitchedAt: now,
	}
	if err := insertSetRuntimeRouteOutboxTx(ctx, tx, snapshot, now); err != nil {
		return Set{}, SetRuntimeRouteSnapshot{}, err
	}
	if err := tx.Commit(); err != nil {
		return Set{}, SetRuntimeRouteSnapshot{}, err
	}
	set, ok, err := s.GetSet(ctx, setID)
	if err != nil || !ok {
		return Set{}, SetRuntimeRouteSnapshot{}, err
	}
	return set, snapshot, nil
}

func (s *MySQLStore) CreateSetUpgradeBatch(ctx context.Context, batch SetUpgradeBatch) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for index := range batch.Runs {
		run := &batch.Runs[index]
		var status string
		var activeGeneration, lastGeneration, lifecycleGeneration, maxRuntimeGeneration int64
		if err := tx.QueryRowContext(ctx, `
			SELECT status,active_runtime_generation,last_runtime_generation,lifecycle_generation
			FROM llmgateway_sets WHERE id=? FOR UPDATE
		`, run.SetID).Scan(&status, &activeGeneration, &lastGeneration, &lifecycleGeneration); err != nil {
			return err
		}
		if status != SetStatusActive {
			return fmt.Errorf("set %q is not active", run.SetID)
		}
		if run.FromGeneration != activeGeneration {
			return fmt.Errorf("set %q active runtime changed while creating upgrade", run.SetID)
		}
		if err := tx.QueryRowContext(ctx, `
			SELECT COALESCE(MAX(generation),0) FROM llmgateway_set_runtimes WHERE set_id=?
		`, run.SetID).Scan(&maxRuntimeGeneration); err != nil {
			return err
		}
		if maxRuntimeGeneration > lastGeneration {
			lastGeneration = maxRuntimeGeneration
		}
		if activeGeneration > lastGeneration {
			lastGeneration = activeGeneration
		}
		run.ToGeneration = lastGeneration + 1
		run.LifecycleGeneration = lifecycleGeneration
		var activeID string
		err := tx.QueryRowContext(ctx, `
			SELECT id FROM llmgateway_set_upgrade_runs
			WHERE set_id=? AND status NOT IN ('completed','failed','rolled_back') LIMIT 1 FOR UPDATE
		`, run.SetID).Scan(&activeID)
		if err == nil {
			return ErrSetUpgradeAlreadyActive
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if _, err := tx.ExecContext(ctx, `
			UPDATE llmgateway_sets SET last_runtime_generation=?,updated_at=? WHERE id=?
		`, run.ToGeneration, batch.UpdatedAt, run.SetID); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO llmgateway_set_upgrade_batches (id, rollout_id, ring_id, target_release_id, target_image, status, max_parallel, stop_on_failure, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, batch.ID, batch.RolloutID, batch.RingID, batch.TargetReleaseID, batch.TargetImage, batch.Status, batch.MaxParallel, batch.StopOnFailure, batch.CreatedAt, batch.UpdatedAt); err != nil {
		return err
	}
	for _, run := range batch.Runs {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO llmgateway_set_upgrade_runs (`+setUpgradeRunColumns+`)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`, setUpgradeRunValues(run)...); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *MySQLStore) GetSetUpgradeBatch(ctx context.Context, id string) (SetUpgradeBatch, bool, error) {
	var batch SetUpgradeBatch
	err := s.db.QueryRowContext(ctx, `
		SELECT id, rollout_id, ring_id, target_release_id, target_image, status, max_parallel, stop_on_failure, created_at, updated_at
		FROM llmgateway_set_upgrade_batches WHERE id=?
	`, id).Scan(&batch.ID, &batch.RolloutID, &batch.RingID, &batch.TargetReleaseID, &batch.TargetImage, &batch.Status, &batch.MaxParallel, &batch.StopOnFailure, &batch.CreatedAt, &batch.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return SetUpgradeBatch{}, false, nil
	}
	if err != nil {
		return SetUpgradeBatch{}, false, err
	}
	batch.Runs, err = s.ListSetUpgradeRuns(ctx, id, nil, 0)
	batch.Status = deriveSetUpgradeBatchStatus(batch.Runs, batch.StopOnFailure)
	return batch, err == nil, err
}

func (s *MySQLStore) GetSetUpgradeRun(ctx context.Context, id string) (SetUpgradeRun, bool, error) {
	run, err := scanSetUpgradeRun(s.db.QueryRowContext(ctx, `SELECT `+setUpgradeRunColumns+` FROM llmgateway_set_upgrade_runs WHERE id=?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return SetUpgradeRun{}, false, nil
	}
	return run, err == nil, err
}

func (s *MySQLStore) ListSetUpgradeRuns(ctx context.Context, batchID string, statuses []string, limit int) ([]SetUpgradeRun, error) {
	query := `SELECT ` + setUpgradeRunColumns + ` FROM llmgateway_set_upgrade_runs WHERE 1=1`
	args := make([]any, 0, len(statuses)+2)
	if batchID != "" {
		query += ` AND batch_id=?`
		args = append(args, batchID)
	}
	if len(statuses) > 0 {
		query += ` AND status IN (` + strings.TrimRight(strings.Repeat("?,", len(statuses)), ",") + `)`
		for _, status := range statuses {
			args = append(args, status)
		}
	}
	query += ` ORDER BY created_at, id`
	if limit > 0 {
		query += ` LIMIT ?`
		args = append(args, limit)
	}
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []SetUpgradeRun
	for rows.Next() {
		run, err := scanSetUpgradeRun(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, run)
	}
	return result, rows.Err()
}

func (s *MySQLStore) TryAcquireSetUpgradeRun(ctx context.Context, id, owner string, ttl time.Duration, now time.Time) (SetUpgradeRun, bool, error) {
	if strings.TrimSpace(owner) == "" || ttl <= 0 {
		return SetUpgradeRun{}, false, fmt.Errorf("upgrade run lease requires owner and ttl")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return SetUpgradeRun{}, false, err
	}
	defer tx.Rollback()
	run, err := scanSetUpgradeRun(tx.QueryRowContext(ctx, `SELECT `+setUpgradeRunColumns+` FROM llmgateway_set_upgrade_runs WHERE id=? FOR UPDATE`, id))
	if errors.Is(err, sql.ErrNoRows) || setUpgradeRunTerminal(run.Status) {
		return SetUpgradeRun{}, false, nil
	}
	if err != nil {
		return SetUpgradeRun{}, false, err
	}
	if run.LeaseOwner != "" && run.LeaseOwner != owner && run.LeaseUntil.After(now) {
		return SetUpgradeRun{}, false, nil
	}
	var setStatus string
	var lifecycleGeneration int64
	if err := tx.QueryRowContext(ctx, `
		SELECT status,lifecycle_generation FROM llmgateway_sets WHERE id=? FOR UPDATE
	`, run.SetID).Scan(&setStatus, &lifecycleGeneration); err != nil {
		return SetUpgradeRun{}, false, err
	}
	if setStatus != SetStatusActive || lifecycleGeneration != run.LifecycleGeneration {
		return SetUpgradeRun{}, false, fmt.Errorf("set %q lifecycle changed during upgrade", run.SetID)
	}
	if run.Status == SetUpgradeRunStatusPending {
		var maxParallel int
		var stopOnFailure bool
		var campaignID, campaignStatus string
		if err := tx.QueryRowContext(ctx, `
			SELECT batches.max_parallel,batches.stop_on_failure,COALESCE(rollouts.campaign_id,''),COALESCE(campaigns.status,'')
			FROM llmgateway_set_upgrade_batches batches
			LEFT JOIN llmgateway_release_rollouts rollouts ON rollouts.id=batches.rollout_id
			LEFT JOIN llmgateway_release_campaigns campaigns ON campaigns.id=rollouts.campaign_id
			WHERE batches.id=? FOR UPDATE
		`, run.BatchID).Scan(&maxParallel, &stopOnFailure, &campaignID, &campaignStatus); err != nil {
			return SetUpgradeRun{}, false, err
		}
		if campaignID != "" && (campaignStatus == "" || campaignStatus == ReleaseCampaignStatusPaused || campaignStatus == ReleaseCampaignStatusCompleted) {
			return SetUpgradeRun{}, false, nil
		}
		if stopOnFailure {
			var failures int
			if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM llmgateway_set_upgrade_runs WHERE batch_id=? AND status=?`, run.BatchID, SetUpgradeRunStatusFailed).Scan(&failures); err != nil {
				return SetUpgradeRun{}, false, err
			}
			if failures > 0 {
				return SetUpgradeRun{}, false, nil
			}
		}
		var active int
		if err := tx.QueryRowContext(ctx, `
			SELECT COUNT(*) FROM llmgateway_set_upgrade_runs
			WHERE batch_id=? AND id<>? AND status NOT IN (?,?,?,?) AND lease_until>?
		`, run.BatchID, run.ID, SetUpgradeRunStatusPending, SetUpgradeRunStatusCompleted, SetUpgradeRunStatusFailed, SetUpgradeRunStatusRolledBack, now).Scan(&active); err != nil {
			return SetUpgradeRun{}, false, err
		}
		if maxParallel > 0 && active >= maxParallel {
			return SetUpgradeRun{}, false, nil
		}
	}
	run.LeaseOwner = owner
	run.LeaseUntil = now.Add(ttl)
	if run.Status == SetUpgradeRunStatusPending {
		run.Status = SetUpgradeRunStatusUpgradingMaster
		result, err := tx.ExecContext(ctx, `
			UPDATE llmgateway_sets
			SET admin_writes_paused=1,admin_writes_pause_reason=?,admin_writes_paused_at=?,updated_at=?
			WHERE id=?
		`, "set upgrade "+run.ID, now, now, run.SetID)
		if err != nil {
			return SetUpgradeRun{}, false, err
		}
		if affected, _ := result.RowsAffected(); affected == 0 {
			return SetUpgradeRun{}, false, fmt.Errorf("set %q not found", run.SetID)
		}
	}
	run.UpdatedAt = now
	if err := updateSetUpgradeRunTx(ctx, tx, run); err != nil {
		return SetUpgradeRun{}, false, err
	}
	return run, true, tx.Commit()
}

func (s *MySQLStore) CompleteSetUpgradeCompatibility(ctx context.Context, claimed SetUpgradeRun, success bool, lastError string, now time.Time) (SetUpgradeRun, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return SetUpgradeRun{}, err
	}
	defer tx.Rollback()
	run, err := claimedSetUpgradeRunTx(ctx, tx, claimed, SetUpgradeRunStatusVerifyingCompatibility, now)
	if err != nil {
		return SetUpgradeRun{}, err
	}
	run.CompatibilityCheckedAt = now
	if success {
		run.Status = SetUpgradeRunStatusPreparing
		run.LastError = ""
	} else {
		run.Status = SetUpgradeRunStatusFailed
		run.LastError = strings.TrimSpace(lastError)
	}
	run.UpdatedAt = now
	if err := updateSetUpgradeRunTx(ctx, tx, run); err != nil {
		return SetUpgradeRun{}, err
	}
	return run, tx.Commit()
}

func (s *MySQLStore) PrepareSetUpgradeRuntime(ctx context.Context, claimed SetUpgradeRun, runtime SetRuntime, now time.Time) (SetUpgradeRun, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return SetUpgradeRun{}, err
	}
	defer tx.Rollback()
	run, err := claimedSetUpgradeRunTx(ctx, tx, claimed, SetUpgradeRunStatusPreparing, now)
	if err != nil {
		return SetUpgradeRun{}, err
	}
	if runtime.SetID != run.SetID || runtime.Generation != run.ToGeneration || runtime.Image != run.TargetImage {
		return SetUpgradeRun{}, fmt.Errorf("candidate runtime does not match upgrade run")
	}
	runtime.ReleaseID = run.TargetReleaseID
	runtime.Status = SetRuntimeStatusPreparing
	runtime.CreatedAt = now
	runtime.UpdatedAt = now
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO llmgateway_set_runtimes (set_id,generation,release_id,image,traffic_base_url,status,created_at,updated_at)
		VALUES (?,?,?,?,?,?,?,?)
	`, runtime.SetID, runtime.Generation, runtime.ReleaseID, runtime.Image, runtime.TrafficBaseURL, runtime.Status, runtime.CreatedAt, runtime.UpdatedAt); err != nil {
		if isMySQLDuplicateKeyError(err) {
			return SetUpgradeRun{}, fmt.Errorf("set runtime %s generation %d is immutable", runtime.SetID, runtime.Generation)
		}
		return SetUpgradeRun{}, err
	}
	run.Status = SetUpgradeRunStatusProbing
	run.UpdatedAt = now
	if err := updateSetUpgradeRunTx(ctx, tx, run); err != nil {
		return SetUpgradeRun{}, err
	}
	return run, tx.Commit()
}

func (s *MySQLStore) RecordSetUpgradeProbe(ctx context.Context, claimed SetUpgradeRun, success bool, lastError string, now time.Time) (SetUpgradeRun, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return SetUpgradeRun{}, err
	}
	defer tx.Rollback()
	run, err := claimedSetUpgradeRunTx(ctx, tx, claimed, SetUpgradeRunStatusProbing, now)
	if err != nil {
		return SetUpgradeRun{}, err
	}
	runtimeStatus := SetRuntimeStatusPreparing
	if success {
		run.ConsecutiveProbeSuccesses++
		run.ConsecutiveProbeFailures = 0
		run.LastError = ""
		if run.ConsecutiveProbeSuccesses >= 3 {
			run.Status = SetUpgradeRunStatusSwitching
			runtimeStatus = SetRuntimeStatusReady
		}
	} else {
		run.ConsecutiveProbeSuccesses = 0
		run.ConsecutiveProbeFailures++
		run.LastError = lastError
		if run.ConsecutiveProbeFailures >= 3 {
			run.Status = SetUpgradeRunStatusFailed
			runtimeStatus = SetRuntimeStatusFailed
			if _, err := tx.ExecContext(ctx, `
				UPDATE llmgateway_sets SET admin_writes_paused=0,admin_writes_pause_reason='',admin_writes_paused_at=NULL,updated_at=? WHERE id=?
			`, now, run.SetID); err != nil {
				return SetUpgradeRun{}, err
			}
		}
	}
	run.UpdatedAt = now
	if _, err := tx.ExecContext(ctx, `UPDATE llmgateway_set_runtimes SET status=?,updated_at=? WHERE set_id=? AND generation=?`, runtimeStatus, now, run.SetID, run.ToGeneration); err != nil {
		return SetUpgradeRun{}, err
	}
	if err := updateSetUpgradeRunTx(ctx, tx, run); err != nil {
		return SetUpgradeRun{}, err
	}
	return run, tx.Commit()
}

func (s *MySQLStore) RecordSetUpgradePostSwitchProbe(ctx context.Context, claimed SetUpgradeRun, success bool, lastError string, now time.Time) (SetUpgradeRun, bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return SetUpgradeRun{}, false, err
	}
	defer tx.Rollback()
	run, err := claimedSetUpgradeRunTx(ctx, tx, claimed, SetUpgradeRunStatusDraining, now)
	if err != nil {
		return SetUpgradeRun{}, false, err
	}
	if success {
		run.ConsecutiveProbeFailures = 0
		run.LastError = ""
	} else {
		run.ConsecutiveProbeFailures++
		run.LastError = lastError
	}
	run.UpdatedAt = now
	if err := updateSetUpgradeRunTx(ctx, tx, run); err != nil {
		return SetUpgradeRun{}, false, err
	}
	if err := tx.Commit(); err != nil {
		return SetUpgradeRun{}, false, err
	}
	return run, run.ConsecutiveProbeFailures >= 3, nil
}

func (s *MySQLStore) SwitchSetUpgradeRuntime(ctx context.Context, claimed SetUpgradeRun, now time.Time) (SetUpgradeRun, SetRuntimeRouteSnapshot, error) {
	return s.switchSetUpgradeRuntime(ctx, claimed, now, false, "")
}

func (s *MySQLStore) RollbackSetUpgradeRuntime(ctx context.Context, claimed SetUpgradeRun, now time.Time, reason string) (SetUpgradeRun, SetRuntimeRouteSnapshot, error) {
	return s.switchSetUpgradeRuntime(ctx, claimed, now, true, reason)
}

func (s *MySQLStore) switchSetUpgradeRuntime(ctx context.Context, claimed SetUpgradeRun, now time.Time, rollback bool, reason string) (SetUpgradeRun, SetRuntimeRouteSnapshot, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return SetUpgradeRun{}, SetRuntimeRouteSnapshot{}, err
	}
	defer tx.Rollback()
	expected := SetUpgradeRunStatusSwitching
	if rollback {
		expected = SetUpgradeRunStatusDraining
	}
	run, err := claimedSetUpgradeRunTx(ctx, tx, claimed, expected, now)
	if err != nil {
		return SetUpgradeRun{}, SetRuntimeRouteSnapshot{}, err
	}
	if rollback && !run.RollbackDeadline.IsZero() && now.After(run.RollbackDeadline) {
		return SetUpgradeRun{}, SetRuntimeRouteSnapshot{}, fmt.Errorf("rollback window expired")
	}
	var setStatus, currentURL string
	var activeGeneration, routeRevision int64
	if err := tx.QueryRowContext(ctx, `SELECT status,traffic_base_url,active_runtime_generation,route_revision FROM llmgateway_sets WHERE id=? FOR UPDATE`, run.SetID).
		Scan(&setStatus, &currentURL, &activeGeneration, &routeRevision); err != nil {
		return SetUpgradeRun{}, SetRuntimeRouteSnapshot{}, err
	}
	targetGeneration := run.ToGeneration
	drainingGeneration := run.FromGeneration
	if rollback {
		targetGeneration, drainingGeneration = run.FromGeneration, run.ToGeneration
	} else if activeGeneration != run.FromGeneration {
		return SetUpgradeRun{}, SetRuntimeRouteSnapshot{}, fmt.Errorf("set active runtime changed during upgrade")
	}
	target, err := scanSetRuntime(tx.QueryRowContext(ctx, `SELECT set_id,generation,release_id,image,traffic_base_url,status,created_at,updated_at FROM llmgateway_set_runtimes WHERE set_id=? AND generation=? FOR UPDATE`, run.SetID, targetGeneration))
	if err != nil {
		return SetUpgradeRun{}, SetRuntimeRouteSnapshot{}, err
	}
	if !rollback && target.Status != SetRuntimeStatusReady {
		return SetUpgradeRun{}, SetRuntimeRouteSnapshot{}, fmt.Errorf("candidate runtime is not ready")
	}
	if _, err := tx.ExecContext(ctx, `UPDATE llmgateway_set_runtimes SET status=?,updated_at=? WHERE set_id=? AND generation=?`, SetRuntimeStatusDraining, now, run.SetID, drainingGeneration); err != nil {
		return SetUpgradeRun{}, SetRuntimeRouteSnapshot{}, err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE llmgateway_set_runtimes SET status=?,updated_at=? WHERE set_id=? AND generation=?`, SetRuntimeStatusActive, now, run.SetID, targetGeneration); err != nil {
		return SetUpgradeRun{}, SetRuntimeRouteSnapshot{}, err
	}
	routeRevision++
	if routeRevision <= 0 {
		routeRevision = 1
	}
	if _, err := tx.ExecContext(ctx, `UPDATE llmgateway_sets SET traffic_base_url=?,active_runtime_generation=?,route_revision=?,updated_at=? WHERE id=?`, target.TrafficBaseURL, targetGeneration, routeRevision, now, run.SetID); err != nil {
		return SetUpgradeRun{}, SetRuntimeRouteSnapshot{}, err
	}
	if rollback {
		run.Status = SetUpgradeRunStatusRollbackSwitching
		run.DrainDeadline = time.Time{}
		run.LastError = reason
	} else {
		run.Status = SetUpgradeRunStatusSwitching
		run.SwitchedAt = now
		run.DrainDeadline = time.Time{}
		run.RollbackDeadline = time.Time{}
	}
	run.UpdatedAt = now
	if err := updateSetUpgradeRunTx(ctx, tx, run); err != nil {
		return SetUpgradeRun{}, SetRuntimeRouteSnapshot{}, err
	}
	snapshot := SetRuntimeRouteSnapshot{SetID: run.SetID, RuntimeGeneration: targetGeneration, RouteRevision: routeRevision, TrafficBaseURL: target.TrafficBaseURL, Enabled: setStatus == SetStatusActive, SwitchedAt: now}
	if err := insertSetRuntimeRouteOutboxTx(ctx, tx, snapshot, now); err != nil {
		return SetUpgradeRun{}, SetRuntimeRouteSnapshot{}, err
	}
	if err := tx.Commit(); err != nil {
		return SetUpgradeRun{}, SetRuntimeRouteSnapshot{}, err
	}
	return run, snapshot, nil
}

func (s *MySQLStore) ConfirmSetRuntimeRoutePublished(ctx context.Context, setID string, routeRevision int64, now time.Time) (SetUpgradeRun, bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return SetUpgradeRun{}, false, err
	}
	defer tx.Rollback()
	var activeGeneration, currentRevision int64
	if err := tx.QueryRowContext(ctx, `SELECT active_runtime_generation,route_revision FROM llmgateway_sets WHERE id=? FOR UPDATE`, setID).Scan(&activeGeneration, &currentRevision); errors.Is(err, sql.ErrNoRows) {
		return SetUpgradeRun{}, false, nil
	} else if err != nil {
		return SetUpgradeRun{}, false, err
	}
	if currentRevision != routeRevision {
		return SetUpgradeRun{}, false, nil
	}
	run, err := scanSetUpgradeRun(tx.QueryRowContext(ctx, `
		SELECT `+setUpgradeRunColumns+` FROM llmgateway_set_upgrade_runs
		WHERE set_id=? AND status IN (?,?) ORDER BY updated_at DESC LIMIT 1 FOR UPDATE
	`, setID, SetUpgradeRunStatusSwitching, SetUpgradeRunStatusRollbackSwitching))
	if errors.Is(err, sql.ErrNoRows) {
		return SetUpgradeRun{}, false, nil
	}
	if err != nil {
		return SetUpgradeRun{}, false, err
	}
	switch run.Status {
	case SetUpgradeRunStatusSwitching:
		if activeGeneration != run.ToGeneration {
			return SetUpgradeRun{}, false, nil
		}
		run.Status = SetUpgradeRunStatusDraining
		run.DrainDeadline = now.Add(run.DrainTimeout)
		run.RollbackDeadline = now.Add(run.RollbackWindow)
		if _, err := tx.ExecContext(ctx, `
			UPDATE llmgateway_sets SET admin_writes_paused=0,admin_writes_pause_reason='',admin_writes_paused_at=NULL,updated_at=? WHERE id=?
		`, now, run.SetID); err != nil {
			return SetUpgradeRun{}, false, err
		}
	case SetUpgradeRunStatusRollbackSwitching:
		if activeGeneration != run.FromGeneration {
			return SetUpgradeRun{}, false, nil
		}
		run.Status = SetUpgradeRunStatusRollbackDraining
		run.DrainDeadline = now.Add(run.DrainTimeout)
	}
	run.UpdatedAt = now
	if err := updateSetUpgradeRunTx(ctx, tx, run); err != nil {
		return SetUpgradeRun{}, false, err
	}
	if err := tx.Commit(); err != nil {
		return SetUpgradeRun{}, false, err
	}
	return run, true, nil
}

func (s *MySQLStore) AdvanceSetUpgradeAfterDrain(ctx context.Context, claimed SetUpgradeRun, now time.Time) (SetUpgradeRun, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return SetUpgradeRun{}, err
	}
	defer tx.Rollback()
	run, err := scanSetUpgradeRun(tx.QueryRowContext(ctx, `SELECT `+setUpgradeRunColumns+` FROM llmgateway_set_upgrade_runs WHERE id=? FOR UPDATE`, claimed.ID))
	if err != nil {
		return SetUpgradeRun{}, err
	}
	if run.Status != SetUpgradeRunStatusDraining && run.Status != SetUpgradeRunStatusRollbackDraining {
		return SetUpgradeRun{}, fmt.Errorf("upgrade run %q is not draining", run.ID)
	}
	if run.LeaseOwner == "" || run.LeaseOwner != claimed.LeaseOwner || !run.LeaseUntil.After(now) {
		return SetUpgradeRun{}, fmt.Errorf("upgrade run lease is not owned or expired")
	}
	if now.Before(run.DrainDeadline) {
		return SetUpgradeRun{}, fmt.Errorf("drain deadline has not elapsed")
	}
	retiredGeneration := run.FromGeneration
	if run.Status == SetUpgradeRunStatusRollbackDraining {
		retiredGeneration = run.ToGeneration
		run.Status = SetUpgradeRunStatusRolledBack
	} else {
		run.Status = SetUpgradeRunStatusCompleted
	}
	if run.TargetReleaseID != "" {
		if run.Status == SetUpgradeRunStatusCompleted {
			if _, err := tx.ExecContext(ctx, `UPDATE llmgateway_sets SET current_release_id=?,target_release_id='',updated_at=? WHERE id=?`, run.TargetReleaseID, now, run.SetID); err != nil {
				return SetUpgradeRun{}, err
			}
		} else if _, err := tx.ExecContext(ctx, `UPDATE llmgateway_sets SET target_release_id='',updated_at=? WHERE id=?`, now, run.SetID); err != nil {
			return SetUpgradeRun{}, err
		}
	}
	if _, err := tx.ExecContext(ctx, `UPDATE llmgateway_set_runtimes SET status=?,updated_at=? WHERE set_id=? AND generation=?`, SetRuntimeStatusRetired, now, run.SetID, retiredGeneration); err != nil {
		return SetUpgradeRun{}, err
	}
	run.UpdatedAt = now
	if err := updateSetUpgradeRunTx(ctx, tx, run); err != nil {
		return SetUpgradeRun{}, err
	}
	return run, tx.Commit()
}

func (s *MySQLStore) CompleteSetUpgradeMaster(ctx context.Context, claimed SetUpgradeRun, success bool, lastError string, now time.Time) (SetUpgradeRun, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return SetUpgradeRun{}, err
	}
	defer tx.Rollback()
	run, err := claimedSetUpgradeRunTx(ctx, tx, claimed, SetUpgradeRunStatusUpgradingMaster, now)
	if err != nil {
		return SetUpgradeRun{}, err
	}
	if success {
		run.Status = SetUpgradeRunStatusVerifyingCompatibility
		run.LastError = ""
		run.MasterUpgradedAt = now
		if _, err := tx.ExecContext(ctx, `
			UPDATE llmgateway_sets
			SET admin_image=?, admin_health_status=?, admin_health_consecutive_failures=0,
				admin_health_error='', admin_health_checked_at=?, admin_health_last_success_at=?, updated_at=?
			WHERE id=?
		`, run.TargetImage, SetAdminHealthHealthy, now, now, now, run.SetID); err != nil {
			return SetUpgradeRun{}, err
		}
	} else {
		run.Status = SetUpgradeRunStatusFailed
		run.LastError = lastError
		if _, err := tx.ExecContext(ctx, `UPDATE llmgateway_sets SET admin_health_status=?,admin_health_error=?,updated_at=? WHERE id=?`, SetAdminHealthUnhealthy, lastError, now, run.SetID); err != nil {
			return SetUpgradeRun{}, err
		}
	}
	run.UpdatedAt = now
	if err := updateSetUpgradeRunTx(ctx, tx, run); err != nil {
		return SetUpgradeRun{}, err
	}
	return run, tx.Commit()
}

func (s *MySQLStore) RequestSetUpgradeRollback(ctx context.Context, id, reason string, now time.Time) (SetUpgradeRun, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return SetUpgradeRun{}, err
	}
	defer tx.Rollback()
	run, err := scanSetUpgradeRun(tx.QueryRowContext(ctx, `SELECT `+setUpgradeRunColumns+` FROM llmgateway_set_upgrade_runs WHERE id=? FOR UPDATE`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return SetUpgradeRun{}, fmt.Errorf("set upgrade run %q not found", id)
	}
	if err != nil {
		return SetUpgradeRun{}, err
	}
	if run.Status != SetUpgradeRunStatusDraining {
		return SetUpgradeRun{}, fmt.Errorf("set upgrade run %q is not rollbackable", id)
	}
	if !run.RollbackDeadline.IsZero() && now.After(run.RollbackDeadline) {
		return SetUpgradeRun{}, fmt.Errorf("rollback window expired")
	}
	run.RollbackRequested = true
	run.RollbackReason = strings.TrimSpace(reason)
	run.UpdatedAt = now
	if err := updateSetUpgradeRunTx(ctx, tx, run); err != nil {
		return SetUpgradeRun{}, err
	}
	return run, tx.Commit()
}

func (s *MySQLStore) RetrySetUpgradeRun(ctx context.Context, id string, now time.Time) (SetUpgradeRun, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return SetUpgradeRun{}, err
	}
	defer tx.Rollback()
	run, err := scanSetUpgradeRun(tx.QueryRowContext(ctx, `SELECT `+setUpgradeRunColumns+` FROM llmgateway_set_upgrade_runs WHERE id=? FOR UPDATE`, id))
	if err != nil {
		return SetUpgradeRun{}, err
	}
	if run.Status != SetUpgradeRunStatusFailed {
		return SetUpgradeRun{}, fmt.Errorf("set upgrade run %q is not retryable", id)
	}
	var activeGeneration int64
	if err := tx.QueryRowContext(ctx, `SELECT active_runtime_generation FROM llmgateway_sets WHERE id=? FOR UPDATE`, run.SetID).Scan(&activeGeneration); err != nil {
		return SetUpgradeRun{}, err
	}
	if activeGeneration == run.FromGeneration {
		run.Status = SetUpgradeRunStatusPending
		run.ConsecutiveProbeFailures = 0
		run.ConsecutiveProbeSuccesses = 0
	} else if activeGeneration == run.ToGeneration {
		run.Status = SetUpgradeRunStatusPreparing
	} else {
		return SetUpgradeRun{}, fmt.Errorf("set active runtime is inconsistent with upgrade run")
	}
	run.LeaseOwner = ""
	run.LeaseUntil = time.Time{}
	run.LastError = ""
	run.UpdatedAt = now
	if err := updateSetUpgradeRunTx(ctx, tx, run); err != nil {
		return SetUpgradeRun{}, err
	}
	return run, tx.Commit()
}

func (s *MySQLStore) ListSetRuntimeRouteOutbox(ctx context.Context, status string, limit int) ([]SetRuntimeRouteOutbox, error) {
	query := `SELECT id,set_id,route_revision,snapshot_json,status,attempts,last_error,created_at,updated_at FROM llmgateway_set_runtime_route_outbox`
	var args []any
	if status != "" {
		query += ` WHERE status=?`
		args = append(args, status)
	}
	query += ` ORDER BY route_revision,created_at`
	if limit > 0 {
		query += ` LIMIT ?`
		args = append(args, limit)
	}
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []SetRuntimeRouteOutbox
	for rows.Next() {
		item, err := scanSetRuntimeRouteOutbox(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

func (s *MySQLStore) CompleteSetRuntimeRouteOutbox(ctx context.Context, id string, success bool, lastError string, now time.Time) error {
	status := SetRuntimeRouteOutboxStatusPending
	if success {
		status = SetRuntimeRouteOutboxStatusPublished
	}
	result, err := s.db.ExecContext(ctx, `UPDATE llmgateway_set_runtime_route_outbox SET status=?,attempts=attempts+1,last_error=?,updated_at=? WHERE id=?`, status, lastError, now, id)
	if err != nil {
		return err
	}
	if affected, _ := result.RowsAffected(); affected == 0 {
		return fmt.Errorf("runtime route outbox %q not found", id)
	}
	return nil
}

func claimedSetUpgradeRunTx(ctx context.Context, tx *sql.Tx, claimed SetUpgradeRun, expected string, now time.Time) (SetUpgradeRun, error) {
	run, err := scanSetUpgradeRun(tx.QueryRowContext(ctx, `SELECT `+setUpgradeRunColumns+` FROM llmgateway_set_upgrade_runs WHERE id=? FOR UPDATE`, claimed.ID))
	if err != nil {
		return SetUpgradeRun{}, err
	}
	if run.Status != expected {
		return SetUpgradeRun{}, fmt.Errorf("upgrade run %q is not in %s", run.ID, expected)
	}
	if run.LeaseOwner == "" || run.LeaseOwner != claimed.LeaseOwner || !run.LeaseUntil.After(now) {
		return SetUpgradeRun{}, fmt.Errorf("upgrade run lease is not owned or expired")
	}
	var setStatus string
	var lifecycleGeneration int64
	if err := tx.QueryRowContext(ctx, `
		SELECT status,lifecycle_generation FROM llmgateway_sets WHERE id=? FOR UPDATE
	`, run.SetID).Scan(&setStatus, &lifecycleGeneration); err != nil {
		return SetUpgradeRun{}, err
	}
	if setStatus != SetStatusActive || lifecycleGeneration != run.LifecycleGeneration {
		return SetUpgradeRun{}, fmt.Errorf("set %q lifecycle changed during upgrade", run.SetID)
	}
	return run, nil
}

func updateSetUpgradeRunTx(ctx context.Context, tx *sql.Tx, run SetUpgradeRun) error {
	_, err := tx.ExecContext(ctx, `
		UPDATE llmgateway_set_upgrade_runs SET status=?,consecutive_probe_successes=?,consecutive_probe_failures=?,
			lease_owner=?,lease_until=?,switched_at=?,drain_deadline=?,rollback_deadline=?,rollback_requested=?,rollback_reason=?,
			master_upgraded_at=?,compatibility_checked_at=?,last_error=?,updated_at=? WHERE id=?
	`, run.Status, run.ConsecutiveProbeSuccesses, run.ConsecutiveProbeFailures, run.LeaseOwner, nullableTime(run.LeaseUntil),
		nullableTime(run.SwitchedAt), nullableTime(run.DrainDeadline), nullableTime(run.RollbackDeadline), run.RollbackRequested, run.RollbackReason,
		nullableTime(run.MasterUpgradedAt), nullableTime(run.CompatibilityCheckedAt), run.LastError, run.UpdatedAt, run.ID)
	return err
}

func insertSetRuntimeRouteOutboxTx(ctx context.Context, tx *sql.Tx, snapshot SetRuntimeRouteSnapshot, now time.Time) error {
	raw, err := json.Marshal(snapshot)
	if err != nil {
		return err
	}
	id := fmt.Sprintf("%s-%d", snapshot.SetID, snapshot.RouteRevision)
	_, err = tx.ExecContext(ctx, `
		INSERT INTO llmgateway_set_runtime_route_outbox (id,set_id,route_revision,snapshot_json,status,attempts,last_error,created_at,updated_at)
		VALUES (?,?,?,?,?,0,'',?,?)
	`, id, snapshot.SetID, snapshot.RouteRevision, raw, SetRuntimeRouteOutboxStatusPending, now, now)
	if isMySQLDuplicateKeyError(err) {
		return fmt.Errorf("runtime route outbox revision %d for set %q already exists", snapshot.RouteRevision, snapshot.SetID)
	}
	return err
}

func setUpgradeRunValues(run SetUpgradeRun) []any {
	return []any{run.ID, run.BatchID, run.SetID, run.Source, run.Namespace, run.Fleet, run.TargetImage,
		run.FromReleaseID, run.TargetReleaseID, run.Sequence,
		run.FromGeneration, run.ToGeneration, run.LifecycleGeneration, run.Status, run.ConsecutiveProbeSuccesses, run.ConsecutiveProbeFailures,
		int64(run.DrainTimeout / time.Second), int64(run.RollbackWindow / time.Second), run.LeaseOwner, nullableTime(run.LeaseUntil),
		nullableTime(run.SwitchedAt), nullableTime(run.DrainDeadline), nullableTime(run.RollbackDeadline), run.RollbackRequested, run.RollbackReason,
		nullableTime(run.MasterUpgradedAt), nullableTime(run.CompatibilityCheckedAt), run.LastError, run.CreatedAt, run.UpdatedAt}
}

func scanSetRuntime(row scanner) (SetRuntime, error) {
	var runtime SetRuntime
	err := row.Scan(&runtime.SetID, &runtime.Generation, &runtime.ReleaseID, &runtime.Image, &runtime.TrafficBaseURL, &runtime.Status, &runtime.CreatedAt, &runtime.UpdatedAt)
	return runtime, err
}

func scanSetUpgradeRun(row scanner) (SetUpgradeRun, error) {
	var run SetUpgradeRun
	var drainSeconds, rollbackSeconds int64
	var leaseUntil, switchedAt, drainDeadline, rollbackDeadline, masterUpgradedAt, compatibilityCheckedAt sql.NullTime
	err := row.Scan(&run.ID, &run.BatchID, &run.SetID, &run.Source, &run.Namespace, &run.Fleet, &run.TargetImage,
		&run.FromReleaseID, &run.TargetReleaseID, &run.Sequence,
		&run.FromGeneration, &run.ToGeneration, &run.LifecycleGeneration, &run.Status, &run.ConsecutiveProbeSuccesses, &run.ConsecutiveProbeFailures,
		&drainSeconds, &rollbackSeconds, &run.LeaseOwner, &leaseUntil, &switchedAt, &drainDeadline, &rollbackDeadline,
		&run.RollbackRequested, &run.RollbackReason, &masterUpgradedAt, &compatibilityCheckedAt,
		&run.LastError, &run.CreatedAt, &run.UpdatedAt)
	if err != nil {
		return SetUpgradeRun{}, err
	}
	run.DrainTimeout = time.Duration(drainSeconds) * time.Second
	run.RollbackWindow = time.Duration(rollbackSeconds) * time.Second
	if leaseUntil.Valid {
		run.LeaseUntil = leaseUntil.Time.UTC()
	}
	if switchedAt.Valid {
		run.SwitchedAt = switchedAt.Time.UTC()
	}
	if drainDeadline.Valid {
		run.DrainDeadline = drainDeadline.Time.UTC()
	}
	if rollbackDeadline.Valid {
		run.RollbackDeadline = rollbackDeadline.Time.UTC()
	}
	if masterUpgradedAt.Valid {
		run.MasterUpgradedAt = masterUpgradedAt.Time.UTC()
	}
	if compatibilityCheckedAt.Valid {
		run.CompatibilityCheckedAt = compatibilityCheckedAt.Time.UTC()
	}
	return run, nil
}

func scanSetRuntimeRouteOutbox(row scanner) (SetRuntimeRouteOutbox, error) {
	var item SetRuntimeRouteOutbox
	var raw []byte
	if err := row.Scan(&item.ID, &item.SetID, &item.RouteRevision, &raw, &item.Status, &item.Attempts, &item.LastError, &item.CreatedAt, &item.UpdatedAt); err != nil {
		return SetRuntimeRouteOutbox{}, err
	}
	if err := json.Unmarshal(raw, &item.Snapshot); err != nil {
		return SetRuntimeRouteOutbox{}, err
	}
	return item, nil
}

func sortedUpgradeRuns(runs []SetUpgradeRun) []SetUpgradeRun {
	sort.Slice(runs, func(i, j int) bool { return runs[i].ID < runs[j].ID })
	return runs
}
