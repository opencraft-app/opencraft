//go:build darwin

package launchd

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/xml"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestEnsureLoadedAcceptsBootstrapErrorWhenExpectedIdentityIsLoaded(t *testing.T) {
	home := t.TempDir()
	definition := testDefinition(t, home, []byte("program-v1"))
	plistPath := filepath.Join(home, "Library", "LaunchAgents", definition.Label+".plist")
	printCalls := 0
	manager := testManager(home, func(_ context.Context, arguments ...string) ([]byte, error) {
		switch arguments[0] {
		case "print":
			printCalls++
			if printCalls == 1 {
				return nil, errors.New("service not found")
			}
			return loadedPrint(t, plistPath, definition), nil
		case "bootout":
			return nil, nil
		case "bootstrap":
			return []byte("Bootstrap failed: 5: Input/output error"), errors.New("exit status 5")
		default:
			return nil, errors.New("unexpected command")
		}
	})
	if err := manager.EnsureLoaded(context.Background(), definition); err != nil {
		t.Fatalf("EnsureLoaded() = %v", err)
	}
}

func TestDefinitionRejectsReservedFingerprintWithoutSideEffects(t *testing.T) {
	home := t.TempDir()
	definition := testDefinition(t, home, []byte("program-v1"))
	definition.Environment[definitionFingerprintEnvironmentKey] = "forged"
	var calls int
	manager := testManager(home, func(context.Context, ...string) ([]byte, error) {
		calls++
		return nil, nil
	})
	if err := manager.EnsureLoaded(context.Background(), definition); !errors.Is(err, ErrInvalidDefinition) {
		t.Fatalf("error = %v", err)
	}
	if calls != 0 {
		t.Fatalf("launchctl calls = %d", calls)
	}
}

func TestRenderDefinitionProducesValidCredentialFreePlist(t *testing.T) {
	definition := testDefinition(t, t.TempDir(), []byte("program-v1"))
	content, err := renderDefinition(definition)
	if err != nil {
		t.Fatal(err)
	}
	decoder := xml.NewDecoder(bytes.NewReader(content))
	for {
		if _, err := decoder.Token(); err != nil {
			if err.Error() == "EOF" {
				break
			}
			t.Fatalf("invalid plist: %v", err)
		}
	}
	text := string(content)
	for _, required := range []string{
		"<integer>63</integer>", definition.Program, definitionFingerprintEnvironmentKey,
	} {
		if !strings.Contains(text, required) {
			t.Fatalf("plist missing %q", required)
		}
	}
	for _, forbidden := range []string{"credential", "Enrollment", "Secret", "token"} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("plist contains %q", forbidden)
		}
	}
}

func TestEnsureLoadedRejectsWritableLaunchAgentsDirectory(t *testing.T) {
	home := t.TempDir()
	directory := filepath.Join(home, "Library", "LaunchAgents")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(directory, 0o777); err != nil {
		t.Fatal(err)
	}
	definition := testDefinition(t, home, []byte("program-v1"))
	manager := testManager(home, func(context.Context, ...string) ([]byte, error) {
		t.Fatal("launchctl called for unsafe directory")
		return nil, nil
	})
	if err := manager.EnsureLoaded(context.Background(), definition); !errors.Is(err, ErrInvalidDirectory) {
		t.Fatalf("error = %v", err)
	}
}

func TestEnsureLoadedAcceptsExpectedIdentityWithoutRunningPID(t *testing.T) {
	home := t.TempDir()
	definition := testDefinition(t, home, []byte("program-v1"))
	plistPath := filepath.Join(home, "Library", "LaunchAgents", definition.Label+".plist")
	var calls [][]string
	printCalls := 0
	manager := testManager(home, func(_ context.Context, arguments ...string) ([]byte, error) {
		calls = append(calls, append([]string(nil), arguments...))
		switch arguments[0] {
		case "print":
			printCalls++
			if printCalls == 1 {
				return nil, errors.New("service not found")
			}
			return loadedPrint(t, plistPath, definition), nil
		case "bootout", "bootstrap":
			return nil, nil
		default:
			t.Fatalf("unexpected launchctl arguments: %v", arguments)
			return nil, nil
		}
	})

	if err := manager.EnsureLoaded(context.Background(), definition); err != nil {
		t.Fatalf("EnsureLoaded() = %v", err)
	}
	domain := "gui/" + strconv.Itoa(os.Geteuid())
	service := domain + "/" + definition.Label
	want := [][]string{
		{"bootout", service},
		{"print", service},
		{"bootstrap", domain, plistPath},
		{"print", service},
	}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("calls = %v, want %v", calls, want)
	}
}

func TestEnsureLoadedSameDefinitionUsesNoSideEffectFastPath(t *testing.T) {
	home := t.TempDir()
	definition := testDefinition(t, home, []byte("program-v1"))
	plistPath := filepath.Join(home, "Library", "LaunchAgents", definition.Label+".plist")
	content, err := renderDefinition(definition)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(plistPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(plistPath, content, 0o600); err != nil {
		t.Fatal(err)
	}
	var calls [][]string
	manager := testManager(home, func(_ context.Context, arguments ...string) ([]byte, error) {
		calls = append(calls, append([]string(nil), arguments...))
		if arguments[0] != "print" {
			t.Fatalf("fast path executed %v", arguments)
		}
		return loadedPrint(t, plistPath, definition), nil
	})

	if err := manager.EnsureLoaded(context.Background(), definition); err != nil {
		t.Fatal(err)
	}
	if len(calls) != 1 || calls[0][0] != "print" {
		t.Fatalf("calls = %v", calls)
	}
}

func TestEnsureLoadedReloadsChangedProgramAtSamePath(t *testing.T) {
	home := t.TempDir()
	oldDefinition := testDefinition(t, home, []byte("program-v1"))
	plistPath := filepath.Join(home, "Library", "LaunchAgents", oldDefinition.Label+".plist")
	oldContent, err := renderDefinition(oldDefinition)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(plistPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(plistPath, oldContent, 0o600); err != nil {
		t.Fatal(err)
	}
	newProgram := []byte("program-v2")
	if err := os.WriteFile(oldDefinition.Program, newProgram, 0o700); err != nil {
		t.Fatal(err)
	}
	newDefinition := oldDefinition
	newDigest := sha256.Sum256(newProgram)
	newDefinition.ProgramSHA256 = hex.EncodeToString(newDigest[:])
	var calls []string
	printCalls := 0
	manager := testManager(home, func(_ context.Context, arguments ...string) ([]byte, error) {
		calls = append(calls, arguments[0])
		switch arguments[0] {
		case "print":
			printCalls++
			if printCalls == 1 {
				return nil, errors.New("service not found")
			}
			return loadedPrint(t, plistPath, newDefinition), nil
		case "bootout", "bootstrap":
			return nil, nil
		default:
			return nil, errors.New("unexpected command")
		}
	})
	if err := manager.EnsureLoaded(context.Background(), newDefinition); err != nil {
		t.Fatal(err)
	}
	if !containsString(calls, "bootout") || !containsString(calls, "bootstrap") {
		t.Fatalf("calls = %v", calls)
	}
}

func TestEnsureLoadedDoesNotFastPathStaleLoadedGeneration(t *testing.T) {
	home := t.TempDir()
	oldDefinition := testDefinition(t, home, []byte("program-v1"))
	newDefinition := oldDefinition
	newDefinition.Environment = map[string]string{"PATH": "/usr/local/bin:/usr/bin:/bin"}
	plistPath := filepath.Join(home, "Library", "LaunchAgents", newDefinition.Label+".plist")
	newContent, err := renderDefinition(newDefinition)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(plistPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(plistPath, newContent, 0o600); err != nil {
		t.Fatal(err)
	}
	var calls []string
	printCalls := 0
	manager := testManager(home, func(_ context.Context, arguments ...string) ([]byte, error) {
		calls = append(calls, arguments[0])
		switch arguments[0] {
		case "print":
			printCalls++
			switch printCalls {
			case 1:
				return loadedPrint(t, plistPath, oldDefinition), nil
			case 2:
				return nil, errors.New("service not found")
			default:
				return loadedPrint(t, plistPath, newDefinition), nil
			}
		case "bootout", "bootstrap":
			return nil, nil
		default:
			return nil, errors.New("unexpected command")
		}
	})
	if err := manager.EnsureLoaded(context.Background(), newDefinition); err != nil {
		t.Fatal(err)
	}
	if !containsString(calls, "bootout") || !containsString(calls, "bootstrap") {
		t.Fatalf("calls = %v", calls)
	}
}

func TestEnsureLoadedRejectsDeclaredProgramHashMismatchWithoutSideEffects(t *testing.T) {
	home := t.TempDir()
	definition := testDefinition(t, home, []byte("program-v1"))
	definition.ProgramSHA256 = hex.EncodeToString(make([]byte, sha256.Size))
	var calls int
	manager := testManager(home, func(context.Context, ...string) ([]byte, error) {
		calls++
		return nil, nil
	})

	err := manager.EnsureLoaded(context.Background(), definition)
	if !errors.Is(err, ErrInvalidDefinition) {
		t.Fatalf("error = %v, want ErrInvalidDefinition", err)
	}
	if calls != 0 {
		t.Fatalf("launchctl calls = %d", calls)
	}
	plistPath := filepath.Join(home, "Library", "LaunchAgents", definition.Label+".plist")
	if _, statErr := os.Stat(plistPath); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("plist stat error = %v", statErr)
	}
}

func TestEnsureLoadedRejectsWrongLoadedFingerprint(t *testing.T) {
	home := t.TempDir()
	definition := testDefinition(t, home, []byte("program-v1"))
	plistPath := filepath.Join(home, "Library", "LaunchAgents", definition.Label+".plist")
	printCalls := 0
	manager := testManager(home, func(_ context.Context, arguments ...string) ([]byte, error) {
		switch arguments[0] {
		case "print":
			printCalls++
			if printCalls == 1 {
				return nil, errors.New("service not found")
			}
			return loadedPrintWithFingerprint(plistPath, definition, "wrong"), nil
		case "bootout", "bootstrap":
			return nil, nil
		default:
			return nil, errors.New("unexpected command")
		}
	})

	err := manager.EnsureLoaded(context.Background(), definition)
	if !errors.Is(err, ErrIdentityMismatch) {
		t.Fatalf("error = %v, want ErrIdentityMismatch", err)
	}
}

func TestEnsureLoadedWaitForSameLabelHonorsContext(t *testing.T) {
	home := t.TempDir()
	definition := testDefinition(t, home, []byte("program-v1"))
	entered := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	first := testManager(home, func(_ context.Context, arguments ...string) ([]byte, error) {
		if arguments[0] == "print" {
			once.Do(func() { close(entered) })
			<-release
			return nil, errors.New("service not found")
		}
		return nil, nil
	})
	firstDone := make(chan error, 1)
	go func() { firstDone <- first.EnsureLoaded(context.Background(), definition) }()
	<-entered

	var secondCalls int
	second := testManager(home, func(context.Context, ...string) ([]byte, error) {
		secondCalls++
		return nil, nil
	})
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	err := second.EnsureLoaded(ctx, definition)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("error = %v, want deadline exceeded", err)
	}
	if secondCalls != 0 {
		t.Fatalf("waiting manager executed %d launchctl calls", secondCalls)
	}
	close(release)
	<-firstDone
}

func testDefinition(t *testing.T, home string, program []byte) Definition {
	t.Helper()
	programPath := filepath.Join(home, "computer", "bin", "vela-computer")
	if err := os.MkdirAll(filepath.Dir(programPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(programPath, program, 0o700); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(program)
	state := filepath.Join(home, "computer", "state")
	return Definition{
		Label: "com.example.computer", Program: programPath,
		ProgramSHA256: hex.EncodeToString(digest[:]),
		Arguments:     []string{"daemon", "run", "--state-dir", state},
		StdoutPath:    filepath.Join(state, "logs", "stdout.log"),
		StderrPath:    filepath.Join(state, "logs", "stderr.log"),
		Environment:   map[string]string{"PATH": "/usr/bin:/bin"},
		KeepAlive:     true, RunAtLoad: true, ProcessType: ProcessTypeBackground, Umask: 0o077,
	}
}

func testManager(home string, run commandRunner) *Manager {
	return newManager(managerConfig{
		home: home, uid: os.Geteuid(), gid: os.Getegid(), run: run,
		transitionTimeout: 40 * time.Millisecond, retryInterval: time.Millisecond,
	})
}

func loadedPrint(t *testing.T, plistPath string, definition Definition) []byte {
	t.Helper()
	fingerprint, err := definitionFingerprint(definition)
	if err != nil {
		t.Fatal(err)
	}
	return loadedPrintWithFingerprint(plistPath, definition, fingerprint)
}

func loadedPrintWithFingerprint(plistPath string, definition Definition, fingerprint string) []byte {
	result := "path = " + plistPath + "\nprogram = " + definition.Program + "\narguments = {\n"
	result += "\t" + definition.Program + "\n"
	for _, argument := range definition.Arguments {
		result += "\t" + argument + "\n"
	}
	result += "}\nenvironment = {\n\t" + definitionFingerprintEnvironmentKey + " => " + fingerprint + "\n}\n"
	return []byte(result)
}

func containsString(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}
