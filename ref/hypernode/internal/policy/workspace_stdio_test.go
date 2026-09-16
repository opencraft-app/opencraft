package policy

import (
	"bytes"
	"io"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func runWorkspaceStdioRequest(t *testing.T, root string, request workspaceStdioRequest) (workspaceStdioMessage, error) {
	t.Helper()
	var input bytes.Buffer
	var output bytes.Buffer
	if err := writeWorkspaceStdioFrame(&input, request); err != nil {
		t.Fatal(err)
	}
	err := RunWorkspaceStdio(root, workspaceStdioProtocol, &input, &output)
	var response workspaceStdioMessage
	if decodeErr := readWorkspaceStdioFrame(&output, &response); decodeErr != nil {
		t.Fatalf("decode workspace response: %v (operation error: %v)", decodeErr, err)
	}
	return response, err
}

func TestWorkspaceStdioFilesystemOperationsStayInsideRoot(t *testing.T) {
	root := t.TempDir()
	response, err := runWorkspaceStdioRequest(t, root, workspaceStdioRequest{
		Operation: "write", Path: "/workspace/projects/repo/README.md", Data: []byte("hello"),
	})
	if err != nil || response.Type != "result" {
		t.Fatalf("write failed: response=%#v err=%v", response, err)
	}
	response, err = runWorkspaceStdioRequest(t, root, workspaceStdioRequest{
		Operation: "metadata", Path: "/workspace/projects/repo/README.md",
	})
	if err != nil || response.Metadata == nil || !response.Metadata.IsFile {
		t.Fatalf("metadata failed: response=%#v err=%v", response, err)
	}
	response, err = runWorkspaceStdioRequest(t, root, workspaceStdioRequest{
		Operation: "list", Path: "/workspace/projects/repo",
	})
	if err != nil || len(response.Entries) != 1 || response.Entries[0].FileName != "README.md" {
		t.Fatalf("list failed: response=%#v err=%v", response, err)
	}
	response, err = runWorkspaceStdioRequest(t, root, workspaceStdioRequest{
		Operation: "read", Path: "/workspace/projects/repo/README.md",
	})
	if err != nil || string(response.Data) != "hello" {
		t.Fatalf("read failed: response=%#v err=%v", response, err)
	}
	response, err = runWorkspaceStdioRequest(t, root, workspaceStdioRequest{
		Operation: "copy", Path: "/workspace/projects/repo",
		DestinationPath: "/workspace/projects/repo-copy", Recursive: true,
	})
	if err != nil || response.Type != "result" {
		t.Fatalf("copy failed: response=%#v err=%v", response, err)
	}
	response, err = runWorkspaceStdioRequest(t, root, workspaceStdioRequest{
		Operation: "read", Path: "/workspace/projects/repo-copy/README.md",
	})
	if err != nil || string(response.Data) != "hello" {
		t.Fatalf("copied read failed: response=%#v err=%v", response, err)
	}
	response, err = runWorkspaceStdioRequest(t, root, workspaceStdioRequest{
		Operation: "remove", Path: "/workspace/projects/repo-copy", Recursive: true,
	})
	if err != nil || response.Type != "result" {
		t.Fatalf("remove failed: response=%#v err=%v", response, err)
	}
	if _, err := os.Stat(filepath.Join(root, "projects", "repo-copy")); !os.IsNotExist(err) {
		t.Fatalf("recursive remove left destination: %v", err)
	}

	outside := filepath.Join(t.TempDir(), "secret")
	if err := os.WriteFile(outside, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Dir(outside), filepath.Join(root, "escape")); err != nil {
		t.Fatal(err)
	}
	response, err = runWorkspaceStdioRequest(t, root, workspaceStdioRequest{
		Operation: "read", Path: "/workspace/escape/secret",
	})
	if err == nil || response.Type != "error" {
		t.Fatalf("symlink escape was not rejected: response=%#v err=%v", response, err)
	}
}

func TestWorkspaceStdioExecUsesWorkspaceCwdEnvironmentLimitsAndTimeout(t *testing.T) {
	root := t.TempDir()
	repository := filepath.Join(root, "projects", "repo")
	if err := os.MkdirAll(repository, 0o755); err != nil {
		t.Fatal(err)
	}
	value := "attachment"
	response, err := runWorkspaceStdioRequest(t, root, workspaceStdioRequest{
		Operation: "exec", Path: "/workspace/projects/repo",
		Command:     []string{"sh", "-c", `printf '%s|' "$HYPERNODE_GATE"; pwd`},
		Environment: map[string]*string{"HYPERNODE_GATE": &value},
		TimeoutMs:   1000, OutputBytesCap: 4096,
	})
	if err != nil || response.Type != "result" || response.ExitCode != 0 {
		t.Fatalf("exec failed: response=%#v err=%v", response, err)
	}
	if got := string(response.Stdout); got != "attachment|"+repository+"\n" {
		t.Fatalf("unexpected stdout: %q", got)
	}
	if len(response.Stderr) != 0 || response.StdoutCapReached || response.StderrCapReached {
		t.Fatalf("unexpected stderr/cap state: %#v", response)
	}

	response, err = runWorkspaceStdioRequest(t, root, workspaceStdioRequest{
		Operation: "exec", Path: "/workspace/projects/repo",
		Command:   []string{"sh", "-c", "printf 123456789"},
		TimeoutMs: 1000, OutputBytesCap: 4,
	})
	if err != nil || string(response.Stdout) != "1234" || !response.StdoutCapReached {
		t.Fatalf("output cap failed: response=%#v err=%v", response, err)
	}

	response, err = runWorkspaceStdioRequest(t, root, workspaceStdioRequest{
		Operation: "exec", Path: "/workspace/projects/repo",
		Command: []string{"sh", "-c", "sleep 1"}, TimeoutMs: 10,
	})
	if err != nil || response.ExitCode != 124 {
		t.Fatalf("timeout failed: response=%#v err=%v", response, err)
	}

	response, err = runWorkspaceStdioRequest(t, root, workspaceStdioRequest{
		Operation: "exec", Path: "/workspace/../outside", Command: []string{"pwd"},
	})
	if err == nil || response.Type != "error" {
		t.Fatalf("escaped cwd was not rejected: response=%#v err=%v", response, err)
	}
}

func readWorkspaceStdioMessage(t *testing.T, input io.Reader) workspaceStdioMessage {
	t.Helper()
	type result struct {
		message workspaceStdioMessage
		err     error
	}
	ready := make(chan result, 1)
	go func() {
		var message workspaceStdioMessage
		err := readWorkspaceStdioFrame(input, &message)
		ready <- result{message: message, err: err}
	}()
	select {
	case value := <-ready:
		if value.err != nil {
			t.Fatal(value.err)
		}
		return value.message
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for workspace stdio message")
		return workspaceStdioMessage{}
	}
}

func TestWorkspaceStdioWatchStreamsNodeShapedEvents(t *testing.T) {
	root := t.TempDir()
	repository := filepath.Join(root, "projects", "repo")
	if err := os.MkdirAll(repository, 0o755); err != nil {
		t.Fatal(err)
	}
	requestReader, requestWriter := io.Pipe()
	responseReader, responseWriter := io.Pipe()
	done := make(chan error, 1)
	go func() {
		done <- RunWorkspaceStdio(root, workspaceStdioProtocol, requestReader, responseWriter)
	}()
	if err := writeWorkspaceStdioFrame(requestWriter, workspaceStdioRequest{
		Operation: "watch", Path: "/workspace/projects/repo", Recursive: true,
	}); err != nil {
		t.Fatal(err)
	}
	if message := readWorkspaceStdioMessage(t, responseReader); message.Type != "ready" {
		t.Fatalf("expected ready, got %#v", message)
	}

	readme := filepath.Join(repository, "README.md")
	if err := os.WriteFile(readme, []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		message := readWorkspaceStdioMessage(t, responseReader)
		if message.Type == "event" && message.Path == "/workspace/projects/repo/README.md" {
			if message.Filename != "README.md" {
				t.Fatalf("unexpected relative filename: %#v", message)
			}
			if message.EventType != "rename" && message.EventType != "change" {
				t.Fatalf("unexpected event type: %#v", message)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("workspace stdio did not report README.md; last=%#v", message)
		}
	}

	// Closing an SSH channel tears down both directions. Mirror that behavior
	// with both pipe halves so a producer blocked behind client backpressure is
	// released as well.
	if err := responseReader.Close(); err != nil {
		t.Fatal(err)
	}
	if err := requestWriter.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err != nil && err != io.ErrClosedPipe {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("workspace stdio did not stop after channel EOF")
	}
}

func TestWorkspaceStdioSpawnStreamsOutputBeforeExit(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "projects"), 0o755); err != nil {
		t.Fatal(err)
	}
	requestReader, requestWriter := io.Pipe()
	responseReader, responseWriter := io.Pipe()
	done := make(chan error, 1)
	go func() {
		done <- RunWorkspaceStdio(root, workspaceStdioProtocol, requestReader, responseWriter)
	}()
	if err := writeWorkspaceStdioFrame(requestWriter, workspaceStdioRequest{
		Operation: "spawn", Path: "/workspace/projects",
		Command: []string{"sh", "-c", "printf first; sleep 0.1; printf second"},
	}); err != nil {
		t.Fatal(err)
	}
	first := readWorkspaceStdioMessage(t, responseReader)
	if first.Type != "event" || first.EventType != "stdout" || string(first.Data) != "first" {
		t.Fatalf("expected first stdout event, got %#v", first)
	}
	second := readWorkspaceStdioMessage(t, responseReader)
	if second.Type != "event" || second.EventType != "stdout" || string(second.Data) != "second" {
		t.Fatalf("expected second stdout event, got %#v", second)
	}
	result := readWorkspaceStdioMessage(t, responseReader)
	if result.Type != "result" || result.ExitCode != 0 {
		t.Fatalf("expected successful result, got %#v", result)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestWorkspaceStdioSpawnForwardsInputAfterRequestFrame(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "projects"), 0o755); err != nil {
		t.Fatal(err)
	}
	requestReader, requestWriter := io.Pipe()
	responseReader, responseWriter := io.Pipe()
	done := make(chan error, 1)
	go func() {
		done <- RunWorkspaceStdio(root, workspaceStdioProtocol, requestReader, responseWriter)
	}()
	if err := writeWorkspaceStdioFrame(requestWriter, workspaceStdioRequest{
		Operation: "spawn", Path: "/workspace/projects",
		Command:        []string{"sh", "-c", "IFS= read -r line; printf 'reply:%s\\n' \"$line\""},
		DisableTimeout: true, InteractiveStdin: true,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := io.WriteString(requestWriter, "hello workspace\n"); err != nil {
		t.Fatal(err)
	}
	message := readWorkspaceStdioMessage(t, responseReader)
	if message.Type != "event" || message.EventType != "stdout" || string(message.Data) != "reply:hello workspace\n" {
		t.Fatalf("expected forwarded stdin reply, got %#v", message)
	}
	result := readWorkspaceStdioMessage(t, responseReader)
	if result.Type != "result" || result.ExitCode != 0 {
		t.Fatalf("expected successful result, got %#v", result)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestWorkspaceStdioSpawnKeepsProtocolAliveAfterFourMiB(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "projects"), 0o755); err != nil {
		t.Fatal(err)
	}
	requestReader, requestWriter := io.Pipe()
	responseReader, responseWriter := io.Pipe()
	done := make(chan error, 1)
	go func() {
		done <- RunWorkspaceStdio(root, workspaceStdioProtocol, requestReader, responseWriter)
	}()
	const initialOutput = workspaceProcessTransportCap + 64*1024
	if err := writeWorkspaceStdioFrame(requestWriter, workspaceStdioRequest{
		Operation: "spawn", Path: "/workspace/projects",
		Command:        []string{"sh", "-c", "head -c 4259840 /dev/zero | tr '\\000' x; IFS= read -r line; printf '\\nterminal:%s\\n' \"$line\""},
		DisableTimeout: true, DisableOutputCap: true, InteractiveStdin: true,
	}); err != nil {
		t.Fatal(err)
	}

	total := 0
	for total < initialOutput {
		message := readWorkspaceStdioMessage(t, responseReader)
		if message.Type != "event" || message.EventType != "stdout" {
			t.Fatalf("expected initial stdout event, got %#v", message)
		}
		total += len(message.Data)
	}
	if total <= workspaceProcessTransportCap {
		t.Fatalf("stream stopped at the old cumulative cap: %d", total)
	}
	if _, err := io.WriteString(requestWriter, "interrupt\n"); err != nil {
		t.Fatal(err)
	}

	tail := make([]byte, 0, 128)
	markerSeen := false
	var result workspaceStdioMessage
	for result.Type == "" {
		message := readWorkspaceStdioMessage(t, responseReader)
		switch message.Type {
		case "event":
			if message.EventType != "stdout" {
				continue
			}
			tail = append(tail, message.Data...)
			if len(tail) > 128 {
				tail = append([]byte(nil), tail[len(tail)-128:]...)
			}
			if bytes.Contains(tail, []byte("terminal:interrupt\n")) {
				markerSeen = true
			}
		case "result":
			result = message
		default:
			t.Fatalf("unexpected workspace message: %#v", message)
		}
	}
	if !markerSeen {
		t.Fatalf("terminal protocol output was lost after the old cap; tail=%q", tail)
	}
	if result.ExitCode != 0 || result.StdoutCapReached || result.StderrCapReached {
		t.Fatalf("expected uncapped successful result, got %#v", result)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestWorkspaceAttachmentProcessBackpressuresWithoutDroppingOutput(t *testing.T) {
	pool := newWorkspaceAttachmentPool(nil)
	process := &workspaceAttachmentProcess{exitCode: -1, ready: make(chan struct{})}
	process.space = sync.NewCond(&process.mu)
	pool.processes["process"] = process

	payload := bytes.Repeat([]byte("x"), hostTerminalBufferLimit+64*1024)
	done := make(chan struct{})
	go func() {
		process.append("stdout", payload)
		close(done)
	}()

	deadline := time.Now().Add(3 * time.Second)
	for {
		process.mu.Lock()
		buffered := len(process.stdout)
		process.mu.Unlock()
		if buffered == hostTerminalBufferLimit {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("process output did not fill the pending window: %d", buffered)
		}
		time.Sleep(time.Millisecond)
	}
	select {
	case <-done:
		t.Fatal("producer bypassed pending-output backpressure")
	default:
	}

	first, err := pool.drainProcess("process")
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("producer did not resume after output was drained")
	}
	second, err := pool.drainProcess("process")
	if err != nil {
		t.Fatal(err)
	}
	combined := append(first["stdoutBytes"].([]byte), second["stdoutBytes"].([]byte)...)
	if !bytes.Equal(combined, payload) {
		t.Fatalf("output changed across backpressure: got=%d want=%d", len(combined), len(payload))
	}
	if first["stdoutCapReached"].(bool) || second["stdoutCapReached"].(bool) {
		t.Fatal("bounded pending output was incorrectly reported as truncation")
	}
}
