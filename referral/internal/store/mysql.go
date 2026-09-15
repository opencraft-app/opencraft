package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/go-sql-driver/mysql"
	"github.com/google/uuid"

	"git.woa.com/wisp/mono/referral/internal/domain"
	"git.woa.com/wisp/mono/referral/internal/events"
)

type MySQLStore struct {
	db *sql.DB
}

var _ Store = (*MySQLStore)(nil)

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
		_ = db.Close()
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

func (s *MySQLStore) UpsertCampaign(ctx context.Context, campaign domain.Campaign) error {
	if strings.TrimSpace(campaign.ID) == "" || strings.TrimSpace(campaign.Name) == "" ||
		(campaign.Status != domain.CampaignStatusActive && campaign.Status != domain.CampaignStatusPaused) ||
		campaign.StartsAt.IsZero() || !campaign.EndsAt.After(campaign.StartsAt) ||
		campaign.InviterCredit <= 0 || campaign.InviteeCredit <= 0 ||
		campaign.VestingDays < 0 || campaign.PendingTTLDays <= campaign.VestingDays ||
		campaign.MaxRewardsPerInviter <= 0 || campaign.BudgetCredit < campaign.InviterCredit+campaign.InviteeCredit {
		return fmt.Errorf("referral campaign configuration is invalid")
	}
	now := time.Now().UTC()
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO referral_campaign (
			campaign_id, name, status, starts_at, ends_at,
			inviter_credit, invitee_credit,
			vesting_days, pending_ttl_days, max_rewards_per_inviter,
			budget_credit, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON DUPLICATE KEY UPDATE
			name = VALUES(name), status = VALUES(status), starts_at = VALUES(starts_at), ends_at = VALUES(ends_at),
			inviter_credit = VALUES(inviter_credit), invitee_credit = VALUES(invitee_credit),
			vesting_days = VALUES(vesting_days),
			pending_ttl_days = VALUES(pending_ttl_days), max_rewards_per_inviter = VALUES(max_rewards_per_inviter),
			budget_credit = VALUES(budget_credit), updated_at = VALUES(updated_at)
	`, strings.TrimSpace(campaign.ID), strings.TrimSpace(campaign.Name), campaign.Status,
		campaign.StartsAt.UTC(), campaign.EndsAt.UTC(), campaign.InviterCredit, campaign.InviteeCredit,
		campaign.VestingDays, campaign.PendingTTLDays,
		campaign.MaxRewardsPerInviter, campaign.BudgetCredit, now, now)
	return err
}

func (s *MySQLStore) ActiveCampaign(ctx context.Context, now time.Time) (*domain.Campaign, error) {
	row := s.db.QueryRowContext(ctx, campaignSelect+`
		WHERE status = ? AND starts_at <= ? AND ends_at > ?
		ORDER BY starts_at DESC LIMIT 1
	`, domain.CampaignStatusActive, now.UTC(), now.UTC())
	campaign, err := scanCampaign(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, domain.ErrNoActiveCampaign
	}
	return campaign, err
}

func (s *MySQLStore) ResolveCode(ctx context.Context, code string, now time.Time) (*domain.CodeResolution, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT rc.code, rc.campaign_id, c.name, c.starts_at, c.ends_at
		FROM referral_code rc
		JOIN referral_campaign c ON c.campaign_id = rc.campaign_id
		WHERE rc.code = ? AND c.status = ? AND c.starts_at <= ? AND c.ends_at > ?
	`, normalizeCode(code), domain.CampaignStatusActive, now.UTC(), now.UTC())
	var result domain.CodeResolution
	if err := row.Scan(&result.Code, &result.CampaignID, &result.CampaignName, &result.StartsAt, &result.EndsAt); errors.Is(err, sql.ErrNoRows) {
		return nil, domain.ErrCodeNotFound
	} else if err != nil {
		return nil, err
	}
	return &result, nil
}

func (s *MySQLStore) CodeForOwner(ctx context.Context, campaignID, userID string) (*domain.Code, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT code, campaign_id, owner_user_id, created_at
		FROM referral_code WHERE campaign_id = ? AND owner_user_id = ?
	`, strings.TrimSpace(campaignID), strings.TrimSpace(userID))
	var code domain.Code
	if err := row.Scan(&code.Code, &code.CampaignID, &code.OwnerUserID, &code.CreatedAt); errors.Is(err, sql.ErrNoRows) {
		return nil, domain.ErrCodeNotFound
	} else if err != nil {
		return nil, err
	}
	return &code, nil
}

func (s *MySQLStore) CreateCode(ctx context.Context, code *domain.Code) error {
	if code == nil {
		return fmt.Errorf("referral code is nil")
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO referral_code (code, campaign_id, owner_user_id, created_at)
		VALUES (?, ?, ?, ?)
	`, normalizeCode(code.Code), strings.TrimSpace(code.CampaignID), strings.TrimSpace(code.OwnerUserID), code.CreatedAt.UTC())
	if isDuplicate(err) {
		return domain.ErrCodeConflict
	}
	return err
}

func (s *MySQLStore) StatsForUser(ctx context.Context, userID string) (domain.Stats, error) {
	userID = strings.TrimSpace(userID)
	var stats domain.Stats
	err := s.db.QueryRowContext(ctx, `
		SELECT
			(SELECT COUNT(DISTINCT invitee_user_id) FROM referral_reward WHERE beneficiary_user_id = ? AND reward_side = ? AND status = ?),
			(SELECT COALESCE(SUM(credit_amount), 0) FROM referral_reward WHERE beneficiary_user_id = ? AND status = ?),
			(SELECT COUNT(*) FROM referral_reward WHERE beneficiary_user_id = ? AND status IN (?, ?, ?, ?)),
			(SELECT COUNT(*) FROM referral_reward WHERE beneficiary_user_id = ? AND status = ?)
	`, userID, domain.RewardSideInviter, domain.RewardStatusGranted,
		userID, domain.RewardStatusGranted,
		userID, domain.RewardStatusPending, domain.RewardStatusVesting, domain.RewardStatusGranting, domain.RewardStatusRetryable,
		userID, domain.RewardStatusGranted,
	).Scan(&stats.SuccessfulReferrals, &stats.GrantedCredits, &stats.PendingRewards, &stats.GrantedRewards)
	return stats, err
}

func (s *MySQLStore) RecordRegistration(ctx context.Context, event events.Envelope, payload events.UserRegistered) error {
	return s.withTx(ctx, func(tx *sql.Tx) error {
		inserted, err := recordInbox(ctx, tx, event)
		if err != nil || !inserted {
			return err
		}
		if strings.TrimSpace(payload.UserID) == "" || normalizeCode(payload.ReferralCode) == "" {
			return nil
		}
		var campaign domain.Campaign
		var inviterUserID string
		err = tx.QueryRowContext(ctx, `
			SELECT referral_campaign.campaign_id, referral_campaign.name, referral_campaign.status,
			       referral_campaign.starts_at, referral_campaign.ends_at,
			       referral_campaign.inviter_credit, referral_campaign.invitee_credit,
			       referral_campaign.vesting_days,
			       referral_campaign.pending_ttl_days, referral_campaign.max_rewards_per_inviter,
			       referral_campaign.budget_credit, rc.owner_user_id
			FROM referral_campaign
			JOIN referral_code rc ON rc.campaign_id = referral_campaign.campaign_id
			WHERE rc.code = ? AND referral_campaign.status = ?
			  AND referral_campaign.starts_at <= ? AND referral_campaign.ends_at > ?
		`, normalizeCode(payload.ReferralCode), domain.CampaignStatusActive, event.OccurredAt.UTC(), event.OccurredAt.UTC()).Scan(campaignScanDest(&campaign, &inviterUserID)...)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		if inviterUserID == payload.UserID {
			return nil
		}
		_, err = tx.ExecContext(ctx, `
			INSERT INTO referral_attribution (
				attribution_id, campaign_id, invitee_user_id, inviter_user_id,
				referral_code, registration_event_id, registered_at, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			ON DUPLICATE KEY UPDATE attribution_id = attribution_id
		`, "rattr_"+uuid.NewString(), campaign.ID, payload.UserID, inviterUserID,
			normalizeCode(payload.ReferralCode), event.EventID, event.OccurredAt.UTC(), time.Now().UTC())
		if err != nil {
			return err
		}
		return createRewardsIfQualified(ctx, tx, campaign.ID, payload.UserID)
	})
}

func (s *MySQLStore) RecordFirstPaid(ctx context.Context, event events.Envelope, payload events.PassFirstPaid) error {
	return s.withTx(ctx, func(tx *sql.Tx) error {
		inserted, err := recordInbox(ctx, tx, event)
		if err != nil || !inserted {
			return err
		}
		if strings.TrimSpace(payload.UserID) == "" || strings.TrimSpace(payload.PassID) == "" || strings.TrimSpace(payload.DealName) == "" {
			return fmt.Errorf("pass.first_paid.v1 payload is incomplete")
		}
		_, err = tx.ExecContext(ctx, `
			INSERT INTO referral_first_paid_fact (
				pass_id, event_id, user_id, bundle_id, deal_name, paid_at, refunded_at, created_at
			) VALUES (?, ?, ?, ?, ?, ?,
			          (SELECT refunded_at FROM referral_refund_fact WHERE pass_id = ?), ?)
			ON DUPLICATE KEY UPDATE pass_id = pass_id
		`, payload.PassID, event.EventID, payload.UserID, payload.BundleID, payload.DealName,
			event.OccurredAt.UTC(), payload.PassID, time.Now().UTC())
		if err != nil {
			return err
		}
		var campaignID string
		if err := tx.QueryRowContext(ctx, `
			SELECT campaign_id FROM referral_attribution
			WHERE invitee_user_id = ? ORDER BY registered_at ASC LIMIT 1
		`, payload.UserID).Scan(&campaignID); errors.Is(err, sql.ErrNoRows) {
			return nil
		} else if err != nil {
			return err
		}
		return createRewardsIfQualified(ctx, tx, campaignID, payload.UserID)
	})
}

func (s *MySQLStore) RecordRefunded(ctx context.Context, event events.Envelope, payload events.PassRefunded) error {
	return s.withTx(ctx, func(tx *sql.Tx) error {
		inserted, err := recordInbox(ctx, tx, event)
		if err != nil || !inserted {
			return err
		}
		if strings.TrimSpace(payload.UserID) == "" || strings.TrimSpace(payload.PassID) == "" {
			return fmt.Errorf("pass.refunded.v1 payload is incomplete")
		}
		now := time.Now().UTC()
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO referral_refund_fact (pass_id, event_id, user_id, deal_name, refunded_at, created_at)
			VALUES (?, ?, ?, ?, ?, ?)
			ON DUPLICATE KEY UPDATE pass_id = pass_id
		`, payload.PassID, event.EventID, payload.UserID, payload.DealName, event.OccurredAt.UTC(), now); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `
			UPDATE referral_first_paid_fact SET refunded_at = ?
			WHERE pass_id = ? AND refunded_at IS NULL
		`, event.OccurredAt.UTC(), payload.PassID); err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `
			UPDATE referral_reward
			SET status = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
			WHERE qualifying_pass_id = ? AND status IN (?, ?, ?, ?)
		`, domain.RewardStatusCancelled, now, payload.PassID,
			domain.RewardStatusPending, domain.RewardStatusVesting, domain.RewardStatusRetryable, domain.RewardStatusGranting)
		return err
	})
}

func (s *MySQLStore) ClaimRewards(ctx context.Context, now time.Time, limit int, leaseOwner string, leaseDuration time.Duration) ([]domain.Reward, error) {
	if limit <= 0 || strings.TrimSpace(leaseOwner) == "" || leaseDuration <= 0 {
		return nil, fmt.Errorf("reward claim configuration is invalid")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `
		UPDATE referral_reward
		SET status = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
		WHERE status = ? AND lease_expires_at <= ?
	`, domain.RewardStatusRetryable, now.UTC(), domain.RewardStatusGranting, now.UTC()); err != nil {
		return nil, err
	}
	rows, err := tx.QueryContext(ctx, `
		SELECT reward_id, campaign_id, invitee_user_id, qualifying_pass_id, beneficiary_user_id,
		       reward_side, credit_amount, idempotency_key, status,
		       eligible_at, grant_deadline, attempt_count
		FROM referral_reward
		WHERE status IN (?, ?, ?) AND eligible_at <= ? AND next_attempt_at <= ?
		  AND grant_deadline > ? AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
		ORDER BY next_attempt_at, created_at
		LIMIT ? FOR UPDATE SKIP LOCKED
	`, domain.RewardStatusPending, domain.RewardStatusVesting, domain.RewardStatusRetryable,
		now.UTC(), now.UTC(), now.UTC(), now.UTC(), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	rewards := make([]domain.Reward, 0, limit)
	for rows.Next() {
		var reward domain.Reward
		if err := rows.Scan(&reward.ID, &reward.CampaignID, &reward.InviteeUserID, &reward.QualifyingPassID, &reward.BeneficiaryUserID,
			&reward.Side, &reward.CreditAmount, &reward.IdempotencyKey, &reward.Status,
			&reward.EligibleAt, &reward.GrantDeadline, &reward.AttemptCount); err != nil {
			return nil, err
		}
		rewards = append(rewards, reward)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i := range rewards {
		result, err := tx.ExecContext(ctx, `
			UPDATE referral_reward
			SET status = ?, lease_owner = ?, lease_expires_at = ?, attempt_count = attempt_count + 1, updated_at = ?
			WHERE reward_id = ? AND status IN (?, ?, ?)
		`, domain.RewardStatusGranting, leaseOwner, now.Add(leaseDuration).UTC(), now.UTC(), rewards[i].ID,
			domain.RewardStatusPending, domain.RewardStatusVesting, domain.RewardStatusRetryable)
		if err != nil {
			return nil, err
		}
		affected, _ := result.RowsAffected()
		if affected == 0 {
			return nil, fmt.Errorf("reward %s lost claim race", rewards[i].ID)
		}
		rewards[i].Status = domain.RewardStatusGranting
		rewards[i].AttemptCount++
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return rewards, nil
}

func (s *MySQLStore) MarkRewardGranted(ctx context.Context, rewardID, subscriptionID, subscriptionName string, grantedAt time.Time) error {
	result, err := s.db.ExecContext(ctx, `
		UPDATE referral_reward
		SET status = ?, subscription_id = ?, subscription_name = ?, granted_at = ?,
		    lease_owner = NULL, lease_expires_at = NULL,
		    last_error_code = NULL, last_error_message = NULL, updated_at = ?
		WHERE reward_id = ? AND status = ?
	`, domain.RewardStatusGranted, subscriptionID, subscriptionName, grantedAt.UTC(), grantedAt.UTC(), rewardID, domain.RewardStatusGranting)
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected != 1 {
		return fmt.Errorf("reward %s left granting state before grant was recorded", rewardID)
	}
	return nil
}

func (s *MySQLStore) MarkRewardRetryable(ctx context.Context, rewardID, code, message string, nextAttempt time.Time) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE referral_reward
		SET status = ?, next_attempt_at = ?, lease_owner = NULL, lease_expires_at = NULL,
		    last_error_code = ?, last_error_message = ?, updated_at = ?
		WHERE reward_id = ? AND status = ?
	`, domain.RewardStatusRetryable, nextAttempt.UTC(), truncate(code, 128), truncate(message, 1024), time.Now().UTC(), rewardID, domain.RewardStatusGranting)
	return err
}

func (s *MySQLStore) CancelExpiredRewards(ctx context.Context, now time.Time) (int64, error) {
	result, err := s.db.ExecContext(ctx, `
		UPDATE referral_reward
		SET status = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
		WHERE status IN (?, ?, ?) AND grant_deadline <= ?
	`, domain.RewardStatusCancelled, now.UTC(), domain.RewardStatusPending, domain.RewardStatusVesting, domain.RewardStatusRetryable, now.UTC())
	if err != nil {
		return 0, err
	}
	return result.RowsAffected()
}

func (s *MySQLStore) withTx(ctx context.Context, fn func(*sql.Tx) error) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit()
}

func recordInbox(ctx context.Context, tx *sql.Tx, event events.Envelope) (bool, error) {
	hash := events.PayloadHash(event.Payload)
	_, err := tx.ExecContext(ctx, `
		INSERT INTO referral_event_inbox (
			event_id, event_type, producer, aggregate_id, correlation_id,
			occurred_at, payload_hash, payload_json, received_at, processed_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, event.EventID, event.EventType, event.Producer, event.AggregateID, event.CorrelationID,
		event.OccurredAt.UTC(), hash, []byte(event.Payload), time.Now().UTC(), time.Now().UTC())
	if err == nil {
		return true, nil
	}
	if !isDuplicate(err) {
		return false, err
	}
	var existingHash string
	if queryErr := tx.QueryRowContext(ctx, `SELECT payload_hash FROM referral_event_inbox WHERE event_id = ?`, event.EventID).Scan(&existingHash); queryErr != nil {
		return false, queryErr
	}
	if existingHash != hash {
		return false, domain.ErrEventConflict
	}
	return false, nil
}

func createRewardsIfQualified(ctx context.Context, tx *sql.Tx, campaignID, inviteeUserID string) error {
	var campaign domain.Campaign
	var inviterUserID, registeredEventID, qualifyingPassID string
	var registeredAt, paidAt time.Time
	err := tx.QueryRowContext(ctx, `
		SELECT referral_campaign.campaign_id, referral_campaign.name, referral_campaign.status,
		       referral_campaign.starts_at, referral_campaign.ends_at,
		       referral_campaign.inviter_credit, referral_campaign.invitee_credit,
		       referral_campaign.vesting_days,
		       referral_campaign.pending_ttl_days, referral_campaign.max_rewards_per_inviter,
		       referral_campaign.budget_credit, ra.inviter_user_id,
		       ra.registration_event_id, ra.registered_at, pf.paid_at, pf.pass_id
		FROM referral_campaign
		JOIN referral_attribution ra ON ra.campaign_id = referral_campaign.campaign_id
		JOIN referral_first_paid_fact pf ON pf.user_id = ra.invitee_user_id AND pf.refunded_at IS NULL
		WHERE referral_campaign.campaign_id = ? AND ra.invitee_user_id = ?
		  AND ra.registered_at >= referral_campaign.starts_at AND ra.registered_at < referral_campaign.ends_at
		  AND pf.paid_at >= referral_campaign.starts_at AND pf.paid_at < referral_campaign.ends_at
		  AND NOT EXISTS (SELECT 1 FROM referral_refund_fact rf WHERE rf.pass_id = pf.pass_id)
		ORDER BY pf.paid_at ASC LIMIT 1 FOR UPDATE
	`, campaignID, inviteeUserID).Scan(campaignScanDest(&campaign, &inviterUserID, &registeredEventID, &registeredAt, &paidAt, &qualifyingPassID)...)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}

	var existing int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM referral_reward WHERE campaign_id = ? AND invitee_user_id = ?`, campaign.ID, inviteeUserID).Scan(&existing); err != nil {
		return err
	}
	if existing > 0 {
		return nil
	}
	var inviterRewardCount int
	if err := tx.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM referral_reward
		WHERE campaign_id = ? AND beneficiary_user_id = ? AND reward_side = ? AND status <> ?
	`, campaign.ID, inviterUserID, domain.RewardSideInviter, domain.RewardStatusCancelled).Scan(&inviterRewardCount); err != nil {
		return err
	}
	if inviterRewardCount >= campaign.MaxRewardsPerInviter {
		return nil
	}
	var committedCredit int64
	if err := tx.QueryRowContext(ctx, `
		SELECT COALESCE(SUM(credit_amount), 0) FROM referral_reward
		WHERE campaign_id = ? AND status <> ?
	`, campaign.ID, domain.RewardStatusCancelled).Scan(&committedCredit); err != nil {
		return err
	}
	if committedCredit+campaign.InviterCredit+campaign.InviteeCredit > campaign.BudgetCredit {
		return nil
	}

	eligibleAt := paidAt.AddDate(0, 0, campaign.VestingDays).UTC()
	status := domain.RewardStatusVesting
	if campaign.VestingDays == 0 {
		status = domain.RewardStatusPending
	}
	grantDeadline := paidAt.AddDate(0, 0, campaign.PendingTTLDays).UTC()
	now := time.Now().UTC()
	for _, reward := range []struct {
		side        string
		beneficiary string
		amount      int64
	}{
		{side: domain.RewardSideInviter, beneficiary: inviterUserID, amount: campaign.InviterCredit},
		{side: domain.RewardSideInvitee, beneficiary: inviteeUserID, amount: campaign.InviteeCredit},
	} {
		idempotencyKey := fmt.Sprintf("referral:%s:%s:%s", campaign.ID, inviteeUserID, reward.side)
		_, err := tx.ExecContext(ctx, `
			INSERT INTO referral_reward (
				reward_id, campaign_id, invitee_user_id, qualifying_pass_id, beneficiary_user_id,
				reward_side, credit_amount, idempotency_key, status,
				eligible_at, grant_deadline, next_attempt_at, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`, "rrwd_"+uuid.NewString(), campaign.ID, inviteeUserID, qualifyingPassID, reward.beneficiary,
			reward.side, reward.amount, idempotencyKey, status,
			eligibleAt, grantDeadline, eligibleAt, now, now)
		if err != nil && !isDuplicate(err) {
			return err
		}
	}
	_ = registeredEventID
	_ = registeredAt
	return nil
}

const campaignSelect = `
	SELECT campaign_id, name, status, starts_at, ends_at,
	       inviter_credit, invitee_credit,
	       vesting_days, pending_ttl_days,
	       max_rewards_per_inviter, budget_credit
	FROM referral_campaign
`

type scanner interface {
	Scan(...any) error
}

func scanCampaign(row scanner) (*domain.Campaign, error) {
	var campaign domain.Campaign
	if err := row.Scan(campaignScanDest(&campaign)...); err != nil {
		return nil, err
	}
	return &campaign, nil
}

func campaignScanDest(campaign *domain.Campaign, extra ...any) []any {
	dest := []any{
		&campaign.ID, &campaign.Name, &campaign.Status, &campaign.StartsAt, &campaign.EndsAt,
		&campaign.InviterCredit, &campaign.InviteeCredit,
		&campaign.VestingDays, &campaign.PendingTTLDays,
		&campaign.MaxRewardsPerInviter, &campaign.BudgetCredit,
	}
	return append(dest, extra...)
}

func normalizeCode(value string) string {
	return strings.ToUpper(strings.TrimSpace(value))
}

func isDuplicate(err error) bool {
	var mysqlErr *mysql.MySQLError
	return errors.As(err, &mysqlErr) && mysqlErr.Number == 1062
}

func truncate(value string, limit int) string {
	value = strings.TrimSpace(value)
	if len(value) <= limit {
		return value
	}
	return value[:limit]
}
