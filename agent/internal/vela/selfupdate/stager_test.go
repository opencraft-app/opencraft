package selfupdate

import (
	"context"
	"crypto/sha256"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestStagerCreatesRecoverableTransactionWithoutTouchingIdentity(t *testing.T) {
	t.Parallel()
	installationRoot := filepath.Join(t.TempDir(), "computer")
	stateRoot := filepath.Join(installationRoot, "state")
	binRoot := filepath.Join(installationRoot, "bin")
	candidateRoot := filepath.Join(stateRoot, "update", "candidates", "00000000000000000007-v0.1.52")
	for _, directory := range []string{stateRoot, binRoot, candidateRoot} {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	currentProgram := filepath.Join(binRoot, "vela-computer")
	candidateProgram := filepath.Join(candidateRoot, "vela-computer")
	if err := os.WriteFile(currentProgram, []byte("v0.1.51"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(candidateProgram, []byte("v0.1.52"), 0o700); err != nil {
		t.Fatal(err)
	}
	identityPath := filepath.Join(stateRoot, "computer.credential")
	if err := os.WriteFile(identityPath, []byte("identity-must-remain"), 0o600); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 8, 18, 1, 0, 0, 0, time.UTC)
	stager, err := NewStager(StagerConfig{
		StateRoot: stateRoot, InstallationRoot: installationRoot,
		CurrentVersion: "v0.1.51", Target: "linux-amd64", CurrentProgram: currentProgram,
		Now:   func() time.Time { return now },
		NewID: func() (string, error) { return "0198d444-0000-7000-8000-000000000001", nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	candidateDigest := sha256.Sum256([]byte("v0.1.52"))
	if err := stager.Stage(context.Background(), Candidate{
		Version: "v0.1.52", Sequence: 7, Directory: candidateRoot,
		Release: VerifiedRelease{
			Version: "v0.1.52", Target: "linux-amd64",
			ProgramSHA256: candidateDigest, ProgramSize: int64(len("v0.1.52")),
		},
	}); err != nil {
		t.Fatal(err)
	}
	journal, ok, err := stager.Pending()
	if err != nil || !ok {
		t.Fatalf("Pending = (%#v, %t, %v)", journal, ok, err)
	}
	if journal.Phase != PhaseStaged || journal.FromVersion != "v0.1.51" ||
		journal.ToVersion != "v0.1.52" || journal.Target != "linux-amd64" ||
		journal.TransactionID != "0198d444-0000-7000-8000-000000000001" {
		t.Fatalf("journal = %#v", journal)
	}
	helper := filepath.Join(stateRoot, filepath.FromSlash(journal.HelperProgram))
	helperBytes, err := os.ReadFile(helper)
	if err != nil || string(helperBytes) != "v0.1.51" {
		t.Fatalf("helper = %q, %v", helperBytes, err)
	}
	identity, err := os.ReadFile(identityPath)
	if err != nil || string(identity) != "identity-must-remain" {
		t.Fatalf("identity changed: %q, %v", identity, err)
	}
}
