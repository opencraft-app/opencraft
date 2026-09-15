package policy

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
	"hypernode/internal/workspaces"
)

// workspaceAttachmentPool owns transport connections for opaque Workspace v2
// capabilities. Policy code names only an attachment ID; driver paths and runc
// identities never cross this boundary.
type workspaceAttachmentPool struct {
	mu        sync.Mutex
	clients   map[string]*workspaceAttachmentClient
	terminals map[string]*workspaceAttachmentTerminal
	processes map[string]*workspaceAttachmentProcess
	notify    func()
	closed    bool
}

type workspaceAttachmentClient struct {
	endpoint workspaces.Endpoint
	client   *ssh.Client
}

type workspaceAttachmentTerminal struct {
	attachmentID string
	session      *ssh.Session
	stdin        io.WriteCloser
	mu           sync.Mutex
	output       []byte
	exited       bool
	exitCode     int
	err          string
	notify       func()
}

// workspaceAttachmentProcess is the host-side equivalent of Node's
// ChildProcess. The QuickJS call that creates it returns immediately; output
// and exit state are drained later from short, non-blocking policy calls.
type workspaceAttachmentProcess struct {
	attachmentID string
	session      *ssh.Session
	stdin        io.WriteCloser
	stdinMu      sync.Mutex
	mu           sync.Mutex
	space        *sync.Cond
	stdout       []byte
	stderr       []byte
	exited       bool
	exitCode     int
	err          string
	stdoutCap    bool
	stderrCap    bool
	closed       bool
	ready        chan struct{}
	readyOnce    sync.Once
	notify       func()
}

func newWorkspaceAttachmentPool(notify func()) *workspaceAttachmentPool {
	return &workspaceAttachmentPool{
		clients:   make(map[string]*workspaceAttachmentClient),
		terminals: make(map[string]*workspaceAttachmentTerminal),
		processes: make(map[string]*workspaceAttachmentProcess),
		notify:    notify,
	}
}

func (p *workspaceAttachmentPool) client(
	ctx context.Context, attachmentID string, endpoint workspaces.Endpoint,
) (*ssh.Client, error) {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return nil, fmt.Errorf("workspace attachment pool is closed")
	}
	if current := p.clients[attachmentID]; current != nil {
		p.mu.Unlock()
		if current.endpoint != endpoint {
			return nil, fmt.Errorf("workspace attachment endpoint changed while active")
		}
		return current.client, nil
	}
	p.mu.Unlock()
	if endpoint.Transport != "ssh" || endpoint.Host == "" || endpoint.Port <= 0 {
		return nil, fmt.Errorf("workspace attachment has no usable SSH endpoint")
	}
	address := net.JoinHostPort(endpoint.Host, strconv.Itoa(endpoint.Port))
	connection, err := (&net.Dialer{Timeout: 10 * time.Second}).DialContext(ctx, "tcp", address)
	if err != nil {
		return nil, fmt.Errorf("connect attached workspace %s: %w", address, err)
	}
	configuration := &ssh.ClientConfig{
		User:            endpoint.Username,
		HostKeyCallback: ssh.InsecureIgnoreHostKey(), // private capability endpoint
		Timeout:         10 * time.Second,
	}
	if configuration.User == "" {
		configuration.User = "root"
	}
	clientConnection, channels, requests, err := ssh.NewClientConn(connection, address, configuration)
	if err != nil {
		_ = connection.Close()
		return nil, fmt.Errorf("handshake attached workspace %s: %w", address, err)
	}
	client := ssh.NewClient(clientConnection, channels, requests)
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		_ = client.Close()
		return nil, fmt.Errorf("workspace attachment pool is closed")
	}
	if current := p.clients[attachmentID]; current != nil {
		p.mu.Unlock()
		_ = client.Close()
		if current.endpoint != endpoint {
			return nil, fmt.Errorf("workspace attachment endpoint changed while active")
		}
		return current.client, nil
	}
	p.clients[attachmentID] = &workspaceAttachmentClient{endpoint: endpoint, client: client}
	p.mu.Unlock()
	return client, nil
}

func (p *workspaceAttachmentPool) invalidate(attachmentID string, expected *ssh.Client) {
	p.mu.Lock()
	current := p.clients[attachmentID]
	if current != nil && current.client == expected {
		delete(p.clients, attachmentID)
	}
	p.mu.Unlock()
	if current != nil && current.client == expected {
		_ = current.client.Close()
	}
}

func (p *workspaceAttachmentPool) detach(attachmentID string) {
	p.mu.Lock()
	current := p.clients[attachmentID]
	delete(p.clients, attachmentID)
	terminals := make([]*workspaceAttachmentTerminal, 0)
	for id, terminal := range p.terminals {
		if terminal.attachmentID == attachmentID {
			delete(p.terminals, id)
			terminals = append(terminals, terminal)
		}
	}
	processes := make([]*workspaceAttachmentProcess, 0)
	for id, process := range p.processes {
		if process.attachmentID == attachmentID {
			delete(p.processes, id)
			processes = append(processes, process)
		}
	}
	p.mu.Unlock()
	for _, terminal := range terminals {
		_ = terminal.close()
	}
	for _, process := range processes {
		_ = process.close()
	}
	if current != nil {
		_ = current.client.Close()
	}
}

func (p *workspaceAttachmentPool) Close() {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return
	}
	p.closed = true
	clients := p.clients
	p.clients = make(map[string]*workspaceAttachmentClient)
	terminals := p.terminals
	p.terminals = make(map[string]*workspaceAttachmentTerminal)
	processes := p.processes
	p.processes = make(map[string]*workspaceAttachmentProcess)
	p.mu.Unlock()
	for _, terminal := range terminals {
		_ = terminal.close()
	}
	for _, process := range processes {
		_ = process.close()
	}
	for _, client := range clients {
		_ = client.client.Close()
	}
}

func (p *workspaceAttachmentPool) openTerminal(
	ctx context.Context, terminalID, attachmentID string, endpoint workspaces.Endpoint, cols, rows int,
) (map[string]any, error) {
	if terminalID == "" {
		return nil, fmt.Errorf("workspace terminal id is required")
	}
	client, err := p.client(ctx, attachmentID, endpoint)
	if err != nil {
		return nil, err
	}
	session, err := client.NewSession()
	if err != nil {
		p.invalidate(attachmentID, client)
		return nil, fmt.Errorf("open attached workspace terminal channel: %w", err)
	}
	stdin, err := session.StdinPipe()
	if err != nil {
		_ = session.Close()
		return nil, err
	}
	stdout, err := session.StdoutPipe()
	if err != nil {
		_ = session.Close()
		return nil, err
	}
	stderr, err := session.StderrPipe()
	if err != nil {
		_ = session.Close()
		return nil, err
	}
	if cols <= 0 {
		cols = 80
	}
	if rows <= 0 {
		rows = 24
	}
	if err := session.RequestPty("xterm-256color", rows, cols, ssh.TerminalModes{
		ssh.ECHO: 1, ssh.TTY_OP_ISPEED: 38400, ssh.TTY_OP_OSPEED: 38400,
	}); err != nil {
		_ = session.Close()
		return nil, fmt.Errorf("request attached workspace PTY: %w", err)
	}
	terminal := &workspaceAttachmentTerminal{
		attachmentID: attachmentID, session: session, stdin: stdin,
		exitCode: -1, notify: p.notify,
	}
	p.mu.Lock()
	if p.closed || p.terminals[terminalID] != nil {
		p.mu.Unlock()
		_ = terminal.close()
		return nil, fmt.Errorf("duplicate or closed workspace terminal id")
	}
	p.terminals[terminalID] = terminal
	p.mu.Unlock()
	if err := session.Shell(); err != nil {
		p.closeTerminal(terminalID)
		return nil, fmt.Errorf("start attached workspace shell: %w", err)
	}
	go terminal.capture(stdout)
	go terminal.capture(stderr)
	go terminal.wait()
	return map[string]any{"cwd": "/workspace/projects", "shell": "/bin/bash"}, nil
}

func (terminal *workspaceAttachmentTerminal) capture(reader io.Reader) {
	buffer := make([]byte, 32*1024)
	for {
		count, err := reader.Read(buffer)
		if count > 0 {
			terminal.mu.Lock()
			terminal.output = append(terminal.output, buffer[:count]...)
			if len(terminal.output) > hostTerminalBufferLimit {
				terminal.output = append([]byte(nil), terminal.output[len(terminal.output)-hostTerminalBufferLimit:]...)
			}
			terminal.mu.Unlock()
			if terminal.notify != nil {
				terminal.notify()
			}
		}
		if err != nil {
			return
		}
	}
}

func (terminal *workspaceAttachmentTerminal) wait() {
	err := terminal.session.Wait()
	terminal.mu.Lock()
	terminal.exited = true
	terminal.exitCode = 0
	if err != nil {
		var exitError *ssh.ExitError
		if errors.As(err, &exitError) {
			terminal.exitCode = exitError.ExitStatus()
		} else {
			terminal.exitCode = -1
			terminal.err = err.Error()
		}
	}
	terminal.mu.Unlock()
	if terminal.notify != nil {
		terminal.notify()
	}
}

func (terminal *workspaceAttachmentTerminal) close() error {
	_ = terminal.stdin.Close()
	err := terminal.session.Close()
	if errors.Is(err, io.EOF) {
		return nil
	}
	return err
}

func (p *workspaceAttachmentPool) terminal(id string) (*workspaceAttachmentTerminal, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	terminal := p.terminals[id]
	if terminal == nil {
		return nil, fmt.Errorf("unknown workspace terminal: %s", id)
	}
	return terminal, nil
}

func (p *workspaceAttachmentPool) writeTerminal(id string, data []byte) error {
	terminal, err := p.terminal(id)
	if err != nil {
		return err
	}
	_, err = terminal.stdin.Write(data)
	return err
}

func (p *workspaceAttachmentPool) resizeTerminal(id string, cols, rows int) error {
	terminal, err := p.terminal(id)
	if err != nil {
		return err
	}
	if cols <= 0 {
		cols = 80
	}
	if rows <= 0 {
		rows = 24
	}
	return terminal.session.WindowChange(rows, cols)
}

func (p *workspaceAttachmentPool) drainTerminal(id string) (map[string]any, error) {
	terminal, err := p.terminal(id)
	if err != nil {
		return nil, err
	}
	terminal.mu.Lock()
	defer terminal.mu.Unlock()
	output := append([]byte(nil), terminal.output...)
	terminal.output = terminal.output[:0]
	return map[string]any{
		"outputBytes": output, "exited": terminal.exited,
		"exitCode": terminal.exitCode, "error": terminal.err,
		"cwd": "/workspace/projects",
	}, nil
}

func (p *workspaceAttachmentPool) closeTerminal(id string) error {
	p.mu.Lock()
	terminal := p.terminals[id]
	delete(p.terminals, id)
	p.mu.Unlock()
	if terminal == nil {
		return nil
	}
	return terminal.close()
}

func (p *workspaceAttachmentPool) startProcess(
	ctx context.Context, processID, attachmentID string, endpoint workspaces.Endpoint, request workspaceStdioRequest,
) error {
	if processID == "" {
		return fmt.Errorf("workspace process id is required")
	}
	process := &workspaceAttachmentProcess{
		attachmentID: attachmentID, exitCode: -1, ready: make(chan struct{}), notify: p.notify,
	}
	process.space = sync.NewCond(&process.mu)
	p.mu.Lock()
	if p.closed || p.processes[processID] != nil {
		p.mu.Unlock()
		return fmt.Errorf("duplicate or closed workspace process id")
	}
	p.processes[processID] = process
	p.mu.Unlock()
	go process.launch(context.WithoutCancel(ctx), p, attachmentID, endpoint, request)
	return nil
}

func (process *workspaceAttachmentProcess) launch(
	ctx context.Context, pool *workspaceAttachmentPool, attachmentID string,
	endpoint workspaces.Endpoint, request workspaceStdioRequest,
) {
	client, err := pool.client(ctx, attachmentID, endpoint)
	if err != nil {
		process.finish(workspaceStdioMessage{}, err)
		return
	}
	session, err := client.NewSession()
	if err != nil {
		pool.invalidate(attachmentID, client)
		process.finish(workspaceStdioMessage{}, fmt.Errorf("open attached workspace process channel: %w", err))
		return
	}
	stdin, err := session.StdinPipe()
	if err != nil {
		_ = session.Close()
		process.finish(workspaceStdioMessage{}, err)
		return
	}
	process.mu.Lock()
	if process.closed {
		process.mu.Unlock()
		_ = stdin.Close()
		_ = session.Close()
		process.markReady()
		return
	}
	process.session = session
	process.stdin = stdin
	process.mu.Unlock()
	stdout, err := session.StdoutPipe()
	if err != nil {
		_ = session.Close()
		process.finish(workspaceStdioMessage{}, err)
		return
	}
	stderr, err := session.StderrPipe()
	if err != nil {
		_ = session.Close()
		process.finish(workspaceStdioMessage{}, err)
		return
	}
	request.Operation = "spawn"
	if err := session.Start(workspaceStdioFastCommand); err != nil {
		pool.invalidate(attachmentID, client)
		process.finish(workspaceStdioMessage{}, fmt.Errorf("start attached workspace process: %w", err))
		return
	}
	if err := writeWorkspaceStdioFrame(stdin, request); err != nil {
		_ = session.Close()
		process.finish(workspaceStdioMessage{}, err)
		return
	}
	if !request.InteractiveStdin {
		_ = stdin.Close()
	}
	process.markReady()
	process.read(stdout, stderr)
}

func (process *workspaceAttachmentProcess) append(stream string, data []byte) {
	for len(data) > 0 {
		process.mu.Lock()
		target := &process.stdout
		if stream == "stderr" {
			target = &process.stderr
		}
		for len(*target) >= hostTerminalBufferLimit && !process.closed {
			process.space.Wait()
		}
		if process.closed {
			process.mu.Unlock()
			return
		}
		available := hostTerminalBufferLimit - len(*target)
		length := len(data)
		if length > available {
			length = available
		}
		*target = append(*target, data[:length]...)
		data = data[length:]
		process.mu.Unlock()
		if process.notify != nil {
			process.notify()
		}
	}
}

func (process *workspaceAttachmentProcess) finish(message workspaceStdioMessage, err error) {
	process.markReady()
	process.mu.Lock()
	if !process.exited {
		process.exited = true
		process.exitCode = message.ExitCode
		process.stdoutCap = process.stdoutCap || message.StdoutCapReached
		process.stderrCap = process.stderrCap || message.StderrCapReached
		if err != nil {
			process.exitCode = 127
			process.err = err.Error()
		}
	}
	process.mu.Unlock()
	if process.notify != nil {
		process.notify()
	}
}

func (process *workspaceAttachmentProcess) markReady() {
	process.readyOnce.Do(func() { close(process.ready) })
}

func (process *workspaceAttachmentProcess) read(stdout, stderr io.Reader) {
	var stderrBuffer bytes.Buffer
	stderrDone := make(chan struct{})
	go func() {
		_, _ = io.Copy(&stderrBuffer, io.LimitReader(stderr, 64*1024))
		close(stderrDone)
	}()
	for {
		var message workspaceStdioMessage
		if err := readWorkspaceStdioFrame(stdout, &message); err != nil {
			_ = process.session.Wait()
			<-stderrDone
			if diagnostic := stderrBuffer.String(); diagnostic != "" {
				process.append("stderr", []byte(diagnostic))
			}
			process.finish(workspaceStdioMessage{}, err)
			return
		}
		switch message.Type {
		case "event":
			process.append(message.EventType, message.Data)
		case "error":
			process.finish(workspaceStdioMessage{}, errors.New(message.Message))
			return
		case "result":
			waitErr := process.session.Wait()
			<-stderrDone
			if waitErr != nil && message.ExitCode == 0 {
				message.ExitCode = 127
				process.finish(message, waitErr)
			} else {
				process.finish(message, nil)
			}
			return
		}
	}
}

func (process *workspaceAttachmentProcess) close() error {
	process.mu.Lock()
	process.closed = true
	if process.space != nil {
		process.space.Broadcast()
	}
	session := process.session
	stdin := process.stdin
	process.mu.Unlock()
	process.stdinMu.Lock()
	if stdin != nil {
		_ = stdin.Close()
	}
	process.stdinMu.Unlock()
	if session == nil {
		return nil
	}
	err := session.Close()
	if errors.Is(err, io.EOF) {
		return nil
	}
	return err
}

func (p *workspaceAttachmentPool) writeProcess(id string, data []byte) error {
	process, err := p.process(id)
	if err != nil {
		return err
	}
	if len(data) > hostProcessBufferLimit {
		return fmt.Errorf("workspace process write exceeds limit")
	}
	select {
	case <-process.ready:
	case <-time.After(10 * time.Second):
		return fmt.Errorf("workspace process stdin did not become ready")
	}
	process.stdinMu.Lock()
	defer process.stdinMu.Unlock()
	process.mu.Lock()
	stdin := process.stdin
	closed := process.closed
	process.mu.Unlock()
	if closed || stdin == nil {
		return fmt.Errorf("workspace process stdin is unavailable")
	}
	_, err = stdin.Write(data)
	return err
}

func (p *workspaceAttachmentPool) process(id string) (*workspaceAttachmentProcess, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	process := p.processes[id]
	if process == nil {
		return nil, fmt.Errorf("unknown workspace process: %s", id)
	}
	return process, nil
}

func (p *workspaceAttachmentPool) drainProcess(id string) (map[string]any, error) {
	process, err := p.process(id)
	if err != nil {
		return nil, err
	}
	process.mu.Lock()
	defer process.mu.Unlock()
	stdout := append([]byte(nil), process.stdout...)
	stderr := append([]byte(nil), process.stderr...)
	process.stdout = process.stdout[:0]
	process.stderr = process.stderr[:0]
	if process.space != nil {
		process.space.Broadcast()
	}
	return map[string]any{
		"stdoutBytes": stdout, "stderrBytes": stderr, "exited": process.exited,
		"exitCode": process.exitCode, "error": process.err,
		"stdoutCapReached": process.stdoutCap, "stderrCapReached": process.stderrCap,
	}, nil
}

func (p *workspaceAttachmentPool) closeProcess(id string) error {
	p.mu.Lock()
	process := p.processes[id]
	delete(p.processes, id)
	p.mu.Unlock()
	if process == nil {
		return nil
	}
	return process.close()
}

func (p *workspaceAttachmentPool) call(
	ctx context.Context, attachmentID string, endpoint workspaces.Endpoint, request workspaceStdioRequest,
) (workspaceStdioMessage, error) {
	client, err := p.client(ctx, attachmentID, endpoint)
	if err != nil {
		return workspaceStdioMessage{}, err
	}
	session, err := client.NewSession()
	if err != nil {
		p.invalidate(attachmentID, client)
		return workspaceStdioMessage{}, fmt.Errorf("open attached workspace channel: %w", err)
	}
	defer session.Close()
	stdin, err := session.StdinPipe()
	if err != nil {
		return workspaceStdioMessage{}, err
	}
	stdout, err := session.StdoutPipe()
	if err != nil {
		return workspaceStdioMessage{}, err
	}
	stderr, err := session.StderrPipe()
	if err != nil {
		return workspaceStdioMessage{}, err
	}
	if err := session.Start(workspaceStdioFastCommand); err != nil {
		p.invalidate(attachmentID, client)
		return workspaceStdioMessage{}, fmt.Errorf("start attached workspace operation: %w", err)
	}
	var stderrBuffer bytes.Buffer
	stderrDone := make(chan struct{})
	go func() {
		_, _ = io.Copy(&stderrBuffer, io.LimitReader(stderr, 64*1024))
		close(stderrDone)
	}()
	cancelled := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			_ = session.Close()
		case <-cancelled:
		}
	}()
	defer close(cancelled)
	if err := writeWorkspaceStdioFrame(stdin, request); err != nil {
		return workspaceStdioMessage{}, err
	}
	_ = stdin.Close()
	var response workspaceStdioMessage
	readErr := readWorkspaceStdioFrame(stdout, &response)
	waitErr := session.Wait()
	<-stderrDone
	if readErr != nil {
		if ctx.Err() != nil {
			return workspaceStdioMessage{}, ctx.Err()
		}
		return workspaceStdioMessage{}, fmt.Errorf("read attached workspace response: %w", readErr)
	}
	if response.Type == "error" {
		return workspaceStdioMessage{}, errors.New(response.Message)
	}
	if response.Type != "result" {
		return workspaceStdioMessage{}, fmt.Errorf("unexpected attached workspace response: %s", response.Type)
	}
	if waitErr != nil {
		message := stderrBuffer.String()
		if message == "" {
			message = waitErr.Error()
		}
		return workspaceStdioMessage{}, fmt.Errorf("attached workspace operation failed: %s", message)
	}
	return response, nil
}
