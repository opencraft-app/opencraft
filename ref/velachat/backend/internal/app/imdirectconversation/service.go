// Package imdirectconversation 编排 Server 内私信腾讯群的可靠异步创建。
package imdirectconversation

import (
	"context"
	"errors"
	"strings"
	"time"

	clockport "chatserver/internal/ports/clock"
	workport "chatserver/internal/ports/imdirectconversation"
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
	repository  workport.Repository
	provisioner tencentimport.DirectGroupProvisioner
	clock       clockport.Clock
	config      Config
}

func NewService(
	repository workport.Repository,
	provisioner tencentimport.DirectGroupProvisioner,
	clock clockport.Clock,
	config Config,
) (*Service, error) {
	if repository == nil || provisioner == nil || clock == nil || strings.TrimSpace(config.WorkerID) == "" ||
		config.LeaseTTL <= 0 || config.MaxAttempts <= 0 || config.BaseBackoff <= 0 || config.MaxBackoff < config.BaseBackoff {
		return nil, errors.New("Server 内私信 IM Worker 配置无效")
	}
	return &Service{repository: repository, provisioner: provisioner, clock: clock, config: config}, nil
}

func (service *Service) ProcessOne(ctx context.Context) (bool, error) {
	now := service.clock.Now().UTC()
	work, ok, err := service.repository.Claim(ctx, workport.Claim{
		LeaseOwner: service.config.WorkerID, Now: now, LeaseExpiresAt: now.Add(service.config.LeaseTTL),
	})
	if err != nil || !ok {
		return false, err
	}
	completion := workport.Completion{
		OperationID: work.OperationID, LeaseOwner: work.LeaseOwner, CompletedAt: service.clock.Now().UTC(),
	}
	if work.DesiredRevision != work.ConversationRevision {
		completion.Status = workport.CompletionSuperseded
		return true, service.complete(ctx, completion)
	}
	if work.IMState == "ready" {
		completion.Status = workport.CompletionSucceeded
		return true, service.complete(ctx, completion)
	}
	err = service.provisioner.EnsureDirectGroup(ctx, tencentimport.DirectGroup{
		GroupID: work.GroupID, Name: work.GroupName,
		MemberAUserID: work.MemberAIMUserID, MemberBUserID: work.MemberBIMUserID,
	})
	completion.CompletedAt = service.clock.Now().UTC()
	if err == nil {
		completion.Status = workport.CompletionSucceeded
		return true, service.complete(ctx, completion)
	}
	completion.ErrorCode = tencentimport.CodeOf(err)
	if completion.ErrorCode == "" {
		completion.ErrorCode = "tencent_unknown_error"
	}
	if tencentimport.IsRetryable(err) && work.Attempts < service.config.MaxAttempts {
		completion.Status = workport.CompletionRetry
		completion.NextAttemptAt = completion.CompletedAt.Add(service.backoff(work.Attempts))
	} else {
		completion.Status = workport.CompletionFailed
	}
	return true, service.complete(ctx, completion)
}

func (service *Service) complete(ctx context.Context, completion workport.Completion) error {
	err := service.repository.Complete(ctx, completion)
	if errors.Is(err, workport.ErrLeaseLost) {
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
