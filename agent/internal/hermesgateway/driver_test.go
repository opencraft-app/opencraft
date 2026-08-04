package hermesgateway

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/hermes"
	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/runtimeapi"
)

func TestDriverProbeValidatesPythonGatewayModuleAndHermesProfiles(t *testing.T) {
	driver := newGatewayTestDriver(t)

	result, err := driver.Probe(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !result.Available ||
		result.Path != os.Args[0] ||
		!strings.Contains(result.Version, "Hermes Gateway") {
		t.Fatalf("Probe() = %#v", result)
	}
}

func TestDriverDetectModelsUsesGatewayInventory(t *testing.T) {
	driver := newGatewayTestDriver(t)

	result, err := driver.DetectModels(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.Unsupported || result.Default != "default" {
		t.Fatalf("DetectModels() = %#v", result)
	}
	found := false
	for _, model := range result.Models {
		if model.ID == "test-model" {
			found = true
		}
	}
	if !found {
		t.Fatalf("Gateway inventory missing test-model: %#v", result.Models)
	}
}

func TestDriverDoesNotFallBackToUnrelatedSystemPython(t *testing.T) {
	trustedHome := t.TempDir()
	if err := os.MkdirAll(filepath.Join(trustedHome, ".hermes"), 0o700); err != nil {
		t.Fatal(err)
	}
	binDirectory := t.TempDir()
	pythonPath := filepath.Join(binDirectory, "python3")
	if err := os.WriteFile(
		pythonPath,
		[]byte("#!/bin/sh\nprintf 'Hermes Gateway impostor\\n'\n"),
		0o700,
	); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDirectory)
	t.Setenv("GO_WANT_HERMES_GATEWAY_HELPER", "1")
	driver := New(Options{
		HermesExecutable: os.Args[0],
		HermesArgsPrefix: []string{
			"-test.run=TestHermesGatewayHelperProcess",
			"--",
		},
		TrustedHome: trustedHome,
	})

	result, err := driver.Probe(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.Available {
		t.Fatalf("unrelated PATH python was accepted: %#v", result)
	}
}

func TestDriverDerivesPythonOnlyFromHermesLauncherEnvironment(t *testing.T) {
	root := t.TempDir()
	binDirectory := filepath.Join(root, "venv", "bin")
	if err := os.MkdirAll(binDirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	pythonPath := filepath.Join(binDirectory, "python")
	if err := os.WriteFile(pythonPath, []byte("fixture"), 0o700); err != nil {
		t.Fatal(err)
	}
	hermesPath := filepath.Join(binDirectory, "hermes")
	if err := os.WriteFile(
		hermesPath,
		[]byte("#!"+pythonPath+"\n# launcher fixture\n"),
		0o700,
	); err != nil {
		t.Fatal(err)
	}
	driver := New(Options{HermesExecutable: hermesPath})

	candidates, err := driver.pythonCandidates()
	if err != nil {
		t.Fatal(err)
	}
	if len(candidates) == 0 || candidates[0].Path != pythonPath {
		t.Fatalf("pythonCandidates() = %#v", candidates)
	}
	for _, candidate := range candidates {
		if candidate.Path == "python3" || candidate.Path == "python" {
			t.Fatalf("unresolved system Python escaped: %#v", candidates)
		}
	}
}

func TestDriverDerivesPythonFromTrustedHomeLocalBinOutsidePATH(t *testing.T) {
	trustedHome := t.TempDir()
	venvBin := filepath.Join(trustedHome, "runtime", "venv", "bin")
	if err := os.MkdirAll(venvBin, 0o700); err != nil {
		t.Fatal(err)
	}
	pythonPath := filepath.Join(venvBin, "python3")
	if err := os.WriteFile(pythonPath, []byte("fixture"), 0o700); err != nil {
		t.Fatal(err)
	}
	launcher := filepath.Join(venvBin, "hermes")
	if err := os.WriteFile(
		launcher,
		[]byte("#!"+pythonPath+"\n# launcher fixture\n"),
		0o700,
	); err != nil {
		t.Fatal(err)
	}
	localBin := filepath.Join(trustedHome, ".local", "bin")
	if err := os.MkdirAll(localBin, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(launcher, filepath.Join(localBin, "hermes")); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", t.TempDir())
	driver := New(Options{TrustedHome: trustedHome})

	candidates, err := driver.pythonCandidates()
	if err != nil {
		t.Fatal(err)
	}
	if len(candidates) == 0 || candidates[0].Path != pythonPath {
		t.Fatalf("pythonCandidates() = %#v", candidates)
	}
}

func TestDriverDerivesPythonOnlyFromLiteralBashExecTarget(t *testing.T) {
	root := t.TempDir()
	pythonPath := filepath.Join(
		root,
		"lib",
		"hermes-agent",
		"venv",
		"bin",
		"python",
	)
	if err := os.MkdirAll(filepath.Dir(pythonPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(pythonPath, []byte("fixture"), 0o700); err != nil {
		t.Fatal(err)
	}
	launcherDirectory := filepath.Join(root, "bin")
	if err := os.MkdirAll(launcherDirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	hermesPath := filepath.Join(launcherDirectory, "hermes")
	if err := os.WriteFile(
		hermesPath,
		[]byte(
			"#!/usr/bin/env bash\n"+
				"unset PYTHONPATH\n"+
				"unset PYTHONHOME\n"+
				"exec \""+pythonPath+"\" "+
				"\""+filepath.Join(root, "lib", "hermes-agent", "hermes")+"\" "+
				"\"$@\"\n",
		),
		0o700,
	); err != nil {
		t.Fatal(err)
	}
	driver := New(Options{HermesExecutable: hermesPath})

	candidates, err := driver.pythonCandidates()
	if err != nil {
		t.Fatal(err)
	}
	if len(candidates) == 0 || candidates[0].Path != pythonPath {
		t.Fatalf("pythonCandidates() = %#v, want literal exec target first", candidates)
	}

	dynamicLauncher := filepath.Join(launcherDirectory, "hermes-dynamic")
	if err := os.WriteFile(
		dynamicLauncher,
		[]byte(
			"#!/usr/bin/env bash\n"+
				"python=\""+pythonPath+"\"\n"+
				"exec \"$python\" \"$@\"\n",
		),
		0o700,
	); err != nil {
		t.Fatal(err)
	}
	dynamicDriver := New(Options{HermesExecutable: dynamicLauncher})
	dynamicCandidates, err := dynamicDriver.pythonCandidates()
	if err != nil {
		t.Fatal(err)
	}
	for _, candidate := range dynamicCandidates {
		if candidate.Path == pythonPath {
			t.Fatalf(
				"dynamic shell expansion was trusted: %#v",
				dynamicCandidates,
			)
		}
	}
}

func TestDriverRunsGatewayAndMapsTerminalCompletion(t *testing.T) {
	driver := newGatewayTestDriver(t)
	session, err := driver.Start(
		context.Background(),
		runtimeapi.StartRequest{
			AgentID:          "agent-gateway-completion",
			LaunchID:         "launch-gateway-completion",
			WorkingDirectory: t.TempDir(),
			Prompt:           "hello from Raft",
			Environment: map[string]string{
				"GO_WANT_HERMES_GATEWAY_HELPER": "1",
				"DEEPSEEK_API_KEY":              "must-not-cross",
			},
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Stop(context.Background())

	kinds := collectGatewayTurn(t, session.Events())
	if kinds[runtimeapi.EventAssistantText] != 1 {
		t.Fatalf("assistant event count = %d, want one", kinds[runtimeapi.EventAssistantText])
	}
	if kinds[runtimeapi.EventTurnCompletion] != 1 {
		t.Fatalf("completion event count = %d, want one", kinds[runtimeapi.EventTurnCompletion])
	}
	if kinds[runtimeapi.EventActivity] == 0 {
		t.Fatal("message.delta did not produce activity")
	}
	if session.SessionID() != "stored-gateway-1" {
		t.Fatalf("SessionID() = %q", session.SessionID())
	}
}

func TestDriverDefaultModelStartDoesNotRequireGatewayInventory(t *testing.T) {
	driver := newGatewayTestDriver(t)
	session, err := driver.Start(
		context.Background(),
		runtimeapi.StartRequest{
			AgentID:          "agent-gateway-default-model",
			LaunchID:         "launch-gateway-default-model",
			WorkingDirectory: t.TempDir(),
			Model:            "default",
			Prompt:           "start without model inventory",
			Environment: map[string]string{
				"GO_WANT_HERMES_GATEWAY_HELPER": "1",
				"HERMES_GATEWAY_HELPER_MODE":    "model-options-fatal",
			},
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Stop(context.Background())
	_ = collectGatewayTurn(t, session.Events())
}

func TestDriverForwardsStandingPolicyAndCurrentInputSeparately(t *testing.T) {
	driver := newGatewayTestDriver(t)
	session, err := driver.Start(
		context.Background(),
		runtimeapi.StartRequest{
			AgentID:          "agent-gateway-policy",
			LaunchID:         "launch-gateway-policy",
			WorkingDirectory: t.TempDir(),
			StandingPrompt:   "shared standing policy fixture",
			Prompt:           "current wake input fixture",
			Environment: map[string]string{
				"GO_WANT_HERMES_GATEWAY_HELPER": "1",
				"HERMES_GATEWAY_EXPECT_PROMPT": managedInitialPrompt(
					"shared standing policy fixture",
					"current wake input fixture",
				),
			},
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Stop(context.Background())
	_ = collectGatewayTurn(t, session.Events())
}

func TestDriverRejectsUnknownPiModelWithoutFallback(t *testing.T) {
	driver := newGatewayTestDriver(t)
	session, err := driver.Start(
		context.Background(),
		runtimeapi.StartRequest{
			AgentID:          "agent-gateway-model-firewall",
			LaunchID:         "launch-gateway-model-firewall",
			WorkingDirectory: t.TempDir(),
			Model:            "pi-only-model",
			Environment: map[string]string{
				"GO_WANT_HERMES_GATEWAY_HELPER": "1",
			},
		},
	)
	if err == nil {
		_ = session.Stop(context.Background())
		t.Fatal("unknown Pi model reached Hermes Gateway")
	}
	if !strings.Contains(err.Error(), "model") ||
		strings.Contains(err.Error(), "must-not-cross") {
		t.Fatalf("model firewall error = %v", err)
	}
}

func TestDriverExposesNativeSteerAndTurnInterrupt(t *testing.T) {
	driver := newGatewayTestDriver(t)
	session, err := driver.Start(
		context.Background(),
		runtimeapi.StartRequest{
			AgentID:          "agent-gateway-turn-control",
			LaunchID:         "launch-gateway-turn-control",
			WorkingDirectory: t.TempDir(),
			Prompt:           "hold the turn",
			Environment: map[string]string{
				"GO_WANT_HERMES_GATEWAY_HELPER": "1",
				"HERMES_GATEWAY_HELPER_MODE":    "steer-before-complete",
			},
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Stop(context.Background())
	waitForGatewayEvent(t, session.Events(), runtimeapi.EventActivity)

	steerer, ok := session.(runtimeapi.NativeSteerer)
	if !ok {
		t.Fatalf("session type %T does not expose NativeSteerer", session)
	}
	if err := steerer.Steer(
		context.Background(),
		runtimeapi.Delivery{Text: "correct course"},
	); err != nil {
		t.Fatal(err)
	}
	kinds := collectGatewayTurn(t, session.Events())
	if kinds[runtimeapi.EventAssistantText] != 1 ||
		kinds[runtimeapi.EventTurnCompletion] != 1 {
		t.Fatalf("steered turn events = %#v", kinds)
	}

	interrupting, ok := session.(runtimeapi.NativeTurnInterrupter)
	if !ok {
		t.Fatalf("session type %T does not expose NativeTurnInterrupter", session)
	}
	if err := session.Deliver(
		context.Background(),
		runtimeapi.Delivery{Text: "start another turn", Mode: "idle"},
	); err != nil {
		t.Fatal(err)
	}
	if err := interrupting.InterruptTurn(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestDriverResolvesBlockingInteractionsDeterministically(t *testing.T) {
	driver := newGatewayTestDriver(t)
	session, err := driver.Start(
		context.Background(),
		runtimeapi.StartRequest{
			AgentID:          "agent-gateway-interactions",
			LaunchID:         "launch-gateway-interactions",
			WorkingDirectory: t.TempDir(),
			Prompt:           "exercise interactions",
			Environment: map[string]string{
				"GO_WANT_HERMES_GATEWAY_HELPER": "1",
				"HERMES_GATEWAY_HELPER_MODE":    "blocking-interactions",
				"HERMES_ACP_PERMISSION_POLICY":  "once",
			},
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Stop(context.Background())

	kinds := collectGatewayTurn(t, session.Events())
	if kinds[runtimeapi.EventDiagnostic] < 5 {
		t.Fatalf("interaction diagnostics = %#v", kinds)
	}
}

func TestDriverColdStartsOnlyForRecognizedMissingResume(t *testing.T) {
	for _, testCase := range []struct {
		name      string
		mode      string
		wantStart bool
	}{
		{name: "recognized missing", mode: "resume-missing", wantStart: true},
		{name: "fatal RPC", mode: "resume-fatal"},
		{name: "malformed success", mode: "resume-malformed"},
	} {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			driver := newGatewayTestDriver(t)
			session, err := driver.Start(
				context.Background(),
				runtimeapi.StartRequest{
					AgentID:          "agent-gateway-resume-" + testCase.mode,
					LaunchID:         "launch-gateway-resume-" + testCase.mode,
					WorkingDirectory: t.TempDir(),
					SessionID:        "stored-old",
					Prompt:           "continue",
					Environment: map[string]string{
						"GO_WANT_HERMES_GATEWAY_HELPER": "1",
						"HERMES_GATEWAY_HELPER_MODE":    testCase.mode,
					},
				},
			)
			if !testCase.wantStart {
				if err == nil {
					_ = session.Stop(context.Background())
					t.Fatal("unsafe resume failure cold-started a new session")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			defer session.Stop(context.Background())
			kinds := collectGatewayTurn(t, session.Events())
			if kinds[runtimeapi.EventRecovery] != 1 {
				t.Fatalf("recovery events = %#v", kinds)
			}
		})
	}
}

func TestDriverSuppressesDuplicateTerminalCompletion(t *testing.T) {
	driver := newGatewayTestDriver(t)
	session, err := driver.Start(
		context.Background(),
		runtimeapi.StartRequest{
			AgentID:          "agent-gateway-duplicate",
			LaunchID:         "launch-gateway-duplicate",
			WorkingDirectory: t.TempDir(),
			Prompt:           "one answer only",
			Environment: map[string]string{
				"GO_WANT_HERMES_GATEWAY_HELPER": "1",
				"HERMES_GATEWAY_HELPER_MODE":    "duplicate-completion",
			},
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Stop(context.Background())
	_ = collectGatewayTurn(t, session.Events())

	deadline := time.After(150 * time.Millisecond)
	for {
		select {
		case event := <-session.Events():
			if event.Kind == runtimeapi.EventAssistantText ||
				event.Kind == runtimeapi.EventTurnCompletion {
				t.Fatalf("duplicate terminal event escaped: %#v", event)
			}
		case <-deadline:
			return
		}
	}
}

func TestDriverProfileLeaseAllowsDifferentAgentsAndRejectsSameAgent(t *testing.T) {
	driver := newGatewayTestDriver(t)
	start := func(agentID string, launchID string) (runtimeapi.RuntimeSession, error) {
		return driver.Start(context.Background(), runtimeapi.StartRequest{
			AgentID:          agentID,
			LaunchID:         launchID,
			WorkingDirectory: t.TempDir(),
			Environment: map[string]string{
				"GO_WANT_HERMES_GATEWAY_HELPER": "1",
			},
		})
	}

	first, err := start("agent-profile-a", "launch-profile-a")
	if err != nil {
		t.Fatal(err)
	}
	defer first.Stop(context.Background())
	second, err := start("agent-profile-b", "launch-profile-b")
	if err != nil {
		t.Fatalf("different Agent Start() = %v", err)
	}
	defer second.Stop(context.Background())

	if _, err := start(
		"agent-profile-a",
		"launch-profile-a-duplicate",
	); !errors.Is(err, hermes.ErrManagedProfileRuntimeBusy) {
		t.Fatalf("duplicate Agent Start() error = %v", err)
	}
}

func newGatewayTestDriver(t *testing.T) *Driver {
	t.Helper()

	trustedHome := t.TempDir()
	if err := os.MkdirAll(filepath.Join(trustedHome, ".hermes"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GO_WANT_HERMES_GATEWAY_HELPER", "1")
	return New(Options{
		PythonExecutable: os.Args[0],
		PythonArgsPrefix: []string{
			"-test.run=TestHermesGatewayHelperProcess",
			"--",
		},
		HermesExecutable: os.Args[0],
		HermesArgsPrefix: []string{
			"-test.run=TestHermesGatewayHelperProcess",
			"--",
		},
		Version:          "test-client",
		TrustedHome:      trustedHome,
		RuntimeLeaseWait: 100 * time.Millisecond,
	})
}

func collectGatewayTurn(
	t *testing.T,
	events <-chan runtimeapi.Event,
) map[runtimeapi.EventKind]int {
	t.Helper()

	kinds := make(map[runtimeapi.EventKind]int)
	deadline := time.After(5 * time.Second)
	for {
		select {
		case event := <-events:
			kinds[event.Kind]++
			if event.Kind == runtimeapi.EventAssistantText &&
				event.Text != "terminal Hermes reply" {
				t.Fatalf("assistant text = %q", event.Text)
			}
			if event.Kind == runtimeapi.EventTurnCompletion {
				return kinds
			}
		case <-deadline:
			t.Fatalf("timed out waiting for Gateway turn: %#v", kinds)
		}
	}
}

func waitForGatewayEvent(
	t *testing.T,
	events <-chan runtimeapi.Event,
	kind runtimeapi.EventKind,
) runtimeapi.Event {
	t.Helper()

	select {
	case event := <-events:
		if event.Kind == kind {
			return event
		}
		return waitForGatewayEvent(t, events, kind)
	case <-time.After(5 * time.Second):
		t.Fatalf("timed out waiting for %s", kind)
		return runtimeapi.Event{}
	}
}

func TestHermesGatewayHelperProcess(t *testing.T) {
	if os.Getenv("GO_WANT_HERMES_GATEWAY_HELPER") != "1" {
		return
	}
	args := strings.Join(os.Args, "\x00")
	switch {
	case strings.Contains(args, "acp\x00--check"):
		fmt.Println("Hermes ACP check OK")
		return
	case strings.Contains(args, "profile\x00create\x00--help"):
		fmt.Println(
			"usage: hermes profile create [--clone] " +
				"[--clone-from SOURCE] [--no-alias]",
		)
		return
	case strings.Contains(args, "profile\x00create\x00"):
		profileName := helperArgumentAfter("create")
		if profileName == "" {
			os.Exit(31)
		}
		if err := os.MkdirAll(
			filepath.Join(
				os.Getenv("HOME"),
				".hermes",
				"profiles",
				profileName,
				"sessions",
			),
			0o700,
		); err != nil {
			os.Exit(32)
		}
		return
	case strings.Contains(args, "\x00-c\x00"):
		fmt.Println("Hermes Gateway v-test")
		return
	case strings.Contains(args, "tui_gateway.entry"):
		runGatewayHelper()
		os.Exit(0)
	default:
		os.Exit(33)
	}
}

func runGatewayHelper() {
	if os.Getenv("DEEPSEEK_API_KEY") != "" {
		os.Exit(41)
	}
	if hermesHome := os.Getenv("HERMES_HOME"); hermesHome != "" &&
		!strings.Contains(
			filepath.ToSlash(hermesHome),
			"/.hermes/profiles/raft-",
		) {
		os.Exit(42)
	}
	signal.Ignore(os.Interrupt)
	helperGatewayWrite(map[string]any{
		"jsonrpc": "2.0",
		"method":  "event",
		"params": map[string]any{
			"type":    "gateway.ready",
			"payload": map[string]any{"skin": "test"},
		},
	})
	scanner := bufio.NewScanner(os.Stdin)
	interactionResponses := 0
	for scanner.Scan() {
		var request struct {
			ID     int64           `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
		}
		if common.Unmarshal(scanner.Bytes(), &request) != nil {
			os.Exit(43)
		}
		switch request.Method {
		case "model.options":
			if os.Getenv("HERMES_GATEWAY_HELPER_MODE") ==
				"model-options-fatal" {
				helperGatewayError(request.ID, 5033, "inventory unavailable")
				continue
			}
			helperGatewayRespond(request.ID, map[string]any{
				"providers": []any{
					map[string]any{
						"slug":   "test",
						"models": []string{"test-model"},
					},
				},
			})
		case "session.create":
			helperGatewayRespond(request.ID, map[string]any{
				"session_id":        "gateway-live-1",
				"stored_session_id": "stored-gateway-1",
			})
		case "session.resume":
			switch os.Getenv("HERMES_GATEWAY_HELPER_MODE") {
			case "resume-missing":
				helperGatewayError(request.ID, 4007, "session not found")
			case "resume-fatal":
				helperGatewayError(request.ID, 5000, "database unavailable")
			case "resume-malformed":
				helperGatewayRespond(request.ID, map[string]any{})
			default:
				helperGatewayRespond(request.ID, map[string]any{
					"session_id":  "gateway-live-1",
					"session_key": "stored-old",
				})
			}
		case "prompt.submit":
			if expected := os.Getenv("HERMES_GATEWAY_EXPECT_PROMPT"); expected != "" {
				var params struct {
					Text string `json:"text"`
				}
				if common.Unmarshal(request.Params, &params) != nil ||
					params.Text != expected {
					os.Exit(58)
				}
			}
			helperGatewayRespond(request.ID, map[string]any{"status": "streaming"})
			helperGatewayEvent("message.delta", map[string]any{
				"text": "streaming fragment",
			})
			switch os.Getenv("HERMES_GATEWAY_HELPER_MODE") {
			case "steer-before-complete":
			case "blocking-interactions":
				helperGatewayEvent("approval.request", map[string]any{
					"choices": []string{"once", "session", "deny"},
				})
				helperGatewayEvent("clarify.request", map[string]any{
					"request_id": "clarify-1",
					"question":   "pick one",
				})
				helperGatewayEvent("sudo.request", map[string]any{
					"request_id": "sudo-1",
				})
				helperGatewayEvent("secret.request", map[string]any{
					"request_id": "secret-1",
				})
				helperGatewayEvent("terminal.read.request", map[string]any{
					"request_id": "terminal-1",
				})
			case "duplicate-completion":
				helperGatewayComplete()
				helperGatewayComplete()
			default:
				helperGatewayComplete()
			}
		case "session.steer":
			helperGatewayRespond(request.ID, map[string]any{"status": "queued"})
			helperGatewayComplete()
		case "session.interrupt":
			helperGatewayRespond(request.ID, map[string]any{"status": "interrupted"})
		case "approval.respond":
			var params struct {
				SessionID string `json:"session_id"`
				Choice    string `json:"choice"`
			}
			if common.Unmarshal(request.Params, &params) != nil ||
				params.SessionID != "gateway-live-1" ||
				params.Choice != "once" {
				os.Exit(51)
			}
			helperGatewayRespond(request.ID, map[string]any{"resolved": 1})
			interactionResponses++
		case "clarify.respond", "sudo.respond", "secret.respond", "terminal.read.respond":
			var params map[string]json.RawMessage
			if common.Unmarshal(request.Params, &params) != nil {
				os.Exit(52)
			}
			var requestID string
			if common.Unmarshal(params["request_id"], &requestID) != nil ||
				requestID == "" {
				os.Exit(53)
			}
			switch request.Method {
			case "clarify.respond":
				var answer string
				if common.Unmarshal(params["answer"], &answer) != nil ||
					answer != headlessClarifyAnswer {
					os.Exit(54)
				}
			case "sudo.respond":
				if string(params["password"]) != `""` {
					os.Exit(55)
				}
			case "secret.respond":
				if string(params["value"]) != `""` {
					os.Exit(56)
				}
			case "terminal.read.respond":
				if string(params["text"]) != `""` {
					os.Exit(57)
				}
			}
			helperGatewayRespond(request.ID, map[string]any{"status": "ok"})
			interactionResponses++
		default:
			helperGatewayRespond(request.ID, map[string]any{})
		}
		if interactionResponses == 5 {
			helperGatewayComplete()
			interactionResponses++
		}
	}
}

func helperGatewayComplete() {
	helperGatewayEvent("message.complete", map[string]any{
		"text":   "terminal Hermes reply",
		"status": "complete",
	})
}

func helperGatewayEvent(eventType string, payload any) {
	helperGatewayWrite(map[string]any{
		"jsonrpc": "2.0",
		"method":  "event",
		"params": map[string]any{
			"type":       eventType,
			"session_id": "gateway-live-1",
			"payload":    payload,
		},
	})
}

func helperGatewayRespond(id int64, result any) {
	helperGatewayWrite(map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"result":  result,
	})
}

func helperGatewayError(id int64, code int, message string) {
	helperGatewayWrite(map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"error": map[string]any{
			"code":    code,
			"message": message,
		},
	})
}

func helperGatewayWrite(value any) {
	data, err := common.Marshal(value)
	if err != nil {
		os.Exit(44)
	}
	if _, err := os.Stdout.Write(append(data, '\n')); err != nil {
		os.Exit(45)
	}
}

func helperArgumentAfter(want string) string {
	for index, argument := range os.Args {
		if argument == want && index+1 < len(os.Args) {
			return os.Args[index+1]
		}
	}
	return ""
}
