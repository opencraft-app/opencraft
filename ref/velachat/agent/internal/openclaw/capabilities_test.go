package openclaw

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"velachat/agent/internal/runtimeapi"
)

func TestDiscoverProfileCapabilitiesReportsManagedOpenClawProfile(t *testing.T) {
	t.Parallel()

	executable := filepath.Join(t.TempDir(), "openclaw")
	script := `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2026.8.18"; exit 0; fi
if [ "$1" = "gateway" ] && [ "$2" = "--help" ]; then
  echo "--allow-unconfigured --port"; exit 0
fi
exit 2
`
	if err := os.WriteFile(executable, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	home := t.TempDir()
	result, err := New(Options{Executable: executable}).DiscoverProfileCapabilities(
		context.Background(),
		runtimeapi.ProfileCapabilityRequest{
			AgentID:     "018f0c9e-7b14-7abc-8def-0123456789ab",
			Environment: map[string]string{"HOME": home},
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if result.Protocol != "openclaw_gateway" ||
		result.ProfileKind != "openclaw_managed" ||
		result.ProfileHome != filepath.Join(
			home,
			".openclaw-vela-fa7216c3dbd15928790094db476aa2ef",
		) || !result.Models.Unsupported || len(result.Skills) != 0 {
		t.Fatalf("capabilities = %#v", result)
	}
}
