package openclaw

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestProbeAcceptsEmbeddableGatewayExecutable(t *testing.T) {
	t.Parallel()

	executable := filepath.Join(t.TempDir(), "openclaw")
	script := `#!/bin/sh
case "$1" in
  --version)
    echo "2026.8.18"
    ;;
  gateway)
    if [ "$2" = "--help" ]; then
      echo "Usage: openclaw gateway --allow-unconfigured --port <port>"
    else
      exit 2
    fi
    ;;
  *)
    exit 2
    ;;
esac
`
	if err := os.WriteFile(executable, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}

	driver := New(Options{Executable: executable, Version: "v-test"})
	probe, err := driver.Probe(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !probe.Available || probe.Path != executable ||
		probe.Version != "2026.8.18" {
		t.Fatalf("Probe() = %#v", probe)
	}
}

func TestProbeRejectsCLIWithoutEmbeddingGatewayFlags(t *testing.T) {
	t.Parallel()

	executable := filepath.Join(t.TempDir(), "openclaw")
	script := `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "2026.2.24"
  exit 0
fi
if [ "$1" = "gateway" ] && [ "$2" = "--help" ]; then
  echo "Usage: openclaw gateway"
  exit 0
fi
exit 2
`
	if err := os.WriteFile(executable, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}

	probe, err := New(Options{Executable: executable}).Probe(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if probe.Available || probe.Diagnostic == "" {
		t.Fatalf("Probe() = %#v, want unavailable diagnostic", probe)
	}
}
