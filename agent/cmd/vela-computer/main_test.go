package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"velachat/agent/internal/vela/managementipc"
)

func TestRunVelaVersionDoesNotTouchStateOrNetwork(t *testing.T) {
	if exitCode := runVela(
		context.Background(),
		[]string{"version"},
	); exitCode != 0 {
		t.Fatalf("runVela version exit code = %d", exitCode)
	}
}

func TestRunVelaDoctorUsesManagementDaemon(t *testing.T) {
	root, err := os.MkdirTemp("", "vela-main-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	server, err := managementipc.Listen(
		filepath.Join(root, "daemon.sock"),
		managementipc.HandlerFunc(func(
			_ context.Context,
			request managementipc.Request,
			sender managementipc.Sender,
		) error {
			if request.Method != "doctor.run" {
				t.Fatalf("method = %q", request.Method)
			}
			return sender.Result(map[string]any{
				"ok":         true,
				"daemon":     "online",
				"agentCount": 0,
			})
		}),
	)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Close() })
	if exitCode := runVela(context.Background(), []string{
		"doctor",
		"--state-dir", root,
		"--json",
	}); exitCode != 0 {
		t.Fatalf("runVela doctor exit code = %d", exitCode)
	}
}
