package selfupdate

import (
	"crypto/sha256"
	"errors"
	"path/filepath"
	"testing"
	"time"
)

func TestTrustStateRejectsReplayAndDowngradeAcrossRestart(t *testing.T) {
	t.Parallel()
	root := filepath.Join(t.TempDir(), "state")
	now := time.Date(2026, 8, 17, 21, 0, 0, 0, time.UTC)
	state, err := OpenTrustState(TrustStateConfig{
		Root: root, Channel: "stable", Target: "linux-amd64",
		CurrentVersion: "v0.1.51", Now: now,
	})
	if err != nil {
		t.Fatal(err)
	}
	accepted := VerifiedChannel{
		Descriptor: ChannelDescriptor{
			SchemaVersion: 1, Channel: "stable", Target: "linux-amd64",
			Sequence: 7, ExpectedVersion: "v0.1.52",
		},
		PayloadSHA256: sha256.Sum256([]byte("sequence-7")),
	}
	changed, err := state.Accept(accepted, now)
	if err != nil || !changed {
		t.Fatalf("first Accept = (%t, %v)", changed, err)
	}
	changed, err = state.Accept(accepted, now.Add(time.Second))
	if err != nil || changed {
		t.Fatalf("identical Accept = (%t, %v)", changed, err)
	}
	collision := accepted
	collision.PayloadSHA256 = sha256.Sum256([]byte("different-sequence-7"))
	if _, err := state.Accept(collision, now); !errors.Is(err, ErrUpdateReplay) {
		t.Fatalf("sequence collision error = %v", err)
	}
	regressed := accepted
	regressed.Descriptor.Sequence = 6
	if _, err := state.Accept(regressed, now); !errors.Is(err, ErrUpdateReplay) {
		t.Fatalf("sequence regression error = %v", err)
	}
	downgrade := accepted
	downgrade.Descriptor.Sequence = 8
	downgrade.Descriptor.ExpectedVersion = "v0.1.50"
	downgrade.PayloadSHA256 = sha256.Sum256([]byte("sequence-8"))
	if _, err := state.Accept(downgrade, now); !errors.Is(err, ErrUpdateDowngrade) {
		t.Fatalf("version downgrade error = %v", err)
	}
	if err := state.MarkHealthy("v0.1.52", now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}

	reopened, err := OpenTrustState(TrustStateConfig{
		Root: root, Channel: "stable", Target: "linux-amd64",
		CurrentVersion: "v0.1.51", Now: now.Add(2 * time.Minute),
	})
	if err != nil {
		t.Fatal(err)
	}
	snapshot := reopened.Snapshot()
	if snapshot.HighestAcceptedSequence != 7 || snapshot.HighestHealthyVersion != "v0.1.52" {
		t.Fatalf("reopened state = %#v", snapshot)
	}
	downgrade.Descriptor.Sequence = 8
	downgrade.Descriptor.ExpectedVersion = "v0.1.51"
	if _, err := reopened.Accept(downgrade, now); !errors.Is(err, ErrUpdateDowngrade) {
		t.Fatalf("restart downgrade error = %v", err)
	}
	beforeHealth, err := OpenTrustState(TrustStateConfig{
		Root: root, Channel: "stable", Target: "linux-amd64",
		CurrentVersion: "v0.1.53", Now: now.Add(3 * time.Minute),
	})
	if err != nil {
		t.Fatal(err)
	}
	if beforeHealth.Snapshot().HighestHealthyVersion != "v0.1.52" {
		t.Fatalf("process start promoted health floor without heartbeat: %#v", beforeHealth.Snapshot())
	}
}
