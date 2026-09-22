package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"

	"git.woa.com/wisp/mono/referral/internal/domain"
)

var _ AttributionAdminStore = (*MySQLStore)(nil)

func (s *MySQLStore) AttributionResetPreview(ctx context.Context, inviteeUserID, attributionID string) (*domain.AttributionResetPreview, error) {
	inviteeUserID = strings.TrimSpace(inviteeUserID)
	if inviteeUserID == "" {
		return nil, fmt.Errorf("invitee_user_id is required")
	}
	return loadAttributionResetPreview(ctx, s.db, inviteeUserID, attributionID, false)
}

func (s *MySQLStore) AttributionResetResult(ctx context.Context, idempotencyKey string) (*domain.AttributionResetResult, error) {
	idempotencyKey = strings.TrimSpace(idempotencyKey)
	if idempotencyKey == "" {
		return nil, nil
	}
	result, err := scanAttributionResetResult(s.db.QueryRowContext(ctx, `
		SELECT operation_id, idempotency_key, invitee_user_id, attribution_id,
		       reward_count, revoked_subscription_count, completed_at
		FROM referral_attribution_reset_audit WHERE idempotency_key = ?
	`, idempotencyKey))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return result, err
}

func (s *MySQLStore) CompleteAttributionReset(
	ctx context.Context,
	expected domain.AttributionResetPreview,
	idempotencyKey string,
	operatorID string,
	reason string,
	completedAt time.Time,
) (*domain.AttributionResetResult, error) {
	idempotencyKey = strings.TrimSpace(idempotencyKey)
	operatorID = strings.TrimSpace(operatorID)
	reason = strings.TrimSpace(reason)
	if idempotencyKey == "" || operatorID == "" || reason == "" {
		return nil, fmt.Errorf("idempotency_key, operator and reason are required")
	}

	var completed *domain.AttributionResetResult
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		if existing, err := scanAttributionResetResult(tx.QueryRowContext(ctx, `
			SELECT operation_id, idempotency_key, invitee_user_id, attribution_id,
			       reward_count, revoked_subscription_count, completed_at
			FROM referral_attribution_reset_audit WHERE idempotency_key = ?
		`, idempotencyKey)); err == nil {
			if existing.InviteeUserID != expected.Attribution.InviteeUserID || existing.AttributionID != expected.Attribution.ID {
				return domain.ErrAttributionResetConflict
			}
			completed = existing
			return nil
		} else if !errors.Is(err, sql.ErrNoRows) {
			return err
		}

		current, err := loadAttributionResetPreview(ctx, tx, expected.Attribution.InviteeUserID, expected.Attribution.ID, true)
		if err != nil {
			return err
		}
		if current.Attribution.ID != expected.Attribution.ID || !sameAttributionRewards(current.Rewards, expected.Rewards) {
			return domain.ErrAttributionResetConflict
		}
		current.Resettable = true

		snapshot, err := json.Marshal(current)
		if err != nil {
			return fmt.Errorf("marshal attribution reset snapshot: %w", err)
		}
		operationID := "rrst_" + uuid.NewString()
		revokedSubscriptions := 0
		for _, reward := range current.Rewards {
			if strings.TrimSpace(reward.SubscriptionName) != "" {
				revokedSubscriptions++
			}
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO referral_attribution_reset_audit (
				operation_id, idempotency_key, attribution_id, campaign_id,
				invitee_user_id, inviter_user_id, referral_code,
				operator_id, reason, reward_count, revoked_subscription_count,
				snapshot_json, created_at, completed_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`, operationID, idempotencyKey, current.Attribution.ID, current.Attribution.CampaignID,
			current.Attribution.InviteeUserID, current.Attribution.InviterUserID, current.Attribution.ReferralCode,
			operatorID, reason, len(current.Rewards), revokedSubscriptions,
			snapshot, completedAt.UTC(), completedAt.UTC()); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `
			DELETE FROM referral_reward WHERE campaign_id = ? AND invitee_user_id = ?
		`, current.Attribution.CampaignID, current.Attribution.InviteeUserID); err != nil {
			return err
		}
		result, err := tx.ExecContext(ctx, `DELETE FROM referral_attribution WHERE attribution_id = ?`, current.Attribution.ID)
		if err != nil {
			return err
		}
		if affected, err := result.RowsAffected(); err != nil || affected != 1 {
			if err != nil {
				return err
			}
			return domain.ErrAttributionResetConflict
		}
		completed = &domain.AttributionResetResult{
			OperationID: operationID, IdempotencyKey: idempotencyKey,
			InviteeUserID: current.Attribution.InviteeUserID, AttributionID: current.Attribution.ID,
			RewardsRemoved: len(current.Rewards), SubscriptionsRevoked: revokedSubscriptions,
			CompletedAt: completedAt.UTC(),
		}
		return nil
	})
	return completed, err
}

type queryRower interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

func loadAttributionResetPreview(ctx context.Context, q queryRower, inviteeUserID, attributionID string, forUpdate bool) (*domain.AttributionResetPreview, error) {
	lock := ""
	if forUpdate {
		lock = " FOR UPDATE"
	}
	var attribution domain.Attribution
	err := q.QueryRowContext(ctx, `
		SELECT attribution_id, campaign_id, invitee_user_id, inviter_user_id,
		       referral_code, registration_event_id, registered_at, created_at
		FROM referral_attribution
		WHERE invitee_user_id = ? AND (? = '' OR attribution_id = ?)
		ORDER BY registered_at DESC LIMIT 1`+lock,
		strings.TrimSpace(inviteeUserID), strings.TrimSpace(attributionID), strings.TrimSpace(attributionID)).Scan(
		&attribution.ID, &attribution.CampaignID, &attribution.InviteeUserID, &attribution.InviterUserID,
		&attribution.ReferralCode, &attribution.RegistrationEventID, &attribution.RegisteredAt, &attribution.CreatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, domain.ErrAttributionNotFound
	}
	if err != nil {
		return nil, err
	}
	rows, err := q.QueryContext(ctx, `
		SELECT reward_id, beneficiary_user_id, reward_side, credit_amount, status,
		       COALESCE(subscription_id, ''), COALESCE(subscription_name, '')
		FROM referral_reward WHERE campaign_id = ? AND invitee_user_id = ?
		ORDER BY reward_side, reward_id`+lock, attribution.CampaignID, attribution.InviteeUserID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	rewards := make([]domain.AttributionReward, 0, 2)
	for rows.Next() {
		var reward domain.AttributionReward
		if err := rows.Scan(&reward.ID, &reward.BeneficiaryUserID, &reward.Side, &reward.CreditAmount,
			&reward.Status, &reward.SubscriptionID, &reward.SubscriptionName); err != nil {
			return nil, err
		}
		rewards = append(rewards, reward)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return &domain.AttributionResetPreview{Attribution: attribution, Rewards: rewards}, nil
}

func scanAttributionResetResult(row *sql.Row) (*domain.AttributionResetResult, error) {
	var result domain.AttributionResetResult
	err := row.Scan(&result.OperationID, &result.IdempotencyKey, &result.InviteeUserID, &result.AttributionID,
		&result.RewardsRemoved, &result.SubscriptionsRevoked, &result.CompletedAt)
	return &result, err
}

func sameAttributionRewards(left, right []domain.AttributionReward) bool {
	if len(left) != len(right) {
		return false
	}
	copyAndSort := func(input []domain.AttributionReward) []domain.AttributionReward {
		result := append([]domain.AttributionReward(nil), input...)
		sort.Slice(result, func(i, j int) bool { return result[i].ID < result[j].ID })
		return result
	}
	left = copyAndSort(left)
	right = copyAndSort(right)
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}
