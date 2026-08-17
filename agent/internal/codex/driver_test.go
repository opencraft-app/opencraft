package codex

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"velachat/agent/internal/common"
	"velachat/agent/internal/runtimeapi"
	"velachat/agent/internal/runtimeprompt"
)

func TestDriverRunsCodexAppServerAndNormalizesEvents(t *testing.T) {
	t.Parallel()

	driver := New(Options{
		Executable: os.Args[0],
		ArgsPrefix: []string{"-test.run=TestCodexAppServerHelper", "--"},
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	session, err := driver.Start(ctx, runtimeapi.StartRequest{
		AgentID:          "agent-1",
		LaunchID:         "launch-1",
		WorkingDirectory: t.TempDir(),
		Prompt:           "hello",
		Environment: map[string]string{
			"VELA_CODEX_HELPER": "1",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer session.Stop(context.Background())

	wantKinds := map[runtimeapi.EventKind]bool{
		runtimeapi.EventSession:        false,
		runtimeapi.EventThinking:       false,
		runtimeapi.EventAssistantText:  false,
		runtimeapi.EventTurnCompletion: false,
	}
	sessionEvents := 0
	deadline := time.After(5 * time.Second)
	for {
		select {
		case event := <-session.Events():
			if event.Kind == runtimeapi.EventAssistantText && event.Text != "hello from fake Codex" {
				t.Fatalf("assistant text = %q", event.Text)
			}
			if event.Kind == runtimeapi.EventSession {
				sessionEvents++
			}
			if _, tracked := wantKinds[event.Kind]; tracked {
				wantKinds[event.Kind] = true
			}
			complete := true
			for _, seen := range wantKinds {
				complete = complete && seen
			}
			if complete {
				if session.SessionID() != "thread-test" {
					t.Fatalf("session ID = %q", session.SessionID())
				}
				if sessionEvents != 1 {
					t.Fatalf("startup session events = %d, want one", sessionEvents)
				}
				return
			}
		case <-deadline:
			t.Fatalf("timed out waiting for events: %#v", wantKinds)
		}
	}
}

func TestDriverForwardsSharedStandingPolicyToThreadStartAndResume(t *testing.T) {
	t.Parallel()

	for _, testCase := range []struct {
		name      string
		sessionID string
		method    string
	}{
		{name: "start", method: "thread/start"},
		{name: "resume", sessionID: "thread-existing", method: "thread/resume"},
	} {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()

			standingPrompt, err := runtimeprompt.ComposeStandingPrompt(
				"agent-codex-policy",
				"Codex-specific instructions",
			)
			if err != nil {
				t.Fatal(err)
			}
			requestLog := filepath.Join(t.TempDir(), "thread-requests.jsonl")
			driver := New(Options{
				Executable: os.Args[0],
				ArgsPrefix: []string{"-test.run=TestCodexAppServerHelper", "--"},
			})
			session, err := driver.Start(context.Background(), runtimeapi.StartRequest{
				AgentID:          "agent-codex-policy",
				LaunchID:         "launch-codex-policy-" + testCase.name,
				WorkingDirectory: t.TempDir(),
				StandingPrompt:   standingPrompt,
				SessionID:        testCase.sessionID,
				Environment: map[string]string{
					"VELA_CODEX_HELPER":             "1",
					"VELA_CODEX_HELPER_REQUEST_LOG": requestLog,
				},
			})
			if err != nil {
				t.Fatal(err)
			}
			defer session.Stop(context.Background())

			raw := waitForCodexHelperRequest(t, requestLog, testCase.method)
			var request struct {
				Params map[string]any `json:"params"`
			}
			if err := common.Unmarshal(raw, &request); err != nil {
				t.Fatal(err)
			}
			got, _ := request.Params["developerInstructions"].(string)
			if got != standingPrompt {
				t.Fatalf(
					"%s developerInstructions = %q, want exact shared prompt %q",
					testCase.method,
					got,
					standingPrompt,
				)
			}
		})
	}
}

func TestDriverExposesObservedAndConfiguredRuntimeHome(t *testing.T) {
	t.Parallel()

	workingDirectory := t.TempDir()
	driver := New(Options{
		Executable: os.Args[0],
		ArgsPrefix: []string{"-test.run=TestCodexAppServerHelper", "--"},
	})
	session, err := driver.Start(context.Background(), runtimeapi.StartRequest{
		AgentID:          "agent-runtime-home",
		LaunchID:         "launch-runtime-home",
		WorkingDirectory: workingDirectory,
		Prompt:           "Start.",
		Environment: map[string]string{
			"VELA_CODEX_HELPER":      "1",
			"VELA_CODEX_HELPER_MODE": "runtime-home",
			"CODEX_HOME":             ".configured-codex-home",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer session.Stop(context.Background())

	provider, ok := session.(runtimeapi.RuntimeHomeProvider)
	if !ok {
		t.Fatal("Codex Runtime session does not expose RuntimeHomeInfo")
	}
	info := provider.RuntimeHomeInfo()
	if got, want := info.ObservedDir, filepath.Join(workingDirectory, ".reported-codex-home"); got != want {
		t.Fatalf("observed Runtime home = %q, want %q", got, want)
	}
	if got, want := info.ConfiguredDir, filepath.Join(workingDirectory, ".configured-codex-home"); got != want {
		t.Fatalf("configured Runtime home = %q, want %q", got, want)
	}
	if !info.Explicit {
		t.Fatal("explicit CODEX_HOME was not preserved")
	}
}

func TestDriverUsesDefaultRuntimeHomeWhenConfiguredValueIsBlank(t *testing.T) {
	t.Parallel()

	workingDirectory := t.TempDir()
	driver := New(Options{
		Executable: os.Args[0],
		ArgsPrefix: []string{"-test.run=TestCodexAppServerHelper", "--"},
	})
	session, err := driver.Start(context.Background(), runtimeapi.StartRequest{
		AgentID:          "agent-default-runtime-home",
		LaunchID:         "launch-default-runtime-home",
		WorkingDirectory: workingDirectory,
		Prompt:           "Start.",
		Environment: map[string]string{
			"VELA_CODEX_HELPER": "1",
			"CODEX_HOME":        " \t ",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer session.Stop(context.Background())

	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	provider, ok := session.(runtimeapi.RuntimeHomeProvider)
	if !ok {
		t.Fatal("Codex Runtime session does not expose RuntimeHomeInfo")
	}
	info := provider.RuntimeHomeInfo()
	if got, want := info.ObservedDir, filepath.Join(home, ".codex"); got != want {
		t.Fatalf("observed default Runtime home = %q, want %q", got, want)
	}
	if got, want := info.ConfiguredDir, filepath.Join(home, ".codex"); got != want {
		t.Fatalf("configured default Runtime home = %q, want %q", got, want)
	}
	if info.Explicit {
		t.Fatal("blank CODEX_HOME was classified as explicit")
	}
}

func TestDriverEchoesUnsupportedServerRequestIDs(t *testing.T) {
	responseLog := filepath.Join(t.TempDir(), "responses.jsonl")
	driver := New(Options{
		Executable: os.Args[0],
		ArgsPrefix: []string{"-test.run=TestCodexAppServerHelper", "--"},
	})
	session, err := driver.Start(context.Background(), runtimeapi.StartRequest{
		AgentID:          "agent-server-request",
		LaunchID:         "launch-server-request",
		WorkingDirectory: t.TempDir(),
		Prompt:           "Start.",
		Environment: map[string]string{
			"VELA_CODEX_HELPER":              "1",
			"VELA_CODEX_HELPER_MODE":         "server-request-envelope",
			"VELA_CODEX_HELPER_RESPONSE_LOG": responseLog,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer session.Stop(context.Background())

	got := waitCodexHelperUnsupportedResponses(t, responseLog, 5)
	want := []codexHelperUnsupportedResponse{
		{
			ID:      `"server-request-string"`,
			Code:    -32601,
			Message: wantUnsupportedServerRequestMessage("account/read"),
		},
		{
			ID:      "0",
			Code:    -32601,
			Message: wantUnsupportedServerRequestMessage("account/read"),
		},
		{
			ID:      `""`,
			Code:    -32601,
			Message: wantUnsupportedServerRequestMessage("account/read"),
		},
		{
			ID:      "null",
			Code:    -32601,
			Message: wantUnsupportedServerRequestMessage("account/read"),
		},
		{
			ID:      `"empty-method"`,
			Code:    -32601,
			Message: wantUnsupportedServerRequestMessage(""),
		},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("unsupported server-request responses = %#v, want %#v", got, want)
	}
}

func TestDriverRejectsWhitespaceInitializeUserAgent(t *testing.T) {
	driver := New(Options{
		Executable: os.Args[0],
		ArgsPrefix: []string{"-test.run=TestCodexAppServerHelper", "--"},
	})
	session, err := driver.Start(context.Background(), runtimeapi.StartRequest{
		AgentID:          "agent-initialize-whitespace",
		LaunchID:         "launch-initialize-whitespace",
		WorkingDirectory: t.TempDir(),
		Prompt:           "Start.",
		Environment: map[string]string{
			"VELA_CODEX_HELPER":      "1",
			"VELA_CODEX_HELPER_MODE": "initialize-whitespace-user-agent",
		},
	})
	if session != nil {
		defer session.Stop(context.Background())
	}
	if err == nil || err.Error() != wantUnsupportedInitializeResultMessage() {
		t.Fatalf(
			"Start() error = %v, want %q",
			err,
			wantUnsupportedInitializeResultMessage(),
		)
	}
}

func TestDriverPinsInitialTurnToStartupResultBeforeLaterThreadNotification(
	t *testing.T,
) {
	t.Parallel()

	driver := New(Options{
		Executable: os.Args[0],
		ArgsPrefix: []string{"-test.run=TestCodexAppServerHelper", "--"},
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	session, err := driver.Start(ctx, runtimeapi.StartRequest{
		AgentID:          "agent-startup-thread-order",
		LaunchID:         "launch-startup-thread-order",
		WorkingDirectory: t.TempDir(),
		Prompt:           "preserve startup thread order",
		Environment: map[string]string{
			"VELA_CODEX_HELPER":      "1",
			"VELA_CODEX_HELPER_MODE": "startup-thread-order",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer session.Stop(context.Background())

	deadline := time.After(5 * time.Second)
	for {
		select {
		case event := <-session.Events():
			if event.Kind != runtimeapi.EventTurnCompletion {
				continue
			}
			if got := session.SessionID(); got != "thread-test" {
				t.Fatalf("current session after later notification = %q", got)
			}
			return
		case <-deadline:
			t.Fatal("timed out waiting for ordered initial turn completion")
		}
	}
}

func TestCodexAppServerHelper(t *testing.T) {
	for _, argument := range os.Args {
		switch argument {
		case "--help":
			os.Exit(0)
		case "--version":
			_, _ = os.Stdout.WriteString("codex-test 9.9.0\nignored-version-line\n")
			os.Exit(0)
		}
	}
	if os.Getenv("VELA_CODEX_HELPER") != "1" {
		return
	}
	mode := os.Getenv("VELA_CODEX_HELPER_MODE")
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		var request struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params map[string]any  `json:"params"`
		}
		if err := common.Unmarshal(scanner.Bytes(), &request); err != nil {
			os.Exit(2)
		}
		if request.Method == "thread/start" || request.Method == "thread/resume" {
			appendCodexHelperRequest(scanner.Bytes())
		}
		if request.Method == "" && mode == "server-request-envelope" {
			appendCodexHelperResponse(scanner.Bytes())
			continue
		}
		switch request.Method {
		case "initialize":
			if mode == "crash-initialize" {
				os.Exit(9)
			}
			result := map[string]any{"userAgent": "fake-codex"}
			if mode == "runtime-home" {
				result["codexHome"] = ".reported-codex-home"
			}
			if mode == "initialize-whitespace-user-agent" {
				result["userAgent"] = " \t "
			}
			if mode == "server-request-envelope" {
				helperWrite(map[string]any{
					"jsonrpc": "2.0",
					"id":      json.RawMessage(`"response-precedence"`),
					"method":  "account/read",
					"result":  map[string]any{},
				})
				for _, id := range []json.RawMessage{
					json.RawMessage(`"server-request-string"`),
					json.RawMessage(`0`),
					json.RawMessage(`""`),
					json.RawMessage(`null`),
				} {
					helperWrite(map[string]any{
						"jsonrpc": "2.0",
						"id":      id,
						"method":  "account/read",
						"params":  map[string]any{},
					})
				}
				helperWrite(map[string]any{
					"jsonrpc": "2.0",
					"id":      json.RawMessage(`"empty-method"`),
					"method":  "",
					"params":  map[string]any{},
				})
			}
			if mode == "models-server-request" {
				helperWrite(map[string]any{
					"jsonrpc": "2.0",
					"id":      request.ID,
					"method":  "account/read",
					"params":  map[string]any{},
				})
			}
			helperWrite(map[string]any{
				"jsonrpc": "2.0",
				"id":      request.ID,
				"result":  result,
			})
		case "initialized":
		case "thread/resume":
			resumeError := ""
			switch mode {
			case "resume-missing", "resume-missing-require-notice":
				resumeError = "rollout not found"
			case "resume-missing-credentials":
				resumeError = "missing credentials"
			case "resume-model-not-found":
				resumeError = "model not found"
			}
			if resumeError != "" {
				helperWrite(map[string]any{
					"jsonrpc": "2.0",
					"id":      request.ID,
					"error": map[string]any{
						"code":    -32000,
						"message": resumeError,
					},
				})
				continue
			}
			helperWrite(map[string]any{
				"jsonrpc": "2.0",
				"id":      request.ID,
				"result":  map[string]any{"thread": map[string]any{"id": "thread-resumed"}},
			})
		case "thread/start":
			if mode == "require-fast-tier" &&
				request.Params["serviceTier"] != "fast" {
				helperWrite(map[string]any{
					"jsonrpc": "2.0",
					"id":      request.ID,
					"error": map[string]any{
						"code":    -32602,
						"message": "missing fast service tier",
					},
				})
				continue
			}
			helperWrite(map[string]any{
				"jsonrpc": "2.0",
				"id":      request.ID,
				"result":  map[string]any{"thread": map[string]any{"id": "thread-test"}},
			})
			if mode == "startup-thread-order" {
				helperWrite(map[string]any{
					"jsonrpc": "2.0",
					"method":  "thread/started",
					"params": map[string]any{
						"thread": map[string]any{
							"id": "thread-later-notification",
						},
					},
				})
			}
		case "turn/start":
			if mode == "root-turn-id-zero-evidence" {
				helperWrite(map[string]any{
					"jsonrpc": "2.0",
					"id":      request.ID,
					"result": map[string]any{
						"turnId": "turn-root-only",
					},
				})
				helperWrite(map[string]any{
					"jsonrpc": "2.0",
					"method":  "turn/started",
					"params": map[string]any{
						"turn": map[string]any{"id": "turn-root-only"},
					},
				})
				helperWrite(map[string]any{
					"jsonrpc": "2.0",
					"method":  "turn/completed",
					"params": map[string]any{
						"turn": map[string]any{
							"id":     "turn-root-only",
							"status": "completed",
						},
					},
				})
				continue
			}
			if mode == "startup-thread-order" &&
				request.Params["threadId"] != "thread-test" {
				helperWrite(map[string]any{
					"jsonrpc": "2.0",
					"id":      request.ID,
					"error": map[string]any{
						"code":    -32602,
						"message": "initial turn did not use startup result thread",
					},
				})
				continue
			}
			if mode == "resume-missing-require-notice" {
				prompt := helperTurnText(request.Params)
				if !strings.Contains(
					prompt,
					"Codex could not resume its previous thread; Vela started a fresh Codex thread.",
				) || !strings.Contains(
					prompt,
					"Use Vela conversation history and local MEMORY.md/notes as the recovery point; do not assume prior Codex thread context is loaded.",
				) || !strings.HasSuffix(prompt, "Continue queued work.") {
					helperWrite(map[string]any{
						"jsonrpc": "2.0",
						"id":      request.ID,
						"error": map[string]any{
							"code":    -32602,
							"message": "missing Codex recovery notice",
						},
					})
					continue
				}
			}
			helperWrite(map[string]any{
				"jsonrpc": "2.0",
				"id":      request.ID,
				"result":  map[string]any{"turn": map[string]any{"id": "turn-test"}},
			})
			helperWrite(map[string]any{
				"jsonrpc": "2.0",
				"method":  "turn/started",
				"params":  map[string]any{"turn": map[string]any{"id": "turn-test"}},
			})
			if mode == "busy-steer" || mode == "busy-steer-reject" {
				continue
			}
			if mode == "zero-evidence-started" {
				helperWrite(map[string]any{
					"jsonrpc": "2.0",
					"method":  "turn/completed",
					"params": map[string]any{
						"turn": map[string]any{
							"id":     "turn-test",
							"status": "completed",
						},
					},
				})
				continue
			}
			if mode == "non-final-agent-message" {
				helperWrite(map[string]any{
					"jsonrpc": "2.0",
					"method":  "item/agentMessage/delta",
					"params": map[string]any{
						"itemId": "item-hidden",
						"delta":  "hidden commentary",
						"phase":  "commentary",
					},
				})
			}
			helperWrite(map[string]any{
				"jsonrpc": "2.0",
				"method":  "item/agentMessage/delta",
				"params":  map[string]any{"itemId": "item-test", "delta": "hello from fake Codex", "phase": "final_answer"},
			})
			helperWrite(map[string]any{
				"jsonrpc": "2.0",
				"method":  "turn/completed",
				"params":  map[string]any{"turn": map[string]any{"id": "turn-test", "status": "completed"}},
			})
		case "turn/steer":
			if mode == "busy-steer-reject" {
				helperWrite(map[string]any{
					"jsonrpc": "2.0",
					"id":      request.ID,
					"error": map[string]any{
						"code":    -32002,
						"message": "temporary steer rejection",
					},
				})
				helperWrite(map[string]any{
					"jsonrpc": "2.0",
					"method":  "turn/completed",
					"params": map[string]any{
						"turn": map[string]any{
							"id":     "turn-test",
							"status": "completed",
						},
					},
				})
				continue
			}
			helperWrite(map[string]any{
				"jsonrpc": "2.0",
				"id":      request.ID,
				"result":  map[string]any{},
			})
			helperWrite(map[string]any{
				"jsonrpc": "2.0",
				"method":  "item/agentMessage/delta",
				"params":  map[string]any{"itemId": "item-steer", "delta": "steered response", "phase": "final_answer"},
			})
			helperWrite(map[string]any{
				"jsonrpc": "2.0",
				"method":  "turn/completed",
				"params":  map[string]any{"turn": map[string]any{"id": "turn-test", "status": "completed"}},
			})
		case "model/list":
			if mode == "models-hang" {
				continue
			}
			if mode == "models-empty" {
				helperWrite(map[string]any{
					"jsonrpc": "2.0",
					"id":      request.ID,
					"result":  map[string]any{"data": []any{}},
				})
				continue
			}
			if mode == "models-malformed" {
				helperWrite(map[string]any{
					"jsonrpc": "2.0",
					"id":      request.ID,
					"result":  map[string]any{"unexpected": true},
				})
				continue
			}
			cursor, _ := request.Params["cursor"].(string)
			if cursor == "" {
				helperWrite(map[string]any{
					"jsonrpc": "2.0",
					"id":      request.ID,
					"result": map[string]any{
						"data": []map[string]any{
							{
								"id":                        "gpt-codex-default",
								"displayName":               "Codex Default",
								"isDefault":                 true,
								"supportedReasoningEfforts": []any{"low", map[string]any{"reasoningEffort": "high"}},
								"serviceTiers":              []any{"fast", map[string]any{"id": "standard"}},
								"defaultReasoningEffort":    "high",
								"defaultServiceTier":        "standard",
							},
							{"id": "gpt-hidden", "hidden": true},
						},
						"nextCursor": "page-2",
					},
				})
				continue
			}
			helperWrite(map[string]any{
				"jsonrpc": "2.0",
				"id":      request.ID,
				"result": map[string]any{
					"models": []map[string]any{
						{"slug": "gpt-codex-fast", "label": "Codex Fast"},
						{"displayName": "missing identity"},
					},
				},
			})
		}
	}
	os.Exit(0)
}

func TestDriverExecutableCandidatesFallThroughDeduplicateAndStaySelected(
	t *testing.T,
) {
	t.Setenv("VELA_CODEX_HELPER", "1")
	t.Setenv("VELA_CODEX_HELPER_MODE", "models")
	rejected := filepath.Join(t.TempDir(), "incompatible-codex")

	driver := New(Options{})
	rejections := 0
	driver.candidateValidator = func(
		_ context.Context,
		candidate executableCandidate,
	) (string, error) {
		if candidate.Path == rejected {
			rejections++
			return candidate.Path + " incompatible", errors.New("incompatible")
		}
		return "", nil
	}
	driver.candidateSource = func() []executableCandidate {
		return []executableCandidate{
			{Path: rejected, Source: "path"},
			{Path: rejected, Source: "duplicate-path"},
			{
				Path:       os.Args[0],
				ArgsPrefix: []string{"-test.run=TestCodexAppServerHelper", "--"},
				Source:     "desktop",
			},
		}
	}

	probe, err := driver.Probe(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !probe.Available || probe.Path != os.Args[0] {
		t.Fatalf("probe = %#v", probe)
	}
	if probe.Version != "codex-test 9.9.0" {
		t.Fatalf("version = %q", probe.Version)
	}
	if !strings.Contains(probe.Diagnostic, rejected) ||
		!strings.Contains(probe.Diagnostic, "incompatible") {
		t.Fatalf("probe diagnostic = %q", probe.Diagnostic)
	}

	models, err := driver.DetectModels(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if models.Default != "gpt-codex-default" || len(models.Models) != 2 {
		t.Fatalf("model result = %#v", models)
	}

	session, err := driver.Start(context.Background(), runtimeapi.StartRequest{
		AgentID:          "agent-candidate-selection",
		LaunchID:         "launch-candidate-selection",
		WorkingDirectory: t.TempDir(),
		Environment:      map[string]string{"VELA_CODEX_HELPER": "1"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := session.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}

	if rejections != 3 {
		t.Fatalf("rejected candidate validations = %d, want 3", rejections)
	}
}

func TestDriverDiscoversCodexBundledWithChatGPT(t *testing.T) {
	const bundledCodex = "/Applications/ChatGPT.app/Contents/Resources/codex"
	if info, err := os.Stat(bundledCodex); err != nil || info.IsDir() {
		t.Skip("ChatGPT bundled Codex is not installed")
	}
	t.Setenv("PATH", t.TempDir())

	candidates := New(Options{}).executableCandidates()
	for _, candidate := range candidates {
		if candidate.Path == bundledCodex {
			return
		}
	}
	t.Fatalf("ChatGPT bundled Codex missing from candidates: %#v", candidates)
}

func TestDriverExecutableCandidatesReportEveryRejection(t *testing.T) {
	first := filepath.Join(t.TempDir(), "first-codex")
	second := filepath.Join(t.TempDir(), "second-codex")
	driver := New(Options{})
	driver.candidateValidator = func(
		_ context.Context,
		candidate executableCandidate,
	) (string, error) {
		switch candidate.Path {
		case first:
			return first + " first-rejection", errors.New("first-rejection")
		case second:
			return second + " second-rejection", errors.New("second-rejection")
		default:
			return "", nil
		}
	}
	driver.candidateSource = func() []executableCandidate {
		return []executableCandidate{
			{Path: first, Source: "path"},
			{Path: second, Source: "desktop"},
		}
	}

	probe, err := driver.Probe(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if probe.Available {
		t.Fatalf("probe = %#v", probe)
	}
	for _, fragment := range []string{
		first, "first-rejection", second, "second-rejection",
	} {
		if !strings.Contains(probe.Diagnostic, fragment) {
			t.Fatalf("probe diagnostic %q does not contain %q", probe.Diagnostic, fragment)
		}
	}
	_, err = driver.Start(context.Background(), runtimeapi.StartRequest{
		WorkingDirectory: t.TempDir(),
	})
	if err == nil {
		t.Fatal("Start succeeded with no compatible Codex candidate")
	}
	for _, fragment := range []string{first, second} {
		if !strings.Contains(err.Error(), fragment) {
			t.Fatalf("Start error %q does not contain %q", err, fragment)
		}
	}
}

func TestDriverDetectsPaginatedCodexAppServerModels(t *testing.T) {
	t.Setenv("VELA_CODEX_HELPER", "1")
	t.Setenv("VELA_CODEX_HELPER_MODE", "models")

	driver := New(Options{
		Executable: os.Args[0],
		ArgsPrefix: []string{"-test.run=TestCodexAppServerHelper", "--"},
	})
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	result, err := driver.DetectModels(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if result.Default != "gpt-codex-default" || len(result.Models) != 2 {
		t.Fatalf("model result = %#v", result)
	}
	if !reflect.DeepEqual(result.Models[0], runtimeapi.Model{
		ID:                        "gpt-codex-default",
		Label:                     "Codex Default",
		Verified:                  "launchable",
		SupportedReasoningEfforts: []string{"low", "high"},
		DefaultReasoningEffort:    "high",
		ServiceTiers:              []string{"fast", "standard"},
		DefaultServiceTier:        "standard",
	}) {
		t.Fatalf("default model = %#v", result.Models[0])
	}
	if !reflect.DeepEqual(result.Models[1], runtimeapi.Model{
		ID:       "gpt-codex-fast",
		Label:    "Codex Fast",
		Verified: "launchable",
	}) {
		t.Fatalf("second model = %#v", result.Models[1])
	}
}

func TestDriverFallsBackToCodexCacheWhenAppServerHasNoUsableModels(
	t *testing.T,
) {
	home := t.TempDir()
	writeCodexModelCacheFixture(t, home)
	t.Setenv("CODEX_HOME", home)
	t.Setenv("VELA_CODEX_HELPER", "1")
	t.Setenv("VELA_CODEX_HELPER_MODE", "models-empty")

	driver := New(Options{
		Executable: os.Args[0],
		ArgsPrefix: []string{"-test.run=TestCodexAppServerHelper", "--"},
	})
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	result, err := driver.DetectModels(ctx)
	if err != nil {
		t.Fatal(err)
	}
	assertCodexModelCacheFixture(t, result)
}

func TestDetectCodexModelsFromCachePreservesObservedSemantics(t *testing.T) {
	home := t.TempDir()
	nested := filepath.Join(home, ".codex")
	if err := os.MkdirAll(nested, 0o700); err != nil {
		t.Fatal(err)
	}
	writeCodexModelCache(t, nested, map[string]any{
		"models": []map[string]any{{
			"slug":         "nested-must-not-win",
			"display_name": "Nested",
		}},
	}, "model = \"nested-must-not-win\"\n")
	writeCodexModelCache(t, home, map[string]any{
		"models": []map[string]any{
			{"slug": "duplicate", "display_name": "First"},
			{"slug": "duplicate", "display_name": "Second"},
			{"slug": " spaced ", "display_name": " "},
			{"slug": "zero-visibility", "visibility": 0},
			{"slug": "empty-visibility", "visibility": ""},
			{"slug": "null-visibility", "visibility": nil},
			{"slug": "array-private", "visibility": []any{}},
			{"slug": "object-private", "visibility": map[string]any{}},
			{"slug": "boolean-private", "visibility": true},
			{"slug": "strict-api", "supported_in_api": 0},
			{"slug": "api-disabled", "supported_in_api": false},
			{"slug": ""},
		},
	}, " # before\n\tmodel = \"outside-eligible-list\"\n")

	result, ok := detectCodexModelsFromCache(home)
	if !ok {
		t.Fatal("root cache was not detected")
	}
	want := runtimeapi.ModelResult{
		Models: []runtimeapi.Model{
			{ID: "duplicate", Label: "First", Verified: "launchable"},
			{ID: "duplicate", Label: "Second", Verified: "launchable"},
			{ID: " spaced ", Label: " ", Verified: "launchable"},
			{ID: "zero-visibility", Label: "zero-visibility", Verified: "launchable"},
			{ID: "empty-visibility", Label: "empty-visibility", Verified: "launchable"},
			{ID: "null-visibility", Label: "null-visibility", Verified: "launchable"},
			{ID: "strict-api", Label: "strict-api", Verified: "launchable"},
		},
		Default: "outside-eligible-list",
	}
	if !reflect.DeepEqual(result, want) {
		t.Fatalf("cached model result = %#v, want %#v", result, want)
	}
}

func TestDetectCodexModelsFromCacheUsesNestedRootOnlyWhenPrimaryIsAbsent(
	t *testing.T,
) {
	home := t.TempDir()
	nested := filepath.Join(home, ".codex")
	if err := os.MkdirAll(nested, 0o700); err != nil {
		t.Fatal(err)
	}
	writeCodexModelCache(t, nested, map[string]any{
		"models": []map[string]any{{"slug": "nested"}},
	}, "")
	result, ok := detectCodexModelsFromCache(home)
	if !ok || len(result.Models) != 1 || result.Models[0].ID != "nested" ||
		result.Default != "" {
		t.Fatalf("nested cache result = %#v, ok = %t", result, ok)
	}
}

func TestDetectCodexModelsFromCacheDoesNotSkipMalformedPrimary(t *testing.T) {
	home := t.TempDir()
	nested := filepath.Join(home, ".codex")
	if err := os.MkdirAll(nested, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(
		filepath.Join(home, "models_cache.json"),
		[]byte(`{"models":`),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	writeCodexModelCache(t, nested, map[string]any{
		"models": []map[string]any{{"slug": "nested"}},
	}, "model = \"nested\"\n")
	if result, ok := detectCodexModelsFromCache(home); ok {
		t.Fatalf("malformed primary cache result = %#v", result)
	}
}

func TestDriverReturnsUnsupportedWhenModelDiscoveryIsExhausted(t *testing.T) {
	t.Setenv("CODEX_HOME", t.TempDir())
	t.Setenv("VELA_CODEX_HELPER", "1")
	t.Setenv("VELA_CODEX_HELPER_MODE", "models-empty")
	driver := New(Options{
		Executable: os.Args[0],
		ArgsPrefix: []string{"-test.run=TestCodexAppServerHelper", "--"},
	})
	result, err := driver.DetectModels(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !result.Unsupported || len(result.Models) != 0 || result.Default != "" {
		t.Fatalf("exhausted discovery result = %#v", result)
	}
}

func TestDriverFallsBackToCacheWhenNoExecutableCandidateValidates(t *testing.T) {
	home := t.TempDir()
	writeCodexModelCacheFixture(t, home)
	t.Setenv("CODEX_HOME", home)
	rejected := filepath.Join(t.TempDir(), "incompatible-codex")
	driver := New(Options{})
	driver.candidateValidator = func(
		context.Context,
		executableCandidate,
	) (string, error) {
		return rejected + " incompatible", errors.New("incompatible")
	}
	driver.candidateSource = func() []executableCandidate {
		return []executableCandidate{{Path: rejected, Source: "configured"}}
	}
	result, err := driver.DetectModels(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	assertCodexModelCacheFixture(t, result)
}

func TestDriverPrefersUsableAppServerModelsOverCache(t *testing.T) {
	home := t.TempDir()
	writeCodexModelCacheFixture(t, home)
	t.Setenv("CODEX_HOME", home)
	t.Setenv("VELA_CODEX_HELPER", "1")
	t.Setenv("VELA_CODEX_HELPER_MODE", "models")
	driver := New(Options{
		Executable: os.Args[0],
		ArgsPrefix: []string{"-test.run=TestCodexAppServerHelper", "--"},
	})
	result, err := driver.DetectModels(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.Default != "gpt-codex-default" || len(result.Models) != 2 {
		t.Fatalf("app-server result = %#v", result)
	}
}

func TestDriverModelDiscoveryIgnoresServerRequestMatchingPendingID(t *testing.T) {
	t.Setenv("VELA_CODEX_HELPER", "1")
	t.Setenv("VELA_CODEX_HELPER_MODE", "models-server-request")

	driver := New(Options{
		Executable: os.Args[0],
		ArgsPrefix: []string{"-test.run=TestCodexAppServerHelper", "--"},
	})
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	result, err := driver.DetectModels(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if result.Default != "gpt-codex-default" || len(result.Models) != 2 {
		t.Fatalf("model result = %#v", result)
	}
}

func TestDriverModelDiscoveryFallsBackAfterIncompatibleInitialize(t *testing.T) {
	home := t.TempDir()
	writeCodexModelCacheFixture(t, home)
	t.Setenv("CODEX_HOME", home)
	t.Setenv("VELA_CODEX_HELPER", "1")
	t.Setenv("VELA_CODEX_HELPER_MODE", "initialize-whitespace-user-agent")

	driver := New(Options{
		Executable: os.Args[0],
		ArgsPrefix: []string{"-test.run=TestCodexAppServerHelper", "--"},
	})
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	result, err := driver.DetectModels(ctx)
	if err != nil {
		t.Fatal(err)
	}
	assertCodexModelCacheFixture(t, result)
}

func TestDriverModelDiscoveryHonorsContextDeadline(t *testing.T) {
	t.Setenv("VELA_CODEX_HELPER", "1")
	t.Setenv("VELA_CODEX_HELPER_MODE", "models-hang")

	driver := New(Options{
		Executable: os.Args[0],
		ArgsPrefix: []string{"-test.run=TestCodexAppServerHelper", "--"},
	})
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	_, err := driver.DetectModels(ctx)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("DetectModels() error = %v, want deadline exceeded", err)
	}
}

func TestDriverModelDiscoveryFallsBackAfterMalformedModelList(t *testing.T) {
	home := t.TempDir()
	writeCodexModelCacheFixture(t, home)
	t.Setenv("CODEX_HOME", home)
	t.Setenv("VELA_CODEX_HELPER", "1")
	t.Setenv("VELA_CODEX_HELPER_MODE", "models-malformed")

	driver := New(Options{
		Executable: os.Args[0],
		ArgsPrefix: []string{"-test.run=TestCodexAppServerHelper", "--"},
	})
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	result, err := driver.DetectModels(ctx)
	if err != nil {
		t.Fatal(err)
	}
	assertCodexModelCacheFixture(t, result)
}

func TestDriverSuppressesNonFinalAgentMessageDelta(t *testing.T) {
	t.Parallel()

	driver := New(Options{
		Executable: os.Args[0],
		ArgsPrefix: []string{"-test.run=TestCodexAppServerHelper", "--"},
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	session, err := driver.Start(ctx, runtimeapi.StartRequest{
		AgentID:          "agent-1",
		LaunchID:         "launch-phase",
		WorkingDirectory: t.TempDir(),
		Prompt:           "start",
		Environment: map[string]string{
			"VELA_CODEX_HELPER":      "1",
			"VELA_CODEX_HELPER_MODE": "non-final-agent-message",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer session.Stop(context.Background())

	message := waitForRuntimeEvent(
		t,
		session.Events(),
		runtimeapi.EventAssistantText,
	)
	if message.Text != "hello from fake Codex" {
		t.Fatalf("first visible assistant message = %#v", message)
	}
}

func TestSessionNormalizesCompactionAndReviewBoundaries(t *testing.T) {
	t.Parallel()

	session := &session{
		events:   make(chan runtimeapi.Event, 4),
		done:     make(chan struct{}),
		launchID: "launch-1",
	}
	for _, item := range []struct {
		method string
		kind   string
		want   runtimeapi.EventKind
	}{
		{
			method: "item/started",
			kind:   "contextCompaction",
			want:   runtimeapi.EventCompactionStarted,
		},
		{
			method: "item/completed",
			kind:   "contextCompaction",
			want:   runtimeapi.EventCompactionFinished,
		},
		{
			method: "item/started",
			kind:   "enteredReviewMode",
			want:   runtimeapi.EventReviewStarted,
		},
		{
			method: "item/completed",
			kind:   "exitedReviewMode",
			want:   runtimeapi.EventReviewFinished,
		},
	} {
		params, err := common.Marshal(map[string]any{
			"item": map[string]any{"type": item.kind},
		})
		if err != nil {
			t.Fatal(err)
		}
		session.normalize(rpcMessage{
			Method: item.method,
			Params: params,
		}, params)
		select {
		case event := <-session.events:
			if event.Kind != item.want || event.LaunchID != "launch-1" {
				t.Fatalf("%s/%s event = %#v", item.method, item.kind, event)
			}
		default:
			t.Fatalf("%s/%s did not emit an event", item.method, item.kind)
		}
	}
}

func TestSessionRestoresCompletedItemsWhenNoDeltaWasObserved(t *testing.T) {
	t.Parallel()

	session := newNormalizationTestSession()
	session.setSessionID("thread-primary")
	reasoning := mustCodexParams(t, map[string]any{
		"threadId": "thread-primary",
		"item": map[string]any{
			"id":      "reasoning-1",
			"type":    "reasoning",
			"summary": []string{"first", "second"},
		},
	})
	session.normalize(rpcMessage{
		Method: "item/completed",
		Params: reasoning,
	}, reasoning)
	if event := <-session.events; event.Kind != runtimeapi.EventThinking ||
		event.Text != "first\nsecond" {
		t.Fatalf("completed reasoning = %#v", event)
	}

	message := mustCodexParams(t, map[string]any{
		"threadId": "thread-primary",
		"item": map[string]any{
			"id":    "message-1",
			"type":  "agentMessage",
			"phase": "final_answer",
			"text":  "completed answer",
		},
	})
	session.normalize(rpcMessage{
		Method: "item/completed",
		Params: message,
	}, message)
	if event := <-session.events; event.Kind != runtimeapi.EventAssistantText ||
		event.Text != "completed answer" {
		t.Fatalf("completed message = %#v", event)
	}

	commentary := mustCodexParams(t, map[string]any{
		"threadId": "thread-primary",
		"item": map[string]any{
			"id":    "message-hidden",
			"type":  "agentMessage",
			"phase": "commentary",
			"text":  "hidden but live",
		},
	})
	session.normalize(rpcMessage{
		Method: "item/completed",
		Params: commentary,
	}, commentary)
	if event := <-session.events; event.Kind != runtimeapi.EventUsage {
		t.Fatalf("suppressed completed message progress = %#v", event)
	}
}

func TestSessionDoesNotDuplicateStreamedCompletedItems(t *testing.T) {
	t.Parallel()

	session := newNormalizationTestSession()
	session.setSessionID("thread-primary")
	delta := mustCodexParams(t, map[string]any{
		"threadId": "thread-primary",
		"itemId":   "message-1",
		"phase":    "final_answer",
		"delta":    "streamed",
	})
	session.normalize(rpcMessage{
		Method: "item/agentMessage/delta",
		Params: delta,
	}, delta)
	if event := <-session.events; event.Kind != runtimeapi.EventAssistantText ||
		event.Text != "streamed" {
		t.Fatalf("streamed message = %#v", event)
	}
	completed := mustCodexParams(t, map[string]any{
		"threadId": "thread-primary",
		"item": map[string]any{
			"id":    "message-1",
			"type":  "agentMessage",
			"phase": "final_answer",
			"text":  "streamed",
		},
	})
	session.normalize(rpcMessage{
		Method: "item/completed",
		Params: completed,
	}, completed)
	select {
	case event := <-session.events:
		t.Fatalf("completed item duplicated streamed output: %#v", event)
	default:
	}
}

func TestSessionDoesNotCarryDeltaLocalPhaseIntoLaterDelta(t *testing.T) {
	t.Parallel()

	session := newNormalizationTestSession()
	session.setSessionID("thread-primary")
	commentary := mustCodexParams(t, map[string]any{
		"threadId": "thread-primary",
		"itemId":   "message-delta-phase",
		"phase":    "commentary",
		"delta":    "hidden commentary",
	})
	session.normalize(rpcMessage{
		Method: "item/agentMessage/delta",
		Params: commentary,
	}, commentary)
	if event := <-session.events; event.Kind != runtimeapi.EventUsage {
		t.Fatalf("commentary delta progress = %#v", event)
	}

	visible := mustCodexParams(t, map[string]any{
		"threadId": "thread-primary",
		"itemId":   "message-delta-phase",
		"delta":    "visible phase-less answer",
	})
	session.normalize(rpcMessage{
		Method: "item/agentMessage/delta",
		Params: visible,
	}, visible)
	if event := <-session.events; event.Kind != runtimeapi.EventAssistantText ||
		event.Text != "visible phase-less answer" {
		t.Fatalf("phase-less delta after commentary = %#v", event)
	}
}

func TestSessionClearsStartedAgentMessagePhaseOnPhaseLessRestart(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		phase map[string]any
	}{
		{name: "absent", phase: map[string]any{}},
		{name: "empty", phase: map[string]any{"phase": ""}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			session := newNormalizationTestSession()
			session.setSessionID("thread-primary")
			first := mustCodexParams(t, map[string]any{
				"threadId": "thread-primary",
				"item": map[string]any{
					"id":    "message-restarted-phase",
					"type":  "agentMessage",
					"phase": "commentary",
				},
			})
			session.normalize(rpcMessage{
				Method: "item/started",
				Params: first,
			}, first)

			restartedItem := map[string]any{
				"id":   "message-restarted-phase",
				"type": "agentMessage",
			}
			for key, value := range test.phase {
				restartedItem[key] = value
			}
			restarted := mustCodexParams(t, map[string]any{
				"threadId": "thread-primary",
				"item":     restartedItem,
			})
			session.normalize(rpcMessage{
				Method: "item/started",
				Params: restarted,
			}, restarted)

			delta := mustCodexParams(t, map[string]any{
				"threadId": "thread-primary",
				"itemId":   "message-restarted-phase",
				"delta":    "visible after phase-less restart",
			})
			session.normalize(rpcMessage{
				Method: "item/agentMessage/delta",
				Params: delta,
			}, delta)
			if event := <-session.events; event.Kind != runtimeapi.EventAssistantText ||
				event.Text != "visible after phase-less restart" {
				t.Fatalf("phase-less restarted message delta = %#v", event)
			}
		})
	}
}

func TestSessionDoesNotInheritStartedPhaseForCompletedAgentMessage(t *testing.T) {
	t.Parallel()

	session := newNormalizationTestSession()
	session.setSessionID("thread-primary")
	started := mustCodexParams(t, map[string]any{
		"threadId": "thread-primary",
		"item": map[string]any{
			"id":    "message-completed-phase",
			"type":  "agentMessage",
			"phase": "commentary",
		},
	})
	session.normalize(rpcMessage{
		Method: "item/started",
		Params: started,
	}, started)
	select {
	case event := <-session.events:
		t.Fatalf("started agent message emitted output: %#v", event)
	default:
	}

	completed := mustCodexParams(t, map[string]any{
		"threadId": "thread-primary",
		"item": map[string]any{
			"id":   "message-completed-phase",
			"type": "agentMessage",
			"text": "visible phase-less completed answer",
		},
	})
	session.normalize(rpcMessage{
		Method: "item/completed",
		Params: completed,
	}, completed)
	if event := <-session.events; event.Kind != runtimeapi.EventAssistantText ||
		event.Text != "visible phase-less completed answer" {
		t.Fatalf("phase-less completed message after commentary start = %#v", event)
	}
}

func TestSessionDoesNotRestoreCompletedItemAfterEmptyDeltaNotification(t *testing.T) {
	t.Parallel()

	session := newNormalizationTestSession()
	session.setSessionID("thread-primary")
	delta := mustCodexParams(t, map[string]any{
		"threadId": "thread-primary",
		"itemId":   "message-empty-delta",
		"phase":    "final_answer",
		"delta":    "",
	})
	session.normalize(rpcMessage{
		Method: "item/agentMessage/delta",
		Params: delta,
	}, delta)
	select {
	case event := <-session.events:
		t.Fatalf("empty delta emitted output: %#v", event)
	default:
	}

	completed := mustCodexParams(t, map[string]any{
		"threadId": "thread-primary",
		"item": map[string]any{
			"id":    "message-empty-delta",
			"type":  "agentMessage",
			"phase": "final_answer",
			"text":  "completed fallback must stay suppressed",
		},
	})
	session.normalize(rpcMessage{
		Method: "item/completed",
		Params: completed,
	}, completed)
	select {
	case event := <-session.events:
		t.Fatalf("completed item duplicated empty streamed notification: %#v", event)
	default:
	}
}

func TestSessionDoesNotRestoreCompletedReasoningAfterEmptySummaryDelta(t *testing.T) {
	t.Parallel()

	session := newNormalizationTestSession()
	session.setSessionID("thread-primary")
	delta := mustCodexParams(t, map[string]any{
		"threadId": "thread-primary",
		"itemId":   "reasoning-empty-delta",
		"delta":    "",
	})
	session.normalize(rpcMessage{
		Method: "item/reasoning/summaryTextDelta",
		Params: delta,
	}, delta)
	select {
	case event := <-session.events:
		t.Fatalf("empty reasoning delta emitted output: %#v", event)
	default:
	}

	completed := mustCodexParams(t, map[string]any{
		"threadId": "thread-primary",
		"item": map[string]any{
			"id":      "reasoning-empty-delta",
			"type":    "reasoning",
			"summary": []string{"completed reasoning must stay suppressed"},
		},
	})
	session.normalize(rpcMessage{
		Method: "item/completed",
		Params: completed,
	}, completed)
	select {
	case event := <-session.events:
		t.Fatalf("completed reasoning duplicated empty streamed notification: %#v", event)
	default:
	}
}

func TestSessionIgnoresEmptyReasoningTextDeltaForTurnEvidence(t *testing.T) {
	t.Parallel()

	session := newNormalizationTestSession()
	session.setSessionID("thread-primary")
	started := mustCodexParams(t, map[string]any{
		"threadId": "thread-primary",
		"turn":     map[string]any{"id": "turn-empty-reasoning-text"},
	})
	session.normalize(rpcMessage{
		Method: "turn/started",
		Params: started,
	}, started)
	if event := <-session.events; event.Kind != runtimeapi.EventThinking {
		t.Fatalf("turn start = %#v", event)
	}

	delta := mustCodexParams(t, map[string]any{
		"threadId": "thread-primary",
		"turnId":   "turn-empty-reasoning-text",
		"itemId":   "reasoning-text-empty-delta",
		"delta":    "",
	})
	session.normalize(rpcMessage{
		Method: "item/reasoning/textDelta",
		Params: delta,
	}, delta)
	select {
	case event := <-session.events:
		t.Fatalf("empty reasoning text delta emitted output: %#v", event)
	default:
	}

	completed := mustCodexParams(t, map[string]any{
		"threadId": "thread-primary",
		"turn": map[string]any{
			"id":     "turn-empty-reasoning-text",
			"status": "completed",
		},
	})
	session.normalize(rpcMessage{
		Method: "turn/completed",
		Params: completed,
	}, completed)
	if diagnostic := <-session.events; diagnostic.Kind != runtimeapi.EventDiagnostic ||
		diagnostic.Name != "Codex warning" {
		t.Fatalf("empty reasoning text diagnostic = %#v", diagnostic)
	}
	if runtimeError := <-session.events; runtimeError.Kind != runtimeapi.EventError ||
		runtimeError.Text != "Codex runtime completed without a response. Please retry. (codex_zero_evidence_turn_completed)" {
		t.Fatalf("empty reasoning text error = %#v", runtimeError)
	}
	if turnEnd := <-session.events; turnEnd.Kind != runtimeapi.EventTurnCompletion ||
		turnEnd.TurnID != "turn-empty-reasoning-text" {
		t.Fatalf("empty reasoning text completion = %#v", turnEnd)
	}
}

func TestSessionIgnoresCompletedReasoningWithoutSummaryForTurnEvidence(t *testing.T) {
	t.Parallel()

	session := newNormalizationTestSession()
	session.setSessionID("thread-primary")
	started := mustCodexParams(t, map[string]any{
		"threadId": "thread-primary",
		"turn":     map[string]any{"id": "turn-empty-reasoning-item"},
	})
	session.normalize(rpcMessage{
		Method: "turn/started",
		Params: started,
	}, started)
	if event := <-session.events; event.Kind != runtimeapi.EventThinking {
		t.Fatalf("turn start = %#v", event)
	}

	reasoning := mustCodexParams(t, map[string]any{
		"threadId": "thread-primary",
		"turnId":   "turn-empty-reasoning-item",
		"item": map[string]any{
			"id":      "reasoning-empty-item",
			"type":    "reasoning",
			"summary": []string{},
		},
	})
	session.normalize(rpcMessage{
		Method: "item/completed",
		Params: reasoning,
	}, reasoning)
	select {
	case event := <-session.events:
		t.Fatalf("empty completed reasoning emitted output: %#v", event)
	default:
	}

	completed := mustCodexParams(t, map[string]any{
		"threadId": "thread-primary",
		"turn": map[string]any{
			"id":     "turn-empty-reasoning-item",
			"status": "completed",
		},
	})
	session.normalize(rpcMessage{
		Method: "turn/completed",
		Params: completed,
	}, completed)
	if diagnostic := <-session.events; diagnostic.Kind != runtimeapi.EventDiagnostic ||
		diagnostic.Name != "Codex warning" {
		t.Fatalf("empty completed reasoning diagnostic = %#v", diagnostic)
	}
	if runtimeError := <-session.events; runtimeError.Kind != runtimeapi.EventError ||
		runtimeError.Text != "Codex runtime completed without a response. Please retry. (codex_zero_evidence_turn_completed)" {
		t.Fatalf("empty completed reasoning error = %#v", runtimeError)
	}
	if turnEnd := <-session.events; turnEnd.Kind != runtimeapi.EventTurnCompletion ||
		turnEnd.TurnID != "turn-empty-reasoning-item" {
		t.Fatalf("empty completed reasoning turn completion = %#v", turnEnd)
	}
}

func TestSessionFansOutFileChangesAndUsesSpecificToolNames(t *testing.T) {
	t.Parallel()

	session := newNormalizationTestSession()
	started := mustCodexParams(t, map[string]any{
		"item": map[string]any{
			"id":   "change-1",
			"type": "fileChange",
			"changes": []map[string]any{
				{"path": "a.txt", "kind": "update"},
				{"path": "b.txt", "kind": "create"},
			},
		},
	})
	session.normalize(rpcMessage{
		Method: "item/started",
		Params: started,
	}, started)
	for index := 0; index < 2; index++ {
		if event := <-session.events; event.Kind != runtimeapi.EventToolCall ||
			event.Name != "file_change" {
			t.Fatalf("file change call %d = %#v", index, event)
		}
	}
	completed := mustCodexParams(t, map[string]any{
		"item": map[string]any{
			"id":   "change-1",
			"type": "fileChange",
		},
	})
	session.normalize(rpcMessage{
		Method: "item/completed",
		Params: completed,
	}, completed)
	for index := 0; index < 2; index++ {
		if event := <-session.events; event.Kind != runtimeapi.EventToolOutput ||
			event.Name != "file_change" {
			t.Fatalf("file change output %d = %#v", index, event)
		}
	}

	mcp := mustCodexParams(t, map[string]any{
		"item": map[string]any{
			"id":        "mcp-1",
			"type":      "mcpToolCall",
			"server":    "github",
			"tool":      "search",
			"arguments": map[string]any{"query": "fixture"},
		},
	})
	session.normalize(rpcMessage{
		Method: "item/started",
		Params: mcp,
	}, mcp)
	if event := <-session.events; event.Kind != runtimeapi.EventToolCall ||
		event.Name != "mcp_github_search" {
		t.Fatalf("MCP tool call = %#v", event)
	}
}

func TestSessionIgnoresEmptyFileChangeForTurnEvidence(t *testing.T) {
	t.Parallel()

	session := newNormalizationTestSession()
	session.setSessionID("thread-primary")
	startedTurn := mustCodexParams(t, map[string]any{
		"threadId": "thread-primary",
		"turn":     map[string]any{"id": "turn-empty-file-change"},
	})
	session.normalize(rpcMessage{
		Method: "turn/started",
		Params: startedTurn,
	}, startedTurn)
	if event := <-session.events; event.Kind != runtimeapi.EventThinking {
		t.Fatalf("turn start = %#v", event)
	}

	startedItem := mustCodexParams(t, map[string]any{
		"threadId": "thread-primary",
		"turnId":   "turn-empty-file-change",
		"item": map[string]any{
			"id":      "file-change-empty",
			"type":    "fileChange",
			"changes": []map[string]any{},
		},
	})
	session.normalize(rpcMessage{
		Method: "item/started",
		Params: startedItem,
	}, startedItem)
	select {
	case event := <-session.events:
		t.Fatalf("empty file-change start emitted output: %#v", event)
	default:
	}

	completedItem := mustCodexParams(t, map[string]any{
		"threadId": "thread-primary",
		"turnId":   "turn-empty-file-change",
		"item": map[string]any{
			"id":      "file-change-empty",
			"type":    "fileChange",
			"changes": []map[string]any{},
		},
	})
	session.normalize(rpcMessage{
		Method: "item/completed",
		Params: completedItem,
	}, completedItem)
	select {
	case event := <-session.events:
		t.Fatalf("empty file-change completion emitted output: %#v", event)
	default:
	}

	completedTurn := mustCodexParams(t, map[string]any{
		"threadId": "thread-primary",
		"turn": map[string]any{
			"id":     "turn-empty-file-change",
			"status": "completed",
		},
	})
	session.normalize(rpcMessage{
		Method: "turn/completed",
		Params: completedTurn,
	}, completedTurn)
	if diagnostic := <-session.events; diagnostic.Kind != runtimeapi.EventDiagnostic ||
		diagnostic.Name != "Codex warning" {
		t.Fatalf("empty file-change diagnostic = %#v", diagnostic)
	}
	if runtimeError := <-session.events; runtimeError.Kind != runtimeapi.EventError ||
		runtimeError.Text != "Codex runtime completed without a response. Please retry. (codex_zero_evidence_turn_completed)" {
		t.Fatalf("empty file-change error = %#v", runtimeError)
	}
	if turnEnd := <-session.events; turnEnd.Kind != runtimeapi.EventTurnCompletion ||
		turnEnd.TurnID != "turn-empty-file-change" {
		t.Fatalf("empty file-change turn completion = %#v", turnEnd)
	}
}

func TestSessionSuppressesSecondaryThreadOutput(t *testing.T) {
	t.Parallel()

	session := newNormalizationTestSession()
	session.setSessionID("thread-primary")
	params := mustCodexParams(t, map[string]any{
		"threadId": "thread-secondary",
		"itemId":   "message-secondary",
		"phase":    "final_answer",
		"delta":    "must stay hidden",
	})
	session.normalize(rpcMessage{
		Method: "item/agentMessage/delta",
		Params: params,
	}, params)
	select {
	case event := <-session.events:
		t.Fatalf("secondary thread output escaped: %#v", event)
	default:
	}
}

func TestSessionUsesLowerPriorityIdentityAfterInvalidThreadID(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		threadID   any
		thread     any
		sessionID  string
		suppressed bool
	}{
		{
			name:       "numeric thread ID falls through to nested thread",
			threadID:   42,
			thread:     map[string]any{"id": "thread-secondary"},
			suppressed: true,
		},
		{
			name:       "boolean thread ID falls through to session",
			threadID:   true,
			sessionID:  "thread-secondary",
			suppressed: true,
		},
		{
			name:       "invalid nested thread falls through to session",
			threadID:   nil,
			thread:     42,
			sessionID:  "thread-secondary",
			suppressed: true,
		},
		{
			name:       "empty thread ID falls through to nested thread",
			threadID:   "",
			thread:     map[string]any{"id": "thread-secondary"},
			suppressed: true,
		},
		{
			name:      "valid primary thread overrides nested secondary",
			threadID:  "thread-primary",
			thread:    map[string]any{"id": "thread-secondary"},
			sessionID: "thread-secondary-session",
		},
		{
			name:     "invalid identity without fallback remains unscoped",
			threadID: 42,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			payload := map[string]any{
				"threadId": test.threadID,
				"itemId":   "message-identity-fallback",
				"phase":    "final_answer",
				"delta":    "identity fallback output",
			}
			if test.thread != nil {
				payload["thread"] = test.thread
			}
			if test.sessionID != "" {
				payload["sessionId"] = test.sessionID
			}
			params := mustCodexParams(t, payload)
			session := newNormalizationTestSession()
			session.setSessionID("thread-primary")
			session.normalize(rpcMessage{
				Method: "item/agentMessage/delta",
				Params: params,
			}, params)

			select {
			case event := <-session.events:
				if test.suppressed {
					t.Fatalf("secondary identity fallback escaped: %#v", event)
				}
				if event.Kind != runtimeapi.EventAssistantText ||
					event.Text != "identity fallback output" {
					t.Fatalf("unscoped/primary identity output = %#v", event)
				}
			default:
				if !test.suppressed {
					t.Fatal("primary or unscoped identity output was suppressed")
				}
			}
		})
	}
}

func TestSessionAdoptsUnclaimedThreadResultBeforeSecondaryFiltering(t *testing.T) {
	t.Parallel()

	session := newNormalizationTestSession()
	session.setSessionID("thread-primary")
	result := mustCodexParams(t, map[string]any{
		"thread": map[string]any{"id": "thread-adopted-result"},
	})
	session.normalize(rpcMessage{
		ID:     json.RawMessage(`997`),
		Result: result,
	}, result)
	select {
	case event := <-session.events:
		t.Fatalf("adopted thread result repeated session output: %#v", event)
	default:
	}

	delta := mustCodexParams(t, map[string]any{
		"threadId": "thread-adopted-result",
		"itemId":   "message-adopted-result",
		"phase":    "final_answer",
		"delta":    "output from adopted thread",
	})
	session.normalize(rpcMessage{
		Method: "item/agentMessage/delta",
		Params: delta,
	}, delta)
	select {
	case event := <-session.events:
		if event.Kind != runtimeapi.EventAssistantText ||
			event.Text != "output from adopted thread" {
			t.Fatalf("adopted thread output = %#v", event)
		}
	default:
		t.Fatal("output from adopted result thread was suppressed as secondary")
	}
}

func TestSessionAnnouncesFirstUnclaimedThreadResult(t *testing.T) {
	t.Parallel()

	session := newNormalizationTestSession()
	result := mustCodexParams(t, map[string]any{
		"thread": map[string]any{"id": "thread-first-unclaimed-result"},
	})
	session.normalize(rpcMessage{
		ID:     json.RawMessage(`996`),
		Result: result,
	}, result)

	select {
	case event := <-session.events:
		if event.Kind != runtimeapi.EventSession ||
			event.SessionID != "thread-first-unclaimed-result" {
			t.Fatalf("first unclaimed thread result = %#v", event)
		}
	default:
		t.Fatal("first unclaimed thread result did not announce the session")
	}
}

func TestSessionAnnouncesThreadReadyOnceAndFencesLaterSecondaryStarts(t *testing.T) {
	t.Parallel()

	session := newNormalizationTestSession()
	result := mustCodexParams(t, map[string]any{
		"thread": map[string]any{"id": "thread-first-ready"},
	})
	session.normalize(rpcMessage{
		ID:     json.RawMessage(`995`),
		Result: result,
	}, result)
	if first := <-session.events; first.Kind != runtimeapi.EventSession ||
		first.SessionID != "thread-first-ready" {
		t.Fatalf("first thread-ready event = %#v", first)
	}

	started := mustCodexParams(t, map[string]any{
		"thread": map[string]any{"id": "thread-later-started"},
	})
	session.normalize(rpcMessage{
		Method: "thread/started",
		Params: started,
	}, started)
	select {
	case duplicate := <-session.events:
		t.Fatalf("later thread/started repeated session output: %#v", duplicate)
	default:
	}
	if got := session.SessionID(); got != "thread-first-ready" {
		t.Fatalf("secondary thread/started changed current thread to %q", got)
	}
}

func TestSessionMatchesThreadStartedIdentityFilteringAndAdoption(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		payload  map[string]any
		expected string
	}{
		{
			name:     "empty nested ID clears current thread",
			payload:  map[string]any{"thread": map[string]any{"id": ""}},
			expected: "",
		},
		{
			name:     "absent nested ID is ignored",
			payload:  map[string]any{"thread": map[string]any{}},
			expected: "thread-primary",
		},
		{
			name:     "null nested ID is ignored",
			payload:  map[string]any{"thread": map[string]any{"id": nil}},
			expected: "thread-primary",
		},
		{
			name:     "numeric nested ID is ignored",
			payload:  map[string]any{"thread": map[string]any{"id": 42}},
			expected: "thread-primary",
		},
		{
			name: "different nested identity is fenced",
			payload: map[string]any{
				"thread": map[string]any{"id": "thread-secondary"},
			},
			expected: "thread-primary",
		},
		{
			name: "matching top-level identity authorizes nested adoption",
			payload: map[string]any{
				"threadId": "thread-primary",
				"thread":   map[string]any{"id": "thread-adopted"},
			},
			expected: "thread-adopted",
		},
		{
			name: "secondary top-level identity fences nested adoption",
			payload: map[string]any{
				"threadId": "thread-secondary",
				"thread":   map[string]any{"id": "thread-third"},
			},
			expected: "thread-primary",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			session := newNormalizationTestSession()
			session.setSessionID("thread-primary")
			params := mustCodexParams(t, test.payload)
			session.normalize(rpcMessage{
				Method: "thread/started",
				Params: params,
			}, params)
			select {
			case event := <-session.events:
				t.Fatalf("thread/started repeated session output: %#v", event)
			default:
			}
			if got := session.SessionID(); got != test.expected {
				t.Fatalf("thread/started adopted %q, want %q", got, test.expected)
			}
		})
	}
}

func TestSessionAcceptsNewIdentityOutputAfterEmptyThreadStarted(t *testing.T) {
	t.Parallel()

	session := newNormalizationTestSession()
	session.setSessionID("thread-primary")
	emptyStarted := mustCodexParams(t, map[string]any{
		"thread": map[string]any{"id": ""},
	})
	session.normalize(rpcMessage{
		Method: "thread/started",
		Params: emptyStarted,
	}, emptyStarted)

	delta := mustCodexParams(t, map[string]any{
		"threadId": "thread-after-empty",
		"itemId":   "message-after-empty",
		"phase":    "final_answer",
		"delta":    "output after empty thread started",
	})
	session.normalize(rpcMessage{
		Method: "item/agentMessage/delta",
		Params: delta,
	}, delta)
	select {
	case event := <-session.events:
		if event.Kind != runtimeapi.EventAssistantText ||
			event.Text != "output after empty thread started" {
			t.Fatalf("post-empty thread output = %#v", event)
		}
	default:
		t.Fatal("post-empty thread output was suppressed")
	}
	if got := session.SessionID(); got != "" {
		t.Fatalf("empty thread/started retained current thread %q", got)
	}
}

func TestSessionGatesBusySteeringAfterToolBoundaryUntilProgress(t *testing.T) {
	t.Parallel()

	session := newNormalizationTestSession()
	session.setSessionID("thread-primary")
	started := mustCodexParams(t, map[string]any{
		"turn": map[string]any{"id": "turn-1"},
	})
	session.normalize(rpcMessage{Method: "turn/started", Params: started}, started)
	<-session.events
	if !session.canSteerBusy() {
		t.Fatal("active turn should initially accept steering")
	}
	tool := mustCodexParams(t, map[string]any{
		"item": map[string]any{"id": "tool-1", "type": "commandExecution"},
	})
	session.normalize(rpcMessage{Method: "item/completed", Params: tool}, tool)
	<-session.events
	if session.canSteerBusy() {
		t.Fatal("post-tool boundary unexpectedly accepts steering")
	}
	progress := mustCodexParams(t, map[string]any{
		"itemId": "message-1",
		"phase":  "final_answer",
		"delta":  "continued",
	})
	session.normalize(rpcMessage{
		Method: "item/agentMessage/delta",
		Params: progress,
	}, progress)
	<-session.events
	if !session.canSteerBusy() {
		t.Fatal("new Runtime progress did not reopen steering")
	}
}

func TestSessionAdoptsUnclaimedTurnResultForIDlessStart(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		result map[string]any
	}{
		{
			name: "nested turn",
			result: map[string]any{
				"turn": map[string]any{"id": "turn-unclaimed-nested"},
			},
		},
		{
			name: "turnId alias",
			result: map[string]any{
				"turnId": "turn-unclaimed-alias",
			},
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			session := newNormalizationTestSession()
			session.setSessionID("thread-primary")
			result := mustCodexParams(t, test.result)
			session.normalize(rpcMessage{
				ID:     json.RawMessage(`995`),
				Result: result,
			}, result)
			select {
			case event := <-session.events:
				t.Fatalf("unclaimed turn result emitted output: %#v", event)
			default:
			}

			started := mustCodexParams(t, map[string]any{
				"threadId": "thread-primary",
				"turn":     map[string]any{},
			})
			session.normalize(rpcMessage{
				Method: "turn/started",
				Params: started,
			}, started)
			if event := <-session.events; event.Kind != runtimeapi.EventThinking {
				t.Fatalf("ID-less turn start = %#v", event)
			}
			if !session.canSteerBusy() {
				t.Fatal("ID-less start did not adopt the accepted turn for steering")
			}
		})
	}
}

func TestSessionPreservesActiveTurnAcrossFalsyRepeatedStart(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		turn map[string]any
	}{
		{
			name: "empty string ID",
			turn: map[string]any{"id": ""},
		},
		{
			name: "absent ID",
			turn: map[string]any{},
		},
		{
			name: "null ID",
			turn: map[string]any{"id": nil},
		},
		{
			name: "numeric ID",
			turn: map[string]any{"id": 42},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			session := newNormalizationTestSession()
			session.setSessionID("thread-primary")
			primary := mustCodexParams(t, map[string]any{
				"threadId": "thread-primary",
				"turn":     map[string]any{"id": "turn-primary"},
			})
			session.normalize(rpcMessage{
				Method: "turn/started",
				Params: primary,
			}, primary)
			<-session.events
			if !session.canSteerBusy() {
				t.Fatal("primary turn did not enable steering")
			}

			repeated := mustCodexParams(t, map[string]any{
				"threadId": "thread-primary",
				"turn":     test.turn,
			})
			session.normalize(rpcMessage{
				Method: "turn/started",
				Params: repeated,
			}, repeated)
			event := <-session.events
			if event.Kind != runtimeapi.EventThinking || event.TurnID != "" {
				t.Fatalf("falsy repeated turn start = %#v", event)
			}
			if !session.canSteerBusy() {
				t.Fatal("falsy repeated turn start cleared active steering")
			}
		})
	}
}

func TestSessionReportsStartedSilentTurnWithUnknownInputEvidence(t *testing.T) {
	t.Parallel()

	session := newNormalizationTestSession()
	session.setSessionID("thread-primary")
	started := mustCodexParams(t, map[string]any{
		"turn": map[string]any{"id": "turn-empty"},
	})
	session.normalize(rpcMessage{Method: "turn/started", Params: started}, started)
	<-session.events
	completed := mustCodexParams(t, map[string]any{
		"turn": map[string]any{
			"id":     "turn-empty",
			"status": "completed",
		},
	})
	session.normalize(rpcMessage{
		Method: "turn/completed",
		Params: completed,
	}, completed)
	if diagnostic := <-session.events; diagnostic.Kind != runtimeapi.EventDiagnostic ||
		diagnostic.Name != "Codex warning" {
		t.Fatalf("unknown-input diagnostic = %#v", diagnostic)
	}
	if runtimeError := <-session.events; runtimeError.Kind != runtimeapi.EventError ||
		runtimeError.Text != "Codex runtime completed without a response. Please retry. (codex_zero_evidence_turn_completed)" {
		t.Fatalf("unknown-input error = %#v", runtimeError)
	}
	if turnEnd := <-session.events; turnEnd.Kind != runtimeapi.EventTurnCompletion ||
		turnEnd.Text != "completed" {
		t.Fatalf("unknown-input turn completion = %#v", turnEnd)
	}
	select {
	case event := <-session.events:
		t.Fatalf("silent turn emitted an extra event: %#v", event)
	default:
	}
}

func TestSessionEmitsOfficialZeroEvidenceSequenceForStartedNonEmptyTurn(t *testing.T) {
	t.Parallel()

	session := newNormalizationTestSession()
	session.setSessionID("thread-primary")
	session.mu.Lock()
	session.turnEvidence.markAcceptedInput("turn-silent", true)
	session.mu.Unlock()

	started := mustCodexParams(t, map[string]any{
		"threadId": "thread-primary",
		"turn":     map[string]any{"id": "turn-silent"},
	})
	session.normalize(rpcMessage{
		Method: "turn/started",
		Params: started,
	}, started)
	if event := <-session.events; event.Kind != runtimeapi.EventThinking {
		t.Fatalf("turn start = %#v", event)
	}

	completed := mustCodexParams(t, map[string]any{
		"threadId": "thread-primary",
		"turn": map[string]any{
			"id":     "turn-silent",
			"status": "completed",
		},
	})
	session.normalize(rpcMessage{
		Method: "turn/completed",
		Params: completed,
	}, completed)

	diagnostic := <-session.events
	if diagnostic.Kind != runtimeapi.EventDiagnostic ||
		diagnostic.Name != "Codex warning" ||
		diagnostic.Text != "Codex runtime completed an empty turn with no output, progress, or token usage" ||
		diagnostic.Detail != "Codex runtime reported turn/completed status=completed after turn/started with no assistant text, reasoning text, tool activity, internal progress, raw response-item progress, or valid thread/tokenUsage/updated payload." {
		t.Fatalf("zero-evidence diagnostic = %#v", diagnostic)
	}
	runtimeError := <-session.events
	if runtimeError.Kind != runtimeapi.EventError ||
		runtimeError.Text != "Codex runtime returned an empty response. Please retry. (codex_zero_evidence_turn_completed)" {
		t.Fatalf("zero-evidence error = %#v", runtimeError)
	}
	turnEnd := <-session.events
	if turnEnd.Kind != runtimeapi.EventTurnCompletion ||
		turnEnd.SessionID != "thread-primary" ||
		turnEnd.TurnID != "turn-silent" {
		t.Fatalf("zero-evidence turn completion = %#v", turnEnd)
	}
}

func TestSessionValidUsageSuppressesZeroEvidenceFailure(t *testing.T) {
	t.Parallel()

	session := newNormalizationTestSession()
	session.setSessionID("thread-primary")
	started := mustCodexParams(t, map[string]any{
		"turn": map[string]any{"id": "turn-usage"},
	})
	session.normalize(rpcMessage{
		Method: "turn/started",
		Params: started,
	}, started)
	<-session.events

	usage := mustCodexParams(t, map[string]any{
		"threadId": "thread-primary",
		"turnId":   "turn-usage",
		"tokenUsage": map[string]any{
			"total": map[string]any{"totalTokens": 0},
		},
	})
	session.normalize(rpcMessage{
		Method: "thread/tokenUsage/updated",
		Params: usage,
	}, usage)
	if event := <-session.events; event.Kind != runtimeapi.EventUsage {
		t.Fatalf("usage = %#v", event)
	}

	completed := mustCodexParams(t, map[string]any{
		"turn": map[string]any{
			"id":     "turn-usage",
			"status": "completed",
		},
	})
	session.normalize(rpcMessage{
		Method: "turn/completed",
		Params: completed,
	}, completed)
	if event := <-session.events; event.Kind != runtimeapi.EventTurnCompletion {
		t.Fatalf("completion after usage = %#v", event)
	}
	select {
	case event := <-session.events:
		t.Fatalf("usage-backed turn emitted extra event: %#v", event)
	default:
	}
}

func TestSessionTreatsArrayTokenUsageTotalWithFiniteSiblingAsEvidence(
	t *testing.T,
) {
	t.Parallel()

	session := newNormalizationTestSession()
	session.setSessionID("thread-primary")
	started := mustCodexParams(t, map[string]any{
		"threadId": "thread-primary",
		"turn":     map[string]any{"id": "turn-array-token-usage"},
	})
	session.normalize(rpcMessage{
		Method: "turn/started",
		Params: started,
	}, started)
	<-session.events

	usage := mustCodexParams(t, map[string]any{
		"threadId": "thread-primary",
		"turnId":   "turn-array-token-usage",
		"tokenUsage": map[string]any{
			"total":              []any{},
			"modelContextWindow": 200000,
		},
	})
	session.normalize(rpcMessage{
		Method: "thread/tokenUsage/updated",
		Params: usage,
	}, usage)
	select {
	case event := <-session.events:
		if event.Kind != runtimeapi.EventUsage {
			t.Fatalf("array-total usage = %#v", event)
		}
	default:
		t.Fatal("array-total usage with a finite sibling was ignored")
	}

	completed := mustCodexParams(t, map[string]any{
		"threadId": "thread-primary",
		"turn": map[string]any{
			"id":     "turn-array-token-usage",
			"status": "completed",
		},
	})
	session.normalize(rpcMessage{
		Method: "turn/completed",
		Params: completed,
	}, completed)
	if event := <-session.events; event.Kind != runtimeapi.EventTurnCompletion {
		t.Fatalf("array-total usage completion = %#v", event)
	}
	select {
	case event := <-session.events:
		t.Fatalf("array-total usage emitted zero-evidence output: %#v", event)
	default:
	}
}

func TestSessionIgnoresMalformedRawResponseItemProgress(t *testing.T) {
	t.Parallel()

	session := newNormalizationTestSession()
	params := mustCodexParams(t, "not-an-object")
	session.normalize(rpcMessage{
		Method: "rawResponseItem/completed",
		Params: params,
	}, params)
	select {
	case event := <-session.events:
		t.Fatalf("malformed raw response item became progress: %#v", event)
	default:
	}
}

func TestSessionTreatsArrayRawResponseItemAsProgress(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		params any
	}{
		{
			name:   "root array",
			params: []any{map[string]any{"type": "message"}},
		},
		{
			name:   "empty root array",
			params: []any{},
		},
		{
			name: "nested item array",
			params: map[string]any{
				"item": []any{map[string]any{"type": "message"}},
			},
		},
		{
			name: "nested empty item array",
			params: map[string]any{
				"item": []any{},
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			session := newNormalizationTestSession()
			session.setSessionID("thread-primary")
			started := mustCodexParams(t, map[string]any{
				"threadId": "thread-primary",
				"turn":     map[string]any{"id": "turn-array-progress"},
			})
			session.normalize(rpcMessage{
				Method: "turn/started",
				Params: started,
			}, started)
			<-session.events

			progress := mustCodexParams(t, test.params)
			session.normalize(rpcMessage{
				Method: "rawResponseItem/completed",
				Params: progress,
			}, progress)
			select {
			case event := <-session.events:
				if event.Kind != runtimeapi.EventUsage {
					t.Fatalf("array raw response progress = %#v", event)
				}
			default:
				t.Fatal("array raw response item did not become progress")
			}

			completed := mustCodexParams(t, map[string]any{
				"threadId": "thread-primary",
				"turn": map[string]any{
					"id":     "turn-array-progress",
					"status": "completed",
				},
			})
			session.normalize(rpcMessage{
				Method: "turn/completed",
				Params: completed,
			}, completed)
			if event := <-session.events; event.Kind != runtimeapi.EventTurnCompletion {
				t.Fatalf("array-progress completion = %#v", event)
			}
			select {
			case event := <-session.events:
				t.Fatalf("array-progress completion emitted extra output: %#v", event)
			default:
			}
		})
	}
}

func TestSessionProjectsRawCodexProgressWithoutVisibleActivity(t *testing.T) {
	t.Parallel()

	session := newNormalizationTestSession()
	params := mustCodexParams(t, map[string]any{
		"turnId": "turn-1",
		"delta":  "raw output",
	})
	session.normalize(rpcMessage{
		Method: "item/commandExecution/outputDelta",
		Params: params,
	}, params)
	if event := <-session.events; event.Kind != runtimeapi.EventUsage {
		t.Fatalf("raw progress = %#v", event)
	}
}

func TestSessionAcceptsOnlyValidOfficialCodexTelemetry(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		method string
		params map[string]any
		want   bool
	}{
		{
			name:   "valid cumulative token usage",
			method: "thread/tokenUsage/updated",
			params: map[string]any{
				"threadId": "thread-primary",
				"tokenUsage": map[string]any{
					"total": map[string]any{
						"inputTokens":  0,
						"outputTokens": 9,
					},
					"modelContextWindow": 200000,
				},
			},
			want: true,
		},
		{
			name:   "token usage without recognized finite values",
			method: "thread/tokenUsage/updated",
			params: map[string]any{
				"tokenUsage": map[string]any{
					"total": map[string]any{
						"futureCounter": 10,
					},
				},
			},
		},
		{
			name:   "unobserved turn scoped token usage",
			method: "turn/tokenUsage/updated",
			params: map[string]any{
				"tokenUsage": map[string]any{
					"total": map[string]any{"totalTokens": 10},
				},
			},
		},
		{
			name:   "valid account rate limits",
			method: "account/rateLimits/updated",
			params: map[string]any{
				"rateLimits": map[string]any{
					"limitId": "codex",
					"primary": map[string]any{
						"usedPercent": 0,
					},
				},
			},
			want: true,
		},
		{
			name:   "array primary with recognized sibling",
			method: "account/rateLimits/updated",
			params: map[string]any{
				"rateLimits": map[string]any{
					"limitId": "codex",
					"primary": []any{},
				},
			},
			want: true,
		},
		{
			name:   "array primary without recognized sibling",
			method: "account/rateLimits/updated",
			params: map[string]any{
				"rateLimits": map[string]any{
					"primary": []any{},
				},
			},
		},
		{
			name:   "rate limits without primary",
			method: "account/rateLimits/updated",
			params: map[string]any{
				"rateLimits": map[string]any{"limitId": "codex"},
			},
		},
		{
			name:   "rate limits without recognized values",
			method: "account/rateLimits/updated",
			params: map[string]any{
				"rateLimits": map[string]any{
					"primary": map[string]any{"futureWindow": 10},
				},
			},
		},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			session := newNormalizationTestSession()
			params := mustCodexParams(t, test.params)
			session.normalize(rpcMessage{
				Method: test.method,
				Params: params,
			}, params)
			select {
			case event := <-session.events:
				if !test.want {
					t.Fatalf("unexpected telemetry event = %#v", event)
				}
				if event.Kind != runtimeapi.EventUsage {
					t.Fatalf("telemetry event = %#v, want internal usage", event)
				}
			default:
				if test.want {
					t.Fatal("valid telemetry was ignored")
				}
			}
		})
	}
}

func TestSessionTreatsRetryableCodexErrorAsInternalProgress(t *testing.T) {
	t.Parallel()

	session := newNormalizationTestSession()
	params := mustCodexParams(t, map[string]any{
		"willRetry": true,
		"error": map[string]any{
			"message": "transient upstream disconnect",
		},
	})
	session.normalize(rpcMessage{
		Method: "error",
		Params: params,
	}, params)
	if event := <-session.events; event.Kind != runtimeapi.EventUsage {
		t.Fatalf("retryable error = %#v, want internal progress", event)
	}
}

func TestSessionProjectsUnclaimedCodexResponseError(t *testing.T) {
	t.Parallel()

	session := newNormalizationTestSession()
	raw := mustCodexParams(t, map[string]any{
		"jsonrpc": "2.0",
		"id":      999,
		"error": map[string]any{
			"code":    -32001,
			"message": "unclaimed Codex response failure",
		},
	})
	session.normalize(rpcMessage{
		ID: json.RawMessage(`999`),
		Error: &rpcError{
			Code:    -32001,
			Message: "unclaimed Codex response failure",
		},
	}, raw)

	select {
	case event := <-session.events:
		if event.Kind != runtimeapi.EventError ||
			event.Text != "unclaimed Codex response failure" {
			t.Fatalf("unclaimed response error = %#v", event)
		}
	default:
		t.Fatal("unclaimed Codex response error was silently dropped")
	}
}

func TestSessionUsesOfficialFallbackForEmptyUnclaimedCodexResponseError(
	t *testing.T,
) {
	t.Parallel()

	session := newNormalizationTestSession()
	raw := mustCodexParams(t, map[string]any{
		"jsonrpc": "2.0",
		"id":      998,
		"error": map[string]any{
			"code": -32002,
		},
	})
	session.normalize(rpcMessage{
		ID:    json.RawMessage(`998`),
		Error: &rpcError{Code: -32002},
	}, raw)

	select {
	case event := <-session.events:
		if event.Kind != runtimeapi.EventError ||
			event.Text != "Codex app-server request failed" {
			t.Fatalf("empty unclaimed response error = %#v", event)
		}
	default:
		t.Fatal("empty unclaimed Codex response error was silently dropped")
	}
}

func TestSessionUsesNestedCodexErrorMessage(t *testing.T) {
	t.Parallel()

	session := newNormalizationTestSession()
	params := mustCodexParams(t, map[string]any{
		"error": map[string]any{
			"message": "nested Codex failure",
		},
	})
	session.normalize(rpcMessage{
		Method: "error",
		Params: params,
	}, params)
	if event := <-session.events; event.Kind != runtimeapi.EventError ||
		event.Text != "nested Codex failure" {
		t.Fatalf("nested error = %#v", event)
	}
}

func TestSessionPreservesCodexErrorNotificationMessages(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		message any
		nested  string
		want    string
	}{
		{
			name:    "top-level ASCII whitespace",
			message: "  terminal failure  ",
			want:    "  terminal failure  ",
		},
		{
			name:   "nested ASCII whitespace",
			nested: "  nested terminal failure  ",
			want:   "  nested terminal failure  ",
		},
		{
			name:    "byte-order-mark-only top-level falls through",
			message: "\ufeff",
			nested:  " nested after byte-order mark ",
			want:    " nested after byte-order mark ",
		},
		{
			name:    "next-line boundaries",
			message: "\u0085terminal failure\u0085",
			nested:  "must not replace next-line text",
			want:    "\u0085terminal failure\u0085",
		},
		{
			name:    "selected message remains unbounded",
			message: strings.Repeat("a", 1001),
			want:    strings.Repeat("a", 1001),
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			payload := map[string]any{}
			if test.message != nil {
				payload["message"] = test.message
			}
			if test.nested != "" {
				payload["error"] = map[string]any{
					"message": test.nested,
				}
			}
			params := mustCodexParams(t, payload)
			session := newNormalizationTestSession()
			session.normalize(rpcMessage{
				Method: "error",
				Params: params,
			}, params)

			event := <-session.events
			if event.Kind != runtimeapi.EventError || event.Text != test.want {
				t.Fatalf(
					"error notification kind=%q text=%q; want text %q",
					event.Kind,
					event.Text,
					test.want,
				)
			}
		})
	}
}

func TestSessionUsesOfficialFallbackForEmptyCodexErrorNotification(t *testing.T) {
	t.Parallel()

	session := newNormalizationTestSession()
	params := mustCodexParams(t, map[string]any{})
	session.normalize(rpcMessage{
		Method: "error",
		Params: params,
	}, params)

	if event := <-session.events; event.Kind != runtimeapi.EventError ||
		event.Text != "Unknown Codex app-server error" {
		t.Fatalf("empty Codex error notification = %#v", event)
	}
}

func TestSessionPrefixesInterruptedTurnNativeDetail(t *testing.T) {
	t.Parallel()

	session := newNormalizationTestSession()
	params := mustCodexParams(t, map[string]any{
		"turn": map[string]any{
			"id":     "turn-interrupted",
			"status": "interrupted",
			"error": map[string]any{
				"message": "operator canceled fixture",
			},
		},
	})
	session.normalize(rpcMessage{
		Method: "turn/completed",
		Params: params,
	}, params)

	if runtimeError := <-session.events; runtimeError.Kind != runtimeapi.EventError ||
		runtimeError.Text != "Codex turn interrupted: operator canceled fixture" {
		t.Fatalf("interrupted turn error = %#v", runtimeError)
	}
	if completion := <-session.events; completion.Kind != runtimeapi.EventTurnCompletion ||
		completion.Text != "interrupted" {
		t.Fatalf("interrupted turn completion = %#v", completion)
	}
}

func TestSessionPreservesCodexCompletedTurnErrorMessages(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		status  string
		message string
		want    string
	}{
		{
			name:    "failed outer ASCII whitespace",
			status:  "failed",
			message: "  failed turn fixture  ",
			want:    "  failed turn fixture  ",
		},
		{
			name:    "failed whitespace-only message",
			status:  "failed",
			message: "  ",
			want:    "  ",
		},
		{
			name:   "failed empty fallback",
			status: "failed",
			want:   "Codex turn failed",
		},
		{
			name:    "failed next-line boundaries",
			status:  "failed",
			message: "\u0085failed turn fixture\u0085",
			want:    "\u0085failed turn fixture\u0085",
		},
		{
			name:    "failed message remains unbounded",
			status:  "failed",
			message: strings.Repeat("f", 1001),
			want:    strings.Repeat("f", 1001),
		},
		{
			name:    "interrupted outer ASCII whitespace",
			status:  "interrupted",
			message: "  interrupted turn fixture  ",
			want:    "Codex turn interrupted:   interrupted turn fixture  ",
		},
		{
			name:    "interrupted whitespace-only detail",
			status:  "interrupted",
			message: "  ",
			want:    "Codex turn interrupted:   ",
		},
		{
			name:   "interrupted empty detail",
			status: "interrupted",
			want:   "Codex turn interrupted",
		},
		{
			name:    "interrupted byte-order-mark detail",
			status:  "interrupted",
			message: "\ufeff",
			want:    "Codex turn interrupted: \ufeff",
		},
		{
			name:    "interrupted next-line boundaries",
			status:  "interrupted",
			message: "\u0085interrupted turn fixture\u0085",
			want:    "Codex turn interrupted: \u0085interrupted turn fixture\u0085",
		},
		{
			name:    "interrupted detail remains unbounded",
			status:  "interrupted",
			message: strings.Repeat("i", 1001),
			want:    "Codex turn interrupted: " + strings.Repeat("i", 1001),
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			params := mustCodexParams(t, map[string]any{
				"turn": map[string]any{
					"id":     "turn-completed-error-fixture",
					"status": test.status,
					"error": map[string]any{
						"message": test.message,
					},
				},
			})
			session := newNormalizationTestSession()
			session.normalize(rpcMessage{
				Method: "turn/completed",
				Params: params,
			}, params)

			runtimeError := <-session.events
			if runtimeError.Kind != runtimeapi.EventError ||
				runtimeError.Text != test.want ||
				runtimeError.TurnID != "turn-completed-error-fixture" {
				t.Fatalf(
					"completed-turn error kind=%q text=%q turn=%q; want text %q",
					runtimeError.Kind,
					runtimeError.Text,
					runtimeError.TurnID,
					test.want,
				)
			}
			completion := <-session.events
			if completion.Kind != runtimeapi.EventTurnCompletion ||
				completion.Text != test.status ||
				completion.TurnID != "turn-completed-error-fixture" {
				t.Fatalf("completed-turn completion = %#v", completion)
			}
		})
	}
}

func TestSessionNormalizesCodexWarningsAndWaitingStatus(t *testing.T) {
	t.Parallel()

	session := newNormalizationTestSession()
	session.setSessionID("thread-primary")
	warning := mustCodexParams(t, map[string]any{
		"threadId": "thread-primary",
		"summary":  "Configuration is deprecated",
		"details":  "Use the replacement setting",
		"path":     "config.toml",
	})
	session.normalize(rpcMessage{
		Method: "configWarning",
		Params: warning,
	}, warning)
	if event := <-session.events; event.Kind != runtimeapi.EventDiagnostic ||
		event.Name != "Codex config warning" ||
		event.Text != "Configuration is deprecated" ||
		event.Detail != "Use the replacement setting\nPath: config.toml" {
		t.Fatalf("config warning = %#v", event)
	}

	waiting := mustCodexParams(t, map[string]any{
		"threadId": "thread-primary",
		"status": map[string]any{
			"type":        "active",
			"activeFlags": []string{"waitingOnApproval", "waitingOnUserInput"},
		},
	})
	session.normalize(rpcMessage{
		Method: "thread/status/changed",
		Params: waiting,
	}, waiting)
	if event := <-session.events; event.Kind != runtimeapi.EventDiagnostic ||
		event.Name != "Codex warning" ||
		event.Text != "Codex thread is waiting on approval and user input" ||
		event.Detail != "Active flags: waitingOnApproval, waitingOnUserInput" {
		t.Fatalf("waiting status = %#v", event)
	}
}

func TestSessionPreservesCodexWaitingFlagMultiplicityAndOrder(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name        string
		activeFlags []any
		wantText    string
		wantDetail  string
	}{
		{
			name: "duplicates and original order",
			activeFlags: []any{
				"waitingOnUserInput",
				"waitingOnApproval",
				"waitingOnUserInput",
				"unrelated",
				"waitingOnApproval",
			},
			wantText: "Codex thread is waiting on approval and user input",
			wantDetail: "Active flags: waitingOnUserInput, waitingOnApproval, " +
				"waitingOnUserInput, waitingOnApproval",
		},
		{
			name: "non-string values are filtered",
			activeFlags: []any{
				42,
				"waitingOnApproval",
				nil,
				"waitingOnUserInput",
				false,
			},
			wantText:   "Codex thread is waiting on approval and user input",
			wantDetail: "Active flags: waitingOnApproval, waitingOnUserInput",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			params := mustCodexParams(t, map[string]any{
				"threadId": "thread-primary",
				"status": map[string]any{
					"type":        "active",
					"activeFlags": test.activeFlags,
				},
			})
			session := newNormalizationTestSession()
			session.setSessionID("thread-primary")
			session.normalize(rpcMessage{
				Method: "thread/status/changed",
				Params: params,
			}, params)

			event := <-session.events
			if event.Kind != runtimeapi.EventDiagnostic ||
				event.Name != "Codex warning" ||
				event.Text != test.wantText ||
				event.Detail != test.wantDetail ||
				event.SessionID != "thread-primary" {
				t.Fatalf(
					"waiting diagnostic kind=%q name=%q text=%q detail=%q session=%q",
					event.Kind,
					event.Name,
					event.Text,
					event.Detail,
					event.SessionID,
				)
			}
		})
	}
}

func TestSessionBoundsCodexDiagnosticTextByUTF16Units(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		input string
		want  string
	}{
		{
			name:  "exact ASCII limit",
			input: strings.Repeat("a", 1000),
			want:  strings.Repeat("a", 1000),
		},
		{
			name:  "ASCII truncation",
			input: strings.Repeat("a", 1001),
			want:  strings.Repeat("a", 999) + "…",
		},
		{
			name:  "multibyte BMP limit",
			input: strings.Repeat("界", 1000),
			want:  strings.Repeat("界", 1000),
		},
		{
			name:  "astral truncation",
			input: strings.Repeat("😀", 499) + "abc",
			want:  strings.Repeat("😀", 499) + "a…",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			session := newNormalizationTestSession()
			params := mustCodexParams(t, map[string]any{
				"message": test.input,
			})
			session.normalize(rpcMessage{
				Method: "warning",
				Params: params,
			}, params)

			if event := <-session.events; event.Kind != runtimeapi.EventDiagnostic ||
				event.Text != test.want {
				t.Fatalf("bounded diagnostic = %#v, want text %q", event, test.want)
			}
		})
	}
}

func TestSessionTrimsCodexDiagnosticTextLikeJavaScript(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		input string
		want  string
	}{
		{
			name:  "byte order marks",
			input: "\ufeffwarning\ufeff",
			want:  "warning",
		},
		{
			name:  "next line is preserved",
			input: "\u0085warning\u0085",
			want:  "\u0085warning\u0085",
		},
		{
			name:  "only byte order mark uses fallback",
			input: "\ufeff",
			want:  "Codex warning",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			session := newNormalizationTestSession()
			params := mustCodexParams(t, map[string]any{
				"message": test.input,
			})
			session.normalize(rpcMessage{
				Method: "warning",
				Params: params,
			}, params)

			if event := <-session.events; event.Kind != runtimeapi.EventDiagnostic ||
				event.Text != test.want {
				t.Fatalf("trimmed diagnostic = %#v, want text %q", event, test.want)
			}
		})
	}
}

func TestSessionNormalizesCodexThreadSystemError(t *testing.T) {
	t.Parallel()

	session := newNormalizationTestSession()
	session.setSessionID("thread-primary")
	params := mustCodexParams(t, map[string]any{
		"threadId": "thread-primary",
		"status": map[string]any{
			"type":    "systemError",
			"message": "native thread failure",
		},
	})
	session.normalize(rpcMessage{
		Method: "thread/status/changed",
		Params: params,
	}, params)
	if event := <-session.events; event.Kind != runtimeapi.EventError ||
		event.Text != "native thread failure" {
		t.Fatalf("system error = %#v", event)
	}
}

func TestSessionBoundsCodexThreadSystemErrorReasonsLikeJavaScript(t *testing.T) {
	t.Parallel()

	astralInput := strings.Repeat("😀", 499) + "abc"
	astralWant := strings.Repeat("😀", 499) + "a…"
	tests := []struct {
		name   string
		status map[string]any
		want   string
	}{
		{
			name: "exact ASCII limit",
			status: map[string]any{
				"type":    "systemError",
				"message": strings.Repeat("a", 1000),
			},
			want: strings.Repeat("a", 1000),
		},
		{
			name: "ASCII overflow",
			status: map[string]any{
				"type":    "systemError",
				"message": strings.Repeat("a", 1001),
			},
			want: strings.Repeat("a", 999) + "…",
		},
		{
			name: "astral overflow",
			status: map[string]any{
				"type":    "systemError",
				"message": astralInput,
			},
			want: astralWant,
		},
		{
			name: "nested error message",
			status: map[string]any{
				"type": "systemError",
				"error": map[string]any{
					"message": astralInput,
				},
			},
			want: astralWant,
		},
		{
			name: "byte order marks",
			status: map[string]any{
				"type":    "systemError",
				"message": "\ufeffnative failure\ufeff",
			},
			want: "native failure",
		},
		{
			name: "next line is preserved",
			status: map[string]any{
				"type":    "systemError",
				"message": "\u0085native failure\u0085",
			},
			want: "\u0085native failure\u0085",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			session := newNormalizationTestSession()
			session.setSessionID("thread-primary")
			params := mustCodexParams(t, map[string]any{
				"threadId": "thread-primary",
				"status":   test.status,
			})
			session.normalize(rpcMessage{
				Method: "thread/status/changed",
				Params: params,
			}, params)

			event := <-session.events
			if event.Kind != runtimeapi.EventError ||
				event.Text != test.want ||
				event.RuntimeErrorNativeReason == nil ||
				!*event.RuntimeErrorNativeReason ||
				event.RuntimeErrorReasonProvenance != "codex_native_reason" {
				t.Fatalf("bounded system error = %#v, want text %q", event, test.want)
			}
		})
	}
}

func TestSessionPreservesCodexTopLevelSystemErrorFallbackReasons(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		message any
		nested  string
		want    string
	}{
		{
			name:    "top-level ASCII whitespace",
			message: "  native fallback failure  ",
			want:    "  native fallback failure  ",
		},
		{
			name:   "nested ASCII whitespace",
			nested: "  nested fallback failure  ",
			want:   "  nested fallback failure  ",
		},
		{
			name:    "byte-order-mark-only top-level falls through",
			message: "\ufeff",
			nested:  " nested after byte-order mark ",
			want:    " nested after byte-order mark ",
		},
		{
			name:    "next-line boundaries",
			message: "\u0085native fallback failure\u0085",
			want:    "\u0085native fallback failure\u0085",
		},
		{
			name:    "top-level fallback remains unbounded",
			message: strings.Repeat("a", 1001),
			want:    strings.Repeat("a", 1001),
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			payload := map[string]any{
				"threadId": "thread-primary",
				"status": map[string]any{
					"type": "systemError",
				},
			}
			if test.message != nil {
				payload["message"] = test.message
			}
			if test.nested != "" {
				payload["error"] = map[string]any{
					"message": test.nested,
				}
			}
			params := mustCodexParams(t, payload)
			session := newNormalizationTestSession()
			session.setSessionID("thread-primary")
			session.normalize(rpcMessage{
				Method: "thread/status/changed",
				Params: params,
			}, params)

			event := <-session.events
			if event.Kind != runtimeapi.EventError ||
				event.Text != test.want ||
				event.RuntimeErrorNativeReason == nil ||
				!*event.RuntimeErrorNativeReason ||
				event.RuntimeErrorReasonProvenance != "codex_native_reason" {
				t.Fatalf(
					"fallback system error kind=%q text=%q native=%v provenance=%q; want text %q",
					event.Kind,
					event.Text,
					event.RuntimeErrorNativeReason,
					event.RuntimeErrorReasonProvenance,
					test.want,
				)
			}
		})
	}
}

func TestSessionNormalizesCodexThreadSystemErrorWithoutReason(t *testing.T) {
	t.Parallel()

	session := newNormalizationTestSession()
	session.setSessionID("thread-primary")
	params := mustCodexParams(t, map[string]any{
		"threadId": "thread-primary",
		"status": map[string]any{
			"type": "systemError",
		},
	})
	session.normalize(rpcMessage{
		Method: "thread/status/changed",
		Params: params,
	}, params)

	if diagnostic := <-session.events; diagnostic.Kind != runtimeapi.EventDiagnostic ||
		diagnostic.Name != "Codex warning" ||
		diagnostic.Text != "Codex thread entered system error state without a reason" ||
		diagnostic.SessionID != "thread-primary" {
		t.Fatalf("reasonless system-error diagnostic = %#v", diagnostic)
	}
	if runtimeError := <-session.events; runtimeError.Kind != runtimeapi.EventError ||
		runtimeError.Text != "Codex thread entered system error state" ||
		runtimeError.RuntimeErrorNativeReason == nil ||
		*runtimeError.RuntimeErrorNativeReason ||
		runtimeError.RuntimeErrorReasonProvenance != "daemon_fallback" {
		t.Fatalf("reasonless system error = %#v", runtimeError)
	}
}

func TestSessionUsesPresentCodexThreadStatusBeforeNestedStatus(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		status any
	}{
		{
			name:   "empty object",
			status: map[string]any{},
		},
		{
			name: "empty type",
			status: map[string]any{
				"type": "",
			},
		},
		{
			name:   "scalar",
			status: "invalid",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			session := newNormalizationTestSession()
			session.setSessionID("thread-primary")
			params := mustCodexParams(t, map[string]any{
				"threadId": "thread-primary",
				"status":   test.status,
				"thread": map[string]any{
					"status": map[string]any{
						"type":    "systemError",
						"message": "stale nested failure",
					},
				},
			})
			session.normalize(rpcMessage{
				Method: "thread/status/changed",
				Params: params,
			}, params)

			select {
			case event := <-session.events:
				t.Fatalf("present top-level status fell through: %#v", event)
			default:
			}
		})
	}
}

func TestSessionFallsBackToNestedCodexThreadStatusWhenTopLevelIsNullish(
	t *testing.T,
) {
	t.Parallel()

	tests := []struct {
		name          string
		includeStatus bool
	}{
		{name: "absent"},
		{name: "null", includeStatus: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			session := newNormalizationTestSession()
			session.setSessionID("thread-primary")
			payload := map[string]any{
				"threadId": "thread-primary",
				"thread": map[string]any{
					"status": map[string]any{
						"type":    "systemError",
						"message": "nested current failure",
					},
				},
			}
			if test.includeStatus {
				payload["status"] = nil
			}
			params := mustCodexParams(t, payload)
			session.normalize(rpcMessage{
				Method: "thread/status/changed",
				Params: params,
			}, params)

			if event := <-session.events; event.Kind != runtimeapi.EventError ||
				event.Text != "nested current failure" {
				t.Fatalf("nullish top-level fallback = %#v", event)
			}
		})
	}
}

func TestDriverRejectsNonDirectoryWorkspaceBeforeStartingRuntime(t *testing.T) {
	t.Parallel()

	workspaceFile := filepath.Join(t.TempDir(), "workspace.txt")
	if err := os.WriteFile(workspaceFile, []byte("not a directory"), 0o600); err != nil {
		t.Fatal(err)
	}
	driver := New(Options{Executable: os.Args[0]})
	_, err := driver.Start(context.Background(), runtimeapi.StartRequest{
		AgentID:          "agent-1",
		LaunchID:         "launch-1",
		WorkingDirectory: workspaceFile,
	})
	if err == nil || !strings.Contains(err.Error(), "not a directory") {
		t.Fatalf("Start() error = %v", err)
	}
}

func TestDriverMapsFastExecutionModeToCodexServiceTier(t *testing.T) {
	t.Parallel()

	driver := New(Options{
		Executable: os.Args[0],
		ArgsPrefix: []string{"-test.run=TestCodexAppServerHelper", "--"},
	})
	session, err := driver.Start(context.Background(), runtimeapi.StartRequest{
		AgentID:          "agent-1",
		LaunchID:         "launch-fast",
		WorkingDirectory: t.TempDir(),
		ExecutionMode:    "fast",
		Environment: map[string]string{
			"VELA_CODEX_HELPER":      "1",
			"VELA_CODEX_HELPER_MODE": "require-fast-tier",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer session.Stop(context.Background())
}

func TestDriverMarksAcceptedInitialPromptAsNonEmptyTurnEvidence(t *testing.T) {
	t.Parallel()

	driver := New(Options{
		Executable: os.Args[0],
		ArgsPrefix: []string{"-test.run=TestCodexAppServerHelper", "--"},
	})
	session, err := driver.Start(context.Background(), runtimeapi.StartRequest{
		AgentID:          "agent-1",
		LaunchID:         "launch-zero-evidence-initial",
		WorkingDirectory: t.TempDir(),
		Prompt:           "this accepted prompt must produce evidence",
		Environment: map[string]string{
			"VELA_CODEX_HELPER":      "1",
			"VELA_CODEX_HELPER_MODE": "zero-evidence-started",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer session.Stop(context.Background())

	runtimeError := waitForRuntimeEvent(t, session.Events(), runtimeapi.EventError)
	if runtimeError.Text != "Codex runtime returned an empty response. Please retry. (codex_zero_evidence_turn_completed)" {
		t.Fatalf("initial prompt zero-evidence error = %#v", runtimeError)
	}
}

func TestDriverIgnoresRootTurnIDForCorrelatedInputEvidence(t *testing.T) {
	t.Parallel()

	driver := New(Options{
		Executable: os.Args[0],
		ArgsPrefix: []string{"-test.run=TestCodexAppServerHelper", "--"},
	})
	session, err := driver.Start(context.Background(), runtimeapi.StartRequest{
		AgentID:          "agent-1",
		LaunchID:         "launch-root-turn-id-zero-evidence",
		WorkingDirectory: t.TempDir(),
		Prompt:           "this accepted prompt has only a root response turn ID",
		Environment: map[string]string{
			"VELA_CODEX_HELPER":      "1",
			"VELA_CODEX_HELPER_MODE": "root-turn-id-zero-evidence",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer session.Stop(context.Background())

	runtimeError := waitForRuntimeEvent(t, session.Events(), runtimeapi.EventError)
	if runtimeError.Text != "Codex runtime completed without a response. Please retry. (codex_zero_evidence_turn_completed)" {
		t.Fatalf("root turnId zero-evidence error = %#v", runtimeError)
	}
}

func TestDriverMarksAcceptedIdleDeliveryAsNonEmptyTurnEvidence(t *testing.T) {
	t.Parallel()

	driver := New(Options{
		Executable: os.Args[0],
		ArgsPrefix: []string{"-test.run=TestCodexAppServerHelper", "--"},
	})
	session, err := driver.Start(context.Background(), runtimeapi.StartRequest{
		AgentID:          "agent-1",
		LaunchID:         "launch-zero-evidence-delivery",
		WorkingDirectory: t.TempDir(),
		Environment: map[string]string{
			"VELA_CODEX_HELPER":      "1",
			"VELA_CODEX_HELPER_MODE": "zero-evidence-started",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer session.Stop(context.Background())

	if err := session.Deliver(
		context.Background(),
		runtimeapi.Delivery{Text: "this accepted delivery must produce evidence"},
	); err != nil {
		t.Fatal(err)
	}
	runtimeError := waitForRuntimeEvent(t, session.Events(), runtimeapi.EventError)
	if runtimeError.Text != "Codex runtime returned an empty response. Please retry. (codex_zero_evidence_turn_completed)" {
		t.Fatalf("idle delivery zero-evidence error = %#v", runtimeError)
	}
}

func TestResultTurnIDAcceptsOnlyObservedCorrelatedResponseShape(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		raw  map[string]any
		want string
	}{
		{
			name: "nested turn",
			raw:  map[string]any{"turn": map[string]any{"id": "turn-nested"}},
			want: "turn-nested",
		},
		{
			name: "root turnId is not correlated input evidence",
			raw:  map[string]any{"turnId": "turn-alias"},
		},
		{
			name: "missing",
			raw:  map[string]any{"futureTurn": "turn-future"},
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			raw := mustCodexParams(t, test.raw)
			if got := resultTurnID(raw); got != test.want {
				t.Fatalf("resultTurnID() = %q, want %q", got, test.want)
			}
		})
	}
}

func TestDriverFallsBackToFreshThreadWhenResumeStateIsMissing(t *testing.T) {
	t.Parallel()

	driver := New(Options{
		Executable: os.Args[0],
		ArgsPrefix: []string{"-test.run=TestCodexAppServerHelper", "--"},
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	session, err := driver.Start(ctx, runtimeapi.StartRequest{
		AgentID:          "agent-1",
		LaunchID:         "launch-resume",
		WorkingDirectory: t.TempDir(),
		SessionID:        "thread-missing",
		Environment: map[string]string{
			"VELA_CODEX_HELPER":      "1",
			"VELA_CODEX_HELPER_MODE": "resume-missing",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer session.Stop(context.Background())
	recovery := waitForRuntimeEvent(t, session.Events(), runtimeapi.EventRecovery)
	if recovery.Text != missingResumeMessage ||
		recovery.Detail != missingResumeDetails ||
		recovery.RecoverySource != "codex_resume_missing_rollout" ||
		recovery.RecoveryClass != "missing_rollout" ||
		recovery.RecoveryAction != "fallback_fresh_thread" ||
		recovery.RequestedSessionID != "thread-missing" ||
		session.SessionID() != "thread-test" {
		t.Fatalf("recovery = %#v, session=%q", recovery, session.SessionID())
	}
}

func TestMissingResumeClassificationIsBoundedToThreadOrRolloutState(t *testing.T) {
	t.Parallel()

	tests := []struct {
		message string
		want    bool
	}{
		{message: "no rollout found", want: true},
		{message: "missing rollout", want: true},
		{message: "rollout 123 was not found", want: true},
		{message: "rollout state is missing", want: true},
		{message: "thread abc not found", want: true},
		{message: "thread state missing", want: true},
		{message: "missing thread", want: true},
		{message: "missing credentials", want: false},
		{message: "model not found", want: false},
		{message: "resource not found", want: false},
		{message: "rollout request forbidden", want: false},
		{message: "unauthorized", want: false},
	}
	for _, tt := range tests {
		tt := tt
		t.Run(tt.message, func(t *testing.T) {
			t.Parallel()
			if got := isMissingResume(errors.New(tt.message)); got != tt.want {
				t.Fatalf("isMissingResume(%q) = %t, want %t", tt.message, got, tt.want)
			}
		})
	}
}

func TestDriverDoesNotColdStartForUnrelatedResumeErrors(t *testing.T) {
	t.Parallel()

	for _, mode := range []string{"resume-missing-credentials", "resume-model-not-found"} {
		mode := mode
		t.Run(mode, func(t *testing.T) {
			t.Parallel()
			driver := New(Options{
				Executable: os.Args[0],
				ArgsPrefix: []string{"-test.run=TestCodexAppServerHelper", "--"},
			})
			_, err := driver.Start(context.Background(), runtimeapi.StartRequest{
				AgentID:          "agent-1",
				LaunchID:         "launch-resume-error",
				WorkingDirectory: t.TempDir(),
				SessionID:        "thread-existing",
				Environment: map[string]string{
					"VELA_CODEX_HELPER":      "1",
					"VELA_CODEX_HELPER_MODE": mode,
				},
			})
			if err == nil || !strings.Contains(err.Error(), "thread/resume") {
				t.Fatalf("Start() error = %v, want terminal resume error", err)
			}
		})
	}
}

func TestDriverPrependsRecoveryNoticeToFreshThreadPrompt(t *testing.T) {
	t.Parallel()

	driver := New(Options{
		Executable: os.Args[0],
		ArgsPrefix: []string{"-test.run=TestCodexAppServerHelper", "--"},
	})
	session, err := driver.Start(context.Background(), runtimeapi.StartRequest{
		AgentID:          "agent-1",
		LaunchID:         "launch-resume-notice",
		WorkingDirectory: t.TempDir(),
		SessionID:        "thread-missing",
		Prompt:           "Continue queued work.",
		Environment: map[string]string{
			"VELA_CODEX_HELPER":      "1",
			"VELA_CODEX_HELPER_MODE": "resume-missing-require-notice",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer session.Stop(context.Background())
	if session.SessionID() != "thread-test" {
		t.Fatalf("session ID = %q, want fresh thread", session.SessionID())
	}
}

func TestDriverSteersActiveTurn(t *testing.T) {
	t.Parallel()

	driver := New(Options{
		Executable: os.Args[0],
		ArgsPrefix: []string{"-test.run=TestCodexAppServerHelper", "--"},
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	session, err := driver.Start(ctx, runtimeapi.StartRequest{
		AgentID:          "agent-1",
		LaunchID:         "launch-steer",
		WorkingDirectory: t.TempDir(),
		Prompt:           "initial",
		Environment: map[string]string{
			"VELA_CODEX_HELPER":      "1",
			"VELA_CODEX_HELPER_MODE": "busy-steer",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer session.Stop(context.Background())
	_ = waitForRuntimeEvent(t, session.Events(), runtimeapi.EventThinking)
	steerer, ok := session.(runtimeapi.NativeSteerer)
	if !ok {
		t.Fatalf("session type %T does not expose NativeSteerer", session)
	}
	if _, ok := session.(runtimeapi.NativeTurnInterrupter); ok {
		t.Fatalf("session type %T unexpectedly exposes NativeTurnInterrupter", session)
	}
	deliverCtx, deliverCancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer deliverCancel()
	if err := steerer.Steer(deliverCtx, runtimeapi.Delivery{Text: "steer this turn"}); err != nil {
		t.Fatal(err)
	}
	message := waitForRuntimeEvent(t, session.Events(), runtimeapi.EventAssistantText)
	if message.Text != "steered response" {
		t.Fatalf("assistant message = %#v", message)
	}
	_ = waitForRuntimeEvent(t, session.Events(), runtimeapi.EventTurnCompletion)
}

func TestDriverReturnsTypedBoundaryRetryWhenLocalSteeringGateIsClosed(t *testing.T) {
	t.Parallel()

	driver := New(Options{
		Executable: os.Args[0],
		ArgsPrefix: []string{"-test.run=TestCodexAppServerHelper", "--"},
	})
	runtimeSession, err := driver.Start(context.Background(), runtimeapi.StartRequest{
		AgentID:          "agent-1",
		LaunchID:         "launch-steer-gated",
		WorkingDirectory: t.TempDir(),
		Prompt:           "initial",
		Environment: map[string]string{
			"VELA_CODEX_HELPER":      "1",
			"VELA_CODEX_HELPER_MODE": "busy-steer",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer runtimeSession.Stop(context.Background())
	_ = waitForRuntimeEvent(t, runtimeSession.Events(), runtimeapi.EventThinking)

	nativeSession := runtimeSession.(*session)
	nativeSession.mu.Lock()
	nativeSession.steeringGate = true
	nativeSession.mu.Unlock()

	steerer, ok := runtimeSession.(runtimeapi.NativeSteerer)
	if !ok {
		t.Fatalf("session type %T does not expose NativeSteerer", runtimeSession)
	}
	err = steerer.Steer(
		context.Background(),
		runtimeapi.Delivery{Text: "retry at the next turn boundary"},
	)
	disposition, retryable := runtimeapi.DeliveryRetryDisposition(err)
	if !retryable ||
		disposition != runtimeapi.RetryTurnBoundary ||
		!errors.Is(err, ErrBusySteeringUnavailable) {
		t.Fatalf(
			"Steer() error = %#v, disposition = %q, retryable = %v",
			err,
			disposition,
			retryable,
		)
	}
}

func TestDriverReturnsTypedBusyDeliveryRejection(t *testing.T) {
	t.Parallel()

	driver := New(Options{
		Executable: os.Args[0],
		ArgsPrefix: []string{"-test.run=TestCodexAppServerHelper", "--"},
	})
	session, err := driver.Start(context.Background(), runtimeapi.StartRequest{
		AgentID:          "agent-1",
		LaunchID:         "launch-steer-reject",
		WorkingDirectory: t.TempDir(),
		Prompt:           "initial",
		Environment: map[string]string{
			"VELA_CODEX_HELPER":      "1",
			"VELA_CODEX_HELPER_MODE": "busy-steer-reject",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer session.Stop(context.Background())
	_ = waitForRuntimeEvent(t, session.Events(), runtimeapi.EventThinking)
	err = session.Deliver(
		context.Background(),
		runtimeapi.Delivery{Text: "rejected steer"},
	)
	disposition, retryable := runtimeapi.DeliveryRetryDisposition(err)
	var native *rpcRequestError
	if !retryable ||
		disposition != runtimeapi.RetryTurnBoundary ||
		!errors.As(err, &native) ||
		native.Method != "turn/steer" {
		t.Fatalf(
			"Deliver() error = %#v, disposition = %q, native = %#v",
			err,
			disposition,
			native,
		)
	}
	_ = waitForRuntimeEvent(t, session.Events(), runtimeapi.EventTurnCompletion)
}

func TestDriverSessionOutlivesSuccessfulStartupContext(t *testing.T) {
	t.Parallel()

	driver := New(Options{
		Executable: os.Args[0],
		ArgsPrefix: []string{"-test.run=TestCodexAppServerHelper", "--"},
	})
	startCtx, cancelStart := context.WithCancel(context.Background())
	session, err := driver.Start(startCtx, runtimeapi.StartRequest{
		AgentID:          "agent-1",
		LaunchID:         "launch-detached",
		WorkingDirectory: t.TempDir(),
		Environment: map[string]string{
			"VELA_CODEX_HELPER": "1",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer session.Stop(context.Background())
	cancelStart()
	time.Sleep(100 * time.Millisecond)

	deliverCtx, cancelDeliver := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancelDeliver()
	if err := session.Deliver(deliverCtx, runtimeapi.Delivery{
		Text: "continue after startup",
	}); err != nil {
		t.Fatalf("Deliver() after startup context cancellation: %v", err)
	}
	message := waitForRuntimeEvent(
		t,
		session.Events(),
		runtimeapi.EventAssistantText,
	)
	if message.Text != "hello from fake Codex" {
		t.Fatalf("assistant message = %#v", message)
	}
}

func TestDriverReportsNativeProcessLiveness(t *testing.T) {
	t.Parallel()

	driver := New(Options{
		Executable: os.Args[0],
		ArgsPrefix: []string{"-test.run=TestCodexAppServerHelper", "--"},
	})
	startCtx, cancelStart := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancelStart()
	session, err := driver.Start(startCtx, runtimeapi.StartRequest{
		AgentID:          "agent-1",
		LaunchID:         "launch-liveness",
		WorkingDirectory: t.TempDir(),
		Environment: map[string]string{
			"VELA_CODEX_HELPER": "1",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	prober, ok := session.(runtimeapi.LivenessProber)
	if !ok {
		t.Fatal("Codex session does not expose optional liveness")
	}
	if got := prober.RuntimeLiveness(); got != runtimeapi.LivenessAlive {
		t.Fatalf("running Codex liveness = %q, want alive", got)
	}
	stopCtx, cancelStop := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancelStop()
	if err := session.Stop(stopCtx); err != nil {
		t.Fatal(err)
	}
	if got := prober.RuntimeLiveness(); got != runtimeapi.LivenessDead {
		t.Fatalf("stopped Codex liveness = %q, want dead", got)
	}
}

func TestDriverDeclaresDirectBusyDelivery(t *testing.T) {
	t.Parallel()

	policy := runtimePolicy()
	if !policy.SupportsStdin ||
		policy.BusyMode != runtimeapi.BusyDeliveryDirect ||
		policy.Completion != runtimeapi.CompletionEvent {
		t.Fatalf("Codex Runtime policy = %#v", policy)
	}
}

func TestDriverReportsAppServerCrashDuringInitialization(t *testing.T) {
	t.Parallel()

	driver := New(Options{
		Executable: os.Args[0],
		ArgsPrefix: []string{"-test.run=TestCodexAppServerHelper", "--"},
	})
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, err := driver.Start(ctx, runtimeapi.StartRequest{
		AgentID:          "agent-1",
		LaunchID:         "launch-crash",
		WorkingDirectory: t.TempDir(),
		Environment: map[string]string{
			"VELA_CODEX_HELPER":      "1",
			"VELA_CODEX_HELPER_MODE": "crash-initialize",
		},
	})
	if err == nil || !strings.Contains(err.Error(), "initialize Codex app-server") {
		t.Fatalf("Start() error = %v", err)
	}
}

func waitForRuntimeEvent(
	t *testing.T,
	events <-chan runtimeapi.Event,
	kind runtimeapi.EventKind,
) runtimeapi.Event {
	t.Helper()
	timeout := time.NewTimer(5 * time.Second)
	defer timeout.Stop()
	var observed []runtimeapi.Event
	for {
		select {
		case event, ok := <-events:
			if !ok {
				t.Fatalf(
					"event stream closed while waiting for %s; observed %#v",
					kind,
					observed,
				)
			}
			if event.Kind == kind {
				return event
			}
			observed = append(observed, event)
		case <-timeout.C:
			t.Fatalf("timed out waiting for %s; observed %#v", kind, observed)
		}
	}
}

func helperWrite(value any) {
	data, err := common.Marshal(value)
	if err != nil {
		os.Exit(3)
	}
	_, _ = os.Stdout.Write(append(data, '\n'))
}

type codexHelperUnsupportedResponse struct {
	ID      string
	Code    int
	Message string
}

func wantUnsupportedServerRequestMessage(method string) string {
	return `Codex app-server request "` + method +
		`" is not supported by the non-interactive Vela daemon`
}

func wantUnsupportedInitializeResultMessage() string {
	return "Codex app-server initialize response is missing the expected " +
		"userAgent handshake field; upgrade Codex CLI to a compatible " +
		"app-server build."
}

func waitCodexHelperUnsupportedResponses(
	t *testing.T,
	path string,
	minimum int,
) []codexHelperUnsupportedResponse {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for {
		raw, err := os.ReadFile(path)
		responses := decodeCodexHelperUnsupportedResponses(t, raw)
		if len(responses) >= minimum {
			return responses
		}
		if time.Now().After(deadline) {
			t.Fatalf(
				"read unsupported Codex responses from %s: %v (log=%q)",
				path,
				err,
				raw,
			)
		}
		time.Sleep(25 * time.Millisecond)
	}
}

func decodeCodexHelperUnsupportedResponses(
	t *testing.T,
	raw []byte,
) []codexHelperUnsupportedResponse {
	t.Helper()
	var responses []codexHelperUnsupportedResponse
	scanner := bufio.NewScanner(strings.NewReader(string(raw)))
	for scanner.Scan() {
		var response struct {
			ID    json.RawMessage `json:"id"`
			Error struct {
				Code    int    `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if common.Unmarshal(scanner.Bytes(), &response) != nil ||
			response.Error.Code != -32601 {
			continue
		}
		responses = append(responses, codexHelperUnsupportedResponse{
			ID:      strings.TrimSpace(string(response.ID)),
			Code:    response.Error.Code,
			Message: response.Error.Message,
		})
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	return responses
}

func appendCodexHelperResponse(raw []byte) {
	path := strings.TrimSpace(os.Getenv("VELA_CODEX_HELPER_RESPONSE_LOG"))
	if path == "" {
		return
	}
	file, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		os.Exit(5)
	}
	defer file.Close()
	if _, err := file.Write(append(append([]byte(nil), raw...), '\n')); err != nil {
		os.Exit(6)
	}
}

func appendCodexHelperRequest(raw []byte) {
	path := strings.TrimSpace(os.Getenv("VELA_CODEX_HELPER_REQUEST_LOG"))
	if path == "" {
		return
	}
	file, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		os.Exit(7)
	}
	defer file.Close()
	if _, err := file.Write(append(append([]byte(nil), raw...), '\n')); err != nil {
		os.Exit(8)
	}
}

func waitForCodexHelperRequest(
	t *testing.T,
	path string,
	method string,
) []byte {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		data, err := os.ReadFile(path)
		if err == nil {
			scanner := bufio.NewScanner(bytes.NewReader(data))
			for scanner.Scan() {
				raw := append([]byte(nil), scanner.Bytes()...)
				var request struct {
					Method string `json:"method"`
				}
				if common.Unmarshal(raw, &request) == nil &&
					request.Method == method {
					return raw
				}
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	data, _ := os.ReadFile(path)
	t.Fatalf("Codex helper capture %q does not contain %q: %s", path, method, data)
	return nil
}

func writeCodexModelCacheFixture(t *testing.T, home string) {
	t.Helper()
	cache := map[string]any{
		"models": []map[string]any{
			{
				"slug":         "cached-default",
				"display_name": "Cached Default",
				"visibility":   "public",
			},
			{
				"slug":       "cached-list",
				"visibility": "list",
			},
			{
				"slug":             "cached-falsy-visibility",
				"visibility":       false,
				"supported_in_api": 0,
			},
			{
				"slug":       "cached-private",
				"visibility": "private",
			},
			{
				"slug":             "cached-api-disabled",
				"supported_in_api": false,
			},
			{
				"slug":         "",
				"display_name": "missing slug",
			},
		},
	}
	raw, err := common.Marshal(cache)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(
		filepath.Join(home, "models_cache.json"),
		raw,
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(
		filepath.Join(home, "config.toml"),
		[]byte("# fixture\n  model = \"cached-default\"\n"),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
}

func writeCodexModelCache(
	t *testing.T,
	root string,
	cache map[string]any,
	config string,
) {
	t.Helper()
	raw, err := common.Marshal(cache)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(
		filepath.Join(root, "models_cache.json"),
		raw,
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	if config == "" {
		return
	}
	if err := os.WriteFile(
		filepath.Join(root, "config.toml"),
		[]byte(config),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
}

func assertCodexModelCacheFixture(
	t *testing.T,
	result runtimeapi.ModelResult,
) {
	t.Helper()
	want := runtimeapi.ModelResult{
		Models: []runtimeapi.Model{
			{
				ID:       "cached-default",
				Label:    "Cached Default",
				Verified: "launchable",
			},
			{
				ID:       "cached-list",
				Label:    "cached-list",
				Verified: "launchable",
			},
			{
				ID:       "cached-falsy-visibility",
				Label:    "cached-falsy-visibility",
				Verified: "launchable",
			},
		},
		Default: "cached-default",
	}
	if !reflect.DeepEqual(result, want) {
		t.Fatalf("cached model result = %#v, want %#v", result, want)
	}
}

func helperTurnText(params map[string]any) string {
	input, _ := params["input"].([]any)
	for _, item := range input {
		fields, _ := item.(map[string]any)
		if text, _ := fields["text"].(string); text != "" {
			return text
		}
	}
	return ""
}

func TestSessionLiveStdoutIgnoresMalformedAndNonObjectLinesBeforeValidFrame(t *testing.T) {
	t.Parallel()

	valid, err := common.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"method":  "thread/started",
		"params": map[string]any{
			"thread": map[string]any{"id": "thread-after-junk"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	input := append([]byte(
		"\n \t\n{not-json}\nnull\nfalse\n0\n\"\"\n\"truthy\"\n[]\n{}\n",
	), valid...)
	input = append(input, '\n')

	events := readLiveStdoutEvents(bytes.NewReader(input))
	if len(events) != 1 ||
		events[0].Kind != runtimeapi.EventSession ||
		events[0].SessionID != "thread-after-junk" {
		t.Fatalf("live stdout events = %#v, want one following session event", events)
	}
}

func TestDecodeRPCMessagePreservesMalformedErrorEnvelopeFacts(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name        string
		errorValue  string
		wantMessage string
	}{
		{name: "null", errorValue: `null`},
		{name: "false", errorValue: `false`},
		{name: "zero", errorValue: `0`},
		{name: "empty string", errorValue: `""`},
		{name: "true", errorValue: `true`},
		{name: "nonzero", errorValue: `1`},
		{name: "string", errorValue: `"failure"`},
		{name: "array", errorValue: `[]`},
		{name: "empty object", errorValue: `{}`},
		{
			name:        "valid message with malformed code",
			errorValue:  `{"code":"not-an-integer","message":"kept message"}`,
			wantMessage: "kept message",
		},
		{name: "falsy nested message", errorValue: `{"message":false}`},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			raw := []byte(
				`{"jsonrpc":"2.0","id":1,"error":` +
					test.errorValue +
					`}`,
			)
			message, err := decodeRPCMessage(raw)
			if err != nil {
				t.Fatalf("decodeRPCMessage() error = %v", err)
			}
			if !message.isResponse() || !message.hasError {
				t.Fatalf("decoded envelope = %#v, want owned error response", message)
			}
			if message.Error == nil {
				t.Fatalf("decoded error = nil, want retained error facts")
			}
			if message.Error.Message != test.wantMessage {
				t.Fatalf(
					"decoded error message = %q, want %q",
					message.Error.Message,
					test.wantMessage,
				)
			}
		})
	}
}

func TestRPCMessagePendingIDMatchesJavaScriptNumericIdentity(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		id   string
		want int64
		ok   bool
	}{
		{name: "integer", id: `1`, want: 1, ok: true},
		{name: "decimal integer", id: `1.0`, want: 1, ok: true},
		{name: "exponent integer", id: `1e0`, want: 1, ok: true},
		{name: "fractional", id: `1.5`},
		{name: "zero", id: `0`},
		{name: "negative zero", id: `-0`},
		{name: "negative", id: `-1`},
		{name: "string", id: `"1"`},
		{name: "null", id: `null`},
		{name: "overflow", id: `9223372036854775808`},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			message, err := decodeRPCMessage(
				[]byte(`{"jsonrpc":"2.0","id":` + test.id + `,"result":{}}`),
			)
			if err != nil {
				t.Fatal(err)
			}
			got, ok := message.pendingID()
			if got != test.want || ok != test.ok {
				t.Fatalf(
					"pendingID(%s) = (%d, %t), want (%d, %t)",
					test.id,
					got,
					ok,
					test.want,
					test.ok,
				)
			}
		})
	}
}

func TestSessionRequestsUseOfficialErrorPresenceAndPrecedence(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name        string
		method      string
		response    string
		wantError   bool
		wantMessage string
	}{
		{
			name:   "initialize result wins over error",
			method: "initialize",
			response: `{"jsonrpc":"2.0","id":1,` +
				`"result":{"userAgent":"compatible"},` +
				`"error":{"code":7,"message":"must not win"}}`,
		},
		{
			name:        "thread error wins over result",
			method:      "thread/start",
			response:    `{"jsonrpc":"2.0","id":1,"result":{"thread":{"id":"wrong"}},"error":{"message":"thread failed"}}`,
			wantError:   true,
			wantMessage: "thread failed",
		},
		{
			name:        "turn null error is pending failure",
			method:      "turn/start",
			response:    `{"jsonrpc":"2.0","id":1,"error":null}`,
			wantError:   true,
			wantMessage: "Codex app-server request failed",
		},
		{
			name:        "delivery false error is pending failure",
			method:      "turn/steer",
			response:    `{"jsonrpc":"2.0","id":1,"error":false}`,
			wantError:   true,
			wantMessage: "Codex app-server request failed",
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			message, err := requestSessionWithResponse(
				t,
				test.method,
				[]byte(test.response),
			)
			if (err != nil) != test.wantError {
				t.Fatalf("request error = %v, wantError = %t", err, test.wantError)
			}
			if test.wantMessage != "" &&
				!strings.Contains(err.Error(), test.wantMessage) {
				t.Fatalf("request error = %v, want message %q", err, test.wantMessage)
			}
			if !test.wantError && len(message.Result) == 0 {
				t.Fatalf("successful response lost result: %#v", message)
			}
		})
	}
}

func TestSessionLiveStdoutMatchesUnclaimedMalformedErrorTruthiness(t *testing.T) {
	t.Parallel()

	input := strings.Join([]string{
		`{"jsonrpc":"2.0","id":101,"error":null}`,
		`{"jsonrpc":"2.0","id":102,"error":false}`,
		`{"jsonrpc":"2.0","id":103,"error":0}`,
		`{"jsonrpc":"2.0","id":104,"error":""}`,
		`{"jsonrpc":"2.0","id":105,"error":true}`,
		`{"jsonrpc":"2.0","id":106,"error":1}`,
		`{"jsonrpc":"2.0","id":107,"error":"failure"}`,
		`{"jsonrpc":"2.0","id":108,"error":[]}`,
		`{"jsonrpc":"2.0","id":109,"error":{}}`,
		`{"jsonrpc":"2.0","id":110,"error":{"code":"bad","message":"kept message"}}`,
		`{"jsonrpc":"2.0","method":"thread/started","params":{"thread":{"id":"thread-after-errors"}}}`,
		"",
	}, "\n")

	events := readLiveStdoutEvents(strings.NewReader(input))
	if len(events) != 7 {
		t.Fatalf("live stdout events = %#v, want six errors and one session", events)
	}
	for index, event := range events[:5] {
		if event.Kind != runtimeapi.EventError ||
			event.Text != "Codex app-server request failed" {
			t.Fatalf("fallback error %d = %#v", index, event)
		}
	}
	if event := events[5]; event.Kind != runtimeapi.EventError ||
		event.Text != "kept message" {
		t.Fatalf("compatible nested error = %#v", event)
	}
	if event := events[6]; event.Kind != runtimeapi.EventSession ||
		event.SessionID != "thread-after-errors" {
		t.Fatalf("following session = %#v", event)
	}
}

func TestModelDiscoveryConsumesOwnedMalformedErrorWithoutWaiting(t *testing.T) {
	t.Parallel()

	message, err := decodeRPCMessage([]byte(
		`{"jsonrpc":"2.0","id":1,` +
			`"error":{"code":"bad","message":"owned discovery failure"}}`,
	))
	if err != nil {
		t.Fatalf("decodeRPCMessage() error = %v", err)
	}
	messages := make(chan rpcMessage, 1)
	messages <- message
	readErrors := make(chan error)
	done := make(chan struct{})
	client := modelDiscoveryClient{
		stdin:      discardWriteCloser{Writer: io.Discard},
		messages:   messages,
		readErrors: readErrors,
		done:       done,
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_, err = client.request(ctx, "model/list", map[string]any{})
	if err == nil || !strings.Contains(err.Error(), "owned discovery failure") {
		t.Fatalf("model discovery request error = %v", err)
	}
}

func TestSessionLiveStdoutIgnoresUnterminatedFinalFrame(t *testing.T) {
	t.Parallel()

	valid, err := common.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"method":  "thread/started",
		"params": map[string]any{
			"thread": map[string]any{"id": "thread-unterminated"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name  string
		input []byte
	}{
		{name: "valid JSON", input: valid},
		{name: "invalid JSON", input: []byte(`{unterminated`)},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if events := readLiveStdoutEvents(bytes.NewReader(test.input)); len(events) != 0 {
				t.Fatalf("unterminated stdout events = %#v, want none", events)
			}
		})
	}
}

func TestSessionLiveStdoutProcessesNewlineTerminatedFrameBeyondScannerLimit(t *testing.T) {
	t.Parallel()

	frame, err := common.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"method":  "thread/started",
		"params": map[string]any{
			"thread":  map[string]any{"id": "thread-oversized"},
			"padding": strings.Repeat("x", maximumRPCLine),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	frame = append(frame, '\n')

	events := readLiveStdoutEvents(bytes.NewReader(frame))
	if len(events) != 1 ||
		events[0].Kind != runtimeapi.EventSession ||
		events[0].SessionID != "thread-oversized" {
		t.Fatalf("oversized stdout events = %#v, want one session event", events)
	}
}

func TestSessionLiveStdoutReadFailureDoesNotEmitRuntimeError(t *testing.T) {
	t.Parallel()

	if events := readLiveStdoutEvents(failingCodexStdoutReader{}); len(events) != 0 {
		t.Fatalf("failed stdout reader events = %#v, want none", events)
	}
}

func TestSessionLiveStdoutCanTraceMethodNamesWithoutPayloads(t *testing.T) {
	t.Setenv("VELA_TRACE_CODEX_METHODS", "1")

	tracePath := filepath.Join(t.TempDir(), "codex-methods.log")
	traceFile, err := os.OpenFile(tracePath, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	originalStderr := os.Stderr
	os.Stderr = traceFile
	t.Cleanup(func() {
		os.Stderr = originalStderr
		_ = traceFile.Close()
	})

	const secret = "must-not-enter-method-trace"
	input := strings.Join([]string{
		`{"jsonrpc":"2.0","method":"turn/completed","params":{"secret":"` + secret + `"}}`,
		`{"jsonrpc":"2.0","id":9,"result":{"secret":"` + secret + `"}}`,
		"",
	}, "\n")
	_ = readLiveStdoutEvents(strings.NewReader(input))

	if err := traceFile.Sync(); err != nil {
		t.Fatal(err)
	}
	trace, err := os.ReadFile(tracePath)
	if err != nil {
		t.Fatal(err)
	}
	const want = "codex rpc method=\"turn/completed\"\n" +
		"codex runtime event=\"turn_completion\" emitted=true\n"
	if got := string(trace); got != want {
		t.Fatalf("method trace = %q, want %q", got, want)
	}
	if bytes.Contains(trace, []byte(secret)) {
		t.Fatalf("method trace leaked payload: %q", trace)
	}
}

func TestSessionLiveStdoutTracesCompletionThreadMatchWithoutIdentityValue(t *testing.T) {
	t.Setenv("VELA_TRACE_CODEX_METHODS", "1")

	tracePath := filepath.Join(t.TempDir(), "codex-completion-identity.log")
	traceFile, err := os.OpenFile(tracePath, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	originalStderr := os.Stderr
	os.Stderr = traceFile
	t.Cleanup(func() {
		os.Stderr = originalStderr
		_ = traceFile.Close()
	})

	const secret = "must-not-enter-completion-trace"
	testSession := newNormalizationTestSession()
	testSession.thread = "thread-current"
	testSession.startupDone = make(chan struct{})
	close(testSession.startupDone)
	testSession.readStdout(strings.NewReader(
		`{"jsonrpc":"2.0","method":"turn/completed","params":{` +
			`"threadId":"thread-secondary","secret":"` + secret + `"}}` + "\n",
	))

	if err := traceFile.Sync(); err != nil {
		t.Fatal(err)
	}
	trace, err := os.ReadFile(tracePath)
	if err != nil {
		t.Fatal(err)
	}
	const want = "codex rpc method=\"turn/completed\" " +
		"thread_identity=present thread_match=false\n"
	if got := string(trace); got != want {
		t.Fatalf("completion identity trace = %q, want %q", got, want)
	}
	if bytes.Contains(trace, []byte("thread-current")) ||
		bytes.Contains(trace, []byte("thread-secondary")) ||
		bytes.Contains(trace, []byte(secret)) {
		t.Fatalf("completion identity trace leaked identity or payload: %q", trace)
	}
}

func TestSessionLiveStdoutTracesMatchingCompletionEmission(t *testing.T) {
	t.Setenv("VELA_TRACE_CODEX_METHODS", "1")

	tracePath := filepath.Join(t.TempDir(), "codex-completion-emission.log")
	traceFile, err := os.OpenFile(tracePath, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	originalStderr := os.Stderr
	os.Stderr = traceFile
	t.Cleanup(func() {
		os.Stderr = originalStderr
		_ = traceFile.Close()
	})

	testSession := newNormalizationTestSession()
	testSession.thread = "thread-current"
	testSession.startupDone = make(chan struct{})
	close(testSession.startupDone)
	testSession.readStdout(strings.NewReader(
		`{"jsonrpc":"2.0","method":"turn/completed","params":{` +
			`"threadId":"thread-current","turn":{"id":"turn-1","status":"completed"}}}` + "\n",
	))

	if err := traceFile.Sync(); err != nil {
		t.Fatal(err)
	}
	trace, err := os.ReadFile(tracePath)
	if err != nil {
		t.Fatal(err)
	}
	const want = "codex rpc method=\"turn/completed\" " +
		"thread_identity=present thread_match=true\n" +
		"codex runtime event=\"turn_completion\" emitted=true\n"
	if got := string(trace); got != want {
		t.Fatalf("matching completion trace = %q, want %q", got, want)
	}
	if bytes.Contains(trace, []byte("thread-current")) ||
		bytes.Contains(trace, []byte("turn-1")) {
		t.Fatalf("matching completion trace leaked identity: %q", trace)
	}
}

type failingCodexStdoutReader struct{}

func (failingCodexStdoutReader) Read([]byte) (int, error) {
	return 0, errors.New("fixture stdout failure")
}

type discardWriteCloser struct {
	io.Writer
}

func (discardWriteCloser) Close() error {
	return nil
}

func requestSessionWithResponse(
	t *testing.T,
	method string,
	rawResponse []byte,
) (rpcMessage, error) {
	t.Helper()
	testSession := &session{
		stdin:         discardWriteCloser{Writer: io.Discard},
		pending:       make(map[int64]chan rpcMessage),
		pendingMethod: make(map[int64]string),
		pendingInput:  make(map[int64]acceptedInputEvidence),
		done:          make(chan struct{}),
	}
	type outcome struct {
		message rpcMessage
		err     error
	}
	result := make(chan outcome, 1)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	go func() {
		message, err := testSession.request(ctx, method, map[string]any{})
		result <- outcome{message: message, err: err}
	}()

	deadline := time.Now().Add(time.Second)
	for {
		testSession.mu.Lock()
		_, pending := testSession.pending[1]
		testSession.mu.Unlock()
		if pending {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("request did not register pending ID 1")
		}
		time.Sleep(time.Millisecond)
	}
	message, err := decodeRPCMessage(rawResponse)
	if err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if !testSession.resolvePending(1, message) {
		t.Fatal("response did not resolve pending ID 1")
	}
	response := <-result
	return response.message, response.err
}

func readLiveStdoutEvents(reader io.Reader) []runtimeapi.Event {
	session := newNormalizationTestSession()
	session.startupDone = make(chan struct{})
	close(session.startupDone)
	session.readStdout(reader)

	var events []runtimeapi.Event
	for event := range session.events {
		events = append(events, event)
	}
	return events
}

func newNormalizationTestSession() *session {
	return &session{
		events:   make(chan runtimeapi.Event, 32),
		done:     make(chan struct{}),
		launchID: "launch-1",
	}
}

func mustCodexParams(t *testing.T, value any) []byte {
	t.Helper()
	data, err := common.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return data
}
