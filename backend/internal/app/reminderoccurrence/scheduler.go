package reminderoccurrence

import (
	"context"
	"errors"
	"strings"
	"time"

	clockport "chatserver/internal/ports/clock"
	occurrenceport "chatserver/internal/ports/reminderoccurrence"
	tencentimport "chatserver/internal/ports/tencentim"
)

type SchedulerConfig struct {
	WorkerID    string
	LeaseTTL    time.Duration
	MaxAttempts int64
	BaseBackoff time.Duration
	MaxBackoff  time.Duration
}

// SchedulerService interleaves durable notification delivery with due
// materialization. Existing Outbox work is drained first after a restart, then
// at most one Reminder is materialized per call.
type SchedulerService struct {
	repository occurrenceport.Repository
	sender     tencentimport.AgentNotificationSender
	clock      clockport.Clock
	config     SchedulerConfig
}

func NewSchedulerService(
	repository occurrenceport.Repository,
	sender tencentimport.AgentNotificationSender,
	clock clockport.Clock,
	config SchedulerConfig,
) (*SchedulerService, error) {
	if repository == nil || sender == nil || clock == nil ||
		strings.TrimSpace(config.WorkerID) == "" || config.LeaseTTL <= 0 ||
		config.MaxAttempts <= 0 || config.BaseBackoff <= 0 ||
		config.MaxBackoff < config.BaseBackoff {
		return nil, errors.New("Reminder Scheduler 配置无效")
	}
	return &SchedulerService{
		repository: repository, sender: sender, clock: clock, config: config,
	}, nil
}

func (service *SchedulerService) ProcessOne(ctx context.Context) (bool, error) {
	now := service.clock.Now().UTC()
	work, ok, err := service.repository.ClaimNotification(
		ctx,
		occurrenceport.NotificationClaim{
			LeaseOwner: service.config.WorkerID,
			Now:        now, LeaseExpiresAt: now.Add(service.config.LeaseTTL),
		},
	)
	if err != nil {
		return false, err
	}
	if ok {
		return true, service.deliver(ctx, work)
	}
	return service.repository.ProcessOne(ctx, now)
}

func (service *SchedulerService) deliver(
	ctx context.Context,
	work occurrenceport.NotificationWork,
) error {
	now := service.clock.Now().UTC()
	if strings.TrimSpace(work.RecipientUserID) == "" {
		return service.retry(
			ctx,
			work,
			now,
			"agent_im_identity_not_ready",
			work.Attempts >= service.config.MaxAttempts,
		)
	}
	current, err := service.repository.NotificationCurrent(ctx, work, now)
	if err != nil {
		return err
	}
	if !current {
		err = service.repository.CompleteNotification(
			ctx, work.EventID, service.config.WorkerID, now,
		)
		if errors.Is(err, occurrenceport.ErrNotificationLeaseLost) {
			return nil
		}
		return err
	}
	err = service.sender.SendAgentNotification(
		ctx,
		tencentimport.AgentNotification{
			ToUserID: work.RecipientUserID,
			Type:     "reminder.due", ServerID: work.ServerID,
			AgentID: work.AgentID, ResourceID: work.ResourceID,
			Revision: work.Revision, EventID: work.EventID,
		},
	)
	if err == nil {
		err = service.repository.CompleteNotification(
			ctx,
			work.EventID,
			service.config.WorkerID,
			service.clock.Now().UTC(),
		)
		if errors.Is(err, occurrenceport.ErrNotificationLeaseLost) {
			return nil
		}
		return err
	}
	code := tencentimport.CodeOf(err)
	if code == "" {
		code = "tencent_unknown_error"
	}
	dead := !tencentimport.IsRetryable(err) ||
		work.Attempts >= service.config.MaxAttempts
	return service.retry(ctx, work, service.clock.Now().UTC(), code, dead)
}

func (service *SchedulerService) retry(
	ctx context.Context,
	work occurrenceport.NotificationWork,
	now time.Time,
	errorCode string,
	dead bool,
) error {
	availableAt := now
	if !dead {
		availableAt = now.Add(service.backoff(work.Attempts))
	}
	err := service.repository.RetryNotification(
		ctx,
		work.EventID,
		service.config.WorkerID,
		availableAt,
		errorCode,
		dead,
	)
	if errors.Is(err, occurrenceport.ErrNotificationLeaseLost) {
		return nil
	}
	return err
}

func (service *SchedulerService) backoff(attempts int64) time.Duration {
	delay := service.config.BaseBackoff
	for attempt := int64(1); attempt < attempts; attempt++ {
		if delay >= service.config.MaxBackoff/2 {
			return service.config.MaxBackoff
		}
		delay *= 2
	}
	if delay > service.config.MaxBackoff {
		return service.config.MaxBackoff
	}
	return delay
}
