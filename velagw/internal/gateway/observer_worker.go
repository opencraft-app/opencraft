package gateway

import (
	"context"
	"errors"
	"fmt"
	"hash/fnv"
	"strings"
	"sync"
	"time"
)

type ObserverWorkerOptions struct {
	PollInterval   time.Duration
	LeaseTTL       time.Duration
	MaxConcurrency int
	SetConcurrency int
	CandidateBatch int
	SeedPoll       time.Duration
	SeedLeaseTTL   time.Duration
}

type ObserverWorkerResult struct {
	ExternalUserID string
	SetID          string
	Duration       time.Duration
	Err            error
}

type tenantObservationProcessor func(context.Context, string) (TenantObservation, error)

func (s *Service) RunObserverWorker(ctx context.Context, owner string, opts ObserverWorkerOptions, onResult func(ObserverWorkerResult), onSeedRun func(WorkerJobRun)) error {
	if err := s.ensureDefaultWorkerJobs(ctx); err != nil {
		return err
	}
	if opts.SeedPoll <= 0 {
		opts.SeedPoll = 5 * time.Second
	}
	if opts.SeedLeaseTTL < minimumWorkerLeaseTTL {
		opts.SeedLeaseTTL = time.Minute
	}
	seedDone := make(chan struct{})
	go func() {
		defer close(seedDone)
		s.runWorkerJobLoop(ctx, owner, WorkerJobRefreshTenantObservations, opts.SeedPoll, opts.SeedLeaseTTL, onSeedRun)
	}()
	err := s.runObserverWorker(ctx, owner, opts, s.ObserveTenant, onResult)
	<-seedDone
	return err
}

func (s *Service) runObserverWorker(ctx context.Context, owner string, opts ObserverWorkerOptions, processor tenantObservationProcessor, onResult func(ObserverWorkerResult)) error {
	owner = strings.TrimSpace(owner)
	if owner == "" {
		owner = "observer-worker"
	}
	if processor == nil {
		return fmt.Errorf("tenant observation processor is required")
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
		s.dispatchTenantObservationTasks(ctx, owner, opts, processor, onResult, globalSlots, setSlots, &wg)
		select {
		case <-ctx.Done():
			wg.Wait()
			return nil
		case <-ticker.C:
		}
	}
}

func (s *Service) dispatchTenantObservationTasks(
	ctx context.Context,
	owner string,
	opts ObserverWorkerOptions,
	processor tenantObservationProcessor,
	onResult func(ObserverWorkerResult),
	globalSlots chan struct{},
	setSlots map[string]chan struct{},
	wg *sync.WaitGroup,
) {
	if cap(globalSlots)-len(globalSlots) <= 0 || ctx.Err() != nil {
		return
	}
	excludedSetIDs := fullWorkerSetIDs(setSlots, "_pending_backend")
	tasks, err := s.store.ListTenantObservationTasks(ctx, TenantObservationTaskListOptions{
		ExcludeSetIDs: excludedSetIDs,
		Now:           s.nowUTC(),
		Limit:         opts.CandidateBatch,
	})
	if err != nil || len(tasks) == 0 {
		return
	}
	bySet, setOrder := groupClaimableObservationTasks(tasks)
	for _, setKey := range setOrder {
		if cap(globalSlots)-len(globalSlots) <= 0 || ctx.Err() != nil {
			return
		}
		setSemaphore := setSlots[setKey]
		if setSemaphore == nil {
			setSemaphore = make(chan struct{}, opts.SetConcurrency)
			setSlots[setKey] = setSemaphore
		}
	claimLoop:
		for _, candidate := range bySet[setKey] {
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
			task, acquired, acquireErr := s.store.TryAcquireTenantObservationTask(ctx, candidate.ExternalUserID, taskOwner, opts.LeaseTTL, s.nowUTC())
			if acquireErr != nil || !acquired {
				<-setSemaphore
				<-globalSlots
				continue
			}
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
					taskProcessor = func(taskCtx context.Context, externalUserID string) (TenantObservation, error) {
						var observation TenantObservation
						err := s.withSetOperationLease(taskCtx, task.SetID, SetOperationTenantObservation, opts.SetConcurrency, func(leasedCtx context.Context) error {
							var err error
							observation, err = processor(leasedCtx, externalUserID)
							return err
						})
						return observation, err
					}
				}
				runErr := s.runAcquiredTenantObservationTask(ctx, task, opts.LeaseTTL, taskProcessor)
				if onResult != nil {
					onResult(ObserverWorkerResult{ExternalUserID: task.ExternalUserID, SetID: task.SetID, Duration: time.Since(started), Err: runErr})
				}
			}()
		}
	}
}

func groupClaimableObservationTasks(tasks []TenantObservationTask) (map[string][]TenantObservationTask, []string) {
	bySet := make(map[string][]TenantObservationTask)
	order := make([]string, 0)
	for _, task := range tasks {
		setKey := strings.TrimSpace(task.SetID)
		if setKey == "" {
			setKey = "_pending_backend"
		}
		if _, ok := bySet[setKey]; !ok {
			order = append(order, setKey)
		}
		bySet[setKey] = append(bySet[setKey], task)
	}
	return bySet, order
}

func (s *Service) runAcquiredTenantObservationTask(ctx context.Context, task TenantObservationTask, leaseTTL time.Duration, processor tenantObservationProcessor) error {
	if leaseTTL <= 0 {
		leaseTTL = 5 * time.Minute
	}
	taskCtx, cancel := context.WithCancel(ctx)
	heartbeatDone := make(chan error, 1)
	go s.renewTenantObservationTaskLease(taskCtx, cancel, task, leaseTTL, heartbeatDone)

	blockedReason, checkErr := s.tenantObservationBlockReason(taskCtx, task)
	var observation TenantObservation
	processErr := checkErr
	if processErr == nil && blockedReason == "" {
		observation, processErr = processor(taskCtx, task.ExternalUserID)
	}
	cancel()
	heartbeatErr := <-heartbeatDone
	if heartbeatErr != nil {
		return heartbeatErr
	}
	if ctx.Err() != nil {
		releaseCtx, releaseCancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		released, releaseErr := s.store.ReleaseTenantObservationTaskLease(releaseCtx, task, s.nowUTC())
		releaseCancel()
		if releaseErr == nil && !released {
			releaseErr = ErrTenantObservationTaskLeaseLost
		}
		return errors.Join(ctx.Err(), releaseErr)
	}

	completion := TenantObservationTaskCompletion{}
	if blockedReason != "" {
		completion.Blocked = true
		completion.Message = blockedReason
		completion.NextRunAt = s.nowUTC().Add(5 * time.Minute)
	} else if processErr != nil {
		completion.Message = processErr.Error()
		completion.NextRunAt = s.nowUTC().Add(tenantObservationBackoff(task.Attempts + 1))
	} else {
		completion.Succeeded = true
		completion.NextRunAt = s.nowUTC().Add(tenantObservationRefreshDelay(task.ExternalUserID, observation.HasActiveSubscription))
	}
	completeCtx, completeCancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	_, completeErr := s.store.CompleteTenantObservationTask(completeCtx, task, completion, s.nowUTC())
	completeCancel()
	return errors.Join(processErr, completeErr)
}

func (s *Service) tenantObservationBlockReason(ctx context.Context, task TenantObservationTask) (string, error) {
	tenant, ok, err := s.store.GetTenant(ctx, task.ExternalUserID)
	if err != nil {
		return "", err
	}
	if !ok {
		return "", fmt.Errorf("tenant %q not found", task.ExternalUserID)
	}
	if tenant.Status != TenantStatusActive {
		return fmt.Sprintf("tenant status is %s", tenant.Status), nil
	}
	if tenant.Backend != UserBackendNew {
		return "", nil
	}
	setID := firstNonEmpty(task.SetID, tenant.SetID)
	set, ok, err := s.store.GetSet(ctx, setID)
	if err != nil {
		return "", err
	}
	if !ok {
		return fmt.Sprintf("set %q not found", setID), nil
	}
	if !setReadyForServing(set) {
		return fmt.Sprintf("set %q is not ready", setID), nil
	}
	return "", nil
}

func tenantObservationRefreshDelay(externalUserID string, active bool) time.Duration {
	base := 6 * time.Hour
	if active {
		base = time.Hour
	}
	hasher := fnv.New64a()
	_, _ = hasher.Write([]byte(externalUserID))
	jitterWindow := uint64(base / 10)
	if jitterWindow == 0 {
		return base
	}
	return base + time.Duration(hasher.Sum64()%jitterWindow)
}

func (s *Service) renewTenantObservationTaskLease(ctx context.Context, cancel context.CancelFunc, task TenantObservationTask, leaseTTL time.Duration, done chan<- error) {
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
			renewed, err := s.store.RenewTenantObservationTaskLease(ctx, task, leaseTTL, s.nowUTC())
			if err == nil && !renewed {
				err = ErrTenantObservationTaskLeaseLost
			}
			if err != nil {
				cancel()
				done <- err
				return
			}
		}
	}
}
