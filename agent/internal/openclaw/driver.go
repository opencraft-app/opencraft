package openclaw

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"velachat/agent/internal/runtimeapi"
)

const gatewayStartupTimeout = 30 * time.Second

type Options struct {
	Version    string
	Executable string
}

type Driver struct {
	version    string
	executable string
}

func New(options Options) *Driver {
	return &Driver{
		version:    options.Version,
		executable: options.Executable,
	}
}

func (driver *Driver) DetectModels(context.Context) (runtimeapi.ModelResult, error) {
	return runtimeapi.ModelResult{Models: []runtimeapi.Model{}, Unsupported: true}, nil
}

func (driver *Driver) Start(
	ctx context.Context,
	request runtimeapi.StartRequest,
) (runtimeapi.RuntimeSession, error) {
	probe, err := driver.Probe(ctx)
	if err != nil {
		return nil, err
	}
	if !probe.Available {
		return nil, errors.New(probe.Diagnostic)
	}
	port, err := reserveLoopbackPort()
	if err != nil {
		return nil, err
	}
	token, err := randomGatewayToken()
	if err != nil {
		return nil, err
	}
	launch := buildGatewayLaunch(request, probe.Path, port, token)
	command := exec.Command(launch.executable, launch.args...)
	command.Dir = launch.directory
	command.Env = environmentList(launch.environment)
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
	go io.Copy(io.Discard, stdout)
	go io.Copy(io.Discard, stderr)
	waitDone := make(chan error, 1)
	go func() { waitDone <- command.Wait() }()

	startupCtx, cancel := context.WithTimeout(ctx, gatewayStartupTimeout)
	defer cancel()
	url := fmt.Sprintf("ws://127.0.0.1:%d", port)
	var client *gatewayClient
	for client == nil {
		select {
		case processErr := <-waitDone:
			return nil, fmt.Errorf("OpenClaw Gateway exited during startup: %w", processErr)
		case <-startupCtx.Done():
			_ = command.Process.Kill()
			<-waitDone
			return nil, errors.New("OpenClaw Gateway startup timed out")
		case <-time.After(100 * time.Millisecond):
			client, err = dialGateway(startupCtx, url, token, driver.version)
			if err != nil && startupCtx.Err() == nil {
				client = nil
				continue
			}
			if err != nil {
				_ = command.Process.Kill()
				<-waitDone
				return nil, err
			}
		}
	}
	session := newRuntimeSession(client, request.LaunchID)
	session.profileHome = filepath.Join(
		launch.environment["HOME"],
		".openclaw-"+managedProfileName(request.AgentID),
	)
	session.process = command.Process
	session.processDone = waitDone
	go func() {
		processErr := <-waitDone
		_ = client.Close()
		waitDone <- processErr
	}()
	initial := composeInitialInput(request.StandingPrompt, request.Prompt)
	if initial != "" {
		if err := session.Deliver(ctx, runtimeapi.Delivery{Text: initial}); err != nil {
			_ = session.Stop(context.Background())
			return nil, err
		}
	}
	return session, nil
}

func reserveLoopbackPort() (int, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer listener.Close()
	return listener.Addr().(*net.TCPAddr).Port, nil
}

func randomGatewayToken() (string, error) {
	value := make([]byte, 32)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return hex.EncodeToString(value), nil
}

func composeInitialInput(standingPrompt string, prompt string) string {
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

var _ runtimeapi.RuntimeDriver = (*Driver)(nil)
