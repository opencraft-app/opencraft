package gateway

import (
	"context"
	"fmt"
	"strings"
	"time"
)

const (
	legacySubscriptionWriteConcurrency = 4
	setOperationLeaseTTL               = 30 * time.Second
	setOperationLeasePollInterval      = 20 * time.Millisecond
)

func (s *Service) withSetSubscriptionWriteLease(ctx context.Context, set Set, operation func(context.Context) error) error {
	limit := set.SubscriptionWriteConcurrency
	if limit <= 0 {
		limit = legacySubscriptionWriteConcurrency
	}
	return s.withSetOperationLease(ctx, set.ID, SetOperationSubscriptionWrite, limit, operation)
}

func (s *Service) withSetOperationLease(ctx context.Context, setID string, operationName string, limit int, operation func(context.Context) error) error {
	setID = strings.TrimSpace(setID)
	operationName = strings.TrimSpace(operationName)
	if setID == "" || operationName == "" || limit <= 0 || operation == nil {
		return fmt.Errorf("set operation lease requires set, operation, positive limit and callback")
	}
	owner := fmt.Sprintf("%s/%s/%d/%s", operationName, setID, s.nowUTC().UnixNano(), randomSecret())

	var lease SetOperationLease
	for {
		acquiredLease, acquired, err := s.store.TryAcquireSetOperationLease(
			ctx, setID, operationName, owner, limit, setOperationLeaseTTL, s.nowUTC(),
		)
		if err != nil {
			return err
		}
		if acquired {
			lease = acquiredLease
			break
		}
		timer := time.NewTimer(setOperationLeasePollInterval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}

	opCtx, cancel := context.WithCancel(ctx)
	heartbeatDone := make(chan error, 1)
	go s.renewSetOperationLease(opCtx, cancel, lease, heartbeatDone)
	opErr := operation(opCtx)
	cancel()
	heartbeatErr := <-heartbeatDone

	releaseCtx, releaseCancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	_, releaseErr := s.store.ReleaseSetOperationLease(releaseCtx, lease)
	releaseCancel()
	if opErr != nil {
		return opErr
	}
	if heartbeatErr != nil {
		return heartbeatErr
	}
	return releaseErr
}

func (s *Service) renewSetOperationLease(ctx context.Context, cancel context.CancelFunc, lease SetOperationLease, done chan<- error) {
	ticker := time.NewTicker(setOperationLeaseTTL / 3)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			done <- nil
			return
		case <-ticker.C:
			renewCtx, renewCancel := context.WithTimeout(ctx, 5*time.Second)
			renewed, err := s.store.RenewSetOperationLease(renewCtx, lease, setOperationLeaseTTL, s.nowUTC())
			renewCancel()
			if err == nil && !renewed {
				err = fmt.Errorf("set operation lease lost for %s/%s slot %d", lease.SetID, lease.Operation, lease.Slot)
			}
			if err != nil {
				cancel()
				done <- err
				return
			}
		}
	}
}
