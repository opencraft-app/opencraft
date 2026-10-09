package selfupdate

import (
	"context"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"time"

	rootstate "velachat/agent/internal/state"
)

var ErrHealthEvidence = errors.New("Computer Update health evidence 无效")

type HealthReporterConfig struct {
	StateRoot string
	Version   string
	Program   string
	Now       func() time.Time
	Trust     *TrustState
}

type HealthReporter struct {
	config HealthReporterConfig
	stager *Stager
}

type healthDocument struct {
	SchemaVersion int       `json:"schemaVersion"`
	TransactionID string    `json:"transactionId"`
	Version       string    `json:"version"`
	ProgramSHA256 string    `json:"programSHA256"`
	ReportedAt    time.Time `json:"reportedAt"`
}

func NewHealthReporter(config HealthReporterConfig) (*HealthReporter, error) {
	if !cleanAbsolute(config.StateRoot) || !cleanAbsolute(config.Program) ||
		!versionPattern.MatchString(config.Version) || config.Now == nil {
		return nil, ErrHealthEvidence
	}
	return &HealthReporter{
		config: config,
		stager: &Stager{
			config: StagerConfig{StateRoot: config.StateRoot},
			store:  rootstate.New(config.StateRoot), ready: make(chan struct{}, 1),
		},
	}, nil
}

func (reporter *HealthReporter) Report() (bool, error) {
	if reporter == nil {
		return false, ErrHealthEvidence
	}
	journal, exists, err := reporter.stager.Pending()
	if err != nil || !exists {
		return false, err
	}
	if journal.Phase != PhaseServiceStarted {
		return false, nil
	}
	if journal.ToVersion != reporter.config.Version {
		return false, ErrHealthEvidence
	}
	digest, _, err := hashProgram(reporter.config.Program)
	if err != nil || hex.EncodeToString(digest[:]) != journal.ToProgramSHA256 {
		return false, ErrHealthEvidence
	}
	if reporter.config.Trust != nil {
		if err := reporter.config.Trust.MarkHealthy(journal.ToVersion, reporter.config.Now().UTC()); err != nil {
			return false, err
		}
	}
	path := filepath.Join("update", "transactions", journal.TransactionID, "healthy.json")
	if err := reporter.stager.store.Write(path, healthDocument{
		SchemaVersion: 1, TransactionID: journal.TransactionID,
		Version: journal.ToVersion, ProgramSHA256: journal.ToProgramSHA256,
		ReportedAt: reporter.config.Now().UTC(),
	}); err != nil {
		return false, ErrHealthEvidence
	}
	return true, nil
}

type FileHealthWaiter struct{ interval time.Duration }

func NewFileHealthWaiter(interval time.Duration) *FileHealthWaiter {
	return &FileHealthWaiter{interval: interval}
}

func (waiter *FileHealthWaiter) Wait(
	ctx context.Context,
	stateRoot string,
	transactionID string,
	version string,
	programSHA256 string,
	timeout time.Duration,
) error {
	if waiter == nil || waiter.interval <= 0 || ctx == nil || !cleanAbsolute(stateRoot) ||
		!versionPattern.MatchString(version) || !validDigestString(programSHA256) || timeout <= 0 {
		return ErrHealthEvidence
	}
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	for {
		filename := filepath.Join(stateRoot, "update", "transactions", transactionID, "healthy.json")
		raw, err := readPrivateJSONFile(filename)
		if err == nil {
			var document healthDocument
			if decodeExactJSON(raw, &document) == nil && document.SchemaVersion == 1 &&
				document.TransactionID == transactionID && document.Version == version &&
				document.ProgramSHA256 == programSHA256 && !document.ReportedAt.IsZero() {
				return nil
			}
			return ErrHealthEvidence
		}
		if !errors.Is(err, os.ErrNotExist) {
			return ErrHealthEvidence
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
			return ErrHealthEvidence
		case <-timer.C:
		}
	}
}

var _ HealthWaiter = (*FileHealthWaiter)(nil)
