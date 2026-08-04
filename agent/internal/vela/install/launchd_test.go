//go:build darwin

package install

import (
	"bytes"
	"context"
	"encoding/xml"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

func TestLaunchAgentAcceptsBootstrapErrorWhenExpectedServiceIsStablyRunning(t *testing.T) {
	home := t.TempDir()
	root := filepath.Join(t.TempDir(), "computer")
	var calls [][]string
	printCalls := 0
	program := filepath.Join(root, "bin", ProgramName)
	plist := filepath.Join(home, "Library", "LaunchAgents", launchAgentLabel+".plist")
	launcher := &userLaunchAgent{
		home: home,
		uid:  os.Geteuid(),
		gid:  os.Getegid(),
		run: func(_ context.Context, arguments ...string) ([]byte, error) {
			calls = append(calls, append([]string(nil), arguments...))
			switch arguments[0] {
			case "bootout":
				return nil, nil
			case "bootstrap":
				return []byte("Bootstrap failed: 5: Input/output error"),
					errors.New("exit status 5")
			case "print":
				printCalls++
				if printCalls == 1 {
					return nil, errors.New("service not found")
				}
				return launchAgentPrint(plist, program, 4242), nil
			default:
				t.Fatalf("unexpected launchctl arguments: %v", arguments)
				return nil, errors.New("unexpected launchctl arguments")
			}
		},
	}
	spec := LaunchSpec{
		Label: launchAgentLabel, ProgramPath: filepath.Join(root, "bin", ProgramName),
		InstallationRoot: root, StateDirectory: filepath.Join(root, "state"),
	}
	if err := launcher.Start(context.Background(), spec); err != nil {
		t.Fatalf("Start() rejected a loaded service: %v", err)
	}
	domain := "gui/" + strconv.Itoa(os.Geteuid())
	service := domain + "/" + launchAgentLabel
	want := [][]string{
		{"bootout", service},
		{"print", service},
		{"bootstrap", domain, plist},
		{"print", service},
		{"print", service},
	}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("launchctl calls = %v, want %v", calls, want)
	}
}

func TestLaunchAgentRejectsBootstrapErrorWhenLoadedServiceHasWrongProgram(t *testing.T) {
	home := t.TempDir()
	root := filepath.Join(t.TempDir(), "computer")
	printCalls := 0
	plist := filepath.Join(home, "Library", "LaunchAgents", launchAgentLabel+".plist")
	launcher := &userLaunchAgent{
		home: home,
		uid:  os.Geteuid(),
		gid:  os.Getegid(),
		run: func(_ context.Context, arguments ...string) ([]byte, error) {
			switch arguments[0] {
			case "bootout":
				return nil, nil
			case "bootstrap":
				return []byte("Bootstrap failed: 5: Input/output error"),
					errors.New("exit status 5")
			case "print":
				printCalls++
				if printCalls == 1 {
					return nil, errors.New("service not found")
				}
				return launchAgentPrint(plist, "/tmp/not-vela-computer", 4242), nil
			default:
				t.Fatalf("unexpected launchctl arguments: %v", arguments)
				return nil, errors.New("unexpected launchctl arguments")
			}
		},
	}
	spec := LaunchSpec{
		Label: launchAgentLabel, ProgramPath: filepath.Join(root, "bin", ProgramName),
		InstallationRoot: root, StateDirectory: filepath.Join(root, "state"),
	}
	if err := launcher.Start(context.Background(), spec); err == nil {
		t.Fatal("Start() accepted a service running the wrong program")
	}
}

func TestLaunchAgentWaitsForBootoutBeforeAttestingReplacement(t *testing.T) {
	home := t.TempDir()
	root := filepath.Join(t.TempDir(), "computer")
	var calls [][]string
	printCalls := 0
	program := filepath.Join(root, "bin", ProgramName)
	plist := filepath.Join(home, "Library", "LaunchAgents", launchAgentLabel+".plist")
	launcher := &userLaunchAgent{
		home: home,
		uid:  os.Geteuid(),
		gid:  os.Getegid(),
		run: func(_ context.Context, arguments ...string) ([]byte, error) {
			calls = append(calls, append([]string(nil), arguments...))
			switch arguments[0] {
			case "bootout":
				return nil, nil
			case "bootstrap":
				return []byte("Bootstrap failed: 5: Input/output error"),
					errors.New("exit status 5")
			case "print":
				printCalls++
				if printCalls == 2 {
					return nil, errors.New("service not found")
				}
				return launchAgentPrint(plist, program, 4242), nil
			default:
				t.Fatalf("unexpected launchctl arguments: %v", arguments)
				return nil, errors.New("unexpected launchctl arguments")
			}
		},
	}
	spec := LaunchSpec{
		Label: launchAgentLabel, ProgramPath: filepath.Join(root, "bin", ProgramName),
		InstallationRoot: root, StateDirectory: filepath.Join(root, "state"),
	}
	if err := launcher.Start(context.Background(), spec); err != nil {
		t.Fatal(err)
	}
	domain := "gui/" + strconv.Itoa(os.Geteuid())
	service := domain + "/" + launchAgentLabel
	want := [][]string{
		{"bootout", service},
		{"print", service},
		{"print", service},
		{"bootstrap", domain, plist},
		{"print", service},
		{"print", service},
	}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("launchctl calls = %v, want %v", calls, want)
	}
}

func launchAgentPrint(plist, program string, pid int) []byte {
	return []byte("path = " + plist + "\n" +
		"state = running\n" +
		"program = " + program + "\n" +
		"pid = " + strconv.Itoa(pid) + "\n")
}

func TestRenderLaunchAgentUsesCanonicalDaemonAndContainsNoCredential(t *testing.T) {
	t.Parallel()

	root := filepath.Join(t.TempDir(), "Vela & Computer")
	spec := LaunchSpec{
		Label:            launchAgentLabel,
		ProgramPath:      filepath.Join(root, "bin", ProgramName),
		InstallationRoot: root,
		StateDirectory:   filepath.Join(root, "state"),
	}
	content, err := renderLaunchAgent(spec)
	if err != nil {
		t.Fatal(err)
	}
	decoder := xml.NewDecoder(bytes.NewReader(content))
	for {
		if _, err := decoder.Token(); err != nil {
			if err.Error() == "EOF" {
				break
			}
			t.Fatalf("invalid plist XML: %v", err)
		}
	}
	text := string(content)
	for _, required := range []string{
		launchAgentLabel,
		strings.ReplaceAll(filepath.Join(root, "bin", ProgramName), "&", "&amp;"),
		"<string>daemon</string>",
		"<string>run</string>",
		"<string>--state-dir</string>",
		strings.ReplaceAll(filepath.Join(root, "state", "logs", "computer.stdout.log"), "&", "&amp;"),
	} {
		if !strings.Contains(text, required) {
			t.Fatalf("LaunchAgent plist is missing %q", required)
		}
	}
	for _, forbidden := range []string{"credential", "Enrollment", "Secret", "token"} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("LaunchAgent plist contains secret-shaped field %q", forbidden)
		}
	}
}
