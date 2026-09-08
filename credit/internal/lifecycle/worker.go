package lifecycle

import (
	"context"
	"errors"
	"fmt"
	"log"
	"time"

	"git.woa.com/wisp/mono/credit/internal/store"
)

type Store interface {
	ListExpiredPackages(context.Context, time.Time, time.Time, int) ([]*store.CreditPackage, error)
	TryClaimExpiredPackage(context.Context, string, time.Time, time.Time) (bool, error)
	ReleaseExpiredPackageClaim(context.Context, string, time.Time) (bool, error)
}

type PackageExpirer interface {
	ExpirePaidPackage(context.Context, string) error
}

type WorkerOptions struct {
	Now           func() time.Time
	PollInterval  time.Duration
	LeaseDuration time.Duration
	BatchSize     int
}

type Worker struct {
	store        Store
	expirer      PackageExpirer
	now          func() time.Time
	pollInterval time.Duration
	lease        time.Duration
	batchSize    int
}

func NewWorker(st Store, expirer PackageExpirer, opts WorkerOptions) *Worker {
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	poll := opts.PollInterval
	if poll <= 0 {
		poll = 10 * time.Second
	}
	lease := opts.LeaseDuration
	if lease <= 0 {
		lease = 30 * time.Second
	}
	batchSize := opts.BatchSize
	if batchSize <= 0 || batchSize > 50 {
		batchSize = 50
	}
	return &Worker{store: st, expirer: expirer, now: now, pollInterval: poll, lease: lease, batchSize: batchSize}
}

func (w *Worker) Run(ctx context.Context) error {
	ticker := time.NewTicker(w.pollInterval)
	defer ticker.Stop()
	for {
		if err := w.RunOnce(ctx); err != nil && !errors.Is(err, context.Canceled) {
			log.Printf("[credit-lifecycle-worker] run failed: %v", err)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

func (w *Worker) RunOnce(ctx context.Context) error {
	now := w.now().UTC().Truncate(time.Second)
	staleBefore := now.Add(-w.lease)
	packages, err := w.store.ListExpiredPackages(ctx, now, staleBefore, w.batchSize)
	if err != nil {
		return err
	}
	var errs []error
	for _, pkg := range packages {
		if pkg == nil {
			continue
		}
		claimed, err := w.store.TryClaimExpiredPackage(ctx, pkg.PackageID, now, staleBefore)
		if err != nil {
			errs = append(errs, err)
			continue
		}
		if !claimed {
			continue
		}
		if err := w.expirer.ExpirePaidPackage(ctx, pkg.PackageID); err != nil {
			released, releaseErr := w.store.ReleaseExpiredPackageClaim(ctx, pkg.PackageID, now)
			if releaseErr != nil {
				err = errors.Join(err, releaseErr)
			} else if !released {
				err = errors.Join(err, fmt.Errorf("release expiration claim for %s: claim no longer owned", pkg.PackageID))
			}
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}
