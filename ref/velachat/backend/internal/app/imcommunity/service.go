// Package imcommunity 编排 Server Community 的可靠异步创建。
package imcommunity

import (
	"context"
	"errors"
	"strings"
	"time"

	clockport "chatserver/internal/ports/clock"
	imcommunityport "chatserver/internal/ports/imcommunity"
	tencentimport "chatserver/internal/ports/tencentim"
)

// Config 配置 Worker 租约、重试和实例身份。
type Config struct {
	WorkerID    string
	LeaseTTL    time.Duration
	MaxAttempts int64
	BaseBackoff time.Duration
	MaxBackoff  time.Duration
}

// Service 每次领取并收敛一个 im.community.ensure 操作。
type Service struct {
	repository  imcommunityport.Repository
	provisioner tencentimport.CommunityProvisioner
	clock       clockport.Clock
	config      Config
}

// NewService 创建 Community Worker 应用服务。
func NewService(
	repository imcommunityport.Repository,
	provisioner tencentimport.CommunityProvisioner,
	clock clockport.Clock,
	config Config,
) (*Service, error) {
	if repository == nil || provisioner == nil || clock == nil ||
		strings.TrimSpace(config.WorkerID) == "" ||
		config.LeaseTTL <= 0 || config.MaxAttempts <= 0 ||
		config.BaseBackoff <= 0 || config.MaxBackoff < config.BaseBackoff {
		return nil, errors.New("IM Community Worker 配置无效")
	}
	return &Service{
		repository:  repository,
		provisioner: provisioner,
		clock:       clock,
		config:      config,
	}, nil
}

// ProcessOne 处理至多一个已到期的 Community 操作。
func (service *Service) ProcessOne(ctx context.Context) (bool, error) {
	now := service.clock.Now().UTC()
	work, ok, err := service.repository.Claim(
		ctx,
		imcommunityport.Claim{
			LeaseOwner:     service.config.WorkerID,
			Now:            now,
			LeaseExpiresAt: now.Add(service.config.LeaseTTL),
		},
	)
	if err != nil || !ok {
		return false, err
	}

	completion := imcommunityport.Completion{
		OperationID: work.OperationID,
		LeaseOwner:  work.LeaseOwner,
		CompletedAt: service.clock.Now().UTC(),
	}
	if work.DesiredRevision != work.ServerRevision {
		completion.Status = imcommunityport.CompletionSuperseded
		return true, service.complete(ctx, completion)
	}
	if work.IMState == "ready" {
		completion.Status = imcommunityport.CompletionSucceeded
		return true, service.complete(ctx, completion)
	}
	err = service.provisioner.EnsureCommunity(
		ctx,
		tencentimport.Community{
			GroupID:      work.GroupID,
			OwnerUserID:  work.OwnerIMUserID,
			Name:         work.ServerName,
			Introduction: work.Description,
		},
	)
	completion.CompletedAt = service.clock.Now().UTC()
	if err == nil {
		completion.Status = imcommunityport.CompletionSucceeded
		return true, service.complete(ctx, completion)
	}

	completion.ErrorCode = tencentimport.CodeOf(err)
	if completion.ErrorCode == "" {
		completion.ErrorCode = "tencent_unknown_error"
	}
	if tencentimport.IsRetryable(err) &&
		work.Attempts < service.config.MaxAttempts {
		completion.Status = imcommunityport.CompletionRetry
		completion.NextAttemptAt = completion.CompletedAt.Add(
			service.backoff(work.Attempts),
		)
	} else {
		completion.Status = imcommunityport.CompletionFailed
	}
	return true, service.complete(ctx, completion)
}

func (service *Service) complete(
	ctx context.Context,
	completion imcommunityport.Completion,
) error {
	err := service.repository.Complete(ctx, completion)
	if errors.Is(err, imcommunityport.ErrLeaseLost) {
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
