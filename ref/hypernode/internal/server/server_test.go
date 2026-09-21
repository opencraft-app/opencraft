package server

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"hypernode/internal/store"
)

func TestSSHHostIdentityIsOwnedByDatabaseAfterLegacyImport(t *testing.T) {
	directory := t.TempDir()
	st, err := store.Open(filepath.Join(directory, "hypernode.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	seedPath := filepath.Join(directory, "legacy-host-key")
	firstSeed, err := generateHostKey()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(seedPath, firstSeed, 0o600); err != nil {
		t.Fatal(err)
	}
	first, err := loadOrCreateHostKey(st, seedPath)
	if err != nil {
		t.Fatal(err)
	}
	secondSeed, err := generateHostKey()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(seedPath, secondSeed, 0o600); err != nil {
		t.Fatal(err)
	}
	second, err := loadOrCreateHostKey(st, seedPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(first.PublicKey().Marshal(), second.PublicKey().Marshal()) {
		t.Fatal("database-backed SSH host identity changed with the legacy seed file")
	}
	stored, found, err := st.NodeIdentity("ssh-ed25519")
	if err != nil || !found || !bytes.Equal(stored, firstSeed) {
		t.Fatalf("database did not retain imported host identity: found=%v err=%v", found, err)
	}
}

func TestReadSSHString(t *testing.T) {
	payload := []byte{0, 0, 0, 3, 'a', 'b', 'c', 9}
	value, rest, ok := readSSHString(payload)
	if !ok || value != "abc" || len(rest) != 1 || rest[0] != 9 {
		t.Fatalf("value=%q rest=%v ok=%v", value, rest, ok)
	}
}

func TestClassifyTransportFailureBeforeIdentification(t *testing.T) {
	failure := classifyTransportFailure(errors.New("ssh: handshake failed: EOF"))
	if failure["phase"] != "pre-identification" {
		t.Fatalf("unexpected phase: %v", failure["phase"])
	}
	if failure["diagnostic"] == "" {
		t.Fatal("expected an actionable diagnostic")
	}
}

func TestClassifyTransportFailureDefaultsToHandshake(t *testing.T) {
	failure := classifyTransportFailure(errors.New("ssh: handshake failed: test"))
	if failure["phase"] != "ssh-handshake" {
		t.Fatalf("unexpected phase: %v", failure["phase"])
	}
	if _, ok := failure["diagnostic"]; ok {
		t.Fatalf("unexpected diagnostic: %v", failure["diagnostic"])
	}
}

func TestCodexAdmissionTimesOut(t *testing.T) {
	timedOut := make(chan struct{})
	admission := newCodexAdmission(10*time.Millisecond, func() { close(timedOut) })
	defer admission.stop()
	select {
	case <-timedOut:
	case <-time.After(time.Second):
		t.Fatal("admission did not time out")
	}
	if admission.admit(func() { t.Fatal("late admission callback ran") }) {
		t.Fatal("late admission succeeded")
	}
}

func TestCodexAdmissionCancelsTimeout(t *testing.T) {
	timedOut := make(chan struct{}, 1)
	admitted := false
	admission := newCodexAdmission(20*time.Millisecond, func() { timedOut <- struct{}{} })
	defer admission.stop()
	if !admission.admit(func() { admitted = true }) || !admitted {
		t.Fatal("admission did not succeed")
	}
	if admission.admit(func() { t.Fatal("duplicate admission callback ran") }) {
		t.Fatal("duplicate admission succeeded")
	}
	time.Sleep(40 * time.Millisecond)
	select {
	case <-timedOut:
		t.Fatal("admitted connection timed out")
	default:
	}
}
