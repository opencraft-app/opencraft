//go:build darwin || linux

package app

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	velacli "github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/vela/cli"
	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/vela/managementipc"
)

func TestActionsResolveStateRootAndDelegateComputerLifecycle(t *testing.T) {
	t.Parallel()

	root := shortAppRoot(t)
	controller := &fakeComputerController{}
	actions, err := NewActions(Config{
		Root:       root,
		Version:    "test-version",
		Stdout:     &bytes.Buffer{},
		Stderr:     &bytes.Buffer{},
		Controller: controller,
	})
	if err != nil {
		t.Fatal(err)
	}
	setup := velacli.SetupOptions{
		PlatformURL:     "https://platform.example.test",
		AccessTokenFile: "/secure/human.token",
		ServerID:        "018f0c9e-7b10-7abc-8def-0123456789ab",
		Name:            "开发机",
	}
	if err := actions.Setup(context.Background(), setup); err != nil {
		t.Fatal(err)
	}
	if err := actions.DaemonRun(
		context.Background(),
		velacli.DaemonRunOptions{},
	); err != nil {
		t.Fatal(err)
	}
	if controller.setupRoot != root ||
		controller.daemonRoot != root ||
		controller.setup.Name != "开发机" {
		t.Fatalf("controller = %#v", controller)
	}
}

func TestStatusDoctorAndLogsUseOnlyManagementIPC(t *testing.T) {
	t.Parallel()

	root := shortAppRoot(t)
	server, err := managementipc.Listen(
		filepath.Join(root, "daemon.sock"),
		managementipc.HandlerFunc(func(
			_ context.Context,
			request managementipc.Request,
			sender managementipc.Sender,
		) error {
			switch request.Method {
			case "status.get":
				return sender.Result(map[string]any{
					"online":     true,
					"version":    "daemon-version",
					"computerId": "computer-test",
					"agents": []map[string]any{{
						"agentId": "agent-a",
					}},
				})
			case "doctor.run":
				return sender.Result(map[string]any{
					"ok":         true,
					"agentCount": 1,
				})
			case "logs.tail":
				if err := sender.Event(map[string]any{
					"timestamp": time.Date(
						2026,
						time.July,
						31,
						12,
						0,
						0,
						0,
						time.UTC,
					),
					"level":     "info",
					"component": "daemon",
					"message":   "已连接",
				}); err != nil {
					return err
				}
				return sender.End()
			default:
				t.Fatalf("method = %q", request.Method)
				return nil
			}
		}),
	)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Close() })
	var output bytes.Buffer
	actions, err := NewActions(Config{
		Root:    root,
		Version: "test-version",
		Stdout:  &output,
		Stderr:  &output,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := actions.Status(
		context.Background(),
		velacli.StatusOptions{JSON: true},
	); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), `"online":true`) ||
		!strings.Contains(output.String(), `"agentId":"agent-a"`) {
		t.Fatalf("status output = %q", output.String())
	}
	output.Reset()
	if err := actions.Doctor(
		context.Background(),
		velacli.DoctorOptions{JSON: true},
	); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), `"ok":true`) {
		t.Fatalf("doctor output = %q", output.String())
	}
	output.Reset()
	if err := actions.Logs(
		context.Background(),
		velacli.LogsOptions{Lines: 10},
	); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), "daemon") ||
		!strings.Contains(output.String(), "已连接") {
		t.Fatalf("logs output = %q", output.String())
	}
}

type fakeComputerController struct {
	mu         sync.Mutex
	setupRoot  string
	daemonRoot string
	setup      velacli.SetupOptions
}

func (c *fakeComputerController) Setup(
	_ context.Context,
	root string,
	options velacli.SetupOptions,
) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.setupRoot = root
	c.setup = options
	return nil
}

func (c *fakeComputerController) Run(
	_ context.Context,
	root string,
) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.daemonRoot = root
	return nil
}

func shortAppRoot(t *testing.T) string {
	t.Helper()
	root, err := os.MkdirTemp("", "vela-app-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	return root
}
