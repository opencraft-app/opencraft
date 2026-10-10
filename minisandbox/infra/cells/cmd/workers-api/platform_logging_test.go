package main

import (
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"strings"
	"testing"
)

func TestPlatformLoggingStartupHelperProcess(t *testing.T) {
	if os.Getenv("WORKERS_API_LOGGING_STARTUP_HELPER") != "1" {
		return
	}
	// Invalid Registry URL fails before any HTTP listener or control request.
	// Qualification identities keep this helper away from in-cluster credentials.
	os.Args = []string{"workers-api", "--registry-url=http://[private-message",
		"--qualification-cell=actor-bj-a01", "--qualification-cell-uid=test-cell-uid",
		"--qualification-datacenter=runtime-a", "--engine-cell=actor-bj-a01",
		"--engine-url=http://127.0.0.1:1", "--datacenter=runtime-a"}
	main()
	os.Exit(3)
}

func TestActualStartupErrorLogDoesNotExposeConfiguration(t *testing.T) {
	command := exec.Command(os.Args[0], "-test.run=^TestPlatformLoggingStartupHelperProcess$")
	command.Env = append(os.Environ(), "WORKERS_API_LOGGING_STARTUP_HELPER=1")
	output, err := command.CombinedOutput()
	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.ExitCode() != 2 {
		t.Fatalf("startup exit=%v", err)
	}
	var record map[string]any
	if err := json.Unmarshal(output, &record); err != nil {
		t.Fatalf("startup did not emit one structured platform error: %v", err)
	}
	if record["msg"] != "configure Workers API" || record["error"] != "transport_error" {
		t.Fatalf("unexpected startup record: %v", record)
	}
	if strings.Contains(string(output), "private-message") || strings.Contains(string(output), "http://") {
		t.Fatal("startup log exposed the malformed configuration")
	}
}
