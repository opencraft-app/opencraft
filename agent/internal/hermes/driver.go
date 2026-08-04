package hermes

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/runtimeapi"
)

const (
	acpProtocolVersion        = 1
	maximumACPLine            = 16 * 1024 * 1024
	startupTimeout            = 30 * time.Second
	cancelGrace               = 75 * time.Millisecond
	stdoutDrainGrace          = 500 * time.Millisecond
	stderrDrainGrace          = 100 * time.Millisecond
	processExitHandshakeGrace = 50 * time.Millisecond
)

var ErrSessionStopped = errors.New("Hermes ACP runtime session has stopped")
var ErrPrimaryTurnActive = errors.New("Hermes ACP primary turn is already active")

type Options struct {
	Executable string
	ArgsPrefix []string
	Version    string
	// TrustedHome overrides the OS-user home for deterministic tests. Managed
	// production launches leave it empty and capture os.UserHomeDir instead.
	TrustedHome      string
	RuntimeLeaseWait time.Duration
}

type Driver struct {
	executable        string
	argsPrefix        []string
	version           string
	trustedHome       string
	homeErr           error
	runtimeLeaseWait  time.Duration
	containerEvidence func() string
}

var _ runtimeapi.RuntimeDriver = (*Driver)(nil)

func New(options Options) *Driver {
	version := strings.TrimSpace(options.Version)
	if version == "" {
		version = "0.1.0-dev"
	}
	trustedHome := strings.TrimSpace(options.TrustedHome)
	var homeErr error
	if trustedHome == "" {
		trustedHome, homeErr = os.UserHomeDir()
	}
	if homeErr == nil {
		if !filepath.IsAbs(trustedHome) {
			homeErr = errors.New("Hermes trusted OS-user home is not absolute")
		} else {
			trustedHome = filepath.Clean(trustedHome)
		}
	}
	return &Driver{
		executable:        strings.TrimSpace(options.Executable),
		argsPrefix:        append([]string(nil), options.ArgsPrefix...),
		version:           version,
		trustedHome:       trustedHome,
		homeErr:           homeErr,
		runtimeLeaseWait:  options.RuntimeLeaseWait,
		containerEvidence: detectContainerEvidence,
	}
}

func (driver *Driver) Start(
	ctx context.Context,
	request runtimeapi.StartRequest,
) (runtimeapi.RuntimeSession, error) {
	if strings.TrimSpace(request.WorkingDirectory) == "" {
		return nil, errors.New("Hermes working directory is required")
	}
	workingDirectory, err := filepath.Abs(request.WorkingDirectory)
	if err != nil {
		return nil, err
	}
	if err := requireDirectory(workingDirectory); err != nil {
		return nil, err
	}
	host, err := driver.PrepareManagedHost(ctx, request.AgentID)
	if err != nil {
		return nil, err
	}
	runtimeLease, err := AcquireManagedProfileRuntimeLease(
		ctx,
		host,
		driver.runtimeLeaseWait,
	)
	if err != nil {
		return nil, err
	}
	leaseOwnedByStart := true
	defer func() {
		if leaseOwnedByStart {
			_ = runtimeLease.Release()
		}
	}()
	environment := copyEnvironment(request.Environment)

	// RAFT_PROFILE and SLOCK_PROFILE select the external wake-bridge
	// credential store. A Computer-managed launch must instead use the
	// generated launch-scoped raft wrapper and capability token.
	delete(environment, "RAFT_PROFILE")
	delete(environment, "SLOCK_PROFILE")
	delete(environment, "HERMES_HOME")
	delete(environment, "HERMES_PROFILE")
	environment["HOME"] = host.TrustedHome

	args := append([]string(nil), host.ArgsPrefix...)
	args = append(args, host.ProfileArgs...)
	args = append(args, "acp")
	command := exec.Command(host.Executable, args...)
	command.Dir = workingDirectory
	command.Env = environmentList(environment)
	stdinReader, stdinWriter, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	stdoutReader, stdoutWriter, err := os.Pipe()
	if err != nil {
		_ = stdinReader.Close()
		_ = stdinWriter.Close()
		return nil, err
	}
	stderrReader, stderrWriter, err := os.Pipe()
	if err != nil {
		_ = stdinReader.Close()
		_ = stdinWriter.Close()
		_ = stdoutReader.Close()
		_ = stdoutWriter.Close()
		return nil, err
	}
	command.Stdin = stdinReader
	command.Stdout = stdoutWriter
	command.Stderr = stderrWriter
	if err := command.Start(); err != nil {
		_ = stdinReader.Close()
		_ = stdinWriter.Close()
		_ = stdoutReader.Close()
		_ = stdoutWriter.Close()
		_ = stderrReader.Close()
		_ = stderrWriter.Close()
		return nil, err
	}
	_ = stdinReader.Close()
	_ = stdoutWriter.Close()
	_ = stderrWriter.Close()

	session := &session{
		command:          command,
		stdin:            stdinWriter,
		stdout:           stdoutReader,
		stderr:           stderrReader,
		wire:             newWireGate(),
		events:           make(chan runtimeapi.Event, 256),
		pending:          make(map[int64]pendingCall),
		done:             make(chan struct{}),
		processDone:      make(chan struct{}),
		readDone:         make(chan struct{}),
		stderrDone:       make(chan struct{}),
		launchID:         request.LaunchID,
		captureStderr:    environment["RAFT_COMPUTER_GO_TRACE_HERMES_ACP"] == "1",
		permissionPolicy: permissionPolicy(environment),
		toolNames:        make(map[string]string),
		runtimeLease:     runtimeLease,
		runtimeHome: runtimeapi.RuntimeHomeInfo{
			ObservedDir:   host.ProfileHome,
			ConfiguredDir: host.ProfileHome,
			Explicit:      true,
		},
	}
	session.initActionDispatcher()
	go session.readStdout(stdoutReader)
	go session.drainStderr(stderrReader)
	go session.wait()
	leaseOwnedByStart = false

	startCtx, cancel := context.WithTimeout(ctx, startupTimeout)
	defer cancel()
	initialize, err := session.request(startCtx, "initialize", map[string]any{
		"protocolVersion": acpProtocolVersion,
		"clientCapabilities": map[string]any{
			"auth":     map[string]bool{"terminal": false},
			"fs":       map[string]bool{"readTextFile": false, "writeTextFile": false},
			"terminal": false,
		},
		"clientInfo": map[string]string{
			"name":    "raft-computer-go",
			"version": driver.version,
		},
	})
	if err != nil {
		session.abortStartup()
		return nil, fmt.Errorf("initialize Hermes ACP: %w", err)
	}
	var initialized initializeResult
	if err := common.Unmarshal(initialize.Result, &initialized); err != nil ||
		initialized.ProtocolVersion != acpProtocolVersion {
		session.abortStartup()
		return nil, errors.New("Hermes ACP returned an incompatible initialize response")
	}
	if initialized.AgentInfo.Name != "" &&
		!strings.Contains(strings.ToLower(initialized.AgentInfo.Name), "hermes") {
		session.abortStartup()
		return nil, errors.New("ACP executable did not identify as Hermes")
	}

	sessionID, resumed, err := session.openACPConversation(
		startCtx,
		workingDirectory,
		request.SessionID,
		initialized.AgentCapabilities.LoadSession,
	)
	if err != nil {
		session.abortStartup()
		return nil, err
	}
	session.setSessionID(sessionID)
	session.emit(runtimeapi.Event{
		Kind:      runtimeapi.EventSession,
		SessionID: sessionID,
		LaunchID:  request.LaunchID,
	})
	if request.SessionID != "" && !resumed {
		session.emit(runtimeapi.Event{
			Kind:               runtimeapi.EventRecovery,
			Text:               "Hermes could not load its previous ACP session; a fresh session was started.",
			LaunchID:           request.LaunchID,
			RecoverySource:     "hermes_acp_resume_missing",
			RecoveryClass:      "missing_session",
			RecoveryAction:     "fallback_fresh_session",
			RequestedSessionID: request.SessionID,
		})
	}
	if model := strings.TrimSpace(request.Model); model != "" && model != "default" {
		if _, err := session.request(startCtx, "session/set_model", map[string]any{
			"sessionId": sessionID,
			"modelId":   model,
		}); err != nil {
			session.abortStartup()
			return nil, fmt.Errorf("select Hermes model: %w", err)
		}
	}
	prompt := managedInitialPrompt(request.StandingPrompt, request.Prompt)
	if prompt != "" {
		if err := session.startPrimaryPrompt(startCtx, prompt); err != nil {
			session.abortStartup()
			return nil, fmt.Errorf("start initial Hermes turn: %w", err)
		}
	}
	return session, nil
}

type initializeResult struct {
	ProtocolVersion int `json:"protocolVersion"`
	AgentInfo       struct {
		Name    string `json:"name"`
		Version string `json:"version"`
	} `json:"agentInfo"`
	AgentCapabilities struct {
		LoadSession bool `json:"loadSession"`
	} `json:"agentCapabilities"`
}

func (session *session) openACPConversation(
	ctx context.Context,
	workingDirectory string,
	requestedSessionID string,
	canLoad bool,
) (string, bool, error) {
	requestedSessionID = strings.TrimSpace(requestedSessionID)
	if requestedSessionID != "" && canLoad {
		session.setSessionID(requestedSessionID)
		session.mu.Lock()
		session.suppressUpdates = true
		session.mu.Unlock()
		response, err := session.request(ctx, "session/load", map[string]any{
			"cwd":        workingDirectory,
			"sessionId":  requestedSessionID,
			"mcpServers": []any{},
		})
		session.mu.Lock()
		session.suppressUpdates = false
		session.mu.Unlock()
		if err != nil {
			session.setSessionID("")
			return "", false, fmt.Errorf("load Hermes ACP session: %w", err)
		}
		if !rawJSONNull(response.Result) {
			return requestedSessionID, true, nil
		}
		session.setSessionID("")
	}
	response, err := session.request(ctx, "session/new", map[string]any{
		"cwd":        workingDirectory,
		"mcpServers": []any{},
	})
	if err != nil {
		return "", false, fmt.Errorf("create Hermes ACP session: %w", err)
	}
	var result struct {
		SessionID string `json:"sessionId"`
	}
	if err := common.Unmarshal(response.Result, &result); err != nil ||
		strings.TrimSpace(result.SessionID) == "" {
		return "", false, errors.New("Hermes ACP session/new response is missing sessionId")
	}
	return result.SessionID, false, nil
}

func managedInitialPrompt(standingPrompt string, prompt string) string {
	standingPrompt = strings.TrimSpace(standingPrompt)
	prompt = strings.TrimSpace(prompt)
	switch {
	case standingPrompt == "":
		return prompt
	case prompt == "":
		return standingPrompt
	default:
		return "[Computer operating instructions]\n" + standingPrompt +
			"\n\n[Current input]\n" + prompt
	}
}

type pendingCall struct {
	method           string
	response         chan rpcMessage
	prompt           bool
	promptRoot       bool
	committed        bool
	deferredResponse *rpcMessage
}

type session struct {
	command     *exec.Cmd
	stdin       io.WriteCloser
	stdout      *os.File
	stderr      *os.File
	events      chan runtimeapi.Event
	pending     map[int64]pendingCall
	done        chan struct{}
	processDone chan struct{}
	readDone    chan struct{}
	stderrDone  chan struct{}

	wire   *wireGate
	mu     sync.Mutex
	nextID int64

	sessionID         string
	launchID          string
	promptFamily      promptFamily
	suppressUpdates   bool
	stopping          bool
	completionFenced  bool
	waitErr           error
	captureStderr     bool
	stderrTail        string
	permissionPolicy  string
	availableCommands map[string]struct{}
	toolNames         map[string]string
	runtimeLease      *ManagedProfileRuntimeLease
	runtimeHome       runtimeapi.RuntimeHomeInfo

	actionWake           chan struct{}
	actionForce          chan struct{}
	actionDone           chan struct{}
	actionQueue          []runtimeapi.Event
	actionsClosing       bool
	terminalActionQueued bool

	doneOnce          sync.Once
	processDoneOnce   sync.Once
	stopOnce          sync.Once
	wireAbortOnce     sync.Once
	killScheduleOnce  sync.Once
	transportFailOnce sync.Once
	actionsInitOnce   sync.Once
	actionsCloseOnce  sync.Once
	actionsForceOnce  sync.Once
}

var _ runtimeapi.RuntimeSession = (*session)(nil)
var _ runtimeapi.RuntimeHomeProvider = (*session)(nil)
var _ runtimeapi.LivenessProber = (*session)(nil)

func (session *session) Events() <-chan runtimeapi.Event {
	return session.events
}

func (session *session) SessionID() string {
	session.mu.Lock()
	defer session.mu.Unlock()
	return session.sessionID
}

func (session *session) setSessionID(value string) {
	session.mu.Lock()
	session.sessionID = value
	session.mu.Unlock()
}

func (session *session) RuntimeHomeInfo() runtimeapi.RuntimeHomeInfo {
	return session.runtimeHome
}

func (session *session) RuntimeLiveness() runtimeapi.Liveness {
	select {
	case <-session.done:
		return runtimeapi.LivenessDead
	default:
	}
	if session.command == nil || session.command.Process == nil {
		return runtimeapi.LivenessUnknown
	}
	err := session.command.Process.Signal(syscall.Signal(0))
	switch {
	case err == nil:
		return runtimeapi.LivenessAlive
	case errors.Is(err, os.ErrProcessDone):
		return runtimeapi.LivenessDead
	default:
		return runtimeapi.LivenessUnknown
	}
}

func (session *session) Deliver(
	ctx context.Context,
	delivery runtimeapi.Delivery,
) error {
	text := strings.TrimSpace(delivery.Text)
	if text == "" {
		return errors.New("Hermes delivery text is required")
	}
	session.mu.Lock()
	sessionID := session.sessionID
	active := session.promptFamily.Active()
	session.mu.Unlock()
	if sessionID == "" {
		return errors.New("Hermes ACP session is not ready")
	}
	mode := strings.TrimSpace(delivery.Mode)
	if mode == "" {
		if active {
			mode = "busy"
		} else {
			mode = "idle"
		}
	}
	if mode != "busy" || !active {
		err := session.startPrimaryPrompt(ctx, text)
		if errors.Is(err, ErrPrimaryTurnActive) || isUnsentPromptWrite(err) {
			return runtimeapi.NewRetryableDeliveryError(
				runtimeapi.RetryDelayedIdle,
				err,
			)
		}
		return err
	}

	if err := ctx.Err(); err != nil {
		return err
	}
	// Hermes ACP interprets a second plain prompt during an active turn as a
	// native redirect when supported, with a safe queued-prompt fallback. The
	// write acknowledges Runtime acceptance; its ACP response completes only
	// the corresponding prompt-family member.
	err := session.sendPrompt(ctx, promptParams(sessionID, text), true)
	if err != nil {
		if !isUnsentPromptWrite(err) {
			return err
		}
		return runtimeapi.NewRetryableDeliveryError(
			runtimeapi.RetryTurnBoundary,
			err,
		)
	}
	return nil
}

func (session *session) startPrimaryPrompt(ctx context.Context, text string) error {
	session.mu.Lock()
	if session.promptFamily.Active() {
		session.mu.Unlock()
		return ErrPrimaryTurnActive
	}
	sessionID := session.sessionID
	if sessionID == "" {
		session.mu.Unlock()
		return errors.New("Hermes ACP session is not ready")
	}
	session.mu.Unlock()
	if err := session.sendPrompt(ctx, promptParams(sessionID, text), false); err != nil {
		return err
	}
	return nil
}

func promptParams(sessionID string, text string) map[string]any {
	return map[string]any{
		"sessionId": sessionID,
		"prompt": []map[string]string{{
			"type": "text",
			"text": text,
		}},
	}
}

func (session *session) Stop(ctx context.Context) error {
	session.stopOnce.Do(func() {
		session.mu.Lock()
		session.stopping = true
		session.completionFenced = true
		active := session.promptFamily.Active()
		sessionID := session.sessionID
		session.mu.Unlock()
		if active && sessionID != "" {
			cancelCtx, cancel := context.WithTimeout(context.Background(), cancelGrace)
			_ = session.notify(cancelCtx, "session/cancel", map[string]string{
				"sessionId": sessionID,
			})
			cancel()
			timer := time.NewTimer(cancelGrace)
			select {
			case <-timer.C:
			case <-session.done:
			case <-ctx.Done():
			}
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
		}
		if session.command != nil && session.command.Process != nil {
			_ = session.command.Process.Signal(os.Interrupt)
			session.scheduleKillAfterGrace()
		}
	})
	select {
	case <-session.done:
		session.mu.Lock()
		defer session.mu.Unlock()
		var exitError *exec.ExitError
		if session.waitErr == nil || errors.As(session.waitErr, &exitError) {
			return nil
		}
		return session.waitErr
	case <-ctx.Done():
		if session.command != nil && session.command.Process != nil {
			if err := session.command.Process.Kill(); err != nil &&
				!errors.Is(err, os.ErrProcessDone) {
				return err
			}
		}
		<-session.done
		return ctx.Err()
	}
}

func (session *session) abortStartup() {
	session.mu.Lock()
	session.stopping = true
	session.mu.Unlock()
	if session.command != nil && session.command.Process != nil {
		_ = session.command.Process.Kill()
	}
	<-session.done
}

func (session *session) abortWire() {
	session.wireAbortOnce.Do(func() {
		if session.stdin != nil {
			_ = session.stdin.Close()
		}
		if session.command != nil && session.command.Process != nil {
			_ = session.command.Process.Signal(os.Interrupt)
		}
	})
}

func (session *session) wait() {
	err := session.command.Wait()
	session.mu.Lock()
	session.waitErr = err
	session.mu.Unlock()
	session.processDoneOnce.Do(func() { close(session.processDone) })
	if session.runtimeLease != nil {
		_ = session.runtimeLease.Release()
	}
	if session.stdin != nil {
		_ = session.stdin.Close()
	}
	timer := time.NewTimer(stdoutDrainGrace)
	select {
	case <-session.readDone:
		timer.Stop()
	case <-timer.C:
		if session.stdout != nil {
			_ = session.stdout.Close()
		}
		<-session.readDone
	}
	stderrTimer := time.NewTimer(stderrDrainGrace)
	select {
	case <-session.stderrDone:
		stderrTimer.Stop()
	case <-stderrTimer.C:
		if session.stderr != nil {
			_ = session.stderr.Close()
		}
		<-session.stderrDone
	}
	session.mu.Lock()
	stopping := session.stopping
	session.mu.Unlock()
	hadActivePrompt := session.failPending(ErrSessionStopped)
	if !stopping {
		detail := ""
		if err != nil {
			detail = "Hermes ACP process exited unexpectedly: " + err.Error()
		} else if hadActivePrompt {
			detail = "Hermes ACP turn ended because the runtime stopped"
		}
		if detail != "" {
			session.mu.Lock()
			stderrTail := strings.TrimSpace(session.stderrTail)
			session.mu.Unlock()
			if stderrTail != "" {
				detail += "\nHermes stderr tail:\n" + stderrTail
			}
			session.emit(runtimeapi.Event{
				Kind:     runtimeapi.EventError,
				Text:     detail,
				LaunchID: session.launchID,
			})
		}
	}
	session.closeEvents()
	session.doneOnce.Do(func() { close(session.done) })
}

func (session *session) drainStderr(stderr io.Reader) {
	defer close(session.stderrDone)
	tail := captureHermesStderr(stderr, session.captureStderr)
	if tail == "" {
		return
	}
	session.mu.Lock()
	session.stderrTail = tail
	session.mu.Unlock()
}

func copyEnvironment(input map[string]string) map[string]string {
	output := make(map[string]string, len(input))
	for key, value := range input {
		output[key] = value
	}
	return output
}

func environmentList(environment map[string]string) []string {
	keys := make([]string, 0, len(environment))
	for key := range environment {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	result := make([]string, 0, len(keys))
	for _, key := range keys {
		result = append(result, key+"="+environment[key])
	}
	return result
}

func permissionPolicy(environment map[string]string) string {
	switch strings.ToLower(strings.TrimSpace(
		environment["HERMES_ACP_PERMISSION_POLICY"],
	)) {
	case "deny":
		return "deny"
	case "once":
		return "once"
	default:
		return "session"
	}
}

func rawJSONNull(raw json.RawMessage) bool {
	text := strings.TrimSpace(string(raw))
	return text == "" || text == "null"
}

func (session *session) readStdout(stdout io.Reader) {
	defer close(session.readDone)
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 64*1024), maximumACPLine)
	for scanner.Scan() {
		message, err := decodeRPCMessage(scanner.Bytes())
		if err != nil {
			session.mu.Lock()
			active := session.promptFamily.Active()
			session.mu.Unlock()
			if active {
				session.failTransport("Hermes ACP emitted malformed JSON-RPC during an active prompt")
				return
			}
			session.emit(runtimeapi.Event{
				Kind:     runtimeapi.EventDiagnostic,
				Text:     "Hermes ACP emitted malformed JSON-RPC",
				LaunchID: session.launchID,
			})
			continue
		}
		session.dispatch(message)
	}
	if err := scanner.Err(); err != nil {
		select {
		case <-session.processDone:
			return
		default:
		}
		session.failTransport("Hermes ACP stdout failed: " + err.Error())
		return
	}
	session.mu.Lock()
	stopping := session.stopping
	session.mu.Unlock()
	timer := time.NewTimer(processExitHandshakeGrace)
	defer timer.Stop()
	select {
	case <-session.processDone:
		return
	case <-timer.C:
	}
	if !stopping {
		session.failTransport("Hermes ACP stdout closed while the process was still active")
	}
}
