// Package imidentity 编排 Human IM 身份的可靠异步创建。
package imidentity

import (
	"context"
	"errors"
	"strings"
	"time"

	clockport "chatserver/internal/ports/clock"
	imidentityport "chatserver/internal/ports/imidentity"
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

// Service 每次领取并收敛一个 im.identity.ensure 操作。
type Service struct {
	repository  imidentityport.Repository
	deriver     imidentityport.IdentityDeriver
	provisioner tencentimport.IdentityProvisioner
	clock       clockport.Clock
	config      Config
}

// NewService 创建 IM 身份 Worker 应用服务。
func NewService(
	repository imidentityport.Repository,
	deriver imidentityport.IdentityDeriver,
	provisioner tencentimport.IdentityProvisioner,
	clock clockport.Clock,
	config Config,
) (*Service, error) {
	if repository == nil || deriver == nil || provisioner == nil ||
		clock == nil || strings.TrimSpace(config.WorkerID) == "" ||
		config.LeaseTTL <= 0 || config.MaxAttempts <= 0 ||
		config.BaseBackoff <= 0 || config.MaxBackoff < config.BaseBackoff {
		return nil, errors.New("IM 身份 Worker 配置无效")
	}
	return &Service{
		repository:  repository,
		deriver:     deriver,
		provisioner: provisioner,
		clock:       clock,
		config:      config,
	}, nil
}

// ProcessOne 处理至多一个已到期操作。
func (service *Service) ProcessOne(ctx context.Context) (bool, error) {
	now := service.clock.Now().UTC()
	work, ok, err := service.repository.Claim(ctx, imidentityport.Claim{
		LeaseOwner:     service.config.WorkerID,
		Now:            now,
		LeaseExpiresAt: now.Add(service.config.LeaseTTL),
	})
	if err != nil || !ok {
		return false, err
	}
	completion := imidentityport.Completion{
		OperationID: work.OperationID,
		LeaseOwner:  work.LeaseOwner,
		CompletedAt: now,
	}
	if work.DesiredRevision != work.AccountRevision {
		completion.Status = imidentityport.CompletionSuperseded
		completion.CompletedAt = service.clock.Now().UTC()
		return true, service.complete(ctx, completion)
	}
	if work.IMState == "ready" && strings.TrimSpace(work.IMUserID) != "" {
		completion.Status = imidentityport.CompletionSucceeded
		completion.IMUserID = work.IMUserID
		completion.CompletedAt = service.clock.Now().UTC()
		return true, service.complete(ctx, completion)
	}
	userID := strings.TrimSpace(work.IMUserID)
	if userID == "" {
		userID, err = service.deriver.HumanUserID(work.AccountID)
		if err != nil {
			completion.Status = imidentityport.CompletionFailed
			completion.ErrorCode = "im_identity_derivation_failed"
			completion.CompletedAt = service.clock.Now().UTC()
			return true, service.complete(ctx, completion)
		}
	}
	err = service.provisioner.EnsureIdentity(ctx, tencentimport.Identity{
		UserID: userID,
		Nick:   work.DisplayName,
	})
	if err == nil {
		completion.Status = imidentityport.CompletionSucceeded
		completion.IMUserID = userID
		completion.CompletedAt = service.clock.Now().UTC()
		return true, service.complete(ctx, completion)
	}
	completion.CompletedAt = service.clock.Now().UTC()
	completion.ErrorCode = tencentimport.CodeOf(err)
	if completion.ErrorCode == "" {
		completion.ErrorCode = "tencent_unknown_error"
	}
	if tencentimport.IsRetryable(err) && work.Attempts < service.config.MaxAttempts {
		completion.Status = imidentityport.CompletionRetry
		completion.NextAttemptAt = completion.CompletedAt.Add(
			service.backoff(work.Attempts),
		)
	} else {
		completion.Status = imidentityport.CompletionFailed
	}
	return true, service.complete(ctx, completion)
}

func (service *Service) complete(
	ctx context.Context,
	completion imidentityport.Completion,
) error {
	err := service.repository.Complete(ctx, completion)
	if errors.Is(err, imidentityport.ErrLeaseLost) {
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
