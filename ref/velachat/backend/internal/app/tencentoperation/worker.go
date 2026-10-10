// Package tencentoperation 编排腾讯云 TAT 可靠操作。
package tencentoperation

import (
	"context"
	"errors"
	"strings"
	"time"

	clockport "chatserver/internal/ports/clock"
	tencentoperationport "chatserver/internal/ports/tencentoperation"
	tencenttatport "chatserver/internal/ports/tencenttat"
)

// Config 配置租约、重试和执行中轮询。
type Config struct {
	WorkerID    string
	LeaseTTL    time.Duration
	MaxAttempts int64
	BaseBackoff time.Duration
	MaxBackoff  time.Duration
	PollDelay   time.Duration
}

// Service 每次领取并推进一个 TAT 操作。
type Service struct {
	repository tencentoperationport.Repository
	client     tencenttatport.Client
	clock      clockport.Clock
	config     Config
}

// NewComputerService 只处理 Computer 注册与探测。Agent 生命周期由
// Computer Assignment 收敛，不通过 TAT RunCommand 部署独立 Agent Host。
func NewComputerService(
	repository tencentoperationport.Repository,
	client tencenttatport.Client,
	clock clockport.Clock,
	config Config,
) (*Service, error) {
	if repository == nil || client == nil || clock == nil ||
		strings.TrimSpace(config.WorkerID) == "" ||
		config.LeaseTTL <= 0 || config.MaxAttempts <= 0 ||
		config.BaseBackoff <= 0 || config.MaxBackoff < config.BaseBackoff ||
		config.PollDelay <= 0 {
		return nil, errors.New("TAT Worker 配置无效")
	}
	return &Service{
		repository: repository,
		client:     client,
		clock:      clock,
		config:     config,
	}, nil
}

// ProcessOne 领取并推进至多一个操作。
func (service *Service) ProcessOne(ctx context.Context) (bool, error) {
	if ctx == nil {
		return false, errors.New("TAT Worker 上下文无效")
	}
	now := service.clock.Now().UTC()
	work, ok, err := service.repository.Claim(ctx, tencentoperationport.Claim{
		LeaseOwner:     service.config.WorkerID,
		Now:            now,
		LeaseExpiresAt: now.Add(service.config.LeaseTTL),
	})
	if err != nil || !ok {
		return false, err
	}
	completion := tencentoperationport.Completion{
		OperationID: work.OperationID,
		LeaseOwner:  work.LeaseOwner,
		CompletedAt: service.clock.Now().UTC(),
	}
	if work.DesiredRevision != work.ResourceRevision {
		completion.Status = tencentoperationport.CompletionSuperseded
		completion.ErrorCode = "stale_revision"
		return true, service.complete(ctx, completion)
	}
	if work.ResourceType != "computer" {
		completion.Status = tencentoperationport.CompletionFailed
		completion.ErrorCode = "tat_resource_type_invalid"
		return true, service.complete(ctx, completion)
	}
	return true, service.processComputer(ctx, work, completion)
}

func (service *Service) processComputer(
	ctx context.Context,
	work tencentoperationport.Work,
	completion tencentoperationport.Completion,
) error {
	switch work.Kind {
	case "tat.computer.registration.reconcile":
		return service.reconcileComputerRegistration(ctx, work, completion)
	case "tat.computer.refresh":
		return service.refreshComputer(ctx, work, completion)
	default:
		completion.Status = tencentoperationport.CompletionFailed
		completion.ErrorCode = "tat_operation_kind_invalid"
		return service.complete(ctx, completion)
	}
}

func (service *Service) reconcileComputerRegistration(
	ctx context.Context,
	work tencentoperationport.Work,
	completion tencentoperationport.Completion,
) error {
	now := service.clock.Now().UTC()
	if work.RegistrationExpiresAt == nil ||
		!work.RegistrationExpiresAt.After(now) {
		completion.Status = tencentoperationport.CompletionFailed
		completion.ErrorCode = "registration_expired"
		completion.CompletedAt = now
		return service.complete(ctx, completion)
	}
	if strings.TrimSpace(work.Target.Region) == "" ||
		(work.Target.OS != tencenttatport.OSLinux &&
			work.Target.OS != tencenttatport.OSWindows &&
			work.Target.OS != tencenttatport.OSMacOS) {
		completion.Status = tencentoperationport.CompletionFailed
		completion.ErrorCode = "tat_target_invalid"
		return service.complete(ctx, completion)
	}
	managed, found, err := service.client.FindManagedByComputerTag(
		ctx,
		work.Target.Region,
		work.ResourceID,
	)
	if err != nil {
		if tencenttatport.IsRetryable(err) {
			return service.completeRegistrationRetry(
				ctx,
				work,
				completion,
				stableTATErrorCode(err),
			)
		}
		return service.completeTencentError(ctx, work, completion, err)
	}
	if !found {
		return service.completeRegistrationRetry(
			ctx,
			work,
			completion,
			"tat_registration_pending",
		)
	}
	if !strings.HasPrefix(managed.InstanceID, "rins-") {
		completion.Status = tencentoperationport.CompletionFailed
		completion.ErrorCode = "tat_managed_instance_invalid"
		return service.complete(ctx, completion)
	}
	if !tencenttatport.ObservedOSCompatible(work.Target.OS, managed.OS) {
		completion.Status = tencentoperationport.CompletionFailed
		completion.ErrorCode = "computer_os_mismatch"
		return service.complete(ctx, completion)
	}
	if !managed.Online {
		return service.completeRegistrationRetry(
			ctx,
			work,
			completion,
			"tat_agent_offline",
		)
	}
	online := true
	completion.Status = tencentoperationport.CompletionSucceeded
	completion.ComputerInstanceID = managed.InstanceID
	completion.ComputerOS = work.Target.OS
	completion.ComputerTATOnline = &online
	completion.CompletedAt = now
	return service.complete(ctx, completion)
}

func (service *Service) completeRegistrationRetry(
	ctx context.Context,
	work tencentoperationport.Work,
	completion tencentoperationport.Completion,
	code string,
) error {
	now := service.clock.Now().UTC()
	if work.RegistrationExpiresAt == nil ||
		!work.RegistrationExpiresAt.After(now) {
		completion.Status = tencentoperationport.CompletionFailed
		completion.ErrorCode = "registration_expired"
		completion.CompletedAt = now
		return service.complete(ctx, completion)
	}
	next := now.Add(service.config.PollDelay)
	if next.After(*work.RegistrationExpiresAt) {
		next = work.RegistrationExpiresAt.UTC()
	}
	completion.Status = tencentoperationport.CompletionRetry
	completion.ErrorCode = code
	completion.NextAttemptAt = next
	completion.CompletedAt = now
	return service.complete(ctx, completion)
}

func (service *Service) refreshComputer(
	ctx context.Context,
	work tencentoperationport.Work,
	completion tencentoperationport.Completion,
) error {
	if !work.ComputerActive {
		completion.Status = tencentoperationport.CompletionFailed
		completion.ErrorCode = "computer_not_active"
		return service.complete(ctx, completion)
	}
	if work.Target.Validate() != nil {
		completion.Status = tencentoperationport.CompletionFailed
		completion.ErrorCode = "tat_target_invalid"
		return service.complete(ctx, completion)
	}
	status, err := service.client.Probe(ctx, work.Target)
	if err != nil {
		return service.completeTencentError(ctx, work, completion, err)
	}
	if !tencenttatport.ObservedOSCompatible(work.Target.OS, status.OS) {
		completion.Status = tencentoperationport.CompletionFailed
		completion.ErrorCode = "computer_os_mismatch"
		return service.complete(ctx, completion)
	}
	online := status.Online
	completion.Status = tencentoperationport.CompletionSucceeded
	completion.ComputerOS = work.Target.OS
	completion.ComputerTATOnline = &online
	completion.CompletedAt = service.clock.Now().UTC()
	return service.complete(ctx, completion)
}

func stableTATErrorCode(err error) string {
	code := tencenttatport.CodeOf(err)
	if code == "" {
		return "tat_unknown_error"
	}
	return code
}

func (service *Service) completeTencentError(
	ctx context.Context,
	work tencentoperationport.Work,
	completion tencentoperationport.Completion,
	err error,
) error {
	code := tencenttatport.CodeOf(err)
	if code == "" {
		code = "tat_unknown_error"
	}
	return service.completeFailure(
		ctx,
		work,
		completion,
		code,
		tencenttatport.IsRetryable(err),
		tencenttatport.IsUncertain(err),
	)
}

func (service *Service) completeFailure(
	ctx context.Context,
	work tencentoperationport.Work,
	completion tencentoperationport.Completion,
	code string,
	retryable bool,
	uncertain bool,
) error {
	completion.CompletedAt = service.clock.Now().UTC()
	completion.ErrorCode = code
	if retryable && work.Attempts < service.config.MaxAttempts {
		completion.Status = tencentoperationport.CompletionRetry
		completion.NextAttemptAt = completion.CompletedAt.Add(
			service.backoff(work.Attempts),
		)
	} else if uncertain {
		completion.Status = tencentoperationport.CompletionUncertain
	} else {
		completion.Status = tencentoperationport.CompletionFailed
	}
	return service.complete(ctx, completion)
}

func (service *Service) complete(
	ctx context.Context,
	completion tencentoperationport.Completion,
) error {
	err := service.repository.Complete(ctx, completion)
	if errors.Is(err, tencentoperationport.ErrLeaseLost) {
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
