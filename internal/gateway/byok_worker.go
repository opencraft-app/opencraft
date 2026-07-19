package gateway

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"git.woa.com/wisp/mono2/llmgateway/internal/observability"
	"go.opentelemetry.io/otel/attribute"
)

type BYOKWorkerOptions struct {
	PollInterval   time.Duration
	LeaseTTL       time.Duration
	MaxConcurrency int
	SetConcurrency int
	CandidateBatch int
}

type BYOKWorkerResult struct {
	ExternalUserID string
	SetID          string
	Duration       time.Duration
	Err            error
}

type byokTaskProcessor func(context.Context, string) error

func (s *Service) RunBYOKWorker(ctx context.Context, owner string, opts BYOKWorkerOptions, onResult func(BYOKWorkerResult)) error {
	return s.runBYOKWorker(ctx, owner, opts, func(taskCtx context.Context, externalUserID string) error {
		_, err := s.syncUserLLMSettings(taskCtx, externalUserID)
		return err
	}, onResult)
}

func (s *Service) runBYOKWorker(ctx context.Context, owner string, opts BYOKWorkerOptions, processor byokTaskProcessor, onResult func(BYOKWorkerResult)) error {
	owner = strings.TrimSpace(owner)
	if owner == "" {
		owner = "byok-worker"
	}
	if processor == nil {
		return fmt.Errorf("BYOK task processor is required")
	}
	if opts.PollInterval <= 0 {
		opts.PollInterval = time.Second
	}
	if opts.LeaseTTL <= 0 {
		opts.LeaseTTL = 5 * time.Minute
	}
	if opts.MaxConcurrency <= 0 {
		opts.MaxConcurrency = 16
	}
	if opts.SetConcurrency <= 0 {
		opts.SetConcurrency = 4
	}
	if opts.SetConcurrency > opts.MaxConcurrency {
		opts.SetConcurrency = opts.MaxConcurrency
	}
	if opts.CandidateBatch <= 0 {
		opts.CandidateBatch = opts.MaxConcurrency * 4
	}

	globalSlots := make(chan struct{}, opts.MaxConcurrency)
	setSlots := map[string]chan struct{}{}
	var wg sync.WaitGroup

	ticker := time.NewTicker(opts.PollInterval)
	defer ticker.Stop()
	for {
		s.dispatchBYOKTasks(ctx, owner, opts, processor, onResult, globalSlots, setSlots, &wg)
		select {
		case <-ctx.Done():
			wg.Wait()
			return nil
		case <-ticker.C:
		}
	}
}

func (s *Service) dispatchBYOKTasks(
	ctx context.Context,
	owner string,
	opts BYOKWorkerOptions,
	processor byokTaskProcessor,
	onResult func(BYOKWorkerResult),
	globalSlots chan struct{},
	setSlots map[string]chan struct{},
	wg *sync.WaitGroup,
) {
	available := cap(globalSlots) - len(globalSlots)
	if available <= 0 || ctx.Err() != nil {
		return
	}
	excludedSetIDs := fullWorkerSetIDs(setSlots, "")
	tasks, err := s.store.ListBYOKSyncTasks(ctx, BYOKSyncTaskListOptions{
		ExcludeSetIDs: excludedSetIDs,
		Now:           s.nowUTC(),
		Limit:         opts.CandidateBatch,
	})
	if err != nil || len(tasks) == 0 {
		return
	}
	bySet, setOrder := groupClaimableBYOKTasks(tasks)
	for _, setID := range setOrder {
		if cap(globalSlots)-len(globalSlots) <= 0 || ctx.Err() != nil {
			return
		}
		setSemaphore := setSlots[setID]
		if setSemaphore == nil {
			setSemaphore = make(chan struct{}, opts.SetConcurrency)
			setSlots[setID] = setSemaphore
		}
		claimed := make([]BYOKSyncTask, 0, opts.SetConcurrency)
	claimLoop:
		for _, candidate := range bySet[setID] {
			select {
			case globalSlots <- struct{}{}:
			default:
				break claimLoop
			}
			select {
			case setSemaphore <- struct{}{}:
			default:
				<-globalSlots
				break claimLoop
			}
			taskOwner := fmt.Sprintf("%s/%s/%d", owner, candidate.ExternalUserID, s.nowUTC().UnixNano())
			task, acquired, acquireErr := s.store.TryAcquireBYOKSyncTask(ctx, candidate.ExternalUserID, taskOwner, opts.LeaseTTL, s.nowUTC())
			if acquireErr != nil || !acquired {
				<-setSemaphore
				<-globalSlots
				continue
			}
			claimed = append(claimed, task)
		}
		if len(claimed) == 0 {
			continue
		}

		set, ok, setErr := s.store.GetSet(ctx, setID)
		if setErr == nil && !ok {
			setErr = fmt.Errorf("set %q not found", setID)
		}
		if setErr == nil && (set.AdminUserID == 0 || strings.TrimSpace(set.AdminAccessToken) == "") {
			setErr = fmt.Errorf("set %q is not bootstrapped", setID)
		}
		if setErr == nil {
			prepareTimeout := opts.LeaseTTL / 3
			if prepareTimeout <= 0 {
				prepareTimeout = time.Minute
			}
			prepareCtx, cancel := context.WithTimeout(ctx, prepareTimeout)
			_, setErr = s.reconcileSetGroupRatios(prepareCtx, set)
			cancel()
		}
		if setErr != nil {
			for _, task := range claimed {
				resultErr := setErr
				if ctx.Err() != nil {
					resultErr = errors.Join(ctx.Err(), s.releaseBYOKSyncTask(ctx, task))
				} else {
					_, completeErr := s.store.CompleteBYOKSyncTask(ctx, task, false, setErr.Error(), s.nowUTC())
					if completeErr != nil {
						resultErr = errors.Join(setErr, completeErr)
					}
				}
				if onResult != nil {
					onResult(BYOKWorkerResult{ExternalUserID: task.ExternalUserID, SetID: task.SetID, Err: resultErr})
				}
				<-setSemaphore
				<-globalSlots
			}
			continue
		}

		for _, task := range claimed {
			task := task
			wg.Add(1)
			go func() {
				defer wg.Done()
				defer func() {
					<-setSemaphore
					<-globalSlots
				}()
				started := time.Now()
				taskProcessor := processor
				if strings.TrimSpace(task.SetID) != "" {
					taskProcessor = func(taskCtx context.Context, externalUserID string) error {
						return s.withSetOperationLease(taskCtx, task.SetID, SetOperationBYOKSync, opts.SetConcurrency, func(leasedCtx context.Context) error {
							return processor(leasedCtx, externalUserID)
						})
					}
				}
				runErr := s.runAcquiredBYOKSyncTask(ctx, task, opts.LeaseTTL, taskProcessor)
				if onResult != nil {
					onResult(BYOKWorkerResult{ExternalUserID: task.ExternalUserID, SetID: task.SetID, Duration: time.Since(started), Err: runErr})
				}
			}()
		}
	}
}

func fullWorkerSetIDs(setSlots map[string]chan struct{}, emptySetKey string) []string {
	setIDs := make([]string, 0, len(setSlots))
	for setKey, slots := range setSlots {
		if cap(slots) == 0 || len(slots) < cap(slots) {
			continue
		}
		if setKey == emptySetKey {
			setKey = ""
		}
		setIDs = append(setIDs, setKey)
	}
	return setIDs
}

func groupClaimableBYOKTasks(tasks []BYOKSyncTask) (map[string][]BYOKSyncTask, []string) {
	bySet := make(map[string][]BYOKSyncTask)
	order := make([]string, 0)
	for _, task := range tasks {
		setID := strings.TrimSpace(task.SetID)
		if _, ok := bySet[setID]; !ok {
			order = append(order, setID)
		}
		bySet[setID] = append(bySet[setID], task)
	}
	return bySet, order
}

func (s *Service) runAcquiredBYOKSyncTask(ctx context.Context, task BYOKSyncTask, leaseTTL time.Duration, processor byokTaskProcessor) (err error) {
	ctx, span := s.startTelemetrySpan(ctx, observability.ScopeConfigConsistency, "llmgateway.byok.sync",
		attribute.String("llmgateway.user.id", task.ExternalUserID),
		attribute.String("llmgateway.set.id", task.SetID),
		attribute.Int64("llmgateway.byok.processing_version", task.ProcessingVersion),
		attribute.Int("llmgateway.attempt", task.Attempts),
	)
	defer func() { observability.FinishSpan(span, err, "byok_sync_failed", s.telemetrySanitizer) }()
	if leaseTTL <= 0 {
		leaseTTL = 5 * time.Minute
	}
	taskCtx, cancel := context.WithCancel(ctx)
	heartbeatDone := make(chan error, 1)
	go s.renewBYOKSyncTaskLease(taskCtx, cancel, task, leaseTTL, heartbeatDone)
	processErr := processor(taskCtx, task.ExternalUserID)
	cancel()
	heartbeatErr := <-heartbeatDone
	if heartbeatErr != nil {
		return heartbeatErr
	}
	if ctx.Err() != nil {
		return errors.Join(ctx.Err(), s.releaseBYOKSyncTask(ctx, task))
	}

	completeCtx, completeCancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer completeCancel()
	if processErr != nil {
		completed, completeErr := s.store.CompleteBYOKSyncTask(completeCtx, task, false, processErr.Error(), s.nowUTC())
		if completeErr == nil {
			s.emitBYOKTaskTransition(completeCtx, task, completed)
			s.emitOperationFailure(completeCtx, observability.ScopeConfigConsistency, "llmgateway.config.operation_failed", "byok_sync_failed",
				attribute.String("llmgateway.user.id", task.ExternalUserID),
				attribute.String("llmgateway.set.id", task.SetID),
				attribute.Int64("llmgateway.byok.processing_version", task.ProcessingVersion),
			)
		}
		return errors.Join(processErr, completeErr)
	}
	completed, completeErr := s.store.CompleteBYOKSyncTask(completeCtx, task, true, "", s.nowUTC())
	if completeErr == nil {
		s.emitBYOKTaskTransition(completeCtx, task, completed)
	}
	return completeErr
}

func (s *Service) emitBYOKTaskTransition(ctx context.Context, previous, current BYOKSyncTask) {
	s.emitCommittedTransition(ctx, observability.ScopeConfigConsistency, "llmgateway.config.state_changed",
		"byok_sync_task", current.ExternalUserID, previous.Status, current.Status,
		attribute.String("llmgateway.user.id", current.ExternalUserID),
		attribute.String("llmgateway.set.id", current.SetID),
		attribute.Int64("llmgateway.byok.requested_version", current.RequestedVersion),
		attribute.Int64("llmgateway.byok.processing_version", current.ProcessingVersion),
		attribute.Int64("llmgateway.byok.applied_version", current.AppliedVersion),
		attribute.Int("llmgateway.attempt", current.Attempts),
	)
}

func (s *Service) releaseBYOKSyncTask(ctx context.Context, task BYOKSyncTask) error {
	releaseCtx, releaseCancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer releaseCancel()
	released, err := s.store.ReleaseBYOKSyncTaskLease(releaseCtx, task, s.nowUTC())
	if err == nil && !released {
		return ErrBYOKSyncTaskLeaseLost
	}
	return err
}

func (s *Service) renewBYOKSyncTaskLease(ctx context.Context, cancel context.CancelFunc, task BYOKSyncTask, leaseTTL time.Duration, done chan<- error) {
	interval := leaseTTL / 3
	if interval <= 0 {
		interval = time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			done <- nil
			return
		case <-ticker.C:
			renewed, err := s.store.RenewBYOKSyncTaskLease(ctx, task, leaseTTL, s.nowUTC())
			if err == nil && !renewed {
				err = ErrBYOKSyncTaskLeaseLost
			}
			if err != nil {
				cancel()
				done <- err
				return
			}
		}
	}
}
