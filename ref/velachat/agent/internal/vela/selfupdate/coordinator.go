package selfupdate

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"time"

	"velachat/agent/internal/vela/activitygate"
)

type HelperLaunch struct {
	HelperProgram string
	StateRoot     string
	TransactionID string
	ParentPID     int
	Target        string
}

type HelperLauncher interface {
	Launch(context.Context, HelperLaunch) error
}

type CoordinatorConfig struct {
	Stager    *Stager
	Gate      *activitygate.Gate
	Launcher  HelperLauncher
	ParentPID int
	Now       func() time.Time
	Shutdown  func()
}

type Coordinator struct{ config CoordinatorConfig }

func NewCoordinator(config CoordinatorConfig) (*Coordinator, error) {
	if config.Stager == nil || config.Gate == nil || config.Launcher == nil ||
		config.ParentPID <= 0 || config.Now == nil || config.Shutdown == nil {
		return nil, ErrTransactionInvalid
	}
	return &Coordinator{config: config}, nil
}

func (coordinator *Coordinator) Run(ctx context.Context) error {
	if coordinator == nil || ctx == nil {
		return ErrTransactionInvalid
	}
	for {
		journal, exists, err := coordinator.config.Stager.Pending()
		if err != nil {
			return err
		}
		if exists {
			switch journal.Phase {
			case PhaseStaged, PhaseWaitingForIdle, PhaseHelperStarted:
				return coordinator.launch(ctx, journal)
			case PhaseDaemonStopped, PhaseProgramSwapped, PhaseServiceStarted,
				PhaseRollbackStarted:
				// The external helper owns these phases. A newly started daemon
				// must remain alive long enough to publish health evidence.
			case PhaseHealthy, PhaseRolledBack, PhaseFailed:
				if err := clearPending(coordinator.config.Stager, journal.TransactionID); err != nil {
					return err
				}
				continue
			default:
				return ErrTransactionInvalid
			}
		}
		timer := time.NewTimer(time.Second)
		select {
		case <-ctx.Done():
			if !timer.Stop() {
				<-timer.C
			}
			return nil
		case <-coordinator.config.Stager.Ready():
			if !timer.Stop() {
				<-timer.C
			}
		case <-timer.C:
		}
	}
}

func (coordinator *Coordinator) launch(ctx context.Context, journal Journal) error {
	if journal.Phase != PhaseStaged && journal.Phase != PhaseWaitingForIdle &&
		journal.Phase != PhaseHelperStarted {
		return nil
	}
	if journal.Phase == PhaseStaged {
		var err error
		journal, err = transitionJournal(
			coordinator.config.Stager, journal, PhaseStaged, PhaseWaitingForIdle,
			"", coordinator.config.Now().UTC(),
		)
		if err != nil {
			return err
		}
	}
	permit, err := coordinator.config.Gate.Drain(ctx)
	if err != nil {
		return err
	}
	keepDraining := false
	defer func() {
		if !keepDraining {
			permit.Release()
		}
	}()
	if journal.Phase == PhaseWaitingForIdle {
		journal, err = transitionJournal(
			coordinator.config.Stager, journal, PhaseWaitingForIdle, PhaseHelperStarted,
			"", coordinator.config.Now().UTC(),
		)
		if err != nil {
			return err
		}
	}
	command := HelperLaunch{
		HelperProgram: filepath.Join(coordinator.config.Stager.config.StateRoot, journal.HelperProgram),
		StateRoot:     coordinator.config.Stager.config.StateRoot,
		TransactionID: journal.TransactionID,
		ParentPID:     coordinator.config.ParentPID, Target: journal.Target,
	}
	if err := coordinator.config.Launcher.Launch(ctx, command); err != nil {
		_, _ = transitionJournal(
			coordinator.config.Stager, journal, PhaseHelperStarted, PhaseFailed,
			"helper_launch_failed", coordinator.config.Now().UTC(),
		)
		return err
	}
	keepDraining = true
	coordinator.config.Shutdown()
	return nil
}

func transitionJournal(
	stager *Stager,
	journal Journal,
	expected Phase,
	next Phase,
	errorCode string,
	now time.Time,
) (Journal, error) {
	if stager == nil || journal.Phase != expected || !validTransition(expected, next) ||
		now.IsZero() || (errorCode != "" && !validErrorCode(errorCode)) {
		return Journal{}, ErrTransactionInvalid
	}
	current, err := LoadJournal(stager.config.StateRoot, journal.TransactionID)
	if err != nil || current.Phase != expected {
		return Journal{}, ErrTransactionInvalid
	}
	current.Phase = next
	current.LastTransitionAt = now.UTC()
	current.ErrorCode = errorCode
	path := filepath.Join("update", "transactions", current.TransactionID, "upgrade.journal.json")
	if err := stager.store.Write(path, current); err != nil {
		return Journal{}, ErrTransactionInvalid
	}
	return current, nil
}

func validTransition(current, next Phase) bool {
	switch current {
	case PhaseStaged:
		return next == PhaseWaitingForIdle || next == PhaseFailed
	case PhaseWaitingForIdle:
		return next == PhaseHelperStarted || next == PhaseFailed
	case PhaseHelperStarted:
		return next == PhaseDaemonStopped || next == PhaseFailed
	case PhaseDaemonStopped:
		return next == PhaseProgramSwapped || next == PhaseRollbackStarted || next == PhaseFailed
	case PhaseProgramSwapped:
		return next == PhaseServiceStarted || next == PhaseRollbackStarted
	case PhaseServiceStarted:
		return next == PhaseHealthy || next == PhaseRollbackStarted
	case PhaseRollbackStarted:
		return next == PhaseRolledBack || next == PhaseFailed
	default:
		return false
	}
}

func validErrorCode(value string) bool {
	if value == "" || len(value) > 100 {
		return false
	}
	for _, character := range value {
		if character >= 'a' && character <= 'z' || character >= '0' && character <= '9' ||
			character == '_' {
			continue
		}
		return false
	}
	return true
}

func clearPending(stager *Stager, transactionID string) error {
	journal, exists, err := stager.Pending()
	if err != nil {
		return err
	}
	if !exists || journal.TransactionID != transactionID {
		return ErrTransactionInvalid
	}
	if err := stager.store.Remove("update/pending.json"); err != nil && !errors.Is(err, os.ErrNotExist) {
		return ErrTransactionInvalid
	}
	return nil
}
