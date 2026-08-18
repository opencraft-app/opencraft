package openclaw

import (
	"context"
	"os"
	"testing"
	"time"

	"velachat/agent/internal/runtimeapi"
)

func TestLiveGatewayHandshake(t *testing.T) {
	executable := os.Getenv("VELA_TEST_OPENCLAW_EXECUTABLE")
	if executable == "" {
		t.Skip("set VELA_TEST_OPENCLAW_EXECUTABLE for a real Gateway probe")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	session, err := New(Options{
		Executable: executable,
		Version:    "integration-test",
	}).Start(ctx, runtimeapi.StartRequest{
		AgentID:          "018f0c9e-7b14-7abc-8def-0123456789ab",
		LaunchID:         "openclaw-live-probe",
		WorkingDirectory: t.TempDir(),
		Environment: map[string]string{
			"HOME": t.TempDir(),
			"PATH": os.Getenv("PATH"),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if session.SessionID() != defaultSessionKey {
		t.Fatalf("session id = %q", session.SessionID())
	}
	if err := session.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
}
