package main

import (
	"bytes"
	"os"
	"os/exec"
	"strings"
	"testing"
)

func TestCommandLineProbe(t *testing.T) {
	for _, test := range []struct {
		name string
		args []string
		done bool
		err  bool
		help bool
	}{
		{name: "normal start"},
		{name: "help", args: []string{"--help"}, done: true, help: true},
		{name: "short help", args: []string{"-h"}, done: true, help: true},
		{name: "unknown flag", args: []string{"--unknown"}, done: true, err: true},
		{name: "unexpected positional", args: []string{"unexpected-private-input"}, done: true, err: true},
		{name: "mixed help", args: []string{"--help", "unexpected-private-input"}, done: true, err: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			var output bytes.Buffer
			done, err := handleCommandLine(test.args, &output)
			if done != test.done || (err != nil) != test.err {
				t.Fatalf("unexpected CLI result: done=%v err=%v", done, err)
			}
			if strings.Contains(output.String(), "Usage: workerd-host-drain-controller [--help]") != test.help {
				t.Fatalf("unexpected help output: %q", output.String())
			}
			if test.err && (output.Len() != 0 || strings.Contains(err.Error(), "unexpected-private-input")) {
				t.Fatal("CLI echoed rejected arguments")
			}
		})
	}
}

func TestHelpExitsBeforeRuntimeInitialization(t *testing.T) {
	if os.Getenv("HOST_DRAIN_HELP_TEST_CHILD") == "1" {
		os.Args = []string{"workerd-host-drain-controller", "--help"}
		main()
		return
	}
	// No Kubernetes endpoint or Cell identity is available. An accidental move
	// of the help path after initialization must fail this subprocess test.
	t.Setenv("KUBERNETES_SERVICE_HOST", "")
	t.Setenv("KUBERNETES_SERVICE_PORT", "")
	t.Setenv("CELL_NAME", "")
	t.Setenv("CELL_NAMESPACE", "")
	t.Setenv("HOST_DRAIN_HELP_TEST_CHILD", "1")
	command := exec.Command(os.Args[0], "-test.run=^TestHelpExitsBeforeRuntimeInitialization$")
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("help entered runtime initialization: %v\n%s", err, output)
	}
	if !bytes.Contains(output, []byte("Usage: workerd-host-drain-controller [--help]")) || bytes.Contains(output, []byte("load in-cluster config")) {
		t.Fatalf("unexpected main help path: %s", output)
	}
}
