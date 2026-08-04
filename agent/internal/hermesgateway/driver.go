package hermesgateway

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
	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/hermes"
	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/runtimeapi"
)

const (
	gatewayProbeTimeout   = 10 * time.Second
	gatewayStartupTimeout = 30 * time.Second
	gatewayStopTimeout    = 3 * time.Second
	headlessClarifyAnswer = "No native interactive UI is available. Ask the user through the current Raft conversation and wait for a new message."
)

type pythonCandidate struct {
	Path       string
	ArgsPrefix []string
}

func (driver *Driver) Probe(
	ctx context.Context,
) (runtimeapi.ProbeResult, error) {
	candidate, version, err := driver.probePythonGateway(ctx)
	if err != nil {
		if ctx.Err() != nil {
			return runtimeapi.ProbeResult{}, ctx.Err()
		}
		return runtimeapi.ProbeResult{Diagnostic: err.Error()}, nil
	}
	hostProbe, err := driver.hostDriver.Probe(ctx)
	if err != nil {
		return runtimeapi.ProbeResult{}, err
	}
	if !hostProbe.Available {
		return runtimeapi.ProbeResult{
			Path: candidate.Path,
			Diagnostic: "Hermes managed Profile host is unavailable: " +
				hostProbe.Diagnostic,
		}, nil
	}
	return runtimeapi.ProbeResult{
		Available: true,
		Path:      candidate.Path,
		Version:   version,
	}, nil
}

func (driver *Driver) DetectModels(
	ctx context.Context,
) (runtimeapi.ModelResult, error) {
	probe, err := driver.Probe(ctx)
	if err != nil {
		return runtimeapi.ModelResult{}, err
	}
	if !probe.Available {
		return runtimeapi.ModelResult{Unsupported: true}, nil
	}
	return driver.queryDefaultModelOptions(ctx)
}

func (driver *Driver) probePythonGateway(
	ctx context.Context,
) (pythonCandidate, string, error) {
	candidates, err := driver.pythonCandidates()
	if err != nil {
		return pythonCandidate{}, "", err
	}
	diagnostics := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		probeCtx, cancel := context.WithTimeout(ctx, gatewayProbeTimeout)
		args := append([]string(nil), candidate.ArgsPrefix...)
		args = append(
			args,
			"-c",
			"import tui_gateway.entry; print('Hermes Gateway')",
		)
		output, probeErr := exec.CommandContext(
			probeCtx,
			candidate.Path,
			args...,
		).CombinedOutput()
		cancel()
		if probeErr == nil {
			version := firstNonEmptyLine(output)
			if version == "" {
				version = "Hermes Gateway"
			}
			return candidate, version, nil
		}
		if ctx.Err() != nil {
			return pythonCandidate{}, "", ctx.Err()
		}
		diagnostics = append(
			diagnostics,
			fmt.Sprintf("%q rejected: %s", candidate.Path, probeErr),
		)
	}
	return pythonCandidate{}, "", fmt.Errorf(
		"no trusted Python can import the Hermes Gateway module: %s",
		strings.Join(diagnostics, "; "),
	)
}

func (driver *Driver) pythonCandidates() ([]pythonCandidate, error) {
	if driver.pythonExecutable != "" {
		return []pythonCandidate{{
			Path:       driver.pythonExecutable,
			ArgsPrefix: append([]string(nil), driver.pythonArgsPrefix...),
		}}, nil
	}
	launcher := driver.hermesExecutable
	if launcher == "" {
		launcher, _ = exec.LookPath("hermes")
	}
	if launcher == "" && driver.homeErr == nil {
		launcher = trustedHomeHermesLauncher(driver.trustedHome)
	}
	if launcher == "" {
		return nil, errors.New(
			"Hermes launcher was not found for trusted Python discovery",
		)
	}
	if resolved, err := filepath.EvalSymlinks(launcher); err == nil {
		launcher = resolved
	}
	candidatePaths := make([]string, 0, 4)
	if interpreter := launcherLiteralExecPythonInterpreter(launcher); interpreter != "" {
		candidatePaths = append(candidatePaths, interpreter)
	}
	if interpreter := launcherShebangInterpreter(launcher); interpreter != "" {
		candidatePaths = append(candidatePaths, interpreter)
	}
	launcherDirectory := filepath.Dir(launcher)
	candidatePaths = append(
		candidatePaths,
		filepath.Join(launcherDirectory, "python3"),
		filepath.Join(launcherDirectory, "python"),
	)
	seen := make(map[string]struct{}, len(candidatePaths))
	candidates := make([]pythonCandidate, 0, len(candidatePaths))
	for _, candidatePath := range candidatePaths {
		candidatePath = strings.TrimSpace(candidatePath)
		if candidatePath == "" {
			continue
		}
		if !filepath.IsAbs(candidatePath) {
			resolved, err := exec.LookPath(candidatePath)
			if err != nil {
				continue
			}
			candidatePath = resolved
		}
		candidatePath = filepath.Clean(candidatePath)
		if _, duplicate := seen[candidatePath]; duplicate {
			continue
		}
		if !isExecutableFile(candidatePath) {
			continue
		}
		seen[candidatePath] = struct{}{}
		candidates = append(candidates, pythonCandidate{Path: candidatePath})
	}
	if len(candidates) == 0 {
		return nil, errors.New(
			"Hermes launcher has no trusted Python interpreter",
		)
	}
	return candidates, nil
}

func trustedHomeHermesLauncher(home string) string {
	for _, relative := range []string{
		filepath.Join(".local", "bin", "hermes"),
		filepath.Join("bin", "hermes"),
	} {
		candidate := filepath.Join(home, relative)
		if isExecutableFile(candidate) {
			return candidate
		}
	}
	return ""
}

func launcherLiteralExecPythonInterpreter(path string) string {
	shebangInterpreter := launcherShebangInterpreter(path)
	switch filepath.Base(shebangInterpreter) {
	case "bash", "sh":
	default:
		return ""
	}

	file, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer file.Close()

	const maximumLauncherBytes = 64 << 10
	scanner := bufio.NewScanner(io.LimitReader(file, maximumLauncherBytes))
	scanner.Buffer(make([]byte, 4096), maximumLauncherBytes)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if !strings.HasPrefix(line, "exec ") &&
			!strings.HasPrefix(line, "exec\t") {
			continue
		}
		target := strings.TrimLeft(line[len("exec"):], " \t")
		if len(target) < 3 || target[0] != '"' && target[0] != '\'' {
			continue
		}
		quote := target[0]
		end := strings.IndexByte(target[1:], quote)
		if end < 0 {
			continue
		}
		end++
		if end+1 < len(target) &&
			target[end+1] != ' ' &&
			target[end+1] != '\t' {
			continue
		}
		interpreter := target[1:end]
		if strings.ContainsAny(interpreter, "$`\\\r\n") ||
			!filepath.IsAbs(interpreter) ||
			!isPythonInterpreterName(filepath.Base(interpreter)) {
			continue
		}
		return filepath.Clean(interpreter)
	}
	return ""
}

func isPythonInterpreterName(name string) bool {
	if name == "python" {
		return true
	}
	if !strings.HasPrefix(name, "python") {
		return false
	}
	version := strings.TrimPrefix(name, "python")
	if version == "" {
		return false
	}
	for _, component := range strings.Split(version, ".") {
		if component == "" {
			return false
		}
		for _, character := range component {
			if character < '0' || character > '9' {
				return false
			}
		}
	}
	return true
}

func launcherShebangInterpreter(path string) string {
	file, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer file.Close()
	line, err := bufio.NewReaderSize(file, 4096).ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return ""
	}
	line = strings.TrimSpace(line)
	if !strings.HasPrefix(line, "#!") {
		return ""
	}
	fields := strings.Fields(strings.TrimSpace(strings.TrimPrefix(line, "#!")))
	if len(fields) == 0 {
		return ""
	}
	if filepath.Base(fields[0]) != "env" {
		return fields[0]
	}
	for _, field := range fields[1:] {
		if !strings.HasPrefix(field, "-") {
			return field
		}
	}
	return ""
}

func isExecutableFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil &&
		info.Mode().IsRegular() &&
		info.Mode().Perm()&0o111 != 0
}

func (driver *Driver) queryDefaultModelOptions(
	ctx context.Context,
) (runtimeapi.ModelResult, error) {
	if driver.homeErr != nil {
		return runtimeapi.ModelResult{}, driver.homeErr
	}
	candidate, _, err := driver.probePythonGateway(ctx)
	if err != nil {
		return runtimeapi.ModelResult{}, err
	}
	environment := sanitizeProcessEnvironment(currentEnvironment())
	environment["HOME"] = driver.trustedHome
	environment["PYTHONUNBUFFERED"] = "1"
	delete(environment, "HERMES_HOME")
	delete(environment, "HERMES_PROFILE")
	delete(environment, "RAFT_PROFILE")
	delete(environment, "SLOCK_PROFILE")

	args := append([]string(nil), candidate.ArgsPrefix...)
	args = append(args, "-u", "-m", "tui_gateway.entry")
	command := exec.Command(candidate.Path, args...)
	command.Env = environmentList(environment)
	stdin, err := command.StdinPipe()
	if err != nil {
		return runtimeapi.ModelResult{}, err
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		return runtimeapi.ModelResult{}, err
	}
	stderr, err := command.StderrPipe()
	if err != nil {
		return runtimeapi.ModelResult{}, err
	}
	if err := command.Start(); err != nil {
		return runtimeapi.ModelResult{}, err
	}
	go io.Copy(io.Discard, stderr)
	wire := newTransport(stdout, stdin, transportOptions{})
	waitDone := make(chan error, 1)
	go func() {
		waitDone <- command.Wait()
	}()
	cleanup := func() {
		wire.Close()
		_ = stdin.Close()
		select {
		case <-waitDone:
		case <-time.After(gatewayStopTimeout):
			if command.Process != nil {
				_ = command.Process.Kill()
			}
			<-waitDone
		}
	}
	defer cleanup()

	startCtx, cancel := context.WithTimeout(ctx, gatewayStartupTimeout)
	defer cancel()
	for {
		select {
		case event := <-wire.Events():
			if event.Type == "gateway.ready" {
				var result gatewayModelOptionsResult
				if err := wire.Call(
					startCtx,
					"model.options",
					nil,
					&result,
				); err != nil {
					return runtimeapi.ModelResult{}, err
				}
				stopCtx, stopCancel := context.WithTimeout(
					context.Background(),
					500*time.Millisecond,
				)
				_ = wire.Call(stopCtx, "process.stop", nil, nil)
				stopCancel()
				return modelResultFromGatewayOptions(result), nil
			}
		case <-wire.Done():
			if err := wire.Err(); err != nil {
				return runtimeapi.ModelResult{}, err
			}
			return runtimeapi.ModelResult{}, errors.New(
				"Hermes Gateway model probe exited before gateway.ready",
			)
		case <-startCtx.Done():
			return runtimeapi.ModelResult{}, startCtx.Err()
		}
	}
}

func (driver *Driver) Start(
	ctx context.Context,
	request runtimeapi.StartRequest,
) (runtimeapi.RuntimeSession, error) {
	workingDirectory := strings.TrimSpace(request.WorkingDirectory)
	if workingDirectory == "" {
		return nil, errors.New("Hermes Gateway working directory is required")
	}
	workingDirectory, err := filepath.Abs(workingDirectory)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(workingDirectory)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, errors.New("Hermes Gateway working directory is not a directory")
	}
	candidate, _, err := driver.probePythonGateway(ctx)
	if err != nil {
		return nil, err
	}
	host, err := driver.hostDriver.PrepareManagedHost(ctx, request.AgentID)
	if err != nil {
		return nil, err
	}
	lease, err := hermes.AcquireManagedProfileRuntimeLease(
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
			_ = lease.Release()
		}
	}()

	environment := sanitizeProcessEnvironment(request.Environment)
	delete(environment, "RAFT_PROFILE")
	delete(environment, "SLOCK_PROFILE")
	delete(environment, "HERMES_PROFILE")
	environment["HOME"] = host.TrustedHome
	environment["HERMES_HOME"] = host.ProfileHome
	environment["PYTHONUNBUFFERED"] = "1"

	args := append([]string(nil), candidate.ArgsPrefix...)
	args = append(args, "-u", "-m", "tui_gateway.entry")
	command := exec.Command(candidate.Path, args...)
	command.Dir = workingDirectory
	command.Env = environmentList(environment)
	stdin, err := command.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr, err := command.StderrPipe()
	if err != nil {
		return nil, err
	}
	if err := command.Start(); err != nil {
		return nil, err
	}
	session := &gatewaySession{
		command:          command,
		stdin:            stdin,
		transport:        newTransport(stdout, stdin, transportOptions{}),
		events:           make(chan runtimeapi.Event, 256),
		ready:            make(chan struct{}),
		eventDone:        make(chan struct{}),
		done:             make(chan struct{}),
		launchID:         request.LaunchID,
		permissionPolicy: gatewayPermissionPolicy(environment),
		runtimeLease:     lease,
		runtimeHome: runtimeapi.RuntimeHomeInfo{
			ObservedDir:   host.ProfileHome,
			ConfiguredDir: host.ProfileHome,
			Explicit:      true,
		},
	}
	go io.Copy(io.Discard, stderr)
	go session.consumeEvents()
	go session.wait()
	leaseOwnedByStart = false

	startCtx, cancel := context.WithTimeout(ctx, gatewayStartupTimeout)
	defer cancel()
	select {
	case <-session.ready:
	case <-session.done:
		return nil, session.startupError("Hermes Gateway exited before gateway.ready")
	case <-startCtx.Done():
		_ = session.Stop(context.Background())
		return nil, fmt.Errorf("wait for Hermes gateway.ready: %w", startCtx.Err())
	}

	requestedModel := strings.TrimSpace(request.Model)
	if requestedModel != "" && requestedModel != "default" {
		models, err := session.modelOptions(startCtx)
		if err != nil {
			session.abortStartup()
			return nil, fmt.Errorf("read Hermes Gateway model options: %w", err)
		}
		if err := validateModelSelection(requestedModel, models); err != nil {
			session.abortStartup()
			return nil, err
		}
	}
	liveID, storedID, resumed, err := session.open(
		startCtx,
		workingDirectory,
		request,
	)
	if err != nil {
		session.abortStartup()
		return nil, err
	}
	session.setIdentity(liveID, storedID)
	session.emit(runtimeapi.Event{
		Kind:      runtimeapi.EventSession,
		SessionID: storedID,
		LaunchID:  request.LaunchID,
	})
	if request.SessionID != "" && !resumed {
		session.emit(runtimeapi.Event{
			Kind:               runtimeapi.EventRecovery,
			Text:               "Hermes Gateway could not resume its previous session; a fresh session was started.",
			LaunchID:           request.LaunchID,
			RecoverySource:     "hermes_gateway_resume_missing",
			RecoveryClass:      "missing_session",
			RecoveryAction:     "fallback_fresh_session",
			RequestedSessionID: request.SessionID,
		})
	}
	prompt := managedInitialPrompt(request.StandingPrompt, request.Prompt)
	if prompt != "" {
		if err := session.submit(startCtx, prompt); err != nil {
			session.abortStartup()
			return nil, fmt.Errorf("submit initial Hermes Gateway prompt: %w", err)
		}
	}
	return session, nil
}

type gatewaySession struct {
	command   *exec.Cmd
	stdin     io.WriteCloser
	transport *transport
	events    chan runtimeapi.Event
	ready     chan struct{}
	eventDone chan struct{}
	done      chan struct{}

	mu               sync.Mutex
	liveID           string
	storedID         string
	active           bool
	waitErr          error
	stopping         bool
	launchID         string
	permissionPolicy string
	runtimeHome      runtimeapi.RuntimeHomeInfo
	runtimeLease     *hermes.ManagedProfileRuntimeLease

	readyOnce sync.Once
	stopOnce  sync.Once
	doneOnce  sync.Once
}

var _ runtimeapi.RuntimeSession = (*gatewaySession)(nil)
var _ runtimeapi.NativeSteerer = (*gatewaySession)(nil)
var _ runtimeapi.NativeTurnInterrupter = (*gatewaySession)(nil)
var _ runtimeapi.RuntimeHomeProvider = (*gatewaySession)(nil)
var _ runtimeapi.LivenessProber = (*gatewaySession)(nil)

func (session *gatewaySession) Events() <-chan runtimeapi.Event {
	return session.events
}

func (session *gatewaySession) SessionID() string {
	session.mu.Lock()
	defer session.mu.Unlock()
	return session.storedID
}

func (session *gatewaySession) RuntimeHomeInfo() runtimeapi.RuntimeHomeInfo {
	return session.runtimeHome
}

func (session *gatewaySession) RuntimeLiveness() runtimeapi.Liveness {
	select {
	case <-session.done:
		return runtimeapi.LivenessDead
	default:
	}
	if session.command == nil || session.command.Process == nil {
		return runtimeapi.LivenessUnknown
	}
	if err := session.command.Process.Signal(syscall.Signal(0)); err == nil {
		return runtimeapi.LivenessAlive
	}
	return runtimeapi.LivenessUnknown
}

func (session *gatewaySession) setIdentity(liveID string, storedID string) {
	session.mu.Lock()
	session.liveID = strings.TrimSpace(liveID)
	session.storedID = strings.TrimSpace(storedID)
	session.mu.Unlock()
}

func (session *gatewaySession) identity() (string, string, bool) {
	session.mu.Lock()
	defer session.mu.Unlock()
	return session.liveID, session.storedID, session.active
}

func (session *gatewaySession) open(
	ctx context.Context,
	workingDirectory string,
	request runtimeapi.StartRequest,
) (string, string, bool, error) {
	requested := strings.TrimSpace(request.SessionID)
	if requested != "" {
		var resumed gatewaySessionResult
		err := session.transport.Call(ctx, "session.resume", map[string]any{
			"session_id": requested,
			"cwd":        workingDirectory,
			"source":     "raft-computer",
		}, &resumed)
		if err == nil {
			liveID, storedID := resumed.identity()
			if liveID != "" && storedID != "" {
				return liveID, storedID, true, nil
			}
			return "", "", false, errors.New(
				"Hermes Gateway session.resume response is missing identity",
			)
		}
		var remote *rpcRemoteError
		if !errors.As(err, &remote) || remote.Code != 4007 {
			return "", "", false, fmt.Errorf(
				"resume Hermes Gateway session: %w",
				err,
			)
		}
	}
	params := map[string]any{
		"cwd":    workingDirectory,
		"source": "raft-computer",
	}
	if model := strings.TrimSpace(request.Model); model != "" && model != "default" {
		params["model"] = model
	}
	if effort := strings.TrimSpace(request.ReasoningEffort); effort != "" {
		params["reasoning_effort"] = effort
	}
	var created gatewaySessionResult
	if err := session.transport.Call(
		ctx,
		"session.create",
		params,
		&created,
	); err != nil {
		return "", "", false, fmt.Errorf("create Hermes Gateway session: %w", err)
	}
	liveID, storedID := created.identity()
	if liveID == "" || storedID == "" {
		return "", "", false, errors.New(
			"Hermes Gateway session response is missing identity",
		)
	}
	return liveID, storedID, false, nil
}

type gatewaySessionResult struct {
	SessionID       string `json:"session_id"`
	StoredSessionID string `json:"stored_session_id"`
	SessionKey      string `json:"session_key"`
}

func (result gatewaySessionResult) identity() (string, string) {
	liveID := strings.TrimSpace(result.SessionID)
	storedID := strings.TrimSpace(result.StoredSessionID)
	if storedID == "" {
		storedID = strings.TrimSpace(result.SessionKey)
	}
	return liveID, storedID
}

func (session *gatewaySession) modelOptions(
	ctx context.Context,
) (runtimeapi.ModelResult, error) {
	var result gatewayModelOptionsResult
	if err := session.transport.Call(ctx, "model.options", nil, &result); err != nil {
		return runtimeapi.ModelResult{}, err
	}
	return modelResultFromGatewayOptions(result), nil
}

type gatewayModelOptionsResult struct {
	Providers []struct {
		Models []json.RawMessage `json:"models"`
	} `json:"providers"`
}

func modelResultFromGatewayOptions(
	result gatewayModelOptionsResult,
) runtimeapi.ModelResult {
	seen := make(map[string]struct{})
	models := make([]runtimeapi.Model, 0)
	for _, provider := range result.Providers {
		for _, raw := range provider.Models {
			modelID := modelIDFromRaw(raw)
			if modelID == "" {
				continue
			}
			if _, duplicate := seen[modelID]; duplicate {
				continue
			}
			seen[modelID] = struct{}{}
			models = append(models, runtimeapi.Model{ID: modelID, Label: modelID})
		}
	}
	sort.Slice(models, func(left int, right int) bool {
		return models[left].ID < models[right].ID
	})
	return runtimeapi.ModelResult{Models: models, Default: "default"}
}

func modelIDFromRaw(raw json.RawMessage) string {
	var text string
	if common.Unmarshal(raw, &text) == nil {
		return strings.TrimSpace(text)
	}
	var object struct {
		ID    string `json:"id"`
		Slug  string `json:"slug"`
		Model string `json:"model"`
	}
	if common.Unmarshal(raw, &object) != nil {
		return ""
	}
	for _, candidate := range []string{object.ID, object.Slug, object.Model} {
		if candidate = strings.TrimSpace(candidate); candidate != "" {
			return candidate
		}
	}
	return ""
}

func (session *gatewaySession) Deliver(
	ctx context.Context,
	delivery runtimeapi.Delivery,
) error {
	_, _, active := session.identity()
	mode := strings.TrimSpace(delivery.Mode)
	if mode == "" {
		if active {
			mode = "busy"
		} else {
			mode = "idle"
		}
	}
	if mode == "busy" {
		return session.Steer(ctx, delivery)
	}
	return session.submit(ctx, delivery.Text)
}

func (session *gatewaySession) submit(ctx context.Context, text string) error {
	text = strings.TrimSpace(text)
	if text == "" {
		return errors.New("Hermes Gateway delivery text is required")
	}
	liveID, _, active := session.identity()
	if liveID == "" {
		return errors.New("Hermes Gateway session is not ready")
	}
	if active {
		return runtimeapi.NewRetryableDeliveryError(
			runtimeapi.RetryDelayedIdle,
			errors.New("Hermes Gateway turn is already active"),
		)
	}
	session.mu.Lock()
	session.active = true
	session.mu.Unlock()
	var result struct {
		Status string `json:"status"`
	}
	err := session.transport.Call(ctx, "prompt.submit", map[string]any{
		"session_id": liveID,
		"text":       text,
	}, &result)
	if err != nil {
		session.mu.Lock()
		session.active = false
		session.mu.Unlock()
		return err
	}
	return nil
}

func (session *gatewaySession) Steer(
	ctx context.Context,
	delivery runtimeapi.Delivery,
) error {
	text := strings.TrimSpace(delivery.Text)
	if text == "" {
		return errors.New("Hermes Gateway delivery text is required")
	}
	liveID, _, active := session.identity()
	if liveID == "" {
		return errors.New("Hermes Gateway session is not ready")
	}
	if !active {
		return runtimeapi.NewRetryableDeliveryError(
			runtimeapi.RetryTurnBoundary,
			errors.New("Hermes Gateway has no active turn to steer"),
		)
	}
	var result struct {
		Status string `json:"status"`
	}
	err := session.transport.Call(ctx, "session.steer", map[string]any{
		"session_id": liveID,
		"text":       text,
	}, &result)
	if err != nil {
		return runtimeapi.NewRetryableDeliveryError(
			runtimeapi.RetryTurnBoundary,
			err,
		)
	}
	if strings.TrimSpace(result.Status) != "queued" {
		return runtimeapi.NewRetryableDeliveryError(
			runtimeapi.RetryTurnBoundary,
			errors.New("Hermes Gateway rejected native steering"),
		)
	}
	return nil
}

func (session *gatewaySession) InterruptTurn(ctx context.Context) error {
	liveID, _, active := session.identity()
	if liveID == "" {
		return errors.New("Hermes Gateway session is not ready")
	}
	if !active {
		return nil
	}
	var result struct {
		Status string `json:"status"`
	}
	return session.transport.Call(ctx, "session.interrupt", map[string]any{
		"session_id": liveID,
	}, &result)
}

func (session *gatewaySession) Stop(ctx context.Context) error {
	session.stopOnce.Do(func() {
		session.mu.Lock()
		session.stopping = true
		session.mu.Unlock()
		stopCtx, cancel := context.WithTimeout(
			context.Background(),
			500*time.Millisecond,
		)
		_ = session.transport.Call(stopCtx, "process.stop", nil, nil)
		cancel()
		if session.stdin != nil {
			_ = session.stdin.Close()
		}
		if session.command != nil && session.command.Process != nil {
			_ = session.command.Process.Signal(os.Interrupt)
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
			_ = session.command.Process.Kill()
		}
		<-session.done
		return ctx.Err()
	case <-time.After(gatewayStopTimeout):
		if session.command != nil && session.command.Process != nil {
			_ = session.command.Process.Kill()
		}
		<-session.done
		return nil
	}
}

func (session *gatewaySession) abortStartup() {
	if session.stdin != nil {
		_ = session.stdin.Close()
	}
	if session.command != nil && session.command.Process != nil {
		_ = session.command.Process.Kill()
	}
	<-session.done
}

func (session *gatewaySession) startupError(prefix string) error {
	session.mu.Lock()
	defer session.mu.Unlock()
	if session.waitErr != nil {
		return fmt.Errorf("%s: %w", prefix, session.waitErr)
	}
	return errors.New(prefix)
}

func (session *gatewaySession) wait() {
	err := session.command.Wait()
	if session.runtimeLease != nil {
		_ = session.runtimeLease.Release()
	}
	session.transport.Close()
	<-session.eventDone
	session.mu.Lock()
	session.waitErr = err
	stopping := session.stopping
	session.mu.Unlock()
	if !stopping {
		session.emit(runtimeapi.Event{
			Kind:     runtimeapi.EventError,
			Text:     "Hermes Gateway process exited unexpectedly",
			LaunchID: session.launchID,
		})
	}
	close(session.events)
	session.doneOnce.Do(func() { close(session.done) })
}

func (session *gatewaySession) consumeEvents() {
	defer close(session.eventDone)
	for {
		select {
		case event := <-session.transport.Events():
			session.handleGatewayEvent(event)
		case <-session.transport.Done():
			for {
				select {
				case event := <-session.transport.Events():
					session.handleGatewayEvent(event)
				default:
					return
				}
			}
		}
	}
}

func (session *gatewaySession) handleGatewayEvent(event gatewayEvent) {
	if event.Type == "gateway.ready" {
		session.traceGatewayEvent(event, "", false)
		session.readyOnce.Do(func() { close(session.ready) })
		return
	}
	liveID, _, _ := session.identity()
	matchesSession := liveID != "" && event.SessionID == liveID
	session.traceGatewayEvent(event, liveID, matchesSession)
	if !matchesSession {
		return
	}
	switch event.Type {
	case "message.delta", "message.interim":
		session.emit(runtimeapi.Event{
			Kind:         runtimeapi.EventActivity,
			ActivityKind: "assistant_stream",
			Detail:       "Hermes is responding",
			LaunchID:     session.launchID,
		})
	case "message.complete":
		session.mu.Lock()
		if !session.active {
			session.mu.Unlock()
			return
		}
		session.active = false
		session.mu.Unlock()
		var payload struct {
			Text      string          `json:"text"`
			Status    string          `json:"status"`
			Reasoning string          `json:"reasoning"`
			Usage     json.RawMessage `json:"usage"`
			Error     string          `json:"error"`
		}
		if common.Unmarshal(event.Payload, &payload) != nil {
			session.emit(runtimeapi.Event{
				Kind:     runtimeapi.EventError,
				Text:     "Hermes Gateway completion payload was malformed",
				LaunchID: session.launchID,
			})
		} else {
			if strings.TrimSpace(payload.Status) == "error" {
				session.emit(runtimeapi.Event{
					Kind:     runtimeapi.EventError,
					Text:     strings.TrimSpace(payload.Error),
					LaunchID: session.launchID,
				})
			} else if text := strings.TrimSpace(payload.Text); text != "" {
				session.emit(runtimeapi.Event{
					Kind:     runtimeapi.EventAssistantText,
					Text:     text,
					LaunchID: session.launchID,
				})
			}
			if len(payload.Usage) > 0 {
				session.emit(runtimeapi.Event{
					Kind:     runtimeapi.EventUsage,
					Raw:      append(json.RawMessage(nil), payload.Usage...),
					LaunchID: session.launchID,
				})
			}
		}
		session.emit(runtimeapi.Event{
			Kind:     runtimeapi.EventTurnCompletion,
			LaunchID: session.launchID,
		})
	case "tool.start":
		session.emit(runtimeapi.Event{
			Kind:     runtimeapi.EventToolCall,
			LaunchID: session.launchID,
			Raw:      append(json.RawMessage(nil), event.Payload...),
		})
	case "tool.progress", "tool.complete":
		session.emit(runtimeapi.Event{
			Kind:     runtimeapi.EventToolOutput,
			LaunchID: session.launchID,
			Raw:      append(json.RawMessage(nil), event.Payload...),
		})
	case "error":
		session.emit(runtimeapi.Event{
			Kind:     runtimeapi.EventError,
			Text:     "Hermes Gateway reported an error",
			LaunchID: session.launchID,
		})
	case "approval.request",
		"clarify.request",
		"sudo.request",
		"secret.request",
		"terminal.read.request":
		session.resolveInteraction(event)
	}
}

func (session *gatewaySession) traceGatewayEvent(
	event gatewayEvent,
	liveID string,
	matchesSession bool,
) {
	if os.Getenv("RAFT_COMPUTER_GO_TRACE_HERMES_EVENTS") != "1" {
		return
	}
	_, _, active := session.identity()
	_, _ = fmt.Fprintf(
		os.Stderr,
		"hermes gateway event=%q session_present=%t session_match=%t active=%t live_session_present=%t\n",
		event.Type,
		strings.TrimSpace(event.SessionID) != "",
		matchesSession,
		active,
		strings.TrimSpace(liveID) != "",
	)
}

func (session *gatewaySession) resolveInteraction(event gatewayEvent) {
	liveID, _, _ := session.identity()
	var payload struct {
		RequestID string   `json:"request_id"`
		Choices   []string `json:"choices"`
	}
	if common.Unmarshal(event.Payload, &payload) != nil {
		session.emit(runtimeapi.Event{
			Kind:     runtimeapi.EventError,
			Text:     "Hermes Gateway interaction payload was malformed",
			LaunchID: session.launchID,
		})
		return
	}
	var method string
	var params map[string]any
	switch event.Type {
	case "approval.request":
		method = "approval.respond"
		choice := permittedApprovalChoice(
			session.permissionPolicy,
			payload.Choices,
		)
		params = map[string]any{
			"session_id": liveID,
			"choice":     choice,
			"all":        false,
		}
	case "clarify.request":
		method = "clarify.respond"
		params = map[string]any{
			"request_id": payload.RequestID,
			"answer":     headlessClarifyAnswer,
		}
	case "sudo.request":
		method = "sudo.respond"
		params = map[string]any{
			"request_id": payload.RequestID,
			"password":   "",
		}
	case "secret.request":
		method = "secret.respond"
		params = map[string]any{
			"request_id": payload.RequestID,
			"value":      "",
		}
	case "terminal.read.request":
		method = "terminal.read.respond"
		params = map[string]any{
			"request_id": payload.RequestID,
			"text":       "",
		}
	}
	if method != "approval.respond" && strings.TrimSpace(payload.RequestID) == "" {
		session.emit(runtimeapi.Event{
			Kind:     runtimeapi.EventError,
			Text:     "Hermes Gateway interaction is missing a request ID",
			LaunchID: session.launchID,
		})
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	err := session.transport.Call(ctx, method, params, nil)
	cancel()
	if err != nil {
		session.emit(runtimeapi.Event{
			Kind:     runtimeapi.EventError,
			Text:     "Hermes Gateway headless interaction resolution failed",
			LaunchID: session.launchID,
		})
		return
	}
	session.emit(runtimeapi.Event{
		Kind:     runtimeapi.EventDiagnostic,
		Text:     "Hermes Gateway headless interaction resolved by policy",
		LaunchID: session.launchID,
	})
}

func gatewayPermissionPolicy(environment map[string]string) string {
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

func permittedApprovalChoice(policy string, choices []string) string {
	preferred := gatewayPermissionPolicy(map[string]string{
		"HERMES_ACP_PERMISSION_POLICY": policy,
	})
	if len(choices) == 0 {
		return preferred
	}
	for _, choice := range choices {
		if strings.TrimSpace(choice) == preferred {
			return preferred
		}
	}
	for _, choice := range choices {
		if strings.TrimSpace(choice) == "deny" {
			return "deny"
		}
	}
	// Never escalate merely because a server omitted the safe choice from its
	// advertised list. An explicit deny may be rejected, but it cannot grant a
	// capability the configured policy did not authorize.
	return "deny"
}

func (session *gatewaySession) emit(event runtimeapi.Event) {
	select {
	case session.events <- event:
	case <-session.done:
	}
}

func managedInitialPrompt(standingPrompt string, prompt string) string {
	standingPrompt = strings.TrimSpace(standingPrompt)
	prompt = strings.TrimSpace(prompt)
	switch {
	case standingPrompt == "":
		return prompt
	case prompt == "":
		return "[Computer operating instructions]\n" + standingPrompt
	default:
		return "[Computer operating instructions]\n" + standingPrompt +
			"\n\n[Current input]\n" + prompt
	}
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

func currentEnvironment() map[string]string {
	environment := make(map[string]string)
	for _, entry := range os.Environ() {
		key, value, found := strings.Cut(entry, "=")
		if found {
			environment[key] = value
		}
	}
	return environment
}

func firstNonEmptyLine(output []byte) string {
	for _, line := range strings.Split(string(output), "\n") {
		if line = strings.TrimSpace(line); line != "" {
			return line
		}
	}
	return ""
}
