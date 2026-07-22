package gateway

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"time"
)

const minimumWorkerLeaseTTL = 15 * time.Second

var workerRunSequence atomic.Uint64

// RunWorkerScheduler gives each built-in job an independent loop. The database
// lease keeps the same job exclusive across worker Pods.
func (s *Service) RunWorkerScheduler(
	ctx context.Context,
	owner string,
	pollInterval time.Duration,
	leaseTTL time.Duration,
	onRun func(WorkerJobRun),
) error {
	return s.runWorkerScheduler(ctx, owner, pollInterval, leaseTTL, nil, onRun)
}

// RunCoreWorkerScheduler only runs Set/fleet control jobs. User-level BYOK and
// observation tasks have their own horizontally scalable consumers.
func (s *Service) RunCoreWorkerScheduler(
	ctx context.Context,
	owner string,
	pollInterval time.Duration,
	leaseTTL time.Duration,
	onRun func(WorkerJobRun),
) error {
	return s.runWorkerScheduler(ctx, owner, pollInterval, leaseTTL, workerJobRunsInCorePool, onRun)
}

func (s *Service) runWorkerScheduler(
	ctx context.Context,
	owner string,
	pollInterval time.Duration,
	leaseTTL time.Duration,
	include func(string) bool,
	onRun func(WorkerJobRun),
) error {
	if err := s.ensureDefaultWorkerJobs(ctx); err != nil {
		return err
	}
	if pollInterval <= 0 {
		pollInterval = 5 * time.Second
	}
	if leaseTTL < minimumWorkerLeaseTTL {
		leaseTTL = minimumWorkerLeaseTTL
	}
	jobs, err := s.store.ListWorkerJobs(ctx, WorkerJobListOptions{})
	if err != nil {
		return err
	}
	var wg sync.WaitGroup
	for _, job := range jobs {
		if include != nil && !include(job.Name) {
			continue
		}
		jobName := job.Name
		wg.Add(1)
		go func() {
			defer wg.Done()
			s.runWorkerJobLoop(ctx, owner, jobName, pollInterval, leaseTTL, onRun)
		}()
	}
	<-ctx.Done()
	wg.Wait()
	return nil
}

func workerJobRunsInCorePool(jobName string) bool {
	switch jobName {
	case WorkerJobRetryBYOKSync, WorkerJobRefreshTenantObservations:
		return false
	default:
		return true
	}
}

func (s *Service) runWorkerJobLoop(
	ctx context.Context,
	owner string,
	jobName string,
	pollInterval time.Duration,
	leaseTTL time.Duration,
	onRun func(WorkerJobRun),
) {
	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()
	for {
		if run, executed := s.tryRunLeasedWorkerJob(ctx, owner, jobName, leaseTTL); executed && onRun != nil {
			onRun(run)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (s *Service) tryRunLeasedWorkerJob(ctx context.Context, owner string, jobName string, leaseTTL time.Duration) (WorkerJobRun, bool) {
	job, ok, err := s.store.GetWorkerJob(ctx, jobName)
	if err != nil || !ok || !job.Enabled {
		return workerSchedulingErrorRun(jobName, owner, err), err != nil
	}
	now := s.nowUTC()
	if !job.NextRunAt.IsZero() && job.NextRunAt.After(now) {
		return WorkerJobRun{}, false
	}
	runOwner := fmt.Sprintf("%s/%s/%d/%d", owner, jobName, now.UnixNano(), workerRunSequence.Add(1))
	leased, acquired, err := s.store.TryAcquireWorkerJobLease(ctx, jobName, runOwner, leaseTTL, now)
	if err != nil || !acquired {
		return workerSchedulingErrorRun(jobName, runOwner, err), err != nil
	}

	jobCtx, cancel := context.WithCancel(ctx)
	heartbeatDone := make(chan error, 1)
	go s.renewWorkerJobLease(jobCtx, cancel, leased.Name, runOwner, leaseTTL, heartbeatDone)
	updated, run, runErr := s.runWorkerJobBodySafely(jobCtx, leased, runOwner)
	cancel()
	heartbeatErr := <-heartbeatDone
	if runErr == nil && heartbeatErr != nil {
		runErr = heartbeatErr
		run.Status = WorkerJobStatusError
		run.Error = heartbeatErr.Error()
	}

	persistCtx, persistCancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	committed, persistErr := s.store.CompleteWorkerJobRun(persistCtx, updated, run)
	persistCancel()
	if persistErr != nil {
		run.Status = WorkerJobStatusError
		run.Error = persistErr.Error()
	} else if !committed {
		run.Status = WorkerJobStatusError
		run.Error = "worker job lease lost before completion"
	}
	return run, true
}

func (s *Service) renewWorkerJobLease(
	ctx context.Context,
	cancel context.CancelFunc,
	jobName string,
	owner string,
	leaseTTL time.Duration,
	done chan<- error,
) {
	interval := leaseTTL / 4
	timeout := leaseTTL / 12
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			done <- nil
			return
		case <-ticker.C:
			renewCtx, renewCancel := context.WithTimeout(ctx, timeout)
			renewed, err := s.store.RenewWorkerJobLease(renewCtx, jobName, owner, leaseTTL, s.nowUTC())
			renewCancel()
			if ctx.Err() != nil {
				done <- nil
				return
			}
			if err != nil || !renewed {
				if err == nil {
					err = fmt.Errorf("worker job lease lost")
				}
				cancel()
				done <- err
				return
			}
		}
	}
}

func workerSchedulingErrorRun(jobName string, owner string, err error) WorkerJobRun {
	if err == nil {
		return WorkerJobRun{}
	}
	now := time.Now().UTC()
	return WorkerJobRun{
		ID:         fmt.Sprintf("%s-schedule-%d", jobName, now.UnixNano()),
		JobName:    jobName,
		Owner:      owner,
		Status:     WorkerJobStatusError,
		StartedAt:  now,
		FinishedAt: now,
		Error:      err.Error(),
	}
}
