// Package tasknotification delivers durable Task assignment wake hints.
package tasknotification

import (
	"context"
	"errors"
	"strings"
	"time"

	clockport "chatserver/internal/ports/clock"
	tasknotificationport "chatserver/internal/ports/tasknotification"
	tencentimport "chatserver/internal/ports/tencentim"
)

type Config struct {
	WorkerID    string
	LeaseTTL    time.Duration
	MaxAttempts int64
	BaseBackoff time.Duration
	MaxBackoff  time.Duration
}

type Processor struct {
	repository tasknotificationport.Repository
	sender     tencentimport.AgentNotificationSender
	clock      clockport.Clock
	config     Config
}

func NewProcessor(
	repository tasknotificationport.Repository,
	sender tencentimport.AgentNotificationSender,
	clock clockport.Clock,
	config Config,
) (*Processor, error) {
	if repository == nil || sender == nil || clock == nil ||
		strings.TrimSpace(config.WorkerID) == "" || config.LeaseTTL <= 0 ||
		config.MaxAttempts <= 0 || config.BaseBackoff <= 0 ||
		config.MaxBackoff < config.BaseBackoff {
		return nil, errors.New("Task notification Processor 配置无效")
	}
	return &Processor{
		repository: repository, sender: sender, clock: clock, config: config,
	}, nil
}

func (processor *Processor) ProcessOne(ctx context.Context) (bool, error) {
	now := processor.clock.Now().UTC()
	work, found, err := processor.repository.Claim(
		ctx,
		tasknotificationport.Claim{
			LeaseOwner: processor.config.WorkerID,
			Now:        now, LeaseExpiresAt: now.Add(processor.config.LeaseTTL),
		},
	)
	if err != nil || !found {
		return found, err
	}
	if !work.Current {
		return true, processor.complete(
			ctx, work, tasknotificationport.CompletionSuperseded, "", time.Time{},
		)
	}
	if strings.TrimSpace(work.RecipientUserID) == "" {
		return true, processor.retry(
			ctx, work, "agent_im_identity_not_ready", work.Attempts >= processor.config.MaxAttempts,
		)
	}
	current, err := processor.repository.Current(
		ctx,
		work,
		processor.clock.Now().UTC(),
	)
	if err != nil {
		return true, err
	}
	if !current {
		return true, processor.complete(
			ctx, work, tasknotificationport.CompletionSuperseded, "", time.Time{},
		)
	}
	err = processor.sender.SendAgentNotification(
		ctx,
		tencentimport.AgentNotification{
			ToUserID: work.RecipientUserID,
			Type:     "task.assigned", ServerID: work.ServerID,
			AgentID: work.AgentID, ResourceID: work.TaskID,
			Revision: work.AssignmentRevision, EventID: work.OperationID,
		},
	)
	if err == nil {
		return true, processor.complete(
			ctx, work, tasknotificationport.CompletionSucceeded, "", time.Time{},
		)
	}
	code := tencentimport.CodeOf(err)
	if code == "" {
		code = "tencent_unknown_error"
	}
	dead := !tencentimport.IsRetryable(err) ||
		work.Attempts >= processor.config.MaxAttempts
	return true, processor.retry(ctx, work, code, dead)
}

func (processor *Processor) retry(
	ctx context.Context,
	work tasknotificationport.Work,
	errorCode string,
	dead bool,
) error {
	if dead {
		return processor.complete(
			ctx, work, tasknotificationport.CompletionFailed, errorCode, time.Time{},
		)
	}
	delay := processor.config.BaseBackoff
	for attempt := int64(1); attempt < work.Attempts; attempt++ {
		if delay >= processor.config.MaxBackoff/2 {
			delay = processor.config.MaxBackoff
			break
		}
		delay *= 2
	}
	if delay > processor.config.MaxBackoff {
		delay = processor.config.MaxBackoff
	}
	return processor.complete(
		ctx,
		work,
		tasknotificationport.CompletionRetry,
		errorCode,
		processor.clock.Now().UTC().Add(delay),
	)
}

func (processor *Processor) complete(
	ctx context.Context,
	work tasknotificationport.Work,
	status tasknotificationport.CompletionStatus,
	errorCode string,
	nextAttemptAt time.Time,
) error {
	err := processor.repository.Complete(
		ctx,
		tasknotificationport.Completion{
			OperationID: work.OperationID, LeaseOwner: work.LeaseOwner,
			Status: status, ErrorCode: errorCode,
			NextAttemptAt: nextAttemptAt, CompletedAt: processor.clock.Now().UTC(),
		},
	)
	if errors.Is(err, tasknotificationport.ErrLeaseLost) {
		return nil
	}
	return err
}
