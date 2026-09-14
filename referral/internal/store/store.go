package store

import (
	"context"
	"time"

	"git.woa.com/wisp/mono/referral/internal/domain"
	"git.woa.com/wisp/mono/referral/internal/events"
)

type Store interface {
	UpsertCampaign(context.Context, domain.Campaign) error
	ActiveCampaign(context.Context, time.Time) (*domain.Campaign, error)
	ResolveCode(context.Context, string, time.Time) (*domain.CodeResolution, error)
	CodeForOwner(context.Context, string, string) (*domain.Code, error)
	CreateCode(context.Context, *domain.Code) error
	StatsForUser(context.Context, string) (domain.Stats, error)
	RecordRegistration(context.Context, events.Envelope, events.UserRegistered) error
	RecordFirstPaid(context.Context, events.Envelope, events.PassFirstPaid) error
	RecordRefunded(context.Context, events.Envelope, events.PassRefunded) error
	ClaimRewards(context.Context, time.Time, int, string, time.Duration) ([]domain.Reward, error)
	MarkRewardGranted(context.Context, string, string, string, time.Time) error
	MarkRewardRetryable(context.Context, string, string, string, time.Time) error
	CancelExpiredRewards(context.Context, time.Time) (int64, error)
}
