package runtimes

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestBuiltinsContainsCodexHermesACPAndHermesGatewayInStableOrder(t *testing.T) {
	t.Parallel()

	registrations := Builtins(Options{Version: "v-test"})
	if len(registrations) != 3 {
		t.Fatalf("Builtins() count = %d, want 3", len(registrations))
	}
	if registrations[0].ID != "codex" {
		t.Fatalf("Builtins()[0] = %#v", registrations[0])
	}
	if registrations[0].WireID != "" {
		t.Fatalf("Codex wire identity = %q, want implicit", registrations[0].WireID)
	}
	if registrations[1].ID != "hermes-acp" ||
		registrations[1].WireID != "opencode" {
		t.Fatalf("Builtins()[1] = %#v", registrations[1])
	}
	if registrations[1].Policy.BusyMode != "direct" ||
		!registrations[1].Policy.SupportsStdin ||
		registrations[1].Policy.Completion != "event" {
		t.Fatalf("Hermes Runtime policy = %#v", registrations[1].Policy)
	}
	if registrations[2].ID != "hermes-gateway" ||
		registrations[2].WireID != "pi" {
		t.Fatalf("Builtins()[2] = %#v", registrations[2])
	}
}

func TestBuiltinsPassesExplicitCodexExecutableToDriver(t *testing.T) {
	t.Parallel()

	executable := filepath.Join(t.TempDir(), "codex")
	trueExecutable, err := exec.LookPath("true")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(trueExecutable, executable); err != nil {
		t.Fatal(err)
	}
	registrations := Builtins(Options{
		Version:         "v-test",
		CodexExecutable: executable,
	})
	driver, err := registrations[0].NewDriver()
	if err != nil {
		t.Fatal(err)
	}
	probe, err := driver.Probe(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !probe.Available || probe.Path != executable {
		t.Fatalf("Codex probe = %#v", probe)
	}
}
