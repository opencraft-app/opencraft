package gateway

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

func (s *MySQLStore) CreateReleaseCampaign(ctx context.Context, campaign ReleaseCampaign, rings []ReleaseCampaignRing) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO llmgateway_release_campaign_scopes
			(source,namespace_name,fleet,active_campaign_id,updated_at)
		VALUES (?,?,?,'',?)
		ON DUPLICATE KEY UPDATE fleet=VALUES(fleet)
	`, campaign.Source, campaign.Namespace, campaign.Fleet, campaign.UpdatedAt); err != nil {
		return err
	}
	var activeID string
	if err := tx.QueryRowContext(ctx, `
		SELECT active_campaign_id FROM llmgateway_release_campaign_scopes
		WHERE source=? AND namespace_name=? AND fleet=? FOR UPDATE
	`, campaign.Source, campaign.Namespace, campaign.Fleet).Scan(&activeID); err != nil {
		return err
	}
	if activeID != "" {
		var activeStatus string
		err := tx.QueryRowContext(ctx, `SELECT status FROM llmgateway_release_campaigns WHERE id=?`, activeID).Scan(&activeStatus)
		if err == nil && activeStatus != ReleaseCampaignStatusCompleted {
			return fmt.Errorf("fleet %q already has active release campaign %q", campaign.Fleet, activeID)
		}
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO llmgateway_release_campaigns
			(id,source,namespace_name,fleet,target_release_id,status,current_ring_id,current_rollout_id,
			 total_rings,completed_rings,last_error,created_at,updated_at)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
	`, campaign.ID, campaign.Source, campaign.Namespace, campaign.Fleet, campaign.TargetReleaseID, campaign.Status,
		campaign.CurrentRingID, campaign.CurrentRolloutID, campaign.TotalRings, campaign.CompletedRings,
		campaign.LastError, campaign.CreatedAt, campaign.UpdatedAt); err != nil {
		return err
	}
	for _, ring := range rings {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO llmgateway_release_campaign_rings
				(campaign_id,sequence_no,ring_id,status,rollout_id,last_error,created_at,updated_at)
			VALUES (?,?,?,?,?,?,?,?)
		`, ring.CampaignID, ring.Sequence, ring.RingID, ring.Status, ring.RolloutID, ring.LastError,
			ring.CreatedAt, ring.UpdatedAt); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE llmgateway_release_campaign_scopes SET active_campaign_id=?,updated_at=?
		WHERE source=? AND namespace_name=? AND fleet=?
	`, campaign.ID, campaign.UpdatedAt, campaign.Source, campaign.Namespace, campaign.Fleet); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *MySQLStore) GetReleaseCampaign(ctx context.Context, id string) (ReleaseCampaign, bool, error) {
	campaign, err := scanReleaseCampaign(s.db.QueryRowContext(ctx, releaseCampaignSelect+` WHERE id=?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return ReleaseCampaign{}, false, nil
	}
	if err != nil {
		return ReleaseCampaign{}, false, err
	}
	campaign.Rings, err = s.listReleaseCampaignRings(ctx, campaign.ID)
	return campaign, err == nil, err
}

func (s *MySQLStore) ListReleaseCampaigns(ctx context.Context, limit int) ([]ReleaseCampaign, error) {
	query := releaseCampaignSelect + ` ORDER BY (status='completed') ASC,created_at DESC,id DESC`
	args := []any{}
	if limit > 0 {
		query += ` LIMIT ?`
		args = append(args, limit)
	}
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	result := make([]ReleaseCampaign, 0)
	for rows.Next() {
		campaign, scanErr := scanReleaseCampaign(rows)
		if scanErr != nil {
			rows.Close()
			return nil, scanErr
		}
		result = append(result, campaign)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	for index := range result {
		result[index].Rings, err = s.listReleaseCampaignRings(ctx, result[index].ID)
		if err != nil {
			return nil, err
		}
	}
	return result, nil
}

func (s *MySQLStore) SaveReleaseCampaign(ctx context.Context, campaign ReleaseCampaign, ring ReleaseCampaignRing) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(ctx, `
		UPDATE llmgateway_release_campaigns
		SET status=?,current_ring_id=?,current_rollout_id=?,total_rings=?,completed_rings=?,last_error=?,updated_at=?
		WHERE id=?
	`, campaign.Status, campaign.CurrentRingID, campaign.CurrentRolloutID, campaign.TotalRings,
		campaign.CompletedRings, campaign.LastError, campaign.UpdatedAt, campaign.ID)
	if err != nil {
		return err
	}
	if affected, err := result.RowsAffected(); err != nil || affected != 1 {
		if err != nil {
			return err
		}
		return fmt.Errorf("release campaign %q not found", campaign.ID)
	}
	if ring.CampaignID != "" {
		result, err = tx.ExecContext(ctx, `
			UPDATE llmgateway_release_campaign_rings
			SET status=?,rollout_id=?,last_error=?,updated_at=?
			WHERE campaign_id=? AND sequence_no=?
		`, ring.Status, ring.RolloutID, ring.LastError, ring.UpdatedAt, ring.CampaignID, ring.Sequence)
		if err != nil {
			return err
		}
		if affected, err := result.RowsAffected(); err != nil || affected != 1 {
			if err != nil {
				return err
			}
			return fmt.Errorf("release campaign ring %q/%d not found", ring.CampaignID, ring.Sequence)
		}
	}
	return tx.Commit()
}

func (s *MySQLStore) ResumeReleaseCampaign(ctx context.Context, campaign ReleaseCampaign, step ReleaseCampaignRing, rollout ReleaseRollout, ring ReleaseRing) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	updates := []struct {
		query string
		args  []any
		name  string
	}{
		{`UPDATE llmgateway_release_campaigns SET status=?,current_ring_id=?,current_rollout_id=?,completed_rings=?,last_error=?,updated_at=? WHERE id=?`,
			[]any{campaign.Status, campaign.CurrentRingID, campaign.CurrentRolloutID, campaign.CompletedRings, campaign.LastError, campaign.UpdatedAt, campaign.ID}, "campaign"},
		{`UPDATE llmgateway_release_campaign_rings SET status=?,rollout_id=?,last_error=?,updated_at=? WHERE campaign_id=? AND sequence_no=?`,
			[]any{step.Status, step.RolloutID, step.LastError, step.UpdatedAt, step.CampaignID, step.Sequence}, "campaign ring"},
		{`UPDATE llmgateway_release_rollouts SET status=?,soak_started_at=?,soak_deadline=?,last_gate_checked_at=?,last_gate_error=?,updated_at=? WHERE id=?`,
			[]any{rollout.Status, nullableTime(rollout.SoakStartedAt), nullableTime(rollout.SoakDeadline), nullableTime(rollout.LastGateCheckedAt), rollout.LastGateError, rollout.UpdatedAt, rollout.ID}, "rollout"},
		{`UPDATE llmgateway_release_rings SET status=?,target_release_id=?,updated_at=? WHERE id=?`,
			[]any{ring.Status, ring.TargetReleaseID, ring.UpdatedAt, ring.ID}, "release ring"},
	}
	for _, update := range updates {
		result, execErr := tx.ExecContext(ctx, update.query, update.args...)
		if execErr != nil {
			return execErr
		}
		if affected, rowsErr := result.RowsAffected(); rowsErr != nil || affected != 1 {
			if rowsErr != nil {
				return rowsErr
			}
			return fmt.Errorf("%s changed while resuming release campaign", update.name)
		}
	}
	return tx.Commit()
}

func (s *MySQLStore) listReleaseCampaignRings(ctx context.Context, campaignID string) ([]ReleaseCampaignRing, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT campaign_id,sequence_no,ring_id,status,rollout_id,last_error,created_at,updated_at
		FROM llmgateway_release_campaign_rings WHERE campaign_id=? ORDER BY sequence_no
	`, campaignID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]ReleaseCampaignRing, 0)
	for rows.Next() {
		var ring ReleaseCampaignRing
		if err := rows.Scan(&ring.CampaignID, &ring.Sequence, &ring.RingID, &ring.Status, &ring.RolloutID,
			&ring.LastError, &ring.CreatedAt, &ring.UpdatedAt); err != nil {
			return nil, err
		}
		result = append(result, ring)
	}
	return result, rows.Err()
}

const releaseCampaignSelect = `SELECT id,source,namespace_name,fleet,target_release_id,status,current_ring_id,
	current_rollout_id,total_rings,completed_rings,last_error,created_at,updated_at FROM llmgateway_release_campaigns`

func scanReleaseCampaign(row scanner) (ReleaseCampaign, error) {
	var campaign ReleaseCampaign
	err := row.Scan(&campaign.ID, &campaign.Source, &campaign.Namespace, &campaign.Fleet,
		&campaign.TargetReleaseID, &campaign.Status, &campaign.CurrentRingID, &campaign.CurrentRolloutID,
		&campaign.TotalRings, &campaign.CompletedRings, &campaign.LastError, &campaign.CreatedAt, &campaign.UpdatedAt)
	return campaign, err
}
