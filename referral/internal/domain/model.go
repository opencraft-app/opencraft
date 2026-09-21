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
	ErrNoActiveCampaign = errors.New("no active referral campaign")
	ErrCodeNotFound     = errors.New("referral code not found")
	ErrSelfReferral     = errors.New("self referral is not allowed")
	ErrDuplicateEvent   = errors.New("referral event already processed")
	ErrEventConflict    = errors.New("referral event id has conflicting payload")
	ErrCodeConflict     = errors.New("referral code conflicts with an existing code or owner")
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
