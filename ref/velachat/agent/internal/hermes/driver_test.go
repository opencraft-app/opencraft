package hermes

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"velachat/agent/internal/common"
	"velachat/agent/internal/runtimeapi"
	"velachat/agent/internal/runtimeprompt"
)

type hermesTestSession = session

func TestDriverProbeValidatesHermesACP(t *testing.T) {
	driver := New(Options{
		Executable: os.Args[0],
		ArgsPrefix: []string{"-test.run=TestHermesACPHelperProcess", "--"},
		Version:    "test-client",
	})
	driver.containerEvidence = noContainerEvidence
	t.Setenv("GO_WANT_HERMES_ACP_HELPER", "1")

	result, err := driver.Probe(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !result.Available || result.Version != "Hermes Agent v-test" {
		t.Fatalf("probe = %#v", result)
	}
}

func TestDriverDiscoversCapabilitiesFromEachManagedProfile(t *testing.T) {
	driver, first, _ := newManagedHermesTestDriver(t, "agent-profile-a")
	if _, err := driver.PrepareManagedHost(context.Background(), "agent-profile-a"); err != nil {
		t.Fatal(err)
	}
	writeHermesCapabilityFixture(t, first.Home, "model-a", "skill-a")
	second, err := managedProfileSelection(driver.trustedHome, "agent-profile-b")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := driver.PrepareManagedHost(context.Background(), "agent-profile-b"); err != nil {
		t.Fatal(err)
	}
	writeHermesCapabilityFixture(t, second.Home, "model-b", "skill-b")

	firstResult, err := driver.DiscoverProfileCapabilities(
		context.Background(), runtimeapi.ProfileCapabilityRequest{
			AgentID: "agent-profile-a", WorkingDirectory: t.TempDir(),
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	secondResult, err := driver.DiscoverProfileCapabilities(
		context.Background(), runtimeapi.ProfileCapabilityRequest{
			AgentID: "agent-profile-b", WorkingDirectory: t.TempDir(),
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	firstSkills := make(map[string]struct{}, len(firstResult.Skills))
	for _, skill := range firstResult.Skills {
		firstSkills[skill.Name] = struct{}{}
	}
	secondSkills := make(map[string]struct{}, len(secondResult.Skills))
	for _, skill := range secondResult.Skills {
		secondSkills[skill.Name] = struct{}{}
	}
	if firstResult.ProfileHome != first.Home ||
		firstResult.Models.Default != "model-a" ||
		len(firstResult.Skills) != 2 {
		t.Fatalf("first Profile capabilities = %#v", firstResult)
	}
	if _, ok := firstSkills["skill-a"]; !ok {
		t.Fatalf("first Profile missing skill-a: %#v", firstResult.Skills)
	}
	if _, ok := firstSkills["vela"]; !ok {
		t.Fatalf("first Profile missing managed Vela Skill: %#v", firstResult.Skills)
	}
	if secondResult.ProfileHome != second.Home ||
		secondResult.Models.Default != "model-b" ||
		len(secondResult.Skills) != 2 {
		t.Fatalf("second Profile capabilities = %#v", secondResult)
	}
	if _, ok := secondSkills["skill-b"]; !ok {
		t.Fatalf("second Profile missing skill-b: %#v", secondResult.Skills)
	}
	if _, ok := secondSkills["vela"]; !ok {
		t.Fatalf("second Profile missing managed Vela Skill: %#v", secondResult.Skills)
	}
}

func writeHermesCapabilityFixture(
	t *testing.T,
	profileHome string,
	model string,
	skill string,
) {
	t.Helper()
	if err := os.WriteFile(
		filepath.Join(profileHome, "config.yaml"),
		[]byte("model: "+model+"\n"),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	directory := filepath.Join(profileHome, "skills", skill)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(
		filepath.Join(directory, "SKILL.md"),
		[]byte("---\nname: "+skill+"\ndescription: Profile skill\n---\n"),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
}

func TestDriverDiscoversTrustedHomeLocalBinOutsidePATH(t *testing.T) {
	trustedHome := t.TempDir()
	hermesPath := filepath.Join(trustedHome, ".local", "bin", "hermes")
	if err := os.MkdirAll(filepath.Dir(hermesPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(hermesPath, []byte("fixture"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", t.TempDir())
	driver := New(Options{TrustedHome: trustedHome})

	candidates := driver.executableCandidates()
	if len(candidates) != 1 || candidates[0].Path != hermesPath {
		t.Fatalf("executableCandidates() = %#v", candidates)
	}
}

func TestDriverProbeRequiresManagedProfileCreateCapabilities(t *testing.T) {
	driver := New(Options{
		Executable: os.Args[0],
		ArgsPrefix: []string{"-test.run=TestHermesACPHelperProcess", "--"},
		Version:    "test-client",
	})
	driver.containerEvidence = noContainerEvidence
	t.Setenv("GO_WANT_HERMES_ACP_HELPER", "1")
	t.Setenv("HERMES_HELPER_PROFILE_HELP", "missing-no-alias")

	result, err := driver.Probe(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.Available {
		t.Fatalf("incompatible Profile CLI was advertised: %#v", result)
	}
	if !strings.Contains(result.Diagnostic, "--no-alias") {
		t.Fatalf("Profile compatibility diagnostic = %q", result.Diagnostic)
	}
}

func TestDriverProbeRejectsContainerInstallBeforeExecutable(t *testing.T) {
	t.Setenv("container", "docker")
	driver := New(Options{
		Executable: filepath.Join(t.TempDir(), "must-not-run"),
	})

	result, err := driver.Probe(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.Available ||
		!strings.Contains(strings.ToLower(result.Diagnostic), "container") {
		t.Fatalf("container Probe = %#v", result)
	}
}

func TestDriverDetectModelsRequiresCompatibleHermesACP(t *testing.T) {
	t.Parallel()

	driver := New(Options{Executable: filepath.Join(t.TempDir(), "missing-hermes")})
	result, err := driver.DetectModels(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !result.Unsupported || len(result.Models) != 0 || result.Default != "" {
		t.Fatalf("models = %#v, want unsupported", result)
	}
}

func TestDriverForwardsSharedStandingPolicyToFirstACPPrompt(t *testing.T) {
	driver, profile, home := newManagedHermesTestDriver(
		t,
		"agent-hermes-policy",
	)
	capturePath := filepath.Join(t.TempDir(), "helper-prompts.log")
	standingPrompt, err := runtimeprompt.ComposeStandingPrompt(
		"agent-hermes-policy",
		"Hermes-specific instructions",
	)
	if err != nil {
		t.Fatal(err)
	}
	currentInput := "Handle the current Hermes input."
	session, err := driver.Start(context.Background(), runtimeapi.StartRequest{
		AgentID:          "agent-hermes-policy",
		LaunchID:         "launch-hermes-policy",
		WorkingDirectory: t.TempDir(),
		Prompt:           currentInput,
		StandingPrompt:   standingPrompt,
		Environment: map[string]string{
			"GO_WANT_HERMES_ACP_HELPER": "1",
			"HERMES_EXPECT_PROFILE":     profile.Name,
			"HERMES_EXPECT_HOME":        home,
			"HERMES_HELPER_CAPTURE":     capturePath,
			"HOME":                      home,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer stopHermesTestSession(t, session)

	waitForHermesCapture(
		t,
		capturePath,
		"prompt:"+managedInitialPrompt(standingPrompt, currentInput),
	)
}

func TestDriverStartProvisionsManagedNativeProfileAndIgnoresCloudOverrides(
	t *testing.T,
) {
	trustedHome := t.TempDir()
	defaultHome := filepath.Join(trustedHome, ".hermes")
	if err := os.MkdirAll(defaultHome, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(
		filepath.Join(defaultHome, "active_profile"),
		[]byte("operator-sticky-profile\n"),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	cloudHome := t.TempDir()
	cloudHermesHome := filepath.Join(cloudHome, "cloud-selected-hermes")
	if err := os.MkdirAll(cloudHermesHome, 0o700); err != nil {
		t.Fatal(err)
	}
	agentID := "agent-managed-native-profile"
	selection, err := managedProfileSelection(trustedHome, agentID)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("GO_WANT_HERMES_ACP_HELPER", "1")
	driver := New(Options{
		Executable:  os.Args[0],
		ArgsPrefix:  []string{"-test.run=TestHermesACPHelperProcess", "--"},
		Version:     "test-client",
		TrustedHome: trustedHome,
	})
	driver.containerEvidence = noContainerEvidence
	session, err := driver.Start(context.Background(), runtimeapi.StartRequest{
		AgentID:          agentID,
		LaunchID:         "launch-managed",
		WorkingDirectory: t.TempDir(),
		Environment: map[string]string{
			"GO_WANT_HERMES_ACP_HELPER": "1",
			"HOME":                      cloudHome,
			"HERMES_HOME":               cloudHermesHome,
			"HERMES_PROFILE":            "cloud-selected-profile",
			"HERMES_EXPECT_PROFILE":     selection.Name,
			"HERMES_EXPECT_HOME":        trustedHome,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer stopHermesTestSession(t, session)

	provider, ok := session.(runtimeapi.RuntimeHomeProvider)
	if !ok {
		t.Fatal("Hermes session does not expose RuntimeHomeInfo")
	}
	info := provider.RuntimeHomeInfo()
	if info.ObservedDir != selection.Home ||
		info.ConfiguredDir != selection.Home ||
		!info.Explicit {
		t.Fatalf("managed Runtime home = %#v", info)
	}
	if err := validateManagedProfileMarker(selection, agentID); err != nil {
		t.Fatalf("managed Profile ownership = %v", err)
	}
	active, err := os.ReadFile(filepath.Join(defaultHome, "active_profile"))
	if err != nil || string(active) != "operator-sticky-profile\n" {
		t.Fatalf("default active Profile changed: data=%q err=%v", active, err)
	}
}

func TestDriverStartMapsACPEventsPermissionAndProfileHome(t *testing.T) {
	driver, profile, home := newManagedHermesTestDriver(t, "agent-1")
	workspace := t.TempDir()
	session, err := driver.Start(context.Background(), runtimeapi.StartRequest{
		AgentID:          "agent-1",
		LaunchID:         "launch-1",
		WorkingDirectory: workspace,
		Prompt:           "hello Hermes",
		Environment: map[string]string{
			"GO_WANT_HERMES_ACP_HELPER": "1",
			"HERMES_PROFILE":            "must-be-ignored",
			"HERMES_EXPECT_PROFILE":     profile.Name,
			"HERMES_EXPECT_HOME":        home,
			"HOME":                      home,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer stopHermesTestSession(t, session)

	if session.SessionID() != "hermes-session-1" {
		t.Fatalf("session id = %q", session.SessionID())
	}
	provider, ok := session.(runtimeapi.RuntimeHomeProvider)
	if !ok {
		t.Fatal("Hermes session does not expose RuntimeHomeInfo")
	}
	info := provider.RuntimeHomeInfo()
	if info.ObservedDir != profile.Home || info.ConfiguredDir != profile.Home ||
		!info.Explicit {
		t.Fatalf("runtime home = %#v", info)
	}

	wantKinds := map[runtimeapi.EventKind]bool{
		runtimeapi.EventSession:        false,
		runtimeapi.EventThinking:       false,
		runtimeapi.EventToolCall:       false,
		runtimeapi.EventToolOutput:     false,
		runtimeapi.EventAssistantText:  false,
		runtimeapi.EventUsage:          false,
		runtimeapi.EventTurnCompletion: false,
	}
	deadline := time.After(5 * time.Second)
	for {
		select {
		case event, ok := <-session.Events():
			if !ok {
				t.Fatal("Hermes events closed before turn completion")
			}
			if _, wanted := wantKinds[event.Kind]; wanted {
				wantKinds[event.Kind] = true
			}
			if event.Kind == runtimeapi.EventTurnCompletion {
				for kind, seen := range wantKinds {
					if !seen {
						t.Fatalf("missing %q event; observed = %#v", kind, wantKinds)
					}
				}
				return
			}
		case <-deadline:
			t.Fatalf("timed out waiting for Hermes events: %#v", wantKinds)
		}
	}
}

func TestDriverStartsTwoAgentsWithIndependentNativeProfilesAndWorkspaces(
	t *testing.T,
) {
	trustedHome := t.TempDir()
	if err := os.MkdirAll(
		filepath.Join(trustedHome, ".hermes"),
		0o700,
	); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GO_WANT_HERMES_ACP_HELPER", "1")
	driver := New(Options{
		Executable:  os.Args[0],
		ArgsPrefix:  []string{"-test.run=TestHermesACPHelperProcess", "--"},
		Version:     "test-client",
		TrustedHome: trustedHome,
	})
	driver.containerEvidence = noContainerEvidence

	type launch struct {
		agentID   string
		launchID  string
		workspace string
		capture   string
		selection profileSelection
		session   runtimeapi.RuntimeSession
		err       error
	}
	launches := []*launch{
		{
			agentID:   "agent-concurrent-a",
			launchID:  "launch-concurrent-a",
			workspace: t.TempDir(),
			capture:   filepath.Join(t.TempDir(), "a.log"),
		},
		{
			agentID:   "agent-concurrent-b",
			launchID:  "launch-concurrent-b",
			workspace: t.TempDir(),
			capture:   filepath.Join(t.TempDir(), "b.log"),
		},
	}
	for _, launch := range launches {
		selection, err := managedProfileSelection(
			trustedHome,
			launch.agentID,
		)
		if err != nil {
			t.Fatal(err)
		}
		launch.selection = selection
	}

	var wait sync.WaitGroup
	for _, launch := range launches {
		launch := launch
		wait.Add(1)
		go func() {
			defer wait.Done()
			launch.session, launch.err = driver.Start(
				context.Background(),
				runtimeapi.StartRequest{
					AgentID:          launch.agentID,
					LaunchID:         launch.launchID,
					WorkingDirectory: launch.workspace,
					Environment: map[string]string{
						"GO_WANT_HERMES_ACP_HELPER": "1",
						"HERMES_EXPECT_PROFILE":     launch.selection.Name,
						"HERMES_EXPECT_HOME":        trustedHome,
						"HERMES_EXPECT_WORKSPACE":   launch.workspace,
						"HERMES_HELPER_CAPTURE":     launch.capture,
					},
				},
			)
		}()
	}
	wait.Wait()
	for _, launch := range launches {
		if launch.err != nil {
			t.Fatalf("%s start: %v", launch.agentID, launch.err)
		}
		defer stopHermesTestSession(t, launch.session)
		provider, ok := launch.session.(runtimeapi.RuntimeHomeProvider)
		if !ok {
			t.Fatalf("%s has no Runtime home", launch.agentID)
		}
		info := provider.RuntimeHomeInfo()
		if info.ObservedDir != launch.selection.Home ||
			info.ConfiguredDir != launch.selection.Home {
			t.Fatalf("%s Runtime home = %#v", launch.agentID, info)
		}
		if err := validateManagedProfileMarker(
			launch.selection,
			launch.agentID,
		); err != nil {
			t.Fatalf("%s ownership: %v", launch.agentID, err)
		}
		processWorkspace, err := filepath.EvalSymlinks(launch.workspace)
		if err != nil {
			t.Fatal(err)
		}
		waitForHermesCapture(
			t,
			launch.capture,
			"acp-cwd:"+processWorkspace,
		)
		waitForHermesCapture(
			t,
			launch.capture,
			"session-cwd:"+launch.workspace,
		)
	}
	if launches[0].selection.Home == launches[1].selection.Home {
		t.Fatal("two Agents shared one Hermes Profile")
	}
}

func TestDriverBusyDeliveryKeepsRootAuthoritativeUntilPromptFamilyDrains(t *testing.T) {
	driver, profile, home := newManagedHermesTestDriver(t, "agent-2")
	capturePath := filepath.Join(t.TempDir(), "helper-events.log")
	releaseFirstPath := filepath.Join(t.TempDir(), "release-first-prompt")
	session, err := driver.Start(context.Background(), runtimeapi.StartRequest{
		AgentID:          "agent-2",
		LaunchID:         "launch-2",
		WorkingDirectory: t.TempDir(),
		Prompt:           "long initial task",
		Environment: map[string]string{
			"GO_WANT_HERMES_ACP_HELPER":        "1",
			"HERMES_EXPECT_PROFILE":            profile.Name,
			"HERMES_EXPECT_HOME":               home,
			"HERMES_HELPER_HOLD_FIRST":         "1",
			"HERMES_HELPER_CAPTURE":            capturePath,
			"HERMES_HELPER_RELEASE_FIRST_FILE": releaseFirstPath,
			"HOME":                             home,
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	deliverCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := session.Deliver(deliverCtx, runtimeapi.Delivery{
		Text: "change direction",
		Mode: "busy",
	}); err != nil {
		t.Fatal(err)
	}
	waitForHermesCapture(t, capturePath, "redirect:change direction")
	assertNoHermesCompletion(t, session.Events(), 150*time.Millisecond)
	if err := os.WriteFile(releaseFirstPath, []byte("release\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	completion := waitForHermesEvent(t, session.Events(), runtimeapi.EventTurnCompletion)
	if completion.Detail != "root_done" {
		t.Fatalf("Hermes completion = %#v, want root response", completion)
	}

	stopCtx, stopCancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer stopCancel()
	if err := session.Stop(stopCtx); err != nil {
		t.Fatal(err)
	}
	for event := range session.Events() {
		if event.Kind == runtimeapi.EventTurnCompletion {
			t.Fatalf("Hermes prompt family emitted a second completion: %#v", event)
		}
	}
}

func TestDriverStopFencesCancelledPromptCompletion(t *testing.T) {
	driver, profile, home := newManagedHermesTestDriver(t, "agent-stop-fence")
	capturePath := filepath.Join(t.TempDir(), "helper-events.log")
	session, err := driver.Start(context.Background(), runtimeapi.StartRequest{
		AgentID:          "agent-stop-fence",
		LaunchID:         "launch-stop-fence",
		WorkingDirectory: t.TempDir(),
		Prompt:           "hold until stopped",
		Environment: map[string]string{
			"GO_WANT_HERMES_ACP_HELPER": "1",
			"HERMES_EXPECT_PROFILE":     profile.Name,
			"HERMES_EXPECT_HOME":        home,
			"HERMES_HELPER_HOLD_FIRST":  "1",
			"HERMES_HELPER_CAPTURE":     capturePath,
			"HOME":                      home,
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	stopCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := session.Stop(stopCtx); err != nil {
		t.Fatal(err)
	}
	waitForHermesCapture(t, capturePath, "cancel:hermes-session-1")
	for event := range session.Events() {
		if event.Kind == runtimeapi.EventTurnCompletion {
			t.Fatalf("Stop projected cancelled prompt as completion: %#v", event)
		}
	}
}

func TestDriverStopKillsInterruptResistantHermes(t *testing.T) {
	driver, profile, home := newManagedHermesTestDriver(t, "agent-ignore-stop")
	session, err := driver.Start(context.Background(), runtimeapi.StartRequest{
		AgentID:          "agent-ignore-stop",
		LaunchID:         "launch-ignore-stop",
		WorkingDirectory: t.TempDir(),
		Prompt:           "ignore ordinary stop",
		Environment: map[string]string{
			"GO_WANT_HERMES_ACP_HELPER": "1",
			"HERMES_EXPECT_PROFILE":     profile.Name,
			"HERMES_EXPECT_HOME":        home,
			"HERMES_HELPER_HOLD_FIRST":  "1",
			"HERMES_HELPER_IGNORE_STOP": "1",
			"HOME":                      home,
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	stopCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	started := time.Now()
	if err := session.Stop(stopCtx); err != nil {
		t.Fatal(err)
	}
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Fatalf("interrupt-resistant Hermes Stop took %s", elapsed)
	}
}

func waitForHermesEvent(
	t *testing.T,
	events <-chan runtimeapi.Event,
	want runtimeapi.EventKind,
) runtimeapi.Event {
	t.Helper()
	timer := time.NewTimer(500 * time.Millisecond)
	defer timer.Stop()
	for {
		select {
		case event, ok := <-events:
			if !ok {
				t.Fatalf("Hermes events closed before %q", want)
			}
			if event.Kind == want {
				return event
			}
		case <-timer.C:
			t.Fatalf("timed out waiting for Hermes event %q", want)
		}
	}
}

func assertNoHermesCompletion(
	t *testing.T,
	events <-chan runtimeapi.Event,
	duration time.Duration,
) {
	t.Helper()
	timer := time.NewTimer(duration)
	defer timer.Stop()
	for {
		select {
		case event, ok := <-events:
			if !ok {
				t.Fatal("Hermes events closed while root prompt remained active")
			}
			if event.Kind == runtimeapi.EventTurnCompletion {
				t.Fatalf("Hermes child acknowledgement completed the prompt family: %#v", event)
			}
		case <-timer.C:
			return
		}
	}
}

func TestDriverResumeSuppressesHermesHistoryReplay(t *testing.T) {
	driver, profile, home := newManagedHermesTestDriver(t, "agent-3")
	session, err := driver.Start(context.Background(), runtimeapi.StartRequest{
		AgentID:          "agent-3",
		LaunchID:         "launch-3",
		WorkingDirectory: t.TempDir(),
		SessionID:        "existing-session",
		Prompt:           "continue",
		Environment: map[string]string{
			"GO_WANT_HERMES_ACP_HELPER": "1",
			"HERMES_EXPECT_PROFILE":     profile.Name,
			"HERMES_EXPECT_HOME":        home,
			"HERMES_HELPER_REPLAY_LOAD": "1",
			"HOME":                      home,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer stopHermesTestSession(t, session)

	if session.SessionID() != "existing-session" {
		t.Fatalf("resumed session id = %q", session.SessionID())
	}
	deadline := time.After(5 * time.Second)
	for {
		select {
		case event, ok := <-session.Events():
			if !ok {
				t.Fatal("events closed before resumed turn completion")
			}
			if strings.Contains(event.Text, "historical replay") {
				t.Fatalf("historical ACP replay escaped as live output: %#v", event)
			}
			if event.Kind == runtimeapi.EventTurnCompletion {
				return
			}
		case <-deadline:
			t.Fatal("timed out waiting for resumed Hermes turn")
		}
	}
}

func TestDriverResumeLoadFailureDoesNotSilentlyStartFreshSession(t *testing.T) {
	driver, profile, home := newManagedHermesTestDriver(t, "agent-4")
	capturePath := filepath.Join(t.TempDir(), "helper-events.log")
	session, err := driver.Start(context.Background(), runtimeapi.StartRequest{
		AgentID:          "agent-4",
		LaunchID:         "launch-4",
		WorkingDirectory: t.TempDir(),
		SessionID:        "existing-session",
		Environment: map[string]string{
			"GO_WANT_HERMES_ACP_HELPER": "1",
			"HERMES_EXPECT_PROFILE":     profile.Name,
			"HERMES_EXPECT_HOME":        home,
			"HERMES_HELPER_FAIL_LOAD":   "1",
			"HERMES_HELPER_CAPTURE":     capturePath,
			"HOME":                      home,
		},
	})
	if session != nil {
		stopHermesTestSession(t, session)
		t.Fatal("resume load failure unexpectedly returned a session")
	}
	if err == nil || !strings.Contains(err.Error(), "load Hermes ACP session") {
		t.Fatalf("start error = %v", err)
	}
	data, readErr := os.ReadFile(capturePath)
	if readErr != nil && !errors.Is(readErr, os.ErrNotExist) {
		t.Fatal(readErr)
	}
	if strings.Contains(string(data), "session-new") {
		t.Fatal("load failure silently fell back to session/new")
	}
}

func TestDriverInvalidPromptResponseTerminatesACPTransport(t *testing.T) {
	driver, profile, home := newManagedHermesTestDriver(t, "agent-invalid-response")
	session, err := driver.Start(context.Background(), runtimeapi.StartRequest{
		AgentID:          "agent-invalid-response",
		LaunchID:         "launch-invalid-response",
		WorkingDirectory: t.TempDir(),
		Prompt:           "trigger invalid response",
		Environment: map[string]string{
			"GO_WANT_HERMES_ACP_HELPER":             "1",
			"HERMES_EXPECT_PROFILE":                 profile.Name,
			"HERMES_EXPECT_HOME":                    home,
			"HERMES_HELPER_INVALID_PROMPT_RESPONSE": "1",
			"HOME":                                  home,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer stopHermesTestSession(t, session)

	if errors := waitForHermesTransportFailure(
		t,
		session.Events(),
		"invalid response id",
	); errors != 1 {
		t.Fatalf("invalid response emitted %d terminal errors, want 1", errors)
	}
}

func TestDriverStdoutEOFWhileProcessLivesTerminatesACPTransport(t *testing.T) {
	driver, profile, home := newManagedHermesTestDriver(t, "agent-stdout-eof")
	session, err := driver.Start(context.Background(), runtimeapi.StartRequest{
		AgentID:          "agent-stdout-eof",
		LaunchID:         "launch-stdout-eof",
		WorkingDirectory: t.TempDir(),
		Prompt:           "trigger stdout eof",
		Environment: map[string]string{
			"GO_WANT_HERMES_ACP_HELPER":  "1",
			"HERMES_EXPECT_PROFILE":      profile.Name,
			"HERMES_EXPECT_HOME":         home,
			"HERMES_HELPER_CLOSE_STDOUT": "1",
			"HOME":                       home,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer stopHermesTestSession(t, session)

	if errors := waitForHermesTransportFailure(
		t,
		session.Events(),
		"stdout",
	); errors != 1 {
		t.Fatalf("stdout failure emitted %d terminal errors, want 1", errors)
	}
}

func TestDriverDrainsFinalPromptResponseBeforeNaturalExit(t *testing.T) {
	driver, profile, home := newManagedHermesTestDriver(t, "agent-final-exit")
	session, err := driver.Start(context.Background(), runtimeapi.StartRequest{
		AgentID:          "agent-final-exit",
		LaunchID:         "launch-final-exit",
		WorkingDirectory: t.TempDir(),
		Prompt:           "finish and exit",
		Environment: map[string]string{
			"GO_WANT_HERMES_ACP_HELPER":       "1",
			"HERMES_EXPECT_PROFILE":           profile.Name,
			"HERMES_EXPECT_HOME":              home,
			"HERMES_HELPER_EXIT_AFTER_PROMPT": "1",
			"HOME":                            home,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	concrete, ok := session.(*hermesTestSession)
	if !ok || concrete.stdout == nil {
		t.Fatal("Hermes Driver did not retain ownership of the parent stdout pipe")
	}

	completion := waitForHermesEvent(
		t,
		session.Events(),
		runtimeapi.EventTurnCompletion,
	)
	if completion.Detail != "natural_exit" {
		t.Fatalf("natural-exit completion = %#v", completion)
	}
	for range session.Events() {
	}
}

func TestDriverBoundsDrainWhenDescendantRetainsStdout(t *testing.T) {
	driver, profile, home := newManagedHermesTestDriver(t, "agent-descendant-stdout")
	session, err := driver.Start(context.Background(), runtimeapi.StartRequest{
		AgentID:          "agent-descendant-stdout",
		LaunchID:         "launch-descendant-stdout",
		WorkingDirectory: t.TempDir(),
		Prompt:           "finish with inherited stdout",
		Environment: map[string]string{
			"GO_WANT_HERMES_ACP_HELPER":             "1",
			"HERMES_EXPECT_PROFILE":                 profile.Name,
			"HERMES_EXPECT_HOME":                    home,
			"HERMES_HELPER_EXIT_AFTER_PROMPT":       "1",
			"HERMES_HELPER_DESCENDANT_HOLDS_STDOUT": "1",
			"HOME":                                  home,
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	completion := waitForHermesEvent(
		t,
		session.Events(),
		runtimeapi.EventTurnCompletion,
	)
	if completion.Detail != "natural_exit" {
		t.Fatalf("descendant-stdout completion = %#v", completion)
	}
	timer := time.NewTimer(2 * time.Second)
	defer timer.Stop()
	for {
		select {
		case _, ok := <-session.Events():
			if !ok {
				return
			}
		case <-timer.C:
			t.Fatal("descendant-held stdout prevented bounded session closure")
		}
	}
}

func TestDriverStopUpgradesFenceAfterNaturalWait(t *testing.T) {
	driver, profile, home := newManagedHermesTestDriver(t, "agent-wait-stop-fence")
	runtimeSession, err := driver.Start(context.Background(), runtimeapi.StartRequest{
		AgentID:          "agent-wait-stop-fence",
		LaunchID:         "launch-wait-stop-fence",
		WorkingDirectory: t.TempDir(),
		Prompt:           "exit before delayed response",
		Environment: map[string]string{
			"GO_WANT_HERMES_ACP_HELPER":                "1",
			"HERMES_EXPECT_PROFILE":                    profile.Name,
			"HERMES_EXPECT_HOME":                       home,
			"HERMES_HELPER_EXIT_WITH_DELAYED_RESPONSE": "1",
			"HOME":   home,
			"GORACE": "atexit_sleep_ms=0",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	concrete := runtimeSession.(*hermesTestSession)
	select {
	case <-concrete.processDone:
	case <-time.After(5 * time.Second):
		t.Fatal("Hermes main process did not exit")
	}

	stopCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := runtimeSession.Stop(stopCtx); err != nil {
		t.Fatal(err)
	}
	for event := range runtimeSession.Events() {
		switch event.Kind {
		case runtimeapi.EventTurnCompletion:
			t.Fatalf("Stop did not suppress delayed natural-exit completion: %#v", event)
		case runtimeapi.EventError:
			t.Fatalf("Stop after Wait emitted a competing terminal error: %#v", event)
		}
	}
}

func waitForHermesTransportFailure(
	t *testing.T,
	events <-chan runtimeapi.Event,
	want string,
) int {
	t.Helper()
	timer := time.NewTimer(2 * time.Second)
	defer timer.Stop()
	sawError := false
	errorCount := 0
	for {
		select {
		case event, ok := <-events:
			if !ok {
				if !sawError {
					t.Fatalf("Hermes transport closed without %q error", want)
				}
				return errorCount
			}
			if event.Kind == runtimeapi.EventError {
				errorCount++
				if strings.Contains(
					strings.ToLower(event.Text),
					strings.ToLower(want),
				) {
					sawError = true
				}
			}
		case <-timer.C:
			t.Fatalf("Hermes transport did not terminate after %q failure", want)
		}
	}
}

func newManagedHermesTestDriver(
	t *testing.T,
	agentID string,
) (*Driver, profileSelection, string) {
	t.Helper()
	trustedHome := t.TempDir()
	if err := os.MkdirAll(
		filepath.Join(trustedHome, ".hermes"),
		0o700,
	); err != nil {
		t.Fatal(err)
	}
	selection, err := managedProfileSelection(trustedHome, agentID)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("GO_WANT_HERMES_ACP_HELPER", "1")
	driver := New(Options{
		Executable:  os.Args[0],
		ArgsPrefix:  []string{"-test.run=TestHermesACPHelperProcess", "--"},
		Version:     "test-client",
		TrustedHome: trustedHome,
	})
	driver.containerEvidence = noContainerEvidence
	return driver, selection, trustedHome
}

func noContainerEvidence() string {
	return ""
}

func TestHermesACPHelperProcess(t *testing.T) {
	if os.Getenv("GO_WANT_HERMES_ACP_HELPER") != "1" {
		return
	}
	if os.Getenv("GO_WANT_HERMES_DELAYED_RESPONSE_HELPER") == "1" {
		delay := 200 * time.Millisecond
		if os.Getenv("HERMES_DELAYED_RESPONSE_DELAY_MS") == "800" {
			delay = 800 * time.Millisecond
		}
		time.Sleep(delay)
		id := json.RawMessage(os.Getenv("HERMES_DELAYED_RESPONSE_ID"))
		helperRespond(id, map[string]any{"stopReason": "delayed_natural_exit"})
		return
	}
	if os.Getenv("HERMES_HELPER_IGNORE_STOP") == "1" {
		signal.Ignore(os.Interrupt)
	}
	args := strings.Join(os.Args, "\x00")
	if strings.Contains(args, "acp\x00--check") {
		fmt.Println("Hermes ACP check OK")
		return
	}
	if strings.Contains(args, "acp\x00--version") ||
		strings.Contains(args, "--version") {
		fmt.Println("Hermes Agent v-test")
		return
	}
	if strings.Contains(args, "profile\x00create\x00--help") {
		switch os.Getenv("HERMES_HELPER_PROFILE_HELP") {
		case "missing-no-alias":
			fmt.Println("usage: hermes profile create [--clone] [--clone-from SOURCE]")
		default:
			fmt.Println(
				"usage: hermes profile create [--clone] " +
					"[--clone-from SOURCE] [--no-alias]",
			)
		}
		return
	}
	if strings.Contains(args, "profile\x00create\x00") {
		if os.Getenv("HERMES_HOME") != "" ||
			os.Getenv("HERMES_PROFILE") != "" {
			os.Exit(46)
		}
		profileName := helperArgumentAfter("create")
		if profileName == "" {
			os.Exit(47)
		}
		profileHome := filepath.Join(
			os.Getenv("HOME"),
			".hermes",
			"profiles",
			profileName,
		)
		if err := os.MkdirAll(
			filepath.Join(profileHome, "sessions"),
			0o700,
		); err != nil {
			os.Exit(48)
		}
		return
	}
	expectedProfile := os.Getenv("HERMES_EXPECT_PROFILE")
	if expectedProfile != "" &&
		!strings.Contains(args, "--profile\x00"+expectedProfile+"\x00acp") {
		os.Exit(41)
	}
	expectedHome := os.Getenv("HERMES_EXPECT_HOME")
	if expectedHome != "" && os.Getenv("HOME") != expectedHome {
		os.Exit(49)
	}
	if os.Getenv("HERMES_HOME") != "" ||
		os.Getenv("HERMES_PROFILE") != "" {
		os.Exit(42)
	}
	if workingDirectory, err := os.Getwd(); err != nil {
		os.Exit(50)
	} else {
		helperCapture("acp-cwd:" + workingDirectory)
	}
	runHermesACPHelper()
	os.Exit(0)
}

func helperArgumentAfter(want string) string {
	for index, argument := range os.Args {
		if argument == want && index+1 < len(os.Args) {
			return os.Args[index+1]
		}
	}
	return ""
}

type helperRPCMessage struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
}

func runHermesACPHelper() {
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 64*1024), 16*1024*1024)
	var firstPromptID json.RawMessage
	var permissionPromptID json.RawMessage
	for scanner.Scan() {
		var message helperRPCMessage
		if common.Unmarshal(scanner.Bytes(), &message) != nil {
			continue
		}
		switch message.Method {
		case "initialize":
			helperRespond(message.ID, map[string]any{
				"protocolVersion": 1,
				"agentInfo": map[string]string{
					"name":    "hermes-agent",
					"version": "test",
				},
				"agentCapabilities": map[string]any{
					"loadSession": true,
				},
			})
		case "session/new":
			helperCapture("session-new")
			var params struct {
				CWD string `json:"cwd"`
			}
			_ = common.Unmarshal(message.Params, &params)
			helperCapture("session-cwd:" + params.CWD)
			expectedWorkspace := os.Getenv("HERMES_EXPECT_WORKSPACE")
			if expectedWorkspace != "" && params.CWD != expectedWorkspace {
				os.Exit(51)
			}
			helperRespond(message.ID, map[string]any{
				"sessionId": "hermes-session-1",
				"models": map[string]any{
					"currentModelId": "test-model",
					"availableModels": []map[string]string{{
						"modelId": "test-model",
						"name":    "Test Model",
					}},
				},
			})
		case "session/load":
			if os.Getenv("HERMES_HELPER_FAIL_LOAD") == "1" {
				helperError(message.ID, -32000, "storage unavailable")
				continue
			}
			if os.Getenv("HERMES_HELPER_REPLAY_LOAD") == "1" {
				var params struct {
					SessionID string `json:"sessionId"`
				}
				_ = common.Unmarshal(message.Params, &params)
				helperNotify("session/update", map[string]any{
					"sessionId": params.SessionID,
					"update": map[string]any{
						"sessionUpdate": "agent_message_chunk",
						"content": map[string]string{
							"type": "text",
							"text": "historical replay",
						},
					},
				})
			}
			helperRespond(message.ID, map[string]any{})
		case "session/resume":
			helperRespond(message.ID, map[string]any{})
		case "session/set_model":
			helperRespond(message.ID, map[string]any{})
		case "session/prompt":
			var params struct {
				Prompt []struct {
					Type string `json:"type"`
					Text string `json:"text"`
				} `json:"prompt"`
			}
			_ = common.Unmarshal(message.Params, &params)
			text := ""
			if len(params.Prompt) > 0 {
				text = params.Prompt[0].Text
			}
			helperCapture("prompt:" + text)
			if os.Getenv("HERMES_HELPER_INVALID_PROMPT_RESPONSE") == "1" {
				helperWrite(map[string]any{
					"jsonrpc": "2.0",
					"id":      nil,
					"result":  map[string]string{"stopReason": "end_turn"},
				})
				continue
			}
			if os.Getenv("HERMES_HELPER_CLOSE_STDOUT") == "1" {
				_ = os.Stdout.Close()
				time.Sleep(10 * time.Second)
				continue
			}
			if os.Getenv("HERMES_HELPER_EXIT_AFTER_PROMPT") == "1" {
				helperRespond(message.ID, map[string]any{"stopReason": "natural_exit"})
				if os.Getenv("HERMES_HELPER_DESCENDANT_HOLDS_STDOUT") == "1" {
					descendant := exec.Command("sh", "-c", "sleep 10")
					descendant.Stdout = os.Stdout
					if err := descendant.Start(); err != nil {
						os.Exit(52)
					}
				}
				os.Exit(0)
			}
			if os.Getenv("HERMES_HELPER_EXIT_WITH_DELAYED_RESPONSE") == "1" {
				descendant := exec.Command(
					os.Args[0],
					"-test.run=TestHermesACPHelperProcess",
					"--",
				)
				descendant.Env = append(
					os.Environ(),
					"GO_WANT_HERMES_DELAYED_RESPONSE_HELPER=1",
					"HERMES_DELAYED_RESPONSE_ID="+string(message.ID),
					"HERMES_DELAYED_RESPONSE_DELAY_MS=800",
				)
				descendant.Stdout = os.Stdout
				descendant.Stderr = os.Stderr
				if err := descendant.Start(); err != nil {
					os.Exit(53)
				}
				os.Exit(0)
			}
			if os.Getenv("HERMES_HELPER_HOLD_FIRST") == "1" &&
				len(firstPromptID) == 0 {
				firstPromptID = append(json.RawMessage(nil), message.ID...)
				continue
			}
			if len(firstPromptID) > 0 {
				helperCapture("redirect:" + text)
				helperRespond(message.ID, map[string]any{"stopReason": "child_ack"})
				releaseFirstPath := os.Getenv("HERMES_HELPER_RELEASE_FIRST_FILE")
				if releaseFirstPath != "" {
					for {
						if _, err := os.Stat(releaseFirstPath); err == nil {
							break
						}
						time.Sleep(5 * time.Millisecond)
					}
					helperRespond(firstPromptID, map[string]any{"stopReason": "root_done"})
					firstPromptID = nil
				}
				continue
			}
			helperNotify("session/update", map[string]any{
				"sessionId": "hermes-session-1",
				"update": map[string]any{
					"sessionUpdate": "available_commands_update",
					"availableCommands": []map[string]string{
						{"name": "steer", "description": "Steer active work"},
					},
				},
			})
			helperNotify("session/update", map[string]any{
				"sessionId": "hermes-session-1",
				"update": map[string]any{
					"sessionUpdate": "agent_thought_chunk",
					"content":       map[string]string{"type": "text", "text": "thinking"},
				},
			})
			helperNotify("session/update", map[string]any{
				"sessionId": "hermes-session-1",
				"update": map[string]any{
					"sessionUpdate": "tool_call",
					"toolCallId":    "tool-1",
					"title":         "vela inbox check",
					"status":        "in_progress",
					"rawInput":      map[string]string{"command": "vela inbox check"},
				},
			})
			permissionPromptID = append(json.RawMessage(nil), message.ID...)
			helperRequest(json.RawMessage(`"permission-1"`), "session/request_permission", map[string]any{
				"sessionId": "hermes-session-1",
				"options": []map[string]string{
					{"optionId": "allow_once", "kind": "allow_once", "name": "Allow once"},
					{"optionId": "allow_session", "kind": "allow_always", "name": "Allow session"},
				},
				"toolCall": map[string]any{
					"toolCallId": "permission-tool",
					"title":      "permission",
				},
			})
		case "session/cancel":
			helperCapture("cancel:hermes-session-1")
			if os.Getenv("HERMES_HELPER_IGNORE_STOP") == "1" {
				continue
			}
			if len(firstPromptID) > 0 {
				helperRespond(firstPromptID, map[string]any{"stopReason": "cancelled"})
				firstPromptID = nil
			}
		default:
			if string(message.ID) == `"permission-1"` {
				var response struct {
					Result struct {
						Outcome struct {
							Outcome  string `json:"outcome"`
							OptionID string `json:"optionId"`
						} `json:"outcome"`
					} `json:"result"`
				}
				_ = common.Unmarshal(scanner.Bytes(), &response)
				if response.Result.Outcome.Outcome != "selected" ||
					response.Result.Outcome.OptionID != "allow_session" {
					os.Exit(43)
				}
				helperNotify("session/update", map[string]any{
					"sessionId": "hermes-session-1",
					"update": map[string]any{
						"sessionUpdate": "tool_call_update",
						"toolCallId":    "tool-1",
						"status":        "completed",
						"rawOutput":     "done",
					},
				})
				helperNotify("session/update", map[string]any{
					"sessionId": "hermes-session-1",
					"update": map[string]any{
						"sessionUpdate": "agent_message_chunk",
						"content":       map[string]string{"type": "text", "text": "hello from Hermes"},
					},
				})
				helperNotify("session/update", map[string]any{
					"sessionId": "hermes-session-1",
					"update": map[string]any{
						"sessionUpdate": "usage_update",
						"used":          10,
						"size":          100,
					},
				})
				helperRespond(permissionPromptID, map[string]any{
					"stopReason": "end_turn",
					"usage": map[string]int{
						"inputTokens":  5,
						"outputTokens": 5,
						"totalTokens":  10,
					},
				})
				permissionPromptID = nil
			} else if len(message.ID) > 0 {
				helperError(message.ID, -32601, "unsupported helper method")
			}
		}
	}
}

func helperRespond(id json.RawMessage, result any) {
	helperWrite(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
}

func helperError(id json.RawMessage, code int, message string) {
	helperWrite(map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"error":   map[string]any{"code": code, "message": message},
	})
}

func helperNotify(method string, params any) {
	helperWrite(map[string]any{
		"jsonrpc": "2.0",
		"method":  method,
		"params":  params,
	})
}

func helperRequest(id json.RawMessage, method string, params any) {
	helperWrite(map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"method":  method,
		"params":  params,
	})
}

func helperWrite(value any) {
	data, err := common.Marshal(value)
	if err != nil {
		os.Exit(44)
	}
	_, _ = os.Stdout.Write(append(data, '\n'))
}

func helperCapture(line string) {
	path := os.Getenv("HERMES_HELPER_CAPTURE")
	if path == "" {
		return
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		os.Exit(45)
	}
	_, _ = fmt.Fprintln(file, line)
	_ = file.Close()
}

func waitForHermesCapture(t *testing.T, path string, want string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		data, err := os.ReadFile(path)
		if err == nil && strings.Contains(string(data), want) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	data, _ := os.ReadFile(path)
	t.Fatalf("capture %q does not contain %q: %s", path, want, data)
}

func stopHermesTestSession(t *testing.T, session runtimeapi.RuntimeSession) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	err := session.Stop(ctx)
	if err != nil &&
		!errors.Is(err, context.DeadlineExceeded) &&
		!errors.Is(err, os.ErrProcessDone) {
		var signalError *os.SyscallError
		if !errors.As(err, &signalError) ||
			!errors.Is(signalError.Err, syscall.ESRCH) {
			t.Errorf("stop Hermes session: %v", err)
		}
	}
}
