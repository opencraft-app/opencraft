package domain

import (
	"errors"
	"time"
)

const (
	CampaignStatusActive = "active"
	CampaignStatusPaused = "paused"

	RewardSideInviter = "inviter"
	RewardSideInvitee = "invitee"

	RewardStatusPending      = "pending"
	RewardStatusVesting      = "vesting"
	RewardStatusGranting     = "granting"
	RewardStatusGranted      = "granted"
	RewardStatusCancelled    = "cancelled"
	RewardStatusRetryable    = "retryable"
	RewardStatusManualReview = "manual_review"
)

var (
	ErrNoActiveCampaign         = errors.New("no active referral campaign")
	ErrCodeNotFound             = errors.New("referral code not found")
	ErrAttributionNotFound      = errors.New("referral attribution not found")
	ErrAttributionResetConflict = errors.New("referral attribution reset conflict")
	ErrSelfReferral             = errors.New("self referral is not allowed")
	ErrDuplicateEvent           = errors.New("referral event already processed")
	ErrEventConflict            = errors.New("referral event id has conflicting payload")
	ErrCodeConflict             = errors.New("referral code conflicts with an existing code or owner")
)

type Campaign struct {
	ID                   string
	Name                 string
	Status               string
	StartsAt             time.Time
	EndsAt               time.Time
	InviterCredit        int64
	InviteeCredit        int64
	VestingDays          int
	PendingTTLDays       int
	MaxRewardsPerInviter int
	BudgetCredit         int64
}

type Code struct {
	Code        string
	CampaignID  string
	OwnerUserID string
	CreatedAt   time.Time
}

type CodeResolution struct {
	Code         string
	CampaignID   string
	CampaignName string
	InviterName  string
	StartsAt     time.Time
	EndsAt       time.Time
}

type Stats struct {
	SuccessfulReferrals int64 `json:"successful_referrals"`
	GrantedCredits      int64 `json:"granted_credits"`
	PendingRewards      int64 `json:"pending_rewards"`
	GrantedRewards      int64 `json:"granted_rewards"`
}

type Reward struct {
	ID                string
	CampaignID        string
	InviteeUserID     string
	QualifyingPassID  string
	BeneficiaryUserID string
	Side              string
	CreditAmount      int64
	IdempotencyKey    string
	Status            string
	EligibleAt        time.Time
	GrantDeadline     time.Time
	AttemptCount      int
}

type Attribution struct {
	ID                  string    `json:"attribution_id"`
	CampaignID          string    `json:"campaign_id"`
	InviteeUserID       string    `json:"invitee_user_id"`
	InviterUserID       string    `json:"inviter_user_id"`
	ReferralCode        string    `json:"referral_code"`
	RegistrationEventID string    `json:"registration_event_id"`
	RegisteredAt        time.Time `json:"registered_at"`
	CreatedAt           time.Time `json:"created_at"`
}

type AttributionReward struct {
	ID                string `json:"reward_id"`
	BeneficiaryUserID string `json:"beneficiary_user_id"`
	Side              string `json:"reward_side"`
	CreditAmount      int64  `json:"credit_amount"`
	Status            string `json:"status"`
	SubscriptionID    string `json:"subscription_id,omitempty"`
	SubscriptionName  string `json:"subscription_name,omitempty"`
}

type AttributionResetPreview struct {
	Attribution Attribution         `json:"attribution"`
	Rewards     []AttributionReward `json:"rewards"`
	Resettable  bool                `json:"resettable"`
	BlockReason string              `json:"block_reason,omitempty"`
}

type AttributionResetResult struct {
	OperationID          string    `json:"operation_id"`
	IdempotencyKey       string    `json:"idempotency_key"`
	InviteeUserID        string    `json:"invitee_user_id"`
	AttributionID        string    `json:"attribution_id"`
	RewardsRemoved       int       `json:"rewards_removed"`
	SubscriptionsRevoked int       `json:"subscriptions_revoked"`
	CompletedAt          time.Time `json:"completed_at"`
}
