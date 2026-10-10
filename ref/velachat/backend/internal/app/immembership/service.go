// Package immembership 编排腾讯云 IM 成员同步。
package immembership

import (
	"context"
	"errors"
	"strings"
	"time"

	clockport "chatserver/internal/ports/clock"
	immembershipport "chatserver/internal/ports/immembership"
	tencentimport "chatserver/internal/ports/tencentim"
)

type Config struct {
	WorkerID    string
	LeaseTTL    time.Duration
	MaxAttempts int64
	BaseBackoff time.Duration
	MaxBackoff  time.Duration
}

type Service struct {
	repository  immembershipport.Repository
	provisioner tencentimport.MembershipProvisioner
	clock       clockport.Clock
	config      Config
}

func NewService(
	repository immembershipport.Repository,
	provisioner tencentimport.MembershipProvisioner,
	clock clockport.Clock,
	config Config,
) (*Service, error) {
	if repository == nil || provisioner == nil || clock == nil ||
		strings.TrimSpace(config.WorkerID) == "" ||
		config.LeaseTTL <= 0 || config.MaxAttempts <= 0 ||
		config.BaseBackoff <= 0 || config.MaxBackoff < config.BaseBackoff {
		return nil, errors.New("IM membership Worker 配置无效")
	}
	return &Service{
		repository: repository, provisioner: provisioner,
		clock: clock, config: config,
	}, nil
}

func (service *Service) ProcessOne(ctx context.Context) (bool, error) {
	now := service.clock.Now().UTC()
	work, ok, err := service.repository.Claim(
		ctx,
		immembershipport.Claim{
			LeaseOwner:     service.config.WorkerID,
			Now:            now,
			LeaseExpiresAt: now.Add(service.config.LeaseTTL),
		},
	)
	if err != nil || !ok {
		return false, err
	}
	completion := immembershipport.Completion{
		OperationID: work.OperationID,
		LeaseOwner:  work.LeaseOwner,
		CompletedAt: service.clock.Now().UTC(),
	}
	if work.DesiredRevision != work.MemberRevision {
		completion.Status = immembershipport.CompletionSuperseded
		return true, service.complete(ctx, completion)
	}
	targetReady := work.Kind == "im.membership.ensure" &&
		work.IMState == "ready"
	targetRemoved := work.Kind == "im.membership.remove" &&
		work.IMState == "removed"
	if targetReady || targetRemoved {
		completion.Status = immembershipport.CompletionSucceeded
		return true, service.complete(ctx, completion)
	}
	if work.ResourceType == "channel_member" && work.TopicID == "" {
		completion.Status = immembershipport.CompletionFailed
		completion.ErrorCode = "invalid_channel_topic"
		return true, service.complete(ctx, completion)
	}
	value := tencentimport.Membership{
		GroupID: work.GroupID,
		TopicID: work.TopicID,
		UserID:  work.IMUserID,
	}
	switch work.Kind {
	case "im.membership.ensure":
		err = service.provisioner.EnsureMember(ctx, value)
	case "im.membership.remove":
		err = service.provisioner.RemoveMember(ctx, value)
	default:
		completion.Status = immembershipport.CompletionFailed
		completion.ErrorCode = "unsupported_operation"
		return true, service.complete(ctx, completion)
	}
	completion.CompletedAt = service.clock.Now().UTC()
	if err == nil {
		completion.Status = immembershipport.CompletionSucceeded
		return true, service.complete(ctx, completion)
	}
	completion.ErrorCode = tencentimport.CodeOf(err)
	if completion.ErrorCode == "" {
		completion.ErrorCode = "tencent_unknown_error"
	}
	if tencentimport.IsRetryable(err) &&
		work.Attempts < service.config.MaxAttempts {
		completion.Status = immembershipport.CompletionRetry
		completion.NextAttemptAt = completion.CompletedAt.Add(
			service.backoff(work.Attempts),
		)
	} else {
		completion.Status = immembershipport.CompletionFailed
	}
	return true, service.complete(ctx, completion)
}

func (service *Service) complete(
	ctx context.Context,
	completion immembershipport.Completion,
) error {
	err := service.repository.Complete(ctx, completion)
	if errors.Is(err, immembershipport.ErrLeaseLost) {
		return nil
	}
	return err
}

func (service *Service) backoff(attempts int64) time.Duration {
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
