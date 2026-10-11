package selfupdate

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
	rootstate "velachat/agent/internal/state"
)

type Phase string

const (
	PhaseStaged          Phase = "staged"
	PhaseWaitingForIdle  Phase = "waiting_for_idle"
	PhaseHelperStarted   Phase = "helper_started"
	PhaseDaemonStopped   Phase = "daemon_stopped"
	PhaseProgramSwapped  Phase = "program_swapped"
	PhaseServiceStarted  Phase = "service_started"
	PhaseHealthy         Phase = "healthy"
	PhaseRollbackStarted Phase = "rollback_started"
	PhaseRolledBack      Phase = "rolled_back"
	PhaseFailed          Phase = "failed"
)

var (
	ErrTransactionInvalid = errors.New("Computer Update transaction 无效")
	ErrTransactionPending = errors.New("Computer Update transaction 已存在")
)

type Journal struct {
	SchemaVersion        int       `json:"schemaVersion"`
	TransactionID        string    `json:"transactionId"`
	Phase                Phase     `json:"phase"`
	Attempt              int       `json:"attempt"`
	StartedAt            time.Time `json:"startedAt"`
	LastTransitionAt     time.Time `json:"lastTransitionAt"`
	FromVersion          string    `json:"fromVersion"`
	FromProgramSHA256    string    `json:"fromProgramSHA256"`
	ToVersion            string    `json:"toVersion"`
	ToProgramSHA256      string    `json:"toProgramSHA256"`
	Target               string    `json:"target"`
	StagedProgram        string    `json:"stagedProgram"`
	HelperProgram        string    `json:"helperProgram"`
	BackupProgram        string    `json:"backupProgram"`
	BackupInstallJournal string    `json:"backupInstallJournal"`
	ErrorCode            string    `json:"errorCode,omitempty"`
}

type StagerConfig struct {
	StateRoot        string
	InstallationRoot string
	CurrentVersion   string
	Target           string
	CurrentProgram   string
	Now              func() time.Time
	NewID            func() (string, error)
}

type Stager struct {
	config StagerConfig
	store  *rootstate.Store
	ready  chan struct{}
}

type pendingDocument struct {
	SchemaVersion int    `json:"schemaVersion"`
	TransactionID string `json:"transactionId"`
}

func NewStager(config StagerConfig) (*Stager, error) {
	if !cleanAbsolute(config.StateRoot) || !cleanAbsolute(config.InstallationRoot) ||
		config.StateRoot != filepath.Join(config.InstallationRoot, "state") ||
		!cleanAbsolute(config.CurrentProgram) ||
		config.CurrentProgram != filepath.Join(config.InstallationRoot, "bin", "vela-computer") ||
		!versionPattern.MatchString(config.CurrentVersion) ||
		(config.Target != "darwin-arm64" && config.Target != "linux-amd64") ||
		config.Now == nil || config.NewID == nil {
		return nil, ErrTransactionInvalid
	}
	if err := ensurePrivateStateRoot(config.StateRoot); err != nil {
		return nil, err
	}
	return &Stager{
		config: config, store: rootstate.New(config.StateRoot), ready: make(chan struct{}, 1),
	}, nil
}

func (stager *Stager) Stage(ctx context.Context, candidate Candidate) error {
	if stager == nil || ctx == nil || ctx.Err() != nil ||
		candidate.Version != candidate.Release.Version ||
		candidate.Release.Target != stager.config.Target || candidate.Sequence < 1 ||
		!versionPattern.MatchString(candidate.Version) || !cleanAbsolute(candidate.Directory) {
		return ErrTransactionInvalid
	}
	if pending, exists, err := stager.Pending(); err != nil {
		return err
	} else if exists {
		if pending.ToVersion == candidate.Version && pending.StagedProgram ==
			mustRelative(stager.config.StateRoot, filepath.Join(candidate.Directory, "vela-computer")) {
			return nil
		}
		return ErrTransactionPending
	}
	stagedProgram := filepath.Join(candidate.Directory, "vela-computer")
	if !pathWithin(stager.config.StateRoot, stagedProgram) ||
		verifyProgramFile(stagedProgram, candidate.Release.ProgramSHA256, candidate.Release.ProgramSize) != nil {
		return ErrTransactionInvalid
	}
	transactionID, err := stager.config.NewID()
	parsedID, parseErr := uuid.Parse(transactionID)
	if err != nil || parseErr != nil || parsedID.Version() != 7 {
		return ErrTransactionInvalid
	}
	transactionRelative := filepath.Join("update", "transactions", transactionID)
	transactionRoot := filepath.Join(stager.config.StateRoot, transactionRelative)
	if err := ensurePrivateDirectory(transactionRoot); err != nil {
		return err
	}
	helperRelative := filepath.Join(transactionRelative, "helper-program")
	helperPath := filepath.Join(stager.config.StateRoot, helperRelative)
	currentDigest, currentSize, err := hashProgram(stager.config.CurrentProgram)
	if err != nil || currentSize <= 0 {
		return ErrTransactionInvalid
	}
	if err := copyProgram(stager.config.CurrentProgram, helperPath, currentDigest, currentSize); err != nil {
		return err
	}
	now := stager.config.Now().UTC()
	journal := Journal{
		SchemaVersion: 1, TransactionID: transactionID, Phase: PhaseStaged, Attempt: 1,
		StartedAt: now, LastTransitionAt: now,
		FromVersion: stager.config.CurrentVersion, FromProgramSHA256: hex.EncodeToString(currentDigest[:]),
		ToVersion: candidate.Version, ToProgramSHA256: hex.EncodeToString(candidate.Release.ProgramSHA256[:]),
		Target:               stager.config.Target,
		StagedProgram:        mustRelative(stager.config.StateRoot, stagedProgram),
		HelperProgram:        helperRelative,
		BackupProgram:        filepath.Join(transactionRelative, "backup", "vela-computer"),
		BackupInstallJournal: filepath.Join(transactionRelative, "backup", "install.journal.json"),
	}
	journalPath := filepath.Join(transactionRelative, "upgrade.journal.json")
	if err := stager.store.Write(journalPath, journal); err != nil {
		return ErrTransactionInvalid
	}
	if err := stager.store.Write("update/pending.json", pendingDocument{
		SchemaVersion: 1, TransactionID: transactionID,
	}); err != nil {
		return ErrTransactionInvalid
	}
	select {
	case stager.ready <- struct{}{}:
	default:
	}
	return nil
}

func (stager *Stager) Ready() <-chan struct{} {
	if stager == nil {
		return nil
	}
	return stager.ready
}

func (stager *Stager) Pending() (Journal, bool, error) {
	if stager == nil {
		return Journal{}, false, ErrTransactionInvalid
	}
	filename := filepath.Join(stager.config.StateRoot, "update", "pending.json")
	raw, err := readPrivateJSONFile(filename)
	if errors.Is(err, os.ErrNotExist) {
		return Journal{}, false, nil
	}
	if err != nil {
		return Journal{}, false, err
	}
	var pending pendingDocument
	if decodeExactJSON(raw, &pending) != nil || pending.SchemaVersion != 1 {
		return Journal{}, false, ErrTransactionInvalid
	}
	journal, err := LoadJournal(stager.config.StateRoot, pending.TransactionID)
	return journal, err == nil, err
}

func LoadJournal(stateRoot, transactionID string) (Journal, error) {
	parsedID, err := uuid.Parse(transactionID)
	if !cleanAbsolute(stateRoot) || err != nil || parsedID.Version() != 7 {
		return Journal{}, ErrTransactionInvalid
	}
	filename := filepath.Join(stateRoot, "update", "transactions", transactionID, "upgrade.journal.json")
	raw, err := readPrivateJSONFile(filename)
	if err != nil {
		return Journal{}, err
	}
	var journal Journal
	if decodeExactJSON(raw, &journal) != nil || validateJournal(stateRoot, journal) != nil ||
		journal.TransactionID != transactionID {
		return Journal{}, ErrTransactionInvalid
	}
	return journal, nil
}

func validateJournal(stateRoot string, journal Journal) error {
	if journal.SchemaVersion != 1 || !knownPhase(journal.Phase) || journal.Attempt < 1 ||
		journal.StartedAt.IsZero() || journal.LastTransitionAt.IsZero() ||
		!versionPattern.MatchString(journal.FromVersion) || !versionPattern.MatchString(journal.ToVersion) ||
		(journal.Target != "darwin-arm64" && journal.Target != "linux-amd64") ||
		!validDigestString(journal.FromProgramSHA256) || !validDigestString(journal.ToProgramSHA256) {
		return ErrTransactionInvalid
	}
	for _, relative := range []string{
		journal.StagedProgram, journal.HelperProgram,
		journal.BackupProgram, journal.BackupInstallJournal,
	} {
		if relative == "" || filepath.IsAbs(relative) || filepath.Clean(relative) != relative ||
			!pathWithin(stateRoot, filepath.Join(stateRoot, relative)) {
			return ErrTransactionInvalid
		}
	}
	return nil
}

func knownPhase(phase Phase) bool {
	switch phase {
	case PhaseStaged, PhaseWaitingForIdle, PhaseHelperStarted, PhaseDaemonStopped,
		PhaseProgramSwapped, PhaseServiceStarted, PhaseHealthy,
		PhaseRollbackStarted, PhaseRolledBack, PhaseFailed:
		return true
	default:
		return false
	}
}

func readPrivateJSONFile(filename string) ([]byte, error) {
	info, err := os.Lstat(filename)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 ||
		info.Mode().Perm() != 0o600 || info.Size() <= 0 || info.Size() > 64*1024 {
		return nil, ErrTransactionInvalid
	}
	return os.ReadFile(filename)
}

func verifyProgramFile(filename string, digest [sha256.Size]byte, size int64) error {
	actual, actualSize, err := hashProgram(filename)
	if err != nil || actualSize != size || subtle.ConstantTimeCompare(actual[:], digest[:]) != 1 {
		return ErrTransactionInvalid
	}
	return nil
}

func hashProgram(filename string) ([sha256.Size]byte, int64, error) {
	info, err := os.Lstat(filename)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() <= 0 {
		return [sha256.Size]byte{}, 0, ErrTransactionInvalid
	}
	file, err := os.Open(filename)
	if err != nil {
		return [sha256.Size]byte{}, 0, ErrTransactionInvalid
	}
	digest := sha256.New()
	written, copyErr := io.Copy(digest, file)
	closeErr := file.Close()
	if copyErr != nil || closeErr != nil || written != info.Size() {
		return [sha256.Size]byte{}, 0, ErrTransactionInvalid
	}
	var value [sha256.Size]byte
	copy(value[:], digest.Sum(nil))
	return value, written, nil
}

func copyProgram(source, destination string, digest [sha256.Size]byte, size int64) error {
	input, err := os.Open(source)
	if err != nil {
		return ErrTransactionInvalid
	}
	defer input.Close()
	output, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o700)
	if err != nil {
		return ErrTransactionInvalid
	}
	hash := sha256.New()
	written, copyErr := io.Copy(io.MultiWriter(output, hash), input)
	if copyErr == nil {
		copyErr = output.Sync()
	}
	closeErr := output.Close()
	if copyErr != nil || closeErr != nil || written != size ||
		subtle.ConstantTimeCompare(hash.Sum(nil), digest[:]) != 1 {
		_ = os.Remove(destination)
		return ErrTransactionInvalid
	}
	return nil
}

func pathWithin(root, filename string) bool {
	relative, err := filepath.Rel(root, filename)
	return err == nil && relative != "." && relative != ".." &&
		!strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

func mustRelative(root, filename string) string {
	value, err := filepath.Rel(root, filename)
	if err != nil {
		return ""
	}
	return value
}

func validDigestString(value string) bool {
	if len(value) != sha256.Size*2 || strings.ToLower(value) != value {
		return false
	}
	decoded, err := hex.DecodeString(value)
	return err == nil && len(decoded) == sha256.Size
}
