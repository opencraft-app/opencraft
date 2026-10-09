package selfupdate

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"time"

	rootstate "velachat/agent/internal/state"
)

var ErrUpdateRolledBack = errors.New("Computer Update 已回滚")

type ParentWaiter interface {
	Wait(context.Context, int, time.Duration) error
}

type MainServiceManager interface {
	StopMain(context.Context) error
	StartMain(context.Context) error
	ResetFailed(context.Context) error
}

type HealthWaiter interface {
	Wait(context.Context, string, string, string, string, time.Duration) error
}

type ApplyHelperConfig struct {
	StateRoot        string
	InstallationRoot string
	TransactionID    string
	ParentPID        int
	Target           string
	Now              func() time.Time
	Parent           ParentWaiter
	Services         MainServiceManager
	Health           HealthWaiter
	ParentTimeout    time.Duration
	HealthTimeout    time.Duration
}

type ApplyHelper struct {
	config ApplyHelperConfig
	stager *Stager
}

type installedJournalDocument struct {
	Schema              int       `json:"schema"`
	Stage               string    `json:"stage"`
	TransactionID       string    `json:"transactionId"`
	PlatformURL         string    `json:"platformUrl"`
	AllowInsecureHTTP   bool      `json:"allowInsecureHttp"`
	Version             string    `json:"version"`
	Target              string    `json:"target"`
	ProgramSHA256       string    `json:"programSha256"`
	ServerID            string    `json:"serverId,omitempty"`
	ComputerID          string    `json:"computerId,omitempty"`
	CredentialID        string    `json:"credentialId,omitempty"`
	CredentialVersion   uint64    `json:"credentialVersion,omitempty"`
	CredentialExpiresAt time.Time `json:"credentialExpiresAt,omitempty"`
	Region              string    `json:"region,omitempty"`
}

func NewApplyHelper(config ApplyHelperConfig) (*ApplyHelper, error) {
	if !cleanAbsolute(config.StateRoot) || !cleanAbsolute(config.InstallationRoot) ||
		config.StateRoot != filepath.Join(config.InstallationRoot, "state") ||
		config.ParentPID <= 0 ||
		(config.Target != "darwin-arm64" && config.Target != "linux-amd64") ||
		config.Now == nil || config.Parent == nil || config.Services == nil || config.Health == nil ||
		config.ParentTimeout <= 0 || config.HealthTimeout <= 0 {
		return nil, ErrTransactionInvalid
	}
	journal, err := LoadJournal(config.StateRoot, config.TransactionID)
	if err != nil || journal.Target != config.Target {
		return nil, ErrTransactionInvalid
	}
	return &ApplyHelper{
		config: config,
		stager: &Stager{
			config: StagerConfig{StateRoot: config.StateRoot},
			store:  rootstate.New(config.StateRoot), ready: make(chan struct{}, 1),
		},
	}, nil
}

func (helper *ApplyHelper) Apply(ctx context.Context) error {
	if helper == nil || ctx == nil {
		return ErrTransactionInvalid
	}
	journal, err := LoadJournal(helper.config.StateRoot, helper.config.TransactionID)
	if err != nil {
		return err
	}
	if journal.Phase == PhaseHealthy || journal.Phase == PhaseRolledBack {
		return nil
	}
	if journal.Phase == PhaseRollbackStarted {
		return helper.rollback(ctx, journal)
	}
	if journal.Phase == PhaseHelperStarted {
		if err := helper.config.Services.StopMain(ctx); err != nil {
			return helper.fail(journal, "service_stop_failed")
		}
		if err := helper.config.Parent.Wait(ctx, helper.config.ParentPID, helper.config.ParentTimeout); err != nil {
			return helper.fail(journal, "parent_exit_timeout")
		}
		journal, err = transitionJournal(
			helper.stager, journal, PhaseHelperStarted, PhaseDaemonStopped,
			"", helper.config.Now().UTC(),
		)
		if err != nil {
			return err
		}
	}
	if journal.Phase == PhaseDaemonStopped {
		if err := helper.backupAndSwap(journal); err != nil {
			return helper.rollback(ctx, journal)
		}
		journal, err = transitionJournal(
			helper.stager, journal, PhaseDaemonStopped, PhaseProgramSwapped,
			"", helper.config.Now().UTC(),
		)
		if err != nil {
			return err
		}
	}
	if journal.Phase == PhaseProgramSwapped {
		if err := helper.config.Services.StartMain(ctx); err != nil {
			return helper.rollback(ctx, journal)
		}
		journal, err = transitionJournal(
			helper.stager, journal, PhaseProgramSwapped, PhaseServiceStarted,
			"", helper.config.Now().UTC(),
		)
		if err != nil {
			return helper.rollback(ctx, journal)
		}
	}
	if journal.Phase != PhaseServiceStarted {
		return ErrTransactionInvalid
	}
	if err := helper.config.Health.Wait(
		ctx, helper.config.StateRoot, journal.TransactionID,
		journal.ToVersion, journal.ToProgramSHA256, helper.config.HealthTimeout,
	); err != nil {
		return helper.rollback(ctx, journal)
	}
	journal, err = transitionJournal(
		helper.stager, journal, PhaseServiceStarted, PhaseHealthy,
		"", helper.config.Now().UTC(),
	)
	if err != nil {
		return err
	}
	return clearPending(helper.stager, journal.TransactionID)
}

func (helper *ApplyHelper) backupAndSwap(journal Journal) error {
	canonical := filepath.Join(helper.config.InstallationRoot, "bin", "vela-computer")
	fromDigest, _ := decodeDigest(journal.FromProgramSHA256)
	toDigest, _ := decodeDigest(journal.ToProgramSHA256)
	currentDigest, currentSize, err := hashProgram(canonical)
	if err != nil || currentDigest != fromDigest {
		return ErrTransactionInvalid
	}
	backupProgram := filepath.Join(helper.config.StateRoot, journal.BackupProgram)
	backupDirectory := filepath.Dir(backupProgram)
	if err := ensurePrivateDirectory(backupDirectory); err != nil {
		return err
	}
	if _, err := os.Lstat(backupProgram); errors.Is(err, os.ErrNotExist) {
		if err := copyProgram(canonical, backupProgram, fromDigest, currentSize); err != nil {
			return err
		}
	}
	installPath := filepath.Join(helper.config.StateRoot, "install.journal.json")
	installRaw, installJournal, err := readInstalledJournal(installPath, journal)
	if err != nil {
		return err
	}
	backupInstall := filepath.Join(helper.config.StateRoot, journal.BackupInstallJournal)
	if _, err := os.Lstat(backupInstall); errors.Is(err, os.ErrNotExist) {
		if err := writeExclusiveSynced(backupInstall, installRaw, 0o600); err != nil {
			return err
		}
	}
	staged := filepath.Join(helper.config.StateRoot, journal.StagedProgram)
	stagedInfo, err := os.Lstat(staged)
	if err != nil || stagedInfo.Size() <= 0 || verifyProgramFile(staged, toDigest, stagedInfo.Size()) != nil {
		return ErrTransactionInvalid
	}
	if err := replaceProgram(staged, canonical, toDigest, stagedInfo.Size()); err != nil {
		return err
	}
	installJournal.Version = journal.ToVersion
	installJournal.ProgramSHA256 = journal.ToProgramSHA256
	if err := rootstate.New(helper.config.StateRoot).Write("install.journal.json", installJournal); err != nil {
		return ErrTransactionInvalid
	}
	return nil
}

func (helper *ApplyHelper) rollback(ctx context.Context, journal Journal) error {
	current, err := LoadJournal(helper.config.StateRoot, journal.TransactionID)
	if err != nil {
		return err
	}
	if current.Phase != PhaseRollbackStarted {
		current, err = transitionJournal(
			helper.stager, current, current.Phase, PhaseRollbackStarted,
			"health_check_failed", helper.config.Now().UTC(),
		)
		if err != nil {
			return err
		}
	}
	_ = helper.config.Services.StopMain(ctx)
	fromDigest, _ := decodeDigest(current.FromProgramSHA256)
	backupProgram := filepath.Join(helper.config.StateRoot, current.BackupProgram)
	info, err := os.Lstat(backupProgram)
	if err != nil || info.Size() <= 0 || verifyProgramFile(backupProgram, fromDigest, info.Size()) != nil {
		return helper.fail(current, "rollback_backup_invalid")
	}
	canonical := filepath.Join(helper.config.InstallationRoot, "bin", "vela-computer")
	if err := replaceProgram(backupProgram, canonical, fromDigest, info.Size()); err != nil {
		return helper.fail(current, "rollback_program_failed")
	}
	backupInstall := filepath.Join(helper.config.StateRoot, current.BackupInstallJournal)
	installRaw, err := readPrivateJSONFile(backupInstall)
	if err != nil {
		return helper.fail(current, "rollback_journal_invalid")
	}
	if err := rootstate.New(helper.config.StateRoot).WriteFile("install.journal.json", installRaw, 0o600); err != nil {
		return helper.fail(current, "rollback_journal_failed")
	}
	if err := helper.config.Services.ResetFailed(ctx); err != nil {
		return helper.fail(current, "rollback_reset_failed")
	}
	if err := helper.config.Services.StartMain(ctx); err != nil {
		return helper.fail(current, "rollback_start_failed")
	}
	current, err = transitionJournal(
		helper.stager, current, PhaseRollbackStarted, PhaseRolledBack,
		"health_check_failed", helper.config.Now().UTC(),
	)
	if err != nil {
		return err
	}
	if err := clearPending(helper.stager, current.TransactionID); err != nil {
		return err
	}
	return ErrUpdateRolledBack
}

func (helper *ApplyHelper) fail(journal Journal, code string) error {
	if validTransition(journal.Phase, PhaseFailed) {
		_, _ = transitionJournal(
			helper.stager, journal, journal.Phase, PhaseFailed,
			code, helper.config.Now().UTC(),
		)
	}
	return ErrTransactionInvalid
}

func readInstalledJournal(
	filename string,
	journal Journal,
) ([]byte, installedJournalDocument, error) {
	raw, err := readPrivateJSONFile(filename)
	if err != nil {
		return nil, installedJournalDocument{}, err
	}
	var installed installedJournalDocument
	if decodeExactJSON(raw, &installed) != nil || installed.Schema != 1 ||
		installed.Stage != "complete" || installed.Version != journal.FromVersion ||
		installed.Target != journal.Target || installed.ProgramSHA256 != journal.FromProgramSHA256 {
		return nil, installedJournalDocument{}, ErrTransactionInvalid
	}
	return raw, installed, nil
}

func replaceProgram(
	source string,
	destination string,
	digest [sha256.Size]byte,
	size int64,
) error {
	temporary, err := os.CreateTemp(filepath.Dir(destination), ".vela-computer-update-*.tmp")
	if err != nil {
		return ErrTransactionInvalid
	}
	temporaryPath := temporary.Name()
	_ = temporary.Close()
	_ = os.Remove(temporaryPath)
	defer os.Remove(temporaryPath)
	if err := copyProgram(source, temporaryPath, digest, size); err != nil {
		return err
	}
	if err := os.Rename(temporaryPath, destination); err != nil {
		return ErrTransactionInvalid
	}
	return syncDirectory(filepath.Dir(destination))
}

func decodeDigest(value string) ([sha256.Size]byte, error) {
	decoded, err := hex.DecodeString(value)
	if err != nil || len(decoded) != sha256.Size {
		return [sha256.Size]byte{}, ErrTransactionInvalid
	}
	var digest [sha256.Size]byte
	copy(digest[:], decoded)
	return digest, nil
}
