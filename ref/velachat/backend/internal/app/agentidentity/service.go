// Package agentidentity 收敛 Agent 普通腾讯 IM UserID。
package agentidentity

import (
	"context"
	"errors"
	"strings"
	"time"

	agentidentityport "chatserver/internal/ports/agentidentity"
	clockport "chatserver/internal/ports/clock"
	idport "chatserver/internal/ports/id"
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
	repository  agentidentityport.Repository
	provisioner identityProvider
	ids         idport.Generator
	clock       clockport.Clock
	config      Config
}

type identityProvider interface {
	tencentimport.IdentityProvisioner
	tencentimport.IdentityDeprovisioner
}

func NewService(
	repository agentidentityport.Repository,
	provisioner identityProvider,
	ids idport.Generator,
	clock clockport.Clock,
	config Config,
) (*Service, error) {
	if repository == nil || provisioner == nil || ids == nil || clock == nil ||
		strings.TrimSpace(config.WorkerID) == "" ||
		config.LeaseTTL <= 0 || config.MaxAttempts <= 0 ||
		config.BaseBackoff <= 0 || config.MaxBackoff < config.BaseBackoff {
		return nil, errors.New("Agent IM 身份 Worker 配置无效")
	}
	return &Service{
		repository: repository, provisioner: provisioner,
		ids: ids, clock: clock, config: config,
	}, nil
}

func (service *Service) ProcessOne(ctx context.Context) (bool, error) {
	now := service.clock.Now().UTC()
	work, ok, err := service.repository.Claim(
		ctx,
		agentidentityport.Claim{
			LeaseOwner: service.config.WorkerID, Now: now,
			LeaseExpiresAt: now.Add(service.config.LeaseTTL),
		},
	)
	if err != nil || !ok {
		return false, err
	}
	completion := agentidentityport.Completion{
		OperationID: work.OperationID,
		LeaseOwner:  work.LeaseOwner,
		CompletedAt: service.clock.Now().UTC(),
	}
	if work.DesiredRevision != work.AgentRevision {
		completion.Status = agentidentityport.CompletionSuperseded
		return true, service.complete(ctx, completion)
	}
	if work.Kind == "im.identity.delete" {
		if !work.Deleted {
			completion.Status = agentidentityport.CompletionSuperseded
			return true, service.complete(ctx, completion)
		}
		return service.processDelete(ctx, work, completion)
	}
	if work.Kind != "im.identity.ensure" || work.Deleted {
		completion.Status = agentidentityport.CompletionSuperseded
		return true, service.complete(ctx, completion)
	}
	if work.IMState == "ready" {
		return service.completeSuccess(ctx, completion)
	}
	if strings.TrimSpace(work.IMUserID) == "" {
		completion.Status = agentidentityport.CompletionFailed
		completion.ErrorCode = "im_identity_missing"
		return true, service.complete(ctx, completion)
	}
	err = service.provisioner.EnsureIdentity(
		ctx,
		tencentimport.Identity{
			UserID: work.IMUserID,
			Nick:   work.DisplayName,
		},
	)
	completion.CompletedAt = service.clock.Now().UTC()
	if err == nil {
		return service.completeSuccess(ctx, completion)
	}
	completion.ErrorCode = tencentimport.CodeOf(err)
	if completion.ErrorCode == "" {
		completion.ErrorCode = "tencent_unknown_error"
	}
	if tencentimport.IsRetryable(err) &&
		work.Attempts < service.config.MaxAttempts {
		completion.Status = agentidentityport.CompletionRetry
		completion.NextAttemptAt = completion.CompletedAt.Add(
			service.backoff(work.Attempts),
		)
	} else {
		completion.Status = agentidentityport.CompletionFailed
	}
	return true, service.complete(ctx, completion)
}

func (service *Service) processDelete(
	ctx context.Context,
	work agentidentityport.Work,
	completion agentidentityport.Completion,
) (bool, error) {
	err := service.repository.RevokeRoute(
		ctx,
		agentidentityport.RouteRevocation{
			OperationID: work.OperationID,
			LeaseOwner:  work.LeaseOwner,
			AgentID:     work.AgentID,
			IMUserID:    work.IMUserID,
			RevokedAt:   service.clock.Now().UTC(),
		},
	)
	if err != nil {
		return service.completeFailure(
			ctx, work, completion, "im_route_revoke_failed", true,
		)
	}
	if strings.TrimSpace(work.IMUserID) == "" {
		return service.completeFailure(
			ctx, work, completion, "im_identity_missing", false,
		)
	}
	if err := service.provisioner.KickIdentity(ctx, work.IMUserID); err != nil {
		return service.completeTencentFailure(ctx, work, completion, err)
	}
	if err := service.provisioner.DeleteIdentity(ctx, work.IMUserID); err != nil {
		return service.completeTencentFailure(ctx, work, completion, err)
	}
	completion.CompletedAt = service.clock.Now().UTC()
	completion.Status = agentidentityport.CompletionSucceeded
	return true, service.complete(ctx, completion)
}

func (service *Service) completeTencentFailure(
	ctx context.Context,
	work agentidentityport.Work,
	completion agentidentityport.Completion,
	err error,
) (bool, error) {
	code := tencentimport.CodeOf(err)
	if code == "" {
		code = "tencent_unknown_error"
	}
	return service.completeFailure(
		ctx,
		work,
		completion,
		code,
		tencentimport.IsRetryable(err),
	)
}

func (service *Service) completeFailure(
	ctx context.Context,
	work agentidentityport.Work,
	completion agentidentityport.Completion,
	code string,
	retryable bool,
) (bool, error) {
	completion.CompletedAt = service.clock.Now().UTC()
	completion.ErrorCode = code
	if retryable && work.Attempts < service.config.MaxAttempts {
		completion.Status = agentidentityport.CompletionRetry
		completion.NextAttemptAt = completion.CompletedAt.Add(
			service.backoff(work.Attempts),
		)
	} else {
		completion.Status = agentidentityport.CompletionFailed
	}
	return true, service.complete(ctx, completion)
}

// RepairLegacyMemberships 为旧版本误标 ready 的 Agent 补发一次 Community ensure。
func (service *Service) RepairLegacyMemberships(
	ctx context.Context,
) (int, error) {
	completed, err := service.repository.LegacyMembershipRepairCompleted(ctx)
	if err != nil || completed {
		return 0, err
	}
	repaired := 0
	for {
		if err := ctx.Err(); err != nil {
			return repaired, err
		}
		candidate, found, err := service.repository.FindLegacyMembership(ctx)
		if err != nil {
			return repaired, err
		}
		if !found {
			markerID, err := service.ids.New()
			if err != nil {
				return repaired, err
			}
			err = service.repository.CompleteLegacyMembershipRepair(
				ctx,
				markerID,
				service.clock.Now().UTC(),
			)
			return repaired, err
		}
		operationID, err := service.ids.New()
		if err != nil {
			return repaired, err
		}
		scheduled, err := service.repository.ScheduleLegacyMembership(
			ctx,
			agentidentityport.LegacyMembershipSchedule{
				LegacyMembership: candidate,
				OperationID:      operationID,
				ScheduledAt:      service.clock.Now().UTC(),
			},
		)
		if err != nil {
			return repaired, err
		}
		if scheduled {
			repaired++
		}
	}
}

func (service *Service) completeSuccess(
	ctx context.Context,
	completion agentidentityport.Completion,
) (bool, error) {
	operationID, err := service.ids.New()
	if err != nil {
		return true, err
	}
	completion.Status = agentidentityport.CompletionSucceeded
	completion.MembershipOperationID = operationID
	return true, service.complete(ctx, completion)
}

func (service *Service) complete(
	ctx context.Context,
	completion agentidentityport.Completion,
) error {
	err := service.repository.Complete(ctx, completion)
	if errors.Is(err, agentidentityport.ErrLeaseLost) {
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
