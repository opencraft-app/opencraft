// Package imtopic 编排 Channel Topic 的可靠异步创建。
package imtopic

import (
	"context"
	"errors"
	"strings"
	"time"

	clockport "chatserver/internal/ports/clock"
	imtopicport "chatserver/internal/ports/imtopic"
	tencentimport "chatserver/internal/ports/tencentim"
)

type Config struct {
	WorkerID    string
	LeaseTTL    time.Duration
	MaxAttempts int64
	BaseBackoff time.Duration
	MaxBackoff  time.Duration
}

// Service 每次领取并收敛一个 im.topic.ensure 操作。
type Service struct {
	repository  imtopicport.Repository
	provisioner tencentimport.TopicProvisioner
	clock       clockport.Clock
	config      Config
}

func NewService(
	repository imtopicport.Repository,
	provisioner tencentimport.TopicProvisioner,
	clock clockport.Clock,
	config Config,
) (*Service, error) {
	if repository == nil || provisioner == nil || clock == nil ||
		strings.TrimSpace(config.WorkerID) == "" ||
		config.LeaseTTL <= 0 || config.MaxAttempts <= 0 ||
		config.BaseBackoff <= 0 || config.MaxBackoff < config.BaseBackoff {
		return nil, errors.New("IM Topic Worker 配置无效")
	}
	return &Service{
		repository:  repository,
		provisioner: provisioner,
		clock:       clock,
		config:      config,
	}, nil
}

func (service *Service) ProcessOne(ctx context.Context) (bool, error) {
	now := service.clock.Now().UTC()
	work, ok, err := service.repository.Claim(ctx, imtopicport.Claim{
		LeaseOwner:     service.config.WorkerID,
		Now:            now,
		LeaseExpiresAt: now.Add(service.config.LeaseTTL),
	})
	if err != nil || !ok {
		return false, err
	}
	completion := imtopicport.Completion{
		OperationID: work.OperationID,
		LeaseOwner:  work.LeaseOwner,
		CompletedAt: service.clock.Now().UTC(),
	}
	if work.DesiredRevision != work.ChannelRevision {
		completion.Status = imtopicport.CompletionSuperseded
		return true, service.complete(ctx, completion)
	}
	if work.IMState == "ready" {
		completion.Status = imtopicport.CompletionSucceeded
		return true, service.complete(ctx, completion)
	}
	err = service.provisioner.EnsureTopic(ctx, tencentimport.Topic{
		GroupID:      work.GroupID,
		TopicID:      work.TopicID,
		TopicName:    work.TopicName,
		OwnerUserID:  work.OwnerIMUserID,
		Introduction: work.Description,
		Private:      work.Private,
	})
	completion.CompletedAt = service.clock.Now().UTC()
	if err == nil {
		completion.Status = imtopicport.CompletionSucceeded
		return true, service.complete(ctx, completion)
	}
	completion.ErrorCode = tencentimport.CodeOf(err)
	if completion.ErrorCode == "" {
		completion.ErrorCode = "tencent_unknown_error"
	}
	if tencentimport.IsRetryable(err) &&
		work.Attempts < service.config.MaxAttempts {
		completion.Status = imtopicport.CompletionRetry
		completion.NextAttemptAt = completion.CompletedAt.Add(
			service.backoff(work.Attempts),
		)
	} else {
		completion.Status = imtopicport.CompletionFailed
	}
	return true, service.complete(ctx, completion)
}

func (service *Service) complete(
	ctx context.Context,
	completion imtopicport.Completion,
) error {
	err := service.repository.Complete(ctx, completion)
	if errors.Is(err, imtopicport.ErrLeaseLost) {
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
