package codex

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"math/big"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf16"

	"velachat/agent/internal/common"
	"velachat/agent/internal/runtimeapi"
)

const (
	chatGPTDesktopExecutable = "/Applications/ChatGPT.app/Contents/Resources/codex"
	codexDesktopExecutable   = "/Applications/Codex.app/Contents/Resources/codex"
	maximumRPCLine           = 16 * 1024 * 1024
	modelProbeTimeout        = 5 * time.Second
	maxModelPages            = 5

	missingResumeMessage = "Codex could not resume its previous thread; Vela started a fresh Codex thread."
	missingResumeDetails = "Use Vela conversation history and local MEMORY.md/notes as the recovery point; do not assume prior Codex thread context is loaded."
	codexRPCFailureText  = "Codex app-server request failed"
)

const codexInitializeCompatibilityText = "Codex app-server initialize " +
	"response is missing the expected userAgent handshake field; upgrade " +
	"Codex CLI to a compatible app-server build."

var (
	ErrBusySteeringUnavailable = errors.New("Codex busy steering is unavailable without an active turn")
	ErrSessionStopped          = errors.New("Codex runtime session has stopped")
	missingResumePatterns      = []*regexp.Regexp{
		regexp.MustCompile(`(?i)\bno\s+rollout\s+found\b`),
		regexp.MustCompile(`(?i)\bmissing\s+rollout\b`),
		regexp.MustCompile(`(?i)\brollout\b.*\b(not found|missing)\b`),
		regexp.MustCompile(`(?i)\bthread\b.*\b(not found|missing)\b`),
		regexp.MustCompile(`(?i)\bmissing\s+thread\b`),
	}
)

type codexInitializeResult struct {
	UserAgent string `json:"userAgent"`
	CodexHome string `json:"codexHome"`
}

func decodeCodexInitializeResult(
	raw json.RawMessage,
) (codexInitializeResult, error) {
	var result codexInitializeResult
	if err := common.Unmarshal(raw, &result); err != nil ||
		strings.TrimSpace(result.UserAgent) == "" {
		return codexInitializeResult{},
			errors.New(codexInitializeCompatibilityText)
	}
	return result, nil
}

func unsupportedCodexServerRequestText(method string) string {
	return `Codex app-server request "` + method +
		`" is not supported by the non-interactive Vela daemon`
}

type Options struct {
	Executable string
	ArgsPrefix []string
	Version    string
}

type Driver struct {
	executable         string
	argsPrefix         []string
	version            string
	candidateSource    func() []executableCandidate
	candidateValidator func(context.Context, executableCandidate) (string, error)
}

func New(options Options) *Driver {
	version := options.Version
	if version == "" {
		version = "0.1.0-dev"
	}
	return &Driver{
		executable: options.Executable,
		argsPrefix: append([]string(nil), options.ArgsPrefix...),
		version:    version,
	}
}

func (d *Driver) discoverProfileCapabilitiesFromAppServer(
	ctx context.Context,
	request runtimeapi.ProfileCapabilityRequest,
	includeSkills bool,
) (runtimeapi.ProfileCapabilityResult, error) {
	selection, err := d.selectExecutable(ctx)
	if err != nil {
		return runtimeapi.ProfileCapabilityResult{}, err
	}
	probeCtx, cancel := context.WithTimeout(ctx, modelProbeTimeout)
	defer cancel()

	args := append(
		append([]string(nil), selection.Candidate.ArgsPrefix...),
		"app-server",
		"--listen",
		"stdio://",
	)
	command := exec.CommandContext(probeCtx, selection.Candidate.Path, args...)
	command.Dir = request.WorkingDirectory
	command.Env = mergedEnvironment(request.Environment)
	stdin, err := command.StdinPipe()
	if err != nil {
		return runtimeapi.ProfileCapabilityResult{}, err
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		return runtimeapi.ProfileCapabilityResult{}, err
	}
	command.Stderr = io.Discard
	if err := command.Start(); err != nil {
		return runtimeapi.ProfileCapabilityResult{}, err
	}
	done := make(chan struct{})
	go func() {
		_ = command.Wait()
		close(done)
	}()
	defer stopDiscoveryProcess(command, stdin, done)

	messages := make(chan rpcMessage)
	readErrors := make(chan error, 1)
	go readDiscoveryMessages(stdout, messages, readErrors)
	client := modelDiscoveryClient{
		stdin:      stdin,
		messages:   messages,
		readErrors: readErrors,
		done:       done,
	}
	initialize, err := client.request(probeCtx, "initialize", map[string]any{
		"clientInfo":   map[string]string{"name": "vela-computer", "version": d.version},
		"capabilities": map[string]bool{"experimentalApi": true},
	})
	if err != nil {
		return runtimeapi.ProfileCapabilityResult{}, fmt.Errorf("initialize Codex profile discovery: %w", err)
	}
	initialized, err := decodeCodexInitializeResult(initialize.Result)
	if err != nil {
		return runtimeapi.ProfileCapabilityResult{}, err
	}
	if err := client.notify("initialized", map[string]any{}); err != nil {
		return runtimeapi.ProfileCapabilityResult{}, err
	}

	result := runtimeapi.ModelResult{Models: []runtimeapi.Model{}}
	cursor := ""
	for pageNumber := 0; pageNumber < maxModelPages; pageNumber++ {
		params := map[string]any{}
		if cursor != "" {
			params["cursor"] = cursor
		}
		response, err := client.request(probeCtx, "model/list", params)
		if err != nil {
			return runtimeapi.ProfileCapabilityResult{}, fmt.Errorf("list Codex models: %w", err)
		}
		page, err := decodeModelPage(response.Result)
		if err != nil {
			return runtimeapi.ProfileCapabilityResult{}, err
		}
		for _, raw := range page.Entries {
			model, isDefault, ok := decodeCodexModel(raw)
			if !ok {
				continue
			}
			result.Models = append(result.Models, model)
			if result.Default == "" && isDefault {
				result.Default = model.ID
			}
		}
		cursor = page.NextCursor
		if cursor == "" {
			break
		}
	}
	skills := []runtimeapi.Skill{}
	if includeSkills {
		skillsResponse, err := client.request(probeCtx, "skills/list", map[string]any{
			"cwds":        []string{request.WorkingDirectory},
			"forceReload": request.ForceReload,
		})
		if err != nil {
			return runtimeapi.ProfileCapabilityResult{}, fmt.Errorf("list Codex skills: %w", err)
		}
		skills, err = decodeCodexSkills(skillsResponse.Result)
		if err != nil {
			return runtimeapi.ProfileCapabilityResult{}, err
		}
	}
	return runtimeapi.ProfileCapabilityResult{
		Protocol:       "codex_app_server",
		RuntimeVersion: d.version,
		ProfileHome:    initialized.CodexHome,
		ProfileKind:    "codex_home",
		Models:         result,
		Skills:         skills,
	}, nil
}

func (d *Driver) detectModelsFromAppServer(
	ctx context.Context,
) (runtimeapi.ModelResult, error) {
	workingDirectory, err := os.Getwd()
	if err != nil {
		workingDirectory = "."
	}
	result, err := d.discoverProfileCapabilitiesFromAppServer(
		ctx,
		runtimeapi.ProfileCapabilityRequest{
			WorkingDirectory: workingDirectory,
		},
		false,
	)
	return result.Models, err
}

func (d *Driver) DiscoverProfileCapabilities(
	ctx context.Context,
	request runtimeapi.ProfileCapabilityRequest,
) (runtimeapi.ProfileCapabilityResult, error) {
	if strings.TrimSpace(request.AgentID) == "" ||
		strings.TrimSpace(request.WorkingDirectory) == "" {
		return runtimeapi.ProfileCapabilityResult{},
			errors.New("Codex Profile discovery requires Agent and workspace")
	}
	workingDirectory, err := filepath.Abs(request.WorkingDirectory)
	if err != nil {
		return runtimeapi.ProfileCapabilityResult{}, err
	}
	if err := ensureDirectory(workingDirectory); err != nil {
		return runtimeapi.ProfileCapabilityResult{}, err
	}
	request.WorkingDirectory = workingDirectory
	return d.discoverProfileCapabilitiesFromAppServer(ctx, request, true)
}

type modelDiscoveryClient struct {
	stdin      io.Writer
	messages   <-chan rpcMessage
	readErrors <-chan error
	done       <-chan struct{}
	nextID     int64
}

func (c *modelDiscoveryClient) request(
	ctx context.Context,
	method string,
	params any,
) (rpcMessage, error) {
	c.nextID++
	requestID := c.nextID
	if err := c.write(map[string]any{
		"jsonrpc": "2.0",
		"id":      requestID,
		"method":  method,
		"params":  params,
	}); err != nil {
		return rpcMessage{}, err
	}
	for {
		select {
		case message, ok := <-c.messages:
			if !ok {
				return rpcMessage{}, errors.New("Codex model discovery stream closed")
			}
			messageID, matchesPending := message.pendingID()
			if !message.isResponse() ||
				!matchesPending ||
				messageID != requestID {
				continue
			}
			if message.requestFailed(method) {
				return message, fmt.Errorf(
					"Codex RPC %s failed (%d): %s",
					method,
					message.Error.Code,
					message.errorMessageOrFallback(),
				)
			}
			return message, nil
		case err := <-c.readErrors:
			if err == nil {
				err = errors.New("Codex model discovery stream closed")
			}
			return rpcMessage{}, err
		case <-c.done:
			return rpcMessage{}, errors.New("Codex model discovery process exited")
		case <-ctx.Done():
			return rpcMessage{}, ctx.Err()
		}
	}
}

func (c *modelDiscoveryClient) notify(method string, params any) error {
	return c.write(map[string]any{
		"jsonrpc": "2.0",
		"method":  method,
		"params":  params,
	})
}

func (c *modelDiscoveryClient) write(value any) error {
	data, err := common.Marshal(value)
	if err != nil {
		return err
	}
	_, err = c.stdin.Write(append(data, '\n'))
	return err
}

func readDiscoveryMessages(
	reader io.Reader,
	messages chan<- rpcMessage,
	readErrors chan<- error,
) {
	defer close(messages)
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 64*1024), maximumRPCLine)
	for scanner.Scan() {
		message, err := decodeRPCMessage(scanner.Bytes())
		if err != nil {
			continue
		}
		messages <- message
	}
	if err := scanner.Err(); err != nil {
		readErrors <- err
	}
}

func stopDiscoveryProcess(
	command *exec.Cmd,
	stdin io.Closer,
	done <-chan struct{},
) {
	_ = stdin.Close()
	select {
	case <-done:
		return
	default:
	}
	if command.Process != nil {
		_ = command.Process.Signal(os.Interrupt)
	}
	timer := time.NewTimer(time.Second)
	defer timer.Stop()
	select {
	case <-done:
	case <-timer.C:
		if command.Process != nil {
			_ = command.Process.Kill()
		}
		<-done
	}
}

type modelPage struct {
	Entries    []json.RawMessage
	NextCursor string
}

func decodeModelPage(raw json.RawMessage) (modelPage, error) {
	var page struct {
		Data       []json.RawMessage `json:"data"`
		Models     []json.RawMessage `json:"models"`
		NextCursor string            `json:"nextCursor"`
	}
	if err := common.Unmarshal(raw, &page); err != nil {
		return modelPage{}, err
	}
	entries := page.Data
	if entries == nil {
		entries = page.Models
	}
	if entries == nil {
		return modelPage{}, errors.New("Codex model/list response is missing models")
	}
	return modelPage{
		Entries:    entries,
		NextCursor: strings.TrimSpace(page.NextCursor),
	}, nil
}

func decodeCodexModel(raw json.RawMessage) (runtimeapi.Model, bool, bool) {
	var entry struct {
		ID                        string            `json:"id"`
		Model                     string            `json:"model"`
		Slug                      string            `json:"slug"`
		DisplayName               string            `json:"displayName"`
		DisplayNameLegacy         string            `json:"display_name"`
		Label                     string            `json:"label"`
		Hidden                    bool              `json:"hidden"`
		IsDefault                 bool              `json:"isDefault"`
		SupportedReasoningEfforts []json.RawMessage `json:"supportedReasoningEfforts"`
		DefaultReasoningEffort    string            `json:"defaultReasoningEffort"`
		ServiceTiers              []json.RawMessage `json:"serviceTiers"`
		AdditionalSpeedTiers      []json.RawMessage `json:"additionalSpeedTiers"`
		DefaultServiceTier        string            `json:"defaultServiceTier"`
	}
	if common.Unmarshal(raw, &entry) != nil || entry.Hidden {
		return runtimeapi.Model{}, false, false
	}
	id := firstNonEmpty(entry.ID, entry.Model, entry.Slug)
	if id == "" {
		return runtimeapi.Model{}, false, false
	}
	label := firstNonEmpty(
		entry.DisplayName,
		entry.DisplayNameLegacy,
		entry.Label,
		id,
	)
	serviceTiers := decodeModelStringList(entry.ServiceTiers, "id", "serviceTier")
	if len(serviceTiers) == 0 {
		serviceTiers = decodeModelStringList(
			entry.AdditionalSpeedTiers,
			"id",
			"serviceTier",
		)
	}
	return runtimeapi.Model{
		ID:                        id,
		Label:                     label,
		Verified:                  "launchable",
		SupportedReasoningEfforts: decodeModelStringList(entry.SupportedReasoningEfforts, "reasoningEffort", "id"),
		DefaultReasoningEffort:    strings.TrimSpace(entry.DefaultReasoningEffort),
		ServiceTiers:              serviceTiers,
		DefaultServiceTier:        strings.TrimSpace(entry.DefaultServiceTier),
	}, entry.IsDefault, true
}

func decodeCodexSkills(raw json.RawMessage) ([]runtimeapi.Skill, error) {
	var result struct {
		Data []struct {
			Skills []json.RawMessage `json:"skills"`
		} `json:"data"`
		Skills []json.RawMessage `json:"skills"`
	}
	if err := common.Unmarshal(raw, &result); err != nil {
		return nil, err
	}
	entries := result.Skills
	for _, group := range result.Data {
		entries = append(entries, group.Skills...)
	}
	if entries == nil {
		return nil, errors.New("Codex skills/list response is missing skills")
	}
	skills := make([]runtimeapi.Skill, 0, len(entries))
	seen := make(map[string]struct{}, len(entries))
	for _, rawSkill := range entries {
		var entry struct {
			ID               string   `json:"id"`
			Name             string   `json:"name"`
			Description      string   `json:"description"`
			DisplayName      string   `json:"displayName"`
			ShortDescription string   `json:"shortDescription"`
			Path             string   `json:"path"`
			Scope            string   `json:"scope"`
			Enabled          *bool    `json:"enabled"`
			Missing          []string `json:"missingDependencyTypes"`
		}
		if common.Unmarshal(rawSkill, &entry) != nil {
			continue
		}
		name := strings.TrimSpace(entry.Name)
		id := firstNonEmpty(entry.ID, name)
		if id == "" || name == "" {
			continue
		}
		if _, duplicate := seen[id]; duplicate {
			continue
		}
		seen[id] = struct{}{}
		enabled := entry.Enabled == nil || *entry.Enabled
		availability := "available"
		if !enabled || len(entry.Missing) > 0 {
			availability = "unavailable"
		}
		scope := strings.TrimSpace(entry.Scope)
		switch scope {
		case "project", "user", "admin", "system", "profile", "external":
		default:
			scope = "unknown"
		}
		skills = append(skills, runtimeapi.Skill{
			ID: id, Name: name, Description: strings.TrimSpace(entry.Description),
			DisplayName:      strings.TrimSpace(entry.DisplayName),
			ShortDescription: strings.TrimSpace(entry.ShortDescription),
			Path:             strings.TrimSpace(entry.Path), Enabled: enabled,
			Availability: availability, Scope: scope,
			MissingDependencyTypes: append([]string(nil), entry.Missing...),
		})
	}
	return skills, nil
}

func decodeModelStringList(
	values []json.RawMessage,
	objectKeys ...string,
) []string {
	if len(values) == 0 {
		return nil
	}
	result := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, raw := range values {
		var text string
		if common.Unmarshal(raw, &text) != nil {
			var object map[string]json.RawMessage
			if common.Unmarshal(raw, &object) != nil {
				continue
			}
			for _, key := range objectKeys {
				if value, ok := object[key]; ok &&
					common.Unmarshal(value, &text) == nil &&
					strings.TrimSpace(text) != "" {
					break
				}
			}
		}
		text = strings.TrimSpace(text)
		if text == "" {
			continue
		}
		if _, exists := seen[text]; exists {
			continue
		}
		seen[text] = struct{}{}
		result = append(result, text)
	}
	return result
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			return value
		}
	}
	return ""
}

func (d *Driver) Start(ctx context.Context, request runtimeapi.StartRequest) (runtimeapi.RuntimeSession, error) {
	selection, err := d.selectExecutable(ctx)
	if err != nil {
		return nil, err
	}
	if request.WorkingDirectory == "" {
		return nil, errors.New("Codex working directory is required")
	}
	if err := ensureDirectory(request.WorkingDirectory); err != nil {
		return nil, err
	}
	args := append(
		append([]string(nil), selection.Candidate.ArgsPrefix...),
		"app-server",
		"--listen",
		"stdio://",
	)
	command := exec.Command(selection.Candidate.Path, args...)
	command.Dir = request.WorkingDirectory
	effectiveEnvironment := mergedEnvironment(request.Environment)
	command.Env = effectiveEnvironment
	configuredHome, explicitHome := resolveCodexHome(
		effectiveEnvironment,
		request.WorkingDirectory,
	)
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
	session := &session{
		command:       command,
		stdin:         stdin,
		events:        make(chan runtimeapi.Event, 256),
		pending:       make(map[int64]chan rpcMessage),
		pendingMethod: make(map[int64]string),
		pendingInput:  make(map[int64]acceptedInputEvidence),
		done:          make(chan struct{}),
		startupDone:   make(chan struct{}),
		launchID:      request.LaunchID,
		runtimeHome: runtimeapi.RuntimeHomeInfo{
			ObservedDir:   configuredHome,
			ConfiguredDir: configuredHome,
			Explicit:      explicitHome,
		},
	}
	defer close(session.startupDone)
	go session.readStdout(stdout)
	go session.drainStderr(stderr)
	go session.wait()

	startupCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	initialize, err := session.request(startupCtx, "initialize", map[string]any{
		"clientInfo":   map[string]string{"name": "vela-computer", "version": d.version},
		"capabilities": map[string]bool{"experimentalApi": true},
	})
	if err != nil {
		session.stopAfterStartupFailure()
		return nil, fmt.Errorf("initialize Codex app-server: %w", err)
	}
	initializeResult, err := decodeCodexInitializeResult(initialize.Result)
	if err != nil {
		session.stopAfterStartupFailure()
		return nil, err
	}
	if strings.TrimSpace(initializeResult.CodexHome) != "" {
		session.runtimeHome.ObservedDir = resolveRuntimeHome(
			request.WorkingDirectory,
			initializeResult.CodexHome,
		)
	}
	if err := session.notify("initialized", map[string]any{}); err != nil {
		session.stopAfterStartupFailure()
		return nil, err
	}

	threadParams := map[string]any{
		"cwd":                   request.WorkingDirectory,
		"approvalPolicy":        "never",
		"sandbox":               "danger-full-access",
		"sandbox_mode":          "danger-full-access",
		"developerInstructions": request.StandingPrompt,
		"experimentalRawEvents": true,
	}
	if request.Model != "" {
		threadParams["model"] = request.Model
	}
	if request.ReasoningEffort != "" {
		threadParams["config"] = map[string]string{"model_reasoning_effort": request.ReasoningEffort}
	}
	if request.ExecutionMode == "fast" {
		threadParams["serviceTier"] = "fast"
	}
	threadMethod := "thread/start"
	if request.SessionID != "" {
		threadMethod = "thread/resume"
		threadParams["threadId"] = request.SessionID
	}
	threadResponse, err := session.request(startupCtx, threadMethod, threadParams)
	if err != nil && threadMethod == "thread/resume" && isMissingResume(err) {
		session.emit(runtimeapi.Event{
			Kind:               runtimeapi.EventRecovery,
			Text:               missingResumeMessage,
			Detail:             missingResumeDetails,
			LaunchID:           request.LaunchID,
			RecoverySource:     "codex_resume_missing_rollout",
			RecoveryClass:      "missing_rollout",
			RecoveryAction:     "fallback_fresh_thread",
			RequestedSessionID: request.SessionID,
		})
		if strings.TrimSpace(request.Prompt) != "" {
			request.Prompt = missingResumeMessage + "\n\n" +
				missingResumeDetails + "\n\n" + request.Prompt
		}
		delete(threadParams, "threadId")
		threadResponse, err = session.request(startupCtx, "thread/start", threadParams)
	}
	if err != nil {
		session.stopAfterStartupFailure()
		return nil, fmt.Errorf("%s: %w", threadMethod, err)
	}
	threadID, err := resultThreadID(threadResponse.Result)
	if err != nil {
		session.stopAfterStartupFailure()
		return nil, err
	}
	if strings.TrimSpace(request.Prompt) != "" {
		if err := session.startTurn(startupCtx, threadID, request.Prompt); err != nil {
			session.stopAfterStartupFailure()
			return nil, fmt.Errorf("start initial Codex turn: %w", err)
		}
	}
	return session, nil
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type rpcRequestError struct {
	Method  string
	Code    int
	Message string
}

func (err *rpcRequestError) Error() string {
	return fmt.Sprintf(
		"Codex RPC %s failed (%d): %s",
		err.Method,
		err.Code,
		err.Message,
	)
}

type rpcMessage struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`

	hasID       bool
	hasMethod   bool
	hasResult   bool
	hasError    bool
	errorTruthy bool
	methodValid bool
}

func decodeRPCMessage(raw []byte) (rpcMessage, error) {
	var envelope map[string]json.RawMessage
	if err := common.Unmarshal(raw, &envelope); err != nil {
		return rpcMessage{}, err
	}
	message := rpcMessage{}
	if field, ok := envelope["jsonrpc"]; ok {
		_ = common.Unmarshal(field, &message.JSONRPC)
	}
	if field, ok := envelope["id"]; ok {
		message.ID = append(json.RawMessage(nil), field...)
		message.hasID = true
	}
	if field, ok := envelope["method"]; ok {
		message.hasMethod = true
		message.methodValid = common.Unmarshal(field, &message.Method) == nil
	}
	if field, ok := envelope["params"]; ok {
		message.Params = append(json.RawMessage(nil), field...)
	}
	if field, ok := envelope["result"]; ok {
		message.Result = append(json.RawMessage(nil), field...)
		message.hasResult = true
	}
	if field, ok := envelope["error"]; ok {
		message.hasError = true
		message.errorTruthy = jsonRPCValueTruthy(field)
		message.Error = &rpcError{}
		if err := decodeCompatibleRPCError(field, message.Error); err != nil {
			return rpcMessage{}, err
		}
	}
	return message, nil
}

func decodeCompatibleRPCError(raw json.RawMessage, target *rpcError) error {
	text := strings.TrimSpace(string(raw))
	if text == "" || text[0] != '{' {
		return nil
	}
	var fields map[string]json.RawMessage
	if err := common.Unmarshal(raw, &fields); err != nil {
		return err
	}
	if code, ok := fields["code"]; ok {
		var compatible int
		if common.Unmarshal(code, &compatible) == nil {
			target.Code = compatible
		}
	}
	if message, ok := fields["message"]; ok {
		var compatible string
		if common.Unmarshal(message, &compatible) == nil {
			target.Message = compatible
			return nil
		}
		if jsonRPCValueTruthy(message) {
			return errors.New(
				"Codex RPC error message has an unsupported non-string value",
			)
		}
	}
	return nil
}

func jsonRPCValueTruthy(raw json.RawMessage) bool {
	text := strings.TrimSpace(string(raw))
	switch text {
	case "", "null", "false":
		return false
	case "true":
		return true
	}
	switch text[0] {
	case '"':
		var value string
		return common.Unmarshal(raw, &value) == nil && value != ""
	case '{', '[':
		return true
	}
	var number big.Rat
	if _, ok := number.SetString(text); ok {
		return number.Sign() != 0
	}
	return true
}

func (message rpcMessage) isResponse() bool {
	return message.hasID && (message.hasResult || message.hasError)
}

func (message rpcMessage) isServerRequest() bool {
	return message.hasID &&
		message.hasMethod &&
		message.methodValid &&
		!message.isResponse()
}

func (message rpcMessage) hasErrorField() bool {
	return message.hasError || message.Error != nil
}

func (message rpcMessage) errorIsTruthy() bool {
	if message.hasError {
		return message.errorTruthy
	}
	return message.Error != nil
}

func (message rpcMessage) errorMessageOrFallback() string {
	if message.Error != nil && message.Error.Message != "" {
		return message.Error.Message
	}
	return codexRPCFailureText
}

func (message rpcMessage) requestFailed(method string) bool {
	if method == "initialize" && message.hasResult {
		return false
	}
	return message.hasErrorField()
}

func (message rpcMessage) pendingID() (int64, bool) {
	if !message.hasID {
		return 0, false
	}
	var number big.Rat
	if _, ok := number.SetString(
		strings.TrimSpace(string(message.ID)),
	); !ok || !number.IsInt() || !number.Num().IsInt64() {
		return 0, false
	}
	id := number.Num().Int64()
	if id <= 0 {
		return 0, false
	}
	return id, true
}

type acceptedInputEvidence struct {
	fallbackTurnID string
}

type session struct {
	command       *exec.Cmd
	stdin         io.WriteCloser
	events        chan runtimeapi.Event
	pending       map[int64]chan rpcMessage
	pendingMethod map[int64]string
	pendingInput  map[int64]acceptedInputEvidence
	done          chan struct{}
	startupDone   chan struct{}

	writeMu          sync.Mutex
	mu               sync.Mutex
	nextID           int64
	thread           string
	sessionAnnounced bool
	turn             string
	pendingTurn      string
	waitErr          error
	launchID         string
	runtimeHome      runtimeapi.RuntimeHomeInfo
	stopOnce         sync.Once
	closeEvents      sync.Once

	streamedAgentMessages map[string]struct{}
	agentMessagePhases    map[string]string
	streamedReasoning     map[string]struct{}
	fileChangeCalls       map[string]int
	steeringGate          bool
	turnEvidence          turnEvidenceState
}

func (s *session) Events() <-chan runtimeapi.Event {
	return s.events
}

func (s *session) SessionID() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.thread
}

func (s *session) RuntimeHomeInfo() runtimeapi.RuntimeHomeInfo {
	return s.runtimeHome
}

func (s *session) RuntimeLiveness() runtimeapi.Liveness {
	select {
	case <-s.done:
		return runtimeapi.LivenessDead
	default:
	}
	if s.command == nil || s.command.Process == nil {
		return runtimeapi.LivenessUnknown
	}
	err := s.command.Process.Signal(syscall.Signal(0))
	switch {
	case err == nil:
		return runtimeapi.LivenessAlive
	case errors.Is(err, os.ErrProcessDone):
		return runtimeapi.LivenessDead
	default:
		return runtimeapi.LivenessUnknown
	}
}

func (s *session) Deliver(ctx context.Context, delivery runtimeapi.Delivery) error {
	text := strings.TrimSpace(delivery.Text)
	if text == "" {
		return errors.New("Codex delivery text is required")
	}
	s.mu.Lock()
	threadID := s.thread
	turnID := s.turn
	s.mu.Unlock()
	if threadID == "" {
		return errors.New("Codex thread is not ready")
	}
	mode := delivery.Mode
	if mode == "" {
		if turnID != "" {
			mode = "busy"
		} else {
			mode = "idle"
		}
	}
	if mode == "busy" {
		return s.Steer(ctx, delivery)
	}
	input := []map[string]string{{"type": "text", "text": text}}
	_, err := s.requestWithAcceptedInput(ctx, "turn/start", map[string]any{
		"threadId": threadID,
		"input":    input,
	}, "")
	return codexDeliveryRetryError("turn/start", err)
}

func (s *session) Steer(ctx context.Context, delivery runtimeapi.Delivery) error {
	text := strings.TrimSpace(delivery.Text)
	if text == "" {
		return errors.New("Codex delivery text is required")
	}
	s.mu.Lock()
	threadID := s.thread
	turnID := s.turn
	canSteer := turnID != "" && s.pendingTurn == "" && !s.steeringGate
	s.mu.Unlock()
	if threadID == "" {
		return errors.New("Codex thread is not ready")
	}
	if !canSteer {
		return runtimeapi.NewRetryableDeliveryError(
			runtimeapi.RetryTurnBoundary,
			ErrBusySteeringUnavailable,
		)
	}
	input := []map[string]string{{"type": "text", "text": text}}
	_, err := s.requestWithAcceptedInput(ctx, "turn/steer", map[string]any{
		"threadId":       threadID,
		"expectedTurnId": turnID,
		"input":          input,
	}, turnID)
	return codexDeliveryRetryError("turn/steer", err)
}

func codexDeliveryRetryError(method string, err error) error {
	if err == nil {
		return nil
	}
	var native *rpcRequestError
	if !errors.As(err, &native) || native.Method != method {
		return err
	}
	switch method {
	case "turn/start":
		return runtimeapi.NewRetryableDeliveryError(
			runtimeapi.RetryDelayedIdle,
			err,
		)
	case "turn/steer":
		return runtimeapi.NewRetryableDeliveryError(
			runtimeapi.RetryTurnBoundary,
			err,
		)
	default:
		return err
	}
}

func (s *session) Stop(ctx context.Context) error {
	s.stopOnce.Do(func() {
		_ = s.command.Process.Signal(os.Interrupt)
	})
	select {
	case <-s.done:
		s.mu.Lock()
		defer s.mu.Unlock()
		var exitError *exec.ExitError
		if s.waitErr == nil || errors.As(s.waitErr, &exitError) {
			return nil
		}
		return s.waitErr
	case <-ctx.Done():
		if err := s.command.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
			return err
		}
		<-s.done
		return ctx.Err()
	}
}

func (s *session) startTurn(
	ctx context.Context,
	threadID string,
	text string,
) error {
	_, err := s.requestWithAcceptedInput(ctx, "turn/start", map[string]any{
		"threadId": threadID,
		"input":    []map[string]string{{"type": "text", "text": text}},
	}, "")
	return err
}

func (s *session) request(ctx context.Context, method string, params any) (rpcMessage, error) {
	return s.requestWithEvidence(ctx, method, params, nil)
}

func (s *session) requestWithAcceptedInput(
	ctx context.Context,
	method string,
	params any,
	fallbackTurnID string,
) (rpcMessage, error) {
	return s.requestWithEvidence(ctx, method, params, &acceptedInputEvidence{
		fallbackTurnID: fallbackTurnID,
	})
}

func (s *session) requestWithEvidence(
	ctx context.Context,
	method string,
	params any,
	inputEvidence *acceptedInputEvidence,
) (rpcMessage, error) {
	s.mu.Lock()
	select {
	case <-s.done:
		s.mu.Unlock()
		return rpcMessage{}, ErrSessionStopped
	default:
	}
	s.nextID++
	id := s.nextID
	result := make(chan rpcMessage, 1)
	s.pending[id] = result
	if s.pendingMethod == nil {
		s.pendingMethod = make(map[int64]string)
	}
	s.pendingMethod[id] = method
	if inputEvidence != nil {
		if s.pendingInput == nil {
			s.pendingInput = make(map[int64]acceptedInputEvidence)
		}
		s.pendingInput[id] = *inputEvidence
	}
	s.mu.Unlock()
	if err := s.write(map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"method":  method,
		"params":  params,
	}); err != nil {
		s.removePending(id)
		return rpcMessage{}, err
	}
	select {
	case response := <-result:
		if response.requestFailed(method) {
			return response, &rpcRequestError{
				Method:  method,
				Code:    response.Error.Code,
				Message: response.errorMessageOrFallback(),
			}
		}
		return response, nil
	case <-ctx.Done():
		s.removePending(id)
		return rpcMessage{}, ctx.Err()
	case <-s.done:
		s.removePending(id)
		return rpcMessage{}, ErrSessionStopped
	}
}

func (s *session) notify(method string, params any) error {
	return s.write(map[string]any{
		"jsonrpc": "2.0",
		"method":  method,
		"params":  params,
	})
}

func (s *session) write(value any) error {
	data, err := common.Marshal(value)
	if err != nil {
		return err
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if _, err := s.stdin.Write(append(data, '\n')); err != nil {
		return err
	}
	return nil
}

func (s *session) readStdout(reader io.Reader) {
	defer func() {
		<-s.startupDone
		s.closeEvents.Do(func() { close(s.events) })
	}()
	lineReader := bufio.NewReader(reader)
	for {
		raw, err := lineReader.ReadBytes('\n')
		if err != nil {
			return
		}
		raw = raw[:len(raw)-1]
		message, err := decodeRPCMessage(raw)
		if err != nil {
			continue
		}
		if os.Getenv("VELA_TRACE_CODEX_METHODS") == "1" &&
			message.hasMethod &&
			message.methodValid &&
			message.Method != "" {
			if message.Method == "turn/completed" {
				if present, matches := s.threadIdentityMatch(message.Params); present {
					_, _ = fmt.Fprintf(
						os.Stderr,
						"codex rpc method=%q thread_identity=present thread_match=%t\n",
						message.Method,
						matches,
					)
				} else {
					_, _ = fmt.Fprintf(os.Stderr, "codex rpc method=%q\n", message.Method)
				}
			} else {
				_, _ = fmt.Fprintf(os.Stderr, "codex rpc method=%q\n", message.Method)
			}
		}
		if message.isResponse() {
			if id, ok := message.pendingID(); ok && s.resolvePending(id, message) {
				continue
			}
		}
		if message.isServerRequest() {
			_ = s.write(map[string]any{
				"jsonrpc": "2.0",
				"id":      message.ID,
				"error": map[string]any{
					"code":    -32601,
					"message": unsupportedCodexServerRequestText(message.Method),
				},
			})
			continue
		}
		s.normalize(message, raw)
	}
}

func (s *session) resolvePending(id int64, message rpcMessage) bool {
	s.mu.Lock()
	channel, ok := s.pending[id]
	if ok {
		delete(s.pending, id)
	}
	method := s.pendingMethod[id]
	delete(s.pendingMethod, id)
	inputEvidence, hasInputEvidence := s.pendingInput[id]
	delete(s.pendingInput, id)
	requestFailed := message.requestFailed(method)
	if ok && hasInputEvidence && !requestFailed {
		turnID := resultTurnID(message.Result)
		if turnID == "" {
			turnID = inputEvidence.fallbackTurnID
		}
		s.turnEvidence.markAcceptedInput(turnID, true)
	}
	s.mu.Unlock()
	if ok && !requestFailed &&
		(method == "thread/start" || method == "thread/resume") {
		if threadID, err := resultThreadID(message.Result); err == nil {
			s.adoptThreadReady(threadID, nil)
		}
	}
	if ok {
		channel <- message
	}
	return ok
}

func (s *session) removePending(id int64) {
	s.mu.Lock()
	delete(s.pending, id)
	delete(s.pendingMethod, id)
	delete(s.pendingInput, id)
	s.mu.Unlock()
}

func (s *session) normalize(message rpcMessage, raw []byte) {
	event := runtimeapi.Event{LaunchID: s.launchID, Raw: append(json.RawMessage(nil), raw...)}
	if len(message.Result) > 0 {
		var result struct {
			Thread *struct {
				ID *string `json:"id"`
			} `json:"thread"`
			Turn *struct {
				ID *string `json:"id"`
			} `json:"turn"`
			TurnID *string `json:"turnId"`
		}
		if common.Unmarshal(message.Result, &result) == nil &&
			result.Thread != nil && result.Thread.ID != nil {
			threadID := *result.Thread.ID
			s.adoptThreadReady(threadID, event.Raw)
			return
		}
		var acceptedTurnID *string
		if result.Turn != nil && result.Turn.ID != nil {
			acceptedTurnID = result.Turn.ID
		} else if result.TurnID != nil {
			acceptedTurnID = result.TurnID
		}
		if acceptedTurnID != nil {
			s.mu.Lock()
			s.pendingTurn = *acceptedTurnID
			s.mu.Unlock()
			return
		}
	}
	if message.errorIsTruthy() {
		event.Kind = runtimeapi.EventError
		event.Text = message.errorMessageOrFallback()
		s.emit(event)
		return
	}
	if s.isSecondaryThread(message.Params) {
		return
	}
	switch message.Method {
	case "thread/started":
		var params struct {
			Thread struct {
				ID *string `json:"id"`
			} `json:"thread"`
		}
		if common.Unmarshal(message.Params, &params) == nil && params.Thread.ID != nil {
			s.adoptThreadReady(*params.Thread.ID, event.Raw)
		}
	case "turn/started":
		var params struct {
			Turn struct {
				ID *string `json:"id"`
			} `json:"turn"`
		}
		_ = common.Unmarshal(message.Params, &params)
		s.mu.Lock()
		s.ensureNormalizationStateLocked()
		startedTurnID := s.pendingTurn
		if params.Turn.ID != nil {
			startedTurnID = *params.Turn.ID
		}
		s.pendingTurn = ""
		if startedTurnID != "" {
			s.turn = startedTurnID
		}
		s.steeringGate = false
		s.turnEvidence.markStarted(startedTurnID)
		threadID := s.thread
		s.mu.Unlock()
		event.Kind = runtimeapi.EventThinking
		event.TurnID = startedTurnID
		event.SessionID = threadID
		s.emit(event)
	case "item/agentMessage/delta":
		var params struct {
			Delta  string `json:"delta"`
			Phase  string `json:"phase"`
			ItemID string `json:"itemId"`
			Item   struct {
				Phase string `json:"phase"`
			} `json:"item"`
		}
		if common.Unmarshal(message.Params, &params) == nil {
			if params.Delta == "" {
				if params.ItemID != "" {
					s.mu.Lock()
					s.ensureNormalizationStateLocked()
					s.streamedAgentMessages[params.ItemID] = struct{}{}
					s.mu.Unlock()
				}
				return
			}
			phase := params.Phase
			if phase == "" {
				phase = params.Item.Phase
			}
			s.mu.Lock()
			s.ensureNormalizationStateLocked()
			if params.ItemID != "" {
				s.streamedAgentMessages[params.ItemID] = struct{}{}
				if phase == "" {
					if stored := s.agentMessagePhases[params.ItemID]; stored != "" {
						phase = stored
					}
				}
			}
			s.noteTurnProgressLocked()
			s.mu.Unlock()
			if phase != "" && phase != "final_answer" {
				event.Kind = runtimeapi.EventUsage
				s.emit(event)
				return
			}
			event.Kind = runtimeapi.EventAssistantText
			event.Text = params.Delta
			s.emit(event)
		}
	case "item/reasoning/summaryTextDelta":
		var params struct {
			Delta  string `json:"delta"`
			ItemID string `json:"itemId"`
		}
		if common.Unmarshal(message.Params, &params) == nil {
			if params.Delta == "" {
				if params.ItemID != "" {
					s.mu.Lock()
					s.ensureNormalizationStateLocked()
					s.streamedReasoning[params.ItemID] = struct{}{}
					s.mu.Unlock()
				}
				return
			}
			s.mu.Lock()
			s.ensureNormalizationStateLocked()
			if params.ItemID != "" {
				s.streamedReasoning[params.ItemID] = struct{}{}
			}
			s.noteTurnProgressLocked()
			s.mu.Unlock()
			event.Kind = runtimeapi.EventThinking
			event.Text = params.Delta
			s.emit(event)
		}
	case "item/started", "item/completed":
		var params struct {
			Item struct {
				ID        string          `json:"id"`
				Type      string          `json:"type"`
				Command   string          `json:"command"`
				Text      string          `json:"text"`
				Phase     string          `json:"phase"`
				Summary   []string        `json:"summary"`
				Server    string          `json:"server"`
				Tool      string          `json:"tool"`
				Arguments json.RawMessage `json:"arguments"`
				Query     string          `json:"query"`
				Changes   []struct {
					Path string `json:"path"`
					Kind string `json:"kind"`
				} `json:"changes"`
			} `json:"item"`
		}
		if common.Unmarshal(message.Params, &params) != nil || params.Item.Type == "" {
			return
		}
		started := message.Method == "item/started"
		switch params.Item.Type {
		case "reasoning":
			if started {
				return
			}
			text := strings.TrimSpace(strings.Join(params.Item.Summary, "\n"))
			s.mu.Lock()
			s.ensureNormalizationStateLocked()
			_, streamed := s.streamedReasoning[params.Item.ID]
			delete(s.streamedReasoning, params.Item.ID)
			if !streamed && text != "" {
				s.noteTurnProgressLocked()
			}
			s.mu.Unlock()
			if !streamed && text != "" {
				event.Kind = runtimeapi.EventThinking
				event.Text = text
				s.emit(event)
			}
			return
		case "agentMessage":
			s.mu.Lock()
			s.ensureNormalizationStateLocked()
			if params.Item.ID != "" {
				if params.Item.Phase == "" {
					delete(s.agentMessagePhases, params.Item.ID)
				} else {
					s.agentMessagePhases[params.Item.ID] = params.Item.Phase
				}
			}
			if started {
				s.mu.Unlock()
				return
			}
			_, streamed := s.streamedAgentMessages[params.Item.ID]
			phase := params.Item.Phase
			delete(s.streamedAgentMessages, params.Item.ID)
			delete(s.agentMessagePhases, params.Item.ID)
			if !streamed && params.Item.Text != "" {
				s.noteTurnProgressLocked()
			}
			s.mu.Unlock()
			if streamed || params.Item.Text == "" {
				return
			}
			if phase != "" && phase != "final_answer" {
				event.Kind = runtimeapi.EventUsage
			} else {
				event.Kind = runtimeapi.EventAssistantText
				event.Text = params.Item.Text
			}
			s.emit(event)
			return
		case "contextCompaction":
			s.noteTurnProgress()
			if started {
				event.Kind = runtimeapi.EventCompactionStarted
			} else {
				event.Kind = runtimeapi.EventCompactionFinished
			}
			s.emit(event)
			return
		case "enteredReviewMode":
			if !started {
				return
			}
			s.noteTurnProgress()
			event.Kind = runtimeapi.EventReviewStarted
			s.emit(event)
			return
		case "exitedReviewMode":
			if started {
				return
			}
			s.noteTurnProgress()
			event.Kind = runtimeapi.EventReviewFinished
			s.emit(event)
			return
		case "fileChange":
			if started {
				count := len(params.Item.Changes)
				s.mu.Lock()
				s.ensureNormalizationStateLocked()
				if count > 0 && params.Item.ID != "" {
					s.fileChangeCalls[params.Item.ID] = count
				}
				if count > 0 {
					s.noteTurnProgressLocked()
				}
				s.mu.Unlock()
				for _, change := range params.Item.Changes {
					next := event
					next.Kind = runtimeapi.EventToolCall
					next.Name = "file_change"
					next.Text = change.Path
					s.emit(next)
				}
				return
			}
			s.mu.Lock()
			s.ensureNormalizationStateLocked()
			count := s.fileChangeCalls[params.Item.ID]
			delete(s.fileChangeCalls, params.Item.ID)
			if count == 0 {
				count = len(params.Item.Changes)
			}
			if count > 0 {
				s.noteToolBoundaryLocked()
			}
			s.mu.Unlock()
			for index := 0; index < count; index++ {
				next := event
				next.Kind = runtimeapi.EventToolOutput
				next.Name = "file_change"
				s.emit(next)
			}
			return
		case "mcpToolCall":
			event.Name = codexMCPToolName(params.Item.Server, params.Item.Tool)
		case "collabAgentToolCall":
			event.Name = "collab_tool_call"
		case "webSearch":
			event.Name = "web_search"
			event.Text = params.Item.Query
		case "commandExecution":
			event.Name = "shell"
			event.Text = params.Item.Command
		default:
			return
		}
		if started {
			s.noteTurnProgress()
			event.Kind = runtimeapi.EventToolCall
		} else {
			s.noteToolBoundary()
			event.Kind = runtimeapi.EventToolOutput
		}
		s.emit(event)
	case "thread/tokenUsage/updated":
		if !validCodexTokenUsage(message.Params) {
			return
		}
		s.mu.Lock()
		s.turnEvidence.markTokenUsage()
		s.mu.Unlock()
		event.Kind = runtimeapi.EventUsage
		s.emit(event)
	case "account/rateLimits/updated":
		if !validCodexRateLimits(message.Params) {
			return
		}
		event.Kind = runtimeapi.EventUsage
		s.emit(event)
	case "configWarning", "warning", "guardianWarning", "deprecationNotice":
		var params struct {
			Summary string `json:"summary"`
			Details string `json:"details"`
			Message string `json:"message"`
			Path    string `json:"path"`
		}
		_ = common.Unmarshal(message.Params, &params)
		event.Kind = runtimeapi.EventDiagnostic
		event.Name = codexDiagnosticTitle(message.Method)
		summary := boundedCodexText(params.Summary)
		details := boundedCodexText(params.Details)
		messageText := boundedCodexText(params.Message)
		path := boundedCodexText(params.Path)
		switch message.Method {
		case "configWarning", "deprecationNotice":
			event.Text = firstNonEmpty(summary, details)
		default:
			event.Text = messageText
		}
		if event.Text == "" {
			event.Text = codexDiagnosticFallback(message.Method)
		}
		detailLines := make([]string, 0, 2)
		if details != "" && details != event.Text {
			detailLines = append(detailLines, details)
		}
		if path != "" {
			detailLines = append(detailLines, "Path: "+path)
		}
		event.Text = boundedCodexText(event.Text)
		event.Detail = boundedCodexText(strings.Join(detailLines, "\n"))
		event.SessionID = s.SessionID()
		s.emit(event)
	case "thread/status/changed":
		var params struct {
			Message string `json:"message"`
			Error   *struct {
				Message string `json:"message"`
			} `json:"error"`
			Status json.RawMessage `json:"status"`
			Thread struct {
				Status json.RawMessage `json:"status"`
			} `json:"thread"`
		}
		_ = common.Unmarshal(message.Params, &params)
		statusPayload := params.Status
		if len(statusPayload) == 0 ||
			strings.TrimSpace(string(statusPayload)) == "null" {
			statusPayload = params.Thread.Status
		}
		var status struct {
			Type        string   `json:"type"`
			Message     string   `json:"message"`
			ActiveFlags []string `json:"activeFlags"`
			Error       *struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		_ = common.Unmarshal(statusPayload, &status)
		statusType := status.Type
		if statusType == "systemError" {
			event.Kind = runtimeapi.EventError
			event.Text = boundedCodexText(status.Message)
			if event.Text == "" && status.Error != nil {
				event.Text = boundedCodexText(status.Error.Message)
			}
			if event.Text == "" && boundedCodexText(params.Message) != "" {
				event.Text = params.Message
			}
			if event.Text == "" &&
				params.Error != nil &&
				boundedCodexText(params.Error.Message) != "" {
				event.Text = params.Error.Message
			}
			nativeReasonPresent := event.Text != ""
			if event.Text == "" {
				event.Text = "Codex thread entered system error state"
			}
			event.RuntimeErrorNativeReason = &nativeReasonPresent
			if nativeReasonPresent {
				event.RuntimeErrorReasonProvenance = "codex_native_reason"
			} else {
				event.RuntimeErrorReasonProvenance = "daemon_fallback"
				diagnostic := event
				diagnostic.Kind = runtimeapi.EventDiagnostic
				diagnostic.Name = "Codex warning"
				diagnostic.Text = "Codex thread entered system error state without a reason"
				diagnostic.SessionID = s.SessionID()
				s.emit(diagnostic)
			}
			s.emit(event)
			return
		}
		waiting := codexWaitingFlags(status.ActiveFlags)
		if statusType == "active" && len(waiting) > 0 {
			event.Kind = runtimeapi.EventDiagnostic
			event.Name = "Codex warning"
			event.Text = "Codex thread is waiting on " + codexWaitingLabel(waiting)
			event.Detail = "Active flags: " + strings.Join(waiting, ", ")
			event.SessionID = s.SessionID()
			s.emit(event)
		}
	case "item/reasoning/textDelta",
		"item/commandExecution/outputDelta",
		"item/mcpToolCall/progress",
		"item/plan/delta",
		"turn/plan/updated",
		"turn/diff/updated",
		"item/fileChange/patchUpdated",
		"item/fileChange/outputDelta",
		"command/exec/outputDelta",
		"process/outputDelta",
		"process/exited",
		"rawResponseItem/completed":
		if message.Method == "item/reasoning/textDelta" {
			var params struct {
				Delta string `json:"delta"`
			}
			if common.Unmarshal(message.Params, &params) != nil || params.Delta == "" {
				return
			}
		}
		if message.Method == "rawResponseItem/completed" &&
			!validCodexRawResponseItem(message.Params) {
			return
		}
		s.noteTurnProgress()
		event.Kind = runtimeapi.EventUsage
		s.emit(event)
	case "turn/completed":
		var params struct {
			Turn struct {
				ID     string `json:"id"`
				Status string `json:"status"`
				Error  *struct {
					Message string `json:"message"`
				} `json:"error"`
			} `json:"turn"`
		}
		_ = common.Unmarshal(message.Params, &params)
		s.mu.Lock()
		s.ensureNormalizationStateLocked()
		completion := s.turnEvidence.markCompleted()
		s.turn = ""
		s.pendingTurn = ""
		s.steeringGate = false
		clear(s.streamedAgentMessages)
		clear(s.agentMessagePhases)
		clear(s.streamedReasoning)
		clear(s.fileChangeCalls)
		event.SessionID = s.thread
		s.mu.Unlock()
		event.TurnID = params.Turn.ID
		if params.Turn.Status == "failed" || params.Turn.Status == "interrupted" {
			event.Kind = runtimeapi.EventError
			if params.Turn.Error != nil {
				event.Text = params.Turn.Error.Message
			}
			if params.Turn.Status == "interrupted" {
				if event.Text == "" {
					event.Text = "Codex turn interrupted"
				} else {
					event.Text = "Codex turn interrupted: " + event.Text
				}
			}
			if event.Text == "" {
				event.Text = "Codex turn " + params.Turn.Status
			}
			s.emit(event)
		}
		if params.Turn.Status == "completed" && completion.ZeroEvidence {
			diagnostic := event
			diagnostic.Kind = runtimeapi.EventDiagnostic
			diagnostic.Name = "Codex warning"
			diagnostic.Text = "Codex runtime completed an empty turn with no output, progress, or token usage"
			diagnostic.Detail = "Codex runtime reported turn/completed status=completed after turn/started with no assistant text, reasoning text, tool activity, internal progress, raw response-item progress, or valid thread/tokenUsage/updated payload."
			s.emit(diagnostic)

			runtimeError := event
			runtimeError.Kind = runtimeapi.EventError
			if completion.InputEvidence == "nonempty" {
				runtimeError.Text = "Codex runtime returned an empty response. Please retry. (codex_zero_evidence_turn_completed)"
			} else {
				runtimeError.Text = "Codex runtime completed without a response. Please retry. (codex_zero_evidence_turn_completed)"
			}
			s.emit(runtimeError)
		}
		event.Kind = runtimeapi.EventTurnCompletion
		event.Text = params.Turn.Status
		s.emit(event)
	case "error":
		var params struct {
			Message   string `json:"message"`
			WillRetry bool   `json:"willRetry"`
			Error     *struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		_ = common.Unmarshal(message.Params, &params)
		if params.WillRetry {
			s.noteTurnProgress()
			event.Kind = runtimeapi.EventUsage
			s.emit(event)
			return
		}
		event.Kind = runtimeapi.EventError
		event.Text = untrimmedCodexText(params.Message)
		if event.Text == "" && params.Error != nil {
			event.Text = untrimmedCodexText(params.Error.Message)
		}
		if event.Text == "" {
			event.Text = "Unknown Codex app-server error"
		}
		s.emit(event)
	}
}

func (s *session) isSecondaryThread(params json.RawMessage) bool {
	present, matches := s.threadIdentityMatch(params)
	return present && !matches
}

func (s *session) threadIdentityMatch(params json.RawMessage) (bool, bool) {
	var identity struct {
		ThreadID  json.RawMessage `json:"threadId"`
		Thread    json.RawMessage `json:"thread"`
		SessionID json.RawMessage `json:"sessionId"`
	}
	if common.Unmarshal(params, &identity) != nil {
		return false, false
	}
	observed := codexNonEmptyStringValue(identity.ThreadID)
	if observed == "" {
		var nested struct {
			ID json.RawMessage `json:"id"`
		}
		if common.Unmarshal(identity.Thread, &nested) == nil {
			observed = codexNonEmptyStringValue(nested.ID)
		}
	}
	if observed == "" {
		observed = codexNonEmptyStringValue(identity.SessionID)
	}
	if observed == "" {
		return false, false
	}
	s.mu.Lock()
	current := s.thread
	s.mu.Unlock()
	return true, current == "" || current == observed
}

func (s *session) ensureNormalizationStateLocked() {
	if s.streamedAgentMessages == nil {
		s.streamedAgentMessages = make(map[string]struct{})
	}
	if s.agentMessagePhases == nil {
		s.agentMessagePhases = make(map[string]string)
	}
	if s.streamedReasoning == nil {
		s.streamedReasoning = make(map[string]struct{})
	}
	if s.fileChangeCalls == nil {
		s.fileChangeCalls = make(map[string]int)
	}
}

func (s *session) noteTurnProgress() {
	s.mu.Lock()
	s.noteTurnProgressLocked()
	s.mu.Unlock()
}

func (s *session) noteTurnProgressLocked() {
	s.steeringGate = false
	s.turnEvidence.markRuntimeActivity()
}

func (s *session) noteToolBoundary() {
	s.mu.Lock()
	s.noteToolBoundaryLocked()
	s.mu.Unlock()
}

func (s *session) noteToolBoundaryLocked() {
	s.steeringGate = true
	s.turnEvidence.markRuntimeActivity()
}

func (s *session) canSteerBusy() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.turn != "" && s.pendingTurn == "" && !s.steeringGate
}

func validCodexTokenUsage(params json.RawMessage) bool {
	var payload struct {
		TokenUsage *struct {
			Total              json.RawMessage `json:"total"`
			ModelContextWindow json.RawMessage `json:"modelContextWindow"`
		} `json:"tokenUsage"`
	}
	if common.Unmarshal(params, &payload) != nil ||
		payload.TokenUsage == nil ||
		codexJSONContainerShape(payload.TokenUsage.Total) == 0 {
		return false
	}
	var total struct {
		TotalTokens           json.RawMessage `json:"totalTokens"`
		InputTokens           json.RawMessage `json:"inputTokens"`
		CachedInputTokens     json.RawMessage `json:"cachedInputTokens"`
		OutputTokens          json.RawMessage `json:"outputTokens"`
		ReasoningOutputTokens json.RawMessage `json:"reasoningOutputTokens"`
	}
	if codexJSONContainerShape(payload.TokenUsage.Total) == '{' {
		_ = common.Unmarshal(payload.TokenUsage.Total, &total)
	}
	return anyFiniteCodexNumber(
		total.TotalTokens,
		total.InputTokens,
		total.CachedInputTokens,
		total.OutputTokens,
		total.ReasoningOutputTokens,
		payload.TokenUsage.ModelContextWindow,
	)
}

func codexJSONContainerShape(raw json.RawMessage) byte {
	value := strings.TrimSpace(string(raw))
	if len(value) == 0 || (value[0] != '{' && value[0] != '[') {
		return 0
	}
	return value[0]
}

func validCodexRateLimits(params json.RawMessage) bool {
	var payload struct {
		RateLimits *struct {
			LimitID  json.RawMessage `json:"limitId"`
			PlanType json.RawMessage `json:"planType"`
			Primary  json.RawMessage `json:"primary"`
		} `json:"rateLimits"`
	}
	if common.Unmarshal(params, &payload) != nil ||
		payload.RateLimits == nil ||
		codexJSONContainerShape(payload.RateLimits.Primary) == 0 {
		return false
	}
	rateLimits := payload.RateLimits
	var primary struct {
		UsedPercent        json.RawMessage `json:"usedPercent"`
		WindowDurationMins json.RawMessage `json:"windowDurationMins"`
		ResetsAt           json.RawMessage `json:"resetsAt"`
	}
	if codexJSONContainerShape(rateLimits.Primary) == '{' {
		_ = common.Unmarshal(rateLimits.Primary, &primary)
	}
	return nonEmptyCodexString(rateLimits.LimitID) ||
		nonEmptyCodexString(rateLimits.PlanType) ||
		anyFiniteCodexNumber(
			primary.UsedPercent,
			primary.WindowDurationMins,
			primary.ResetsAt,
		)
}

func validCodexRawResponseItem(params json.RawMessage) bool {
	var value any
	if common.Unmarshal(params, &value) != nil || value == nil {
		return false
	}
	root, isObject := value.(map[string]any)
	if !isObject {
		_, isArray := value.([]any)
		return isArray
	}
	for _, key := range []string{"item", "responseItem", "rawItem"} {
		nested, ok := root[key]
		if !ok || nested == nil {
			continue
		}
		switch nested.(type) {
		case map[string]any, []any:
			return true
		default:
			return false
		}
	}
	return true
}

func anyFiniteCodexNumber(values ...json.RawMessage) bool {
	for _, raw := range values {
		var value *float64
		if len(raw) > 0 &&
			common.Unmarshal(raw, &value) == nil &&
			value != nil &&
			!math.IsNaN(*value) &&
			!math.IsInf(*value, 0) {
			return true
		}
	}
	return false
}

func nonEmptyCodexString(raw json.RawMessage) bool {
	return codexNonEmptyStringValue(raw) != ""
}

func codexNonEmptyStringValue(raw json.RawMessage) string {
	var value *string
	if len(raw) == 0 ||
		common.Unmarshal(raw, &value) != nil ||
		value == nil ||
		len(*value) == 0 {
		return ""
	}
	return *value
}

func codexMCPToolName(server string, tool string) string {
	if tool == "" {
		tool = "unknown"
	}
	if server == "" {
		return "mcp_" + tool
	}
	return "mcp_" + server + "_" + tool
}

func codexDiagnosticTitle(method string) string {
	switch method {
	case "configWarning":
		return "Codex config warning"
	case "guardianWarning":
		return "Codex guardian warning"
	case "deprecationNotice":
		return "Codex deprecation notice"
	default:
		return "Codex warning"
	}
}

func codexDiagnosticFallback(method string) string {
	switch method {
	case "configWarning":
		return "Codex configuration warning"
	case "guardianWarning":
		return "Codex guardian warning"
	case "deprecationNotice":
		return "Codex deprecation notice"
	default:
		return "Codex warning"
	}
}

func boundedCodexText(value string) string {
	const maximum = 1000
	value = strings.TrimFunc(value, func(candidate rune) bool {
		switch candidate {
		case '\u0009', '\u000A', '\u000B', '\u000C', '\u000D',
			'\u0020', '\u00A0', '\u1680', '\u2028', '\u2029',
			'\u202F', '\u205F', '\u3000', '\uFEFF':
			return true
		default:
			return candidate >= '\u2000' && candidate <= '\u200A'
		}
	})
	units := utf16.Encode([]rune(value))
	if len(units) <= maximum {
		return value
	}
	return string(utf16.Decode(units[:maximum-1])) + "…"
}

func untrimmedCodexText(value string) string {
	if boundedCodexText(value) == "" {
		return ""
	}
	return value
}

func codexWaitingFlags(activeFlags []string) []string {
	result := make([]string, 0, 2)
	for _, flag := range activeFlags {
		if flag != "waitingOnApproval" && flag != "waitingOnUserInput" {
			continue
		}
		result = append(result, flag)
	}
	return result
}

func codexWaitingLabel(flags []string) string {
	hasApproval := false
	hasUserInput := false
	for _, flag := range flags {
		hasApproval = hasApproval || flag == "waitingOnApproval"
		hasUserInput = hasUserInput || flag == "waitingOnUserInput"
	}
	switch {
	case hasApproval && hasUserInput:
		return "approval and user input"
	case hasApproval:
		return "approval"
	default:
		return "user input"
	}
}

func (s *session) emit(event runtimeapi.Event) {
	emitted := false
	select {
	case s.events <- event:
		emitted = true
	case <-s.done:
	}
	if os.Getenv("VELA_TRACE_CODEX_METHODS") == "1" &&
		event.Kind == runtimeapi.EventTurnCompletion {
		_, _ = fmt.Fprintf(
			os.Stderr,
			"codex runtime event=%q emitted=%t\n",
			event.Kind,
			emitted,
		)
	}
}

func (s *session) setSessionID(threadID string) {
	s.mu.Lock()
	s.thread = threadID
	s.sessionAnnounced = true
	s.mu.Unlock()
}

func (s *session) adoptThreadReady(threadID string, raw json.RawMessage) {
	s.mu.Lock()
	s.thread = threadID
	announce := !s.sessionAnnounced
	if announce {
		s.sessionAnnounced = true
	}
	s.mu.Unlock()
	if !announce {
		return
	}
	s.emit(runtimeapi.Event{
		Kind:      runtimeapi.EventSession,
		SessionID: threadID,
		LaunchID:  s.launchID,
		Raw:       append(json.RawMessage(nil), raw...),
	})
}

func (s *session) wait() {
	err := s.command.Wait()
	s.mu.Lock()
	s.waitErr = err
	s.mu.Unlock()
	close(s.done)
}

func (s *session) drainStderr(reader io.Reader) {
	_, _ = io.Copy(io.Discard, io.LimitReader(reader, 4*1024*1024))
}

func (s *session) stopAfterStartupFailure() {
	stopCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_ = s.Stop(stopCtx)
}

func resultThreadID(raw json.RawMessage) (string, error) {
	var result struct {
		Thread struct {
			ID string `json:"id"`
		} `json:"thread"`
	}
	if err := common.Unmarshal(raw, &result); err != nil {
		return "", err
	}
	if result.Thread.ID == "" {
		return "", errors.New("Codex thread response is missing a thread ID")
	}
	return result.Thread.ID, nil
}

func resultTurnID(raw json.RawMessage) string {
	var result struct {
		Turn struct {
			ID string `json:"id"`
		} `json:"turn"`
	}
	if common.Unmarshal(raw, &result) != nil {
		return ""
	}
	return result.Turn.ID
}

func isMissingResume(err error) bool {
	message := err.Error()
	var requestError *rpcRequestError
	if errors.As(err, &requestError) {
		message = requestError.Message
	}
	for _, pattern := range missingResumePatterns {
		if pattern.MatchString(message) {
			return true
		}
	}
	return false
}

func toolName(itemType string) string {
	switch itemType {
	case "commandExecution":
		return "shell"
	case "fileChange":
		return "file_change"
	case "mcpToolCall":
		return "mcp_tool"
	case "webSearch":
		return "web_search"
	default:
		return itemType
	}
}

func mergedEnvironment(overrides map[string]string) []string {
	values := make(map[string]string)
	for _, entry := range os.Environ() {
		key, value, found := strings.Cut(entry, "=")
		if found {
			values[key] = value
		}
	}
	for key, value := range overrides {
		values[key] = value
	}
	result := make([]string, 0, len(values))
	for key, value := range values {
		result = append(result, key+"="+value)
	}
	return result
}

func resolveCodexHome(environment []string, workingDirectory string) (string, bool) {
	for _, entry := range environment {
		key, value, found := strings.Cut(entry, "=")
		if key != "CODEX_HOME" || !found {
			continue
		}
		if strings.TrimSpace(value) != "" {
			return resolveRuntimeHome(workingDirectory, value), true
		}
		break
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".codex"), false
}

func resolveRuntimeHome(workingDirectory string, value string) string {
	if filepath.IsAbs(value) {
		return filepath.Clean(value)
	}
	return filepath.Clean(filepath.Join(workingDirectory, value))
}

func ensureDirectory(path string) error {
	info, err := os.Stat(filepath.Clean(path))
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return errors.New("Codex working directory is not a directory")
	}
	return nil
}
