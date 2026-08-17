//go:build darwin || linux

package selfupdate

import (
	"context"
	"errors"
	"os"
	"syscall"
	"time"
)

type ProcessParentWaiter struct{ interval time.Duration }

func NewProcessParentWaiter(interval time.Duration) *ProcessParentWaiter {
	return &ProcessParentWaiter{interval: interval}
}

func (waiter *ProcessParentWaiter) Wait(
	ctx context.Context,
	pid int,
	timeout time.Duration,
) error {
	if waiter == nil || waiter.interval <= 0 || ctx == nil || pid <= 0 || timeout <= 0 {
		return ErrTransactionInvalid
	}
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	for {
		process, err := os.FindProcess(pid)
		if err != nil {
			return nil
		}
		err = process.Signal(syscall.Signal(0))
		if errors.Is(err, os.ErrProcessDone) || errors.Is(err, syscall.ESRCH) {
			return nil
		}
		if err != nil && !errors.Is(err, syscall.EPERM) {
			return ErrTransactionInvalid
		}
		timer := time.NewTimer(waiter.interval)
		select {
		case <-ctx.Done():
			if !timer.Stop() {
				<-timer.C
			}
			return ctx.Err()
		case <-deadline.C:
			if !timer.Stop() {
				<-timer.C
			}
			return ErrTransactionInvalid
		case <-timer.C:
		}
	}
}
