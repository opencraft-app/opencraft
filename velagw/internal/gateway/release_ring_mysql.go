package gateway

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

func (s *MySQLStore) SaveNewAPIRelease(ctx context.Context, release NewAPIRelease) error {
	if existing, ok, err := s.GetNewAPIRelease(ctx, release.ID); err != nil {
		return err
	} else if ok {
		if existing.Source != release.Source || existing.Namespace != release.Namespace || existing.Fleet != release.Fleet ||
			existing.Version != release.Version || existing.Image != release.Image || existing.Compatibility != release.Compatibility || existing.Status != release.Status {
			return fmt.Errorf("new-api release %q is immutable", release.ID)
		}
		return nil
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO llmgateway_newapi_releases
			(id,source,namespace_name,fleet,version,image,compatibility,status,created_at,updated_at)
		VALUES (?,?,?,?,?,?,?,?,?,?)
	`, release.ID, release.Source, release.Namespace, release.Fleet, release.Version, release.Image,
		release.Compatibility, release.Status, release.CreatedAt, release.UpdatedAt)
	return err
}

func (s *MySQLStore) GetNewAPIRelease(ctx context.Context, id string) (NewAPIRelease, bool, error) {
	release, err := scanNewAPIRelease(s.db.QueryRowContext(ctx, `
		SELECT id,source,namespace_name,fleet,version,image,compatibility,status,created_at,updated_at
		FROM llmgateway_newapi_releases WHERE id=?
	`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return NewAPIRelease{}, false, nil
	}
	return release, err == nil, err
}

func (s *MySQLStore) ListNewAPIReleases(ctx context.Context) ([]NewAPIRelease, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id,source,namespace_name,fleet,version,image,compatibility,status,created_at,updated_at
		FROM llmgateway_newapi_releases ORDER BY created_at,id
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]NewAPIRelease, 0)
	for rows.Next() {
		release, scanErr := scanNewAPIRelease(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		result = append(result, release)
	}
	return result, rows.Err()
}

func (s *MySQLStore) SaveReleaseRing(ctx context.Context, ring ReleaseRing) error {
	if existing, ok, err := s.GetReleaseRing(ctx, ring.ID); err != nil {
		return err
	} else if ok {
		ring.CreatedAt = existing.CreatedAt
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO llmgateway_release_rings
			(id,source,namespace_name,fleet,name,ordinal,serving_release_id,target_release_id,status,
			 admission_enabled,max_parallel,soak_seconds,created_at,updated_at)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
		ON DUPLICATE KEY UPDATE name=VALUES(name),ordinal=VALUES(ordinal),
			serving_release_id=VALUES(serving_release_id),target_release_id=VALUES(target_release_id),status=VALUES(status),
			admission_enabled=VALUES(admission_enabled),max_parallel=VALUES(max_parallel),soak_seconds=VALUES(soak_seconds),
			updated_at=VALUES(updated_at)
	`, ring.ID, ring.Source, ring.Namespace, ring.Fleet, ring.Name, ring.Ordinal, ring.ServingReleaseID,
		ring.TargetReleaseID, ring.Status, ring.AdmissionEnabled, ring.MaxParallel, ring.SoakSeconds,
		ring.CreatedAt, ring.UpdatedAt)
	return err
}

func (s *MySQLStore) GetReleaseRing(ctx context.Context, id string) (ReleaseRing, bool, error) {
	ring, err := scanReleaseRing(s.db.QueryRowContext(ctx, `
		SELECT id,source,namespace_name,fleet,name,ordinal,serving_release_id,target_release_id,status,
			admission_enabled,max_parallel,soak_seconds,created_at,updated_at
		FROM llmgateway_release_rings WHERE id=?
	`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return ReleaseRing{}, false, nil
	}
	return ring, err == nil, err
}

func (s *MySQLStore) ListReleaseRings(ctx context.Context) ([]ReleaseRing, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id,source,namespace_name,fleet,name,ordinal,serving_release_id,target_release_id,status,
			admission_enabled,max_parallel,soak_seconds,created_at,updated_at
		FROM llmgateway_release_rings ORDER BY ordinal,id
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]ReleaseRing, 0)
	for rows.Next() {
		ring, scanErr := scanReleaseRing(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		result = append(result, ring)
	}
	return result, rows.Err()
}

func (s *MySQLStore) SaveReleaseRollout(ctx context.Context, rollout ReleaseRollout) error {
	if existing, ok, err := s.GetReleaseRollout(ctx, rollout.ID); err != nil {
		return err
	} else if ok {
		rollout.CreatedAt = existing.CreatedAt
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO llmgateway_release_rollouts
			(id,ring_id,target_release_id,batch_id,status,total_sets,completed_sets,failed_sets,current_set_id,campaign_id,campaign_sequence,
			 soak_started_at,soak_deadline,last_gate_checked_at,last_gate_error,created_at,updated_at)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
		ON DUPLICATE KEY UPDATE status=VALUES(status),total_sets=VALUES(total_sets),completed_sets=VALUES(completed_sets),
			failed_sets=VALUES(failed_sets),current_set_id=VALUES(current_set_id),soak_started_at=VALUES(soak_started_at),
			soak_deadline=VALUES(soak_deadline),last_gate_checked_at=VALUES(last_gate_checked_at),
			last_gate_error=VALUES(last_gate_error),updated_at=VALUES(updated_at)
	`, rollout.ID, rollout.RingID, rollout.TargetReleaseID, rollout.BatchID, rollout.Status,
		rollout.TotalSets, rollout.CompletedSets, rollout.FailedSets, rollout.CurrentSetID, rollout.CampaignID, rollout.CampaignSequence,
		nullableTime(rollout.SoakStartedAt), nullableTime(rollout.SoakDeadline), nullableTime(rollout.LastGateCheckedAt), rollout.LastGateError,
		rollout.CreatedAt, rollout.UpdatedAt)
	return err
}

func (s *MySQLStore) GetReleaseRollout(ctx context.Context, id string) (ReleaseRollout, bool, error) {
	rollout, err := scanReleaseRollout(s.db.QueryRowContext(ctx, `
		SELECT id,ring_id,target_release_id,batch_id,status,total_sets,completed_sets,failed_sets,current_set_id,campaign_id,campaign_sequence,
			soak_started_at,soak_deadline,last_gate_checked_at,last_gate_error,created_at,updated_at
		FROM llmgateway_release_rollouts WHERE id=?
	`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return ReleaseRollout{}, false, nil
	}
	return rollout, err == nil, err
}

func (s *MySQLStore) GetReleaseRolloutByCampaignStep(ctx context.Context, campaignID string, sequence int) (ReleaseRollout, bool, error) {
	rollout, err := scanReleaseRollout(s.db.QueryRowContext(ctx, `
		SELECT id,ring_id,target_release_id,batch_id,status,total_sets,completed_sets,failed_sets,current_set_id,
			campaign_id,campaign_sequence,soak_started_at,soak_deadline,last_gate_checked_at,last_gate_error,created_at,updated_at
		FROM llmgateway_release_rollouts WHERE campaign_id=? AND campaign_sequence=? ORDER BY created_at DESC LIMIT 1
	`, campaignID, sequence))
	if errors.Is(err, sql.ErrNoRows) {
		return ReleaseRollout{}, false, nil
	}
	return rollout, err == nil, err
}

func (s *MySQLStore) ListReleaseRollouts(ctx context.Context, ringID string, limit int) ([]ReleaseRollout, error) {
	query := `SELECT id,ring_id,target_release_id,batch_id,status,total_sets,completed_sets,failed_sets,current_set_id,campaign_id,campaign_sequence,soak_started_at,soak_deadline,last_gate_checked_at,last_gate_error,created_at,updated_at FROM llmgateway_release_rollouts`
	args := make([]any, 0, 2)
	if ringID != "" {
		query += ` WHERE ring_id=?`
		args = append(args, ringID)
	}
	query += ` ORDER BY (status IN ('completed','failed')) ASC,created_at DESC,id DESC`
	if limit > 0 {
		query += ` LIMIT ?`
		args = append(args, limit)
	}
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]ReleaseRollout, 0)
	for rows.Next() {
		rollout, scanErr := scanReleaseRollout(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		result = append(result, rollout)
	}
	return result, rows.Err()
}

func (s *MySQLStore) SaveReleaseRolloutAndRing(ctx context.Context, rollout ReleaseRollout, ring ReleaseRing) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(ctx, `
		UPDATE llmgateway_release_rollouts
		SET status=?,total_sets=?,completed_sets=?,failed_sets=?,current_set_id=?,soak_started_at=?,soak_deadline=?,
			last_gate_checked_at=?,last_gate_error=?,updated_at=? WHERE id=?
	`, rollout.Status, rollout.TotalSets, rollout.CompletedSets, rollout.FailedSets, rollout.CurrentSetID,
		nullableTime(rollout.SoakStartedAt), nullableTime(rollout.SoakDeadline), nullableTime(rollout.LastGateCheckedAt),
		rollout.LastGateError, rollout.UpdatedAt, rollout.ID)
	if err != nil {
		return err
	}
	if affected, err := result.RowsAffected(); err != nil || affected != 1 {
		if err != nil {
			return err
		}
		return fmt.Errorf("release rollout %q not found", rollout.ID)
	}
	result, err = tx.ExecContext(ctx, `
		UPDATE llmgateway_release_rings
		SET serving_release_id=?,target_release_id=?,status=?,updated_at=? WHERE id=?
	`, ring.ServingReleaseID, ring.TargetReleaseID, ring.Status, ring.UpdatedAt, ring.ID)
	if err != nil {
		return err
	}
	if affected, err := result.RowsAffected(); err != nil || affected != 1 {
		if err != nil {
			return err
		}
		return fmt.Errorf("release ring %q not found", ring.ID)
	}
	return tx.Commit()
}

func (s *MySQLStore) CreateReleaseRolloutPlan(ctx context.Context, ring ReleaseRing, rollout ReleaseRollout, batch SetUpgradeBatch) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	currentRing, err := scanReleaseRing(tx.QueryRowContext(ctx, `
		SELECT id,source,namespace_name,fleet,name,ordinal,serving_release_id,target_release_id,status,
			admission_enabled,max_parallel,soak_seconds,created_at,updated_at
		FROM llmgateway_release_rings WHERE id=? FOR UPDATE
	`, ring.ID))
	if errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("release ring %q not found", ring.ID)
	}
	if err != nil {
		return err
	}
	if currentRing.Status != ReleaseRingStatusSteady {
		return fmt.Errorf("release ring %q is not steady", ring.ID)
	}
	for index := range batch.Runs {
		run := &batch.Runs[index]
		var setStatus, releaseRingID, currentReleaseID, targetReleaseID string
		var activeGeneration, lastGeneration, lifecycleGeneration, maxRuntimeGeneration int64
		if err := tx.QueryRowContext(ctx, `
			SELECT status,release_ring_id,current_release_id,target_release_id,active_runtime_generation,last_runtime_generation,lifecycle_generation
			FROM llmgateway_sets WHERE id=? FOR UPDATE
		`, run.SetID).Scan(&setStatus, &releaseRingID, &currentReleaseID, &targetReleaseID, &activeGeneration, &lastGeneration, &lifecycleGeneration); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return fmt.Errorf("set %q not found", run.SetID)
			}
			return err
		}
		if setStatus != SetStatusActive || releaseRingID != ring.ID || targetReleaseID != "" ||
			currentReleaseID != run.FromReleaseID || activeGeneration != run.FromGeneration || lifecycleGeneration != run.LifecycleGeneration {
			return fmt.Errorf("set %q changed while creating release rollout", run.SetID)
		}
		if err := tx.QueryRowContext(ctx, `SELECT COALESCE(MAX(generation),0) FROM llmgateway_set_runtimes WHERE set_id=?`, run.SetID).Scan(&maxRuntimeGeneration); err != nil {
			return err
		}
		if maxRuntimeGeneration > lastGeneration {
			lastGeneration = maxRuntimeGeneration
		}
		if activeGeneration > lastGeneration {
			lastGeneration = activeGeneration
		}
		run.ToGeneration = lastGeneration + 1
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
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO llmgateway_set_upgrade_batches
			(id,rollout_id,ring_id,target_release_id,target_image,status,max_parallel,stop_on_failure,created_at,updated_at)
		VALUES (?,?,?,?,?,?,?,?,?,?)
	`, batch.ID, batch.RolloutID, batch.RingID, batch.TargetReleaseID, batch.TargetImage, batch.Status,
		batch.MaxParallel, batch.StopOnFailure, batch.CreatedAt, batch.UpdatedAt); err != nil {
		return err
	}
	for _, run := range batch.Runs {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO llmgateway_set_upgrade_runs (`+setUpgradeRunColumns+`)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`, setUpgradeRunValues(run)...); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `
			UPDATE llmgateway_sets SET target_release_id=?,last_runtime_generation=?,updated_at=? WHERE id=?
		`, run.TargetReleaseID, run.ToGeneration, rollout.UpdatedAt, run.SetID); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE llmgateway_release_rings SET target_release_id=?,status=?,updated_at=? WHERE id=?
	`, ring.TargetReleaseID, ring.Status, ring.UpdatedAt, ring.ID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO llmgateway_release_rollouts
			(id,ring_id,target_release_id,batch_id,status,total_sets,completed_sets,failed_sets,current_set_id,
			 campaign_id,campaign_sequence,soak_started_at,soak_deadline,last_gate_checked_at,last_gate_error,created_at,updated_at)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
	`, rollout.ID, rollout.RingID, rollout.TargetReleaseID, rollout.BatchID, rollout.Status,
		rollout.TotalSets, rollout.CompletedSets, rollout.FailedSets, rollout.CurrentSetID,
		rollout.CampaignID, rollout.CampaignSequence, nullableTime(rollout.SoakStartedAt), nullableTime(rollout.SoakDeadline),
		nullableTime(rollout.LastGateCheckedAt), rollout.LastGateError,
		rollout.CreatedAt, rollout.UpdatedAt); err != nil {
		return err
	}
	return tx.Commit()
}

func scanNewAPIRelease(row scanner) (NewAPIRelease, error) {
	var release NewAPIRelease
	err := row.Scan(&release.ID, &release.Source, &release.Namespace, &release.Fleet, &release.Version,
		&release.Image, &release.Compatibility, &release.Status, &release.CreatedAt, &release.UpdatedAt)
	return release, err
}

func scanReleaseRing(row scanner) (ReleaseRing, error) {
	var ring ReleaseRing
	err := row.Scan(&ring.ID, &ring.Source, &ring.Namespace, &ring.Fleet, &ring.Name, &ring.Ordinal,
		&ring.ServingReleaseID, &ring.TargetReleaseID, &ring.Status, &ring.AdmissionEnabled,
		&ring.MaxParallel, &ring.SoakSeconds, &ring.CreatedAt, &ring.UpdatedAt)
	ring.SoakDuration = time.Duration(ring.SoakSeconds) * time.Second
	return ring, err
}

func scanReleaseRollout(row scanner) (ReleaseRollout, error) {
	var rollout ReleaseRollout
	var soakStartedAt, soakDeadline, lastGateCheckedAt sql.NullTime
	var lastGateError sql.NullString
	err := row.Scan(&rollout.ID, &rollout.RingID, &rollout.TargetReleaseID, &rollout.BatchID, &rollout.Status,
		&rollout.TotalSets, &rollout.CompletedSets, &rollout.FailedSets, &rollout.CurrentSetID,
		&rollout.CampaignID, &rollout.CampaignSequence,
		&soakStartedAt, &soakDeadline, &lastGateCheckedAt, &lastGateError,
		&rollout.CreatedAt, &rollout.UpdatedAt)
	rollout.LastGateError = lastGateError.String
	if soakStartedAt.Valid {
		rollout.SoakStartedAt = soakStartedAt.Time.UTC()
	}
	if soakDeadline.Valid {
		rollout.SoakDeadline = soakDeadline.Time.UTC()
	}
	if lastGateCheckedAt.Valid {
		rollout.LastGateCheckedAt = lastGateCheckedAt.Time.UTC()
	}
	return rollout, err
}
