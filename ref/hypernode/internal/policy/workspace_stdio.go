package policy

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	workspaceStdioProtocol    = "hypernode-fs@v1"
	workspaceStdioFastCommand = "@hypernode workspace-stdio hypernode-fs@v1"
	workspaceStdioFrameLimit  = 16 << 20
	workspaceStdioBufferLimit = 24 << 20
)

type workspaceStdioRequest struct {
	Operation        string             `json:"op"`
	Path             string             `json:"path,omitempty"`
	DestinationPath  string             `json:"destinationPath,omitempty"`
	Recursive        bool               `json:"recursive,omitempty"`
	Force            bool               `json:"force,omitempty"`
	Data             []byte             `json:"data,omitempty"`
	Command          []string           `json:"command,omitempty"`
	Environment      map[string]*string `json:"env,omitempty"`
	TimeoutMs        int64              `json:"timeoutMs,omitempty"`
	DisableTimeout   bool               `json:"disableTimeout,omitempty"`
	OutputBytesCap   int                `json:"outputBytesCap,omitempty"`
	DisableOutputCap bool               `json:"disableOutputCap,omitempty"`
	InteractiveStdin bool               `json:"interactiveStdin,omitempty"`
}

type workspaceStdioMessage struct {
	Type             string                         `json:"type"`
	EventType        string                         `json:"eventType,omitempty"`
	Filename         string                         `json:"filename,omitempty"`
	Path             string                         `json:"path,omitempty"`
	Message          string                         `json:"message,omitempty"`
	Metadata         *workspaceStdioMetadata        `json:"metadata,omitempty"`
	Entries          []workspaceStdioDirectoryEntry `json:"entries,omitempty"`
	Data             []byte                         `json:"data,omitempty"`
	ExitCode         int                            `json:"exitCode,omitempty"`
	Stdout           []byte                         `json:"stdout,omitempty"`
	Stderr           []byte                         `json:"stderr,omitempty"`
	StdoutCapReached bool                           `json:"stdoutCapReached,omitempty"`
	StderrCapReached bool                           `json:"stderrCapReached,omitempty"`
}

type workspaceStdioMetadata struct {
	IsDirectory  bool  `json:"isDirectory"`
	IsFile       bool  `json:"isFile"`
	IsSymlink    bool  `json:"isSymlink"`
	CreatedAtMs  int64 `json:"createdAtMs"`
	ModifiedAtMs int64 `json:"modifiedAtMs"`
}

type workspaceStdioDirectoryEntry struct {
	FileName    string `json:"fileName"`
	IsDirectory bool   `json:"isDirectory"`
	IsFile      bool   `json:"isFile"`
}

func writeWorkspaceStdioFrame(output io.Writer, value any) error {
	payload, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if len(payload) > workspaceStdioFrameLimit {
		return fmt.Errorf("workspace stdio frame exceeds limit")
	}
	header := [4]byte{}
	binary.BigEndian.PutUint32(header[:], uint32(len(payload)))
	if _, err := output.Write(header[:]); err != nil {
		return err
	}
	if _, err := output.Write(payload); err != nil {
		return err
	}
	if flusher, ok := output.(interface{ Flush() error }); ok {
		return flusher.Flush()
	}
	return nil
}

func readWorkspaceStdioFrame(input io.Reader, value any) error {
	header := [4]byte{}
	if _, err := io.ReadFull(input, header[:]); err != nil {
		return err
	}
	length := binary.BigEndian.Uint32(header[:])
	if length == 0 || length > workspaceStdioFrameLimit {
		return fmt.Errorf("invalid workspace stdio frame length: %d", length)
	}
	payload := make([]byte, int(length))
	if _, err := io.ReadFull(input, payload); err != nil {
		return err
	}
	if err := json.Unmarshal(payload, value); err != nil {
		return fmt.Errorf("decode workspace stdio frame: %w", err)
	}
	return nil
}

// RunWorkspaceStdio implements the protocol shared by the in-process vSSH
// fast path and the helper binary launched through a regular OpenSSH server.
// One invocation owns exactly one SSH channel and one filesystem operation;
// SSH itself provides multiplexing, flow control, cancellation, and isolation.
func RunWorkspaceStdio(root, protocol string, input io.Reader, output io.Writer) error {
	if protocol != workspaceStdioProtocol {
		return fmt.Errorf("unsupported workspace stdio protocol: %s", protocol)
	}
	var request workspaceStdioRequest
	if err := readWorkspaceStdioFrame(input, &request); err != nil {
		return err
	}
	if request.Operation == "spawn" {
		var processInput io.Reader
		if request.InteractiveStdin {
			processInput = input
		}
		return streamWorkspaceProcess(root, request, processInput, output)
	}
	if request.Operation != "watch" {
		response, err := executeWorkspaceStdioRequest(root, request)
		if err != nil {
			_ = writeWorkspaceStdioFrame(output, workspaceStdioMessage{Type: "error", Message: err.Error()})
			return err
		}
		response.Type = "result"
		return writeWorkspaceStdioFrame(output, response)
	}
	logicalRoot, err := workspaceLogicalPath(request.Path)
	if err != nil {
		return err
	}
	root, err = filepath.Abs(root)
	if err != nil {
		return fmt.Errorf("resolve workspace stdio root: %w", err)
	}
	root, err = filepath.EvalSymlinks(root)
	if err != nil {
		return fmt.Errorf("resolve workspace stdio root symlinks: %w", err)
	}
	wake := make(chan struct{}, 1)
	notify := func() {
		select {
		case wake <- struct{}{}:
		default:
		}
	}
	watch, err := newWorkspaceWatch(logicalRoot, root, notify)
	if err != nil {
		return err
	}
	defer watch.Close()

	inputClosed := make(chan struct{})
	go func() {
		_, _ = io.Copy(io.Discard, input)
		close(inputClosed)
	}()
	writer := bufio.NewWriter(output)
	readySent := false
	for {
		select {
		case <-inputClosed:
			return nil
		case <-wake:
			events, ready, failure, _ := watch.drainState()
			if failure != "" {
				_ = writeWorkspaceStdioFrame(writer, workspaceStdioMessage{Type: "error", Message: failure})
				return errors.New(failure)
			}
			if ready && !readySent {
				if err := writeWorkspaceStdioFrame(writer, workspaceStdioMessage{Type: "ready"}); err != nil {
					return err
				}
				readySent = true
			}
			for _, event := range events {
				filename := ""
				if event.Path != logicalRoot && strings.HasPrefix(event.Path, logicalRoot+"/") {
					filename = strings.TrimPrefix(event.Path, logicalRoot+"/")
				}
				if err := writeWorkspaceStdioFrame(writer, workspaceStdioMessage{
					Type: "event", EventType: event.EventType, Filename: filename, Path: event.Path,
				}); err != nil {
					return err
				}
			}
		}
	}
}

func executeWorkspaceStdioRequest(rootPath string, request workspaceStdioRequest) (workspaceStdioMessage, error) {
	root, err := os.OpenRoot(rootPath)
	if err != nil {
		return workspaceStdioMessage{}, fmt.Errorf("open workspace root: %w", err)
	}
	defer root.Close()
	relative, err := workspaceRelativePath(request.Path)
	if err != nil {
		return workspaceStdioMessage{}, err
	}
	switch request.Operation {
	case "metadata":
		info, err := root.Lstat(relative)
		if err != nil {
			return workspaceStdioMessage{}, err
		}
		metadata := workspaceMetadata(info)
		return workspaceStdioMessage{Metadata: &metadata}, nil
	case "list":
		directory, err := root.Open(relative)
		if err != nil {
			return workspaceStdioMessage{}, err
		}
		entries, err := directory.ReadDir(-1)
		_ = directory.Close()
		if err != nil {
			return workspaceStdioMessage{}, err
		}
		result := make([]workspaceStdioDirectoryEntry, 0, len(entries))
		for _, entry := range entries {
			info, err := entry.Info()
			if err != nil {
				return workspaceStdioMessage{}, err
			}
			result = append(result, workspaceStdioDirectoryEntry{
				FileName: entry.Name(), IsDirectory: info.IsDir(), IsFile: info.Mode().IsRegular(),
			})
		}
		sort.Slice(result, func(left, right int) bool { return result[left].FileName < result[right].FileName })
		return workspaceStdioMessage{Entries: result}, nil
	case "read":
		file, err := root.Open(relative)
		if err != nil {
			return workspaceStdioMessage{}, err
		}
		data, err := io.ReadAll(io.LimitReader(file, workspaceStdioFrameLimit+1))
		_ = file.Close()
		if err != nil {
			return workspaceStdioMessage{}, err
		}
		if len(data) > workspaceStdioFrameLimit {
			return workspaceStdioMessage{}, fmt.Errorf("workspace file exceeds read limit")
		}
		return workspaceStdioMessage{Data: data}, nil
	case "write":
		if err := workspaceRootMkdirAll(root, path.Dir(relative), 0o770); err != nil {
			return workspaceStdioMessage{}, err
		}
		file, err := root.OpenFile(relative, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o664)
		if err != nil {
			return workspaceStdioMessage{}, err
		}
		_, writeErr := file.Write(request.Data)
		closeErr := file.Close()
		if writeErr != nil {
			return workspaceStdioMessage{}, writeErr
		}
		return workspaceStdioMessage{}, closeErr
	case "mkdir":
		if request.Recursive {
			err = workspaceRootMkdirAll(root, relative, 0o770)
		} else if relative != "." {
			err = root.Mkdir(relative, 0o770)
		}
		return workspaceStdioMessage{}, err
	case "remove":
		err = workspaceRootRemove(root, relative, request.Recursive)
		if request.Force && errors.Is(err, fs.ErrNotExist) {
			err = nil
		}
		return workspaceStdioMessage{}, err
	case "copy":
		destination, err := workspaceRelativePath(request.DestinationPath)
		if err != nil {
			return workspaceStdioMessage{}, err
		}
		return workspaceStdioMessage{}, workspaceRootCopy(root, relative, destination, request.Recursive)
	case "exec":
		return executeWorkspaceProcess(rootPath, request)
	default:
		return workspaceStdioMessage{}, fmt.Errorf("unsupported workspace stdio operation: %s", request.Operation)
	}
}

const (
	workspaceProcessDefaultTimeout = 10 * time.Second
	workspaceProcessDefaultCap     = 1 << 20
	// A single framed response contains both base64-encoded streams. Keeping
	// each stream below 4 MiB leaves ample room under the 16 MiB frame limit.
	workspaceProcessTransportCap = 4 << 20
)

type workspaceCappedBuffer struct {
	buffer  bytes.Buffer
	limit   int
	reached bool
}

func (buffer *workspaceCappedBuffer) Write(value []byte) (int, error) {
	written := len(value)
	remaining := buffer.limit - buffer.buffer.Len()
	if remaining <= 0 {
		buffer.reached = buffer.reached || written > 0
		return written, nil
	}
	if len(value) > remaining {
		_, _ = buffer.buffer.Write(value[:remaining])
		buffer.reached = true
		return written, nil
	}
	_, _ = buffer.buffer.Write(value)
	return written, nil
}

func executeWorkspaceProcess(rootPath string, request workspaceStdioRequest) (workspaceStdioMessage, error) {
	cap := workspaceProcessCap(request)
	stdout := &workspaceCappedBuffer{limit: cap}
	stderr := &workspaceCappedBuffer{limit: cap}
	result, err := runWorkspaceProcess(rootPath, request, stdout, stderr)
	result.Stdout = stdout.buffer.Bytes()
	result.Stderr = stderr.buffer.Bytes()
	result.StdoutCapReached = stdout.reached
	result.StderrCapReached = stderr.reached
	return result, err
}

func workspaceProcessCap(request workspaceStdioRequest) int {
	cap := workspaceProcessDefaultCap
	if request.OutputBytesCap > 0 {
		cap = request.OutputBytesCap
	}
	if request.DisableOutputCap || cap > workspaceProcessTransportCap {
		cap = workspaceProcessTransportCap
	}
	return cap
}

type workspaceStreamWriter struct {
	mu        *sync.Mutex
	output    io.Writer
	stream    string
	remaining int
	unlimited bool
	reached   bool
}

func (writer *workspaceStreamWriter) Write(value []byte) (int, error) {
	written := len(value)
	if !writer.unlimited && writer.remaining <= 0 {
		writer.reached = writer.reached || written > 0
		return written, nil
	}
	chunk := value
	if !writer.unlimited && len(chunk) > writer.remaining {
		chunk = chunk[:writer.remaining]
		writer.reached = true
	}
	if !writer.unlimited {
		writer.remaining -= len(chunk)
	}
	if len(chunk) == 0 {
		return written, nil
	}
	writer.mu.Lock()
	err := writeWorkspaceStdioFrame(writer.output, workspaceStdioMessage{
		Type: "event", EventType: writer.stream, Data: append([]byte(nil), chunk...),
	})
	writer.mu.Unlock()
	if err != nil {
		return 0, err
	}
	return written, nil
}

func streamWorkspaceProcess(rootPath string, request workspaceStdioRequest, input io.Reader, output io.Writer) error {
	var writeMu sync.Mutex
	cap := workspaceProcessCap(request)
	// Spawn output is split into independent event frames, so an unlimited
	// long-lived process does not need to fit its cumulative output into one
	// transport frame. Backpressure is provided by the stream itself.
	stdout := &workspaceStreamWriter{
		mu: &writeMu, output: output, stream: "stdout", remaining: cap, unlimited: request.DisableOutputCap,
	}
	stderr := &workspaceStreamWriter{
		mu: &writeMu, output: output, stream: "stderr", remaining: cap, unlimited: request.DisableOutputCap,
	}
	result, err := runWorkspaceProcessWithInput(rootPath, request, input, stdout, stderr)
	if err != nil {
		writeMu.Lock()
		writeErr := writeWorkspaceStdioFrame(output, workspaceStdioMessage{Type: "error", Message: err.Error()})
		writeMu.Unlock()
		if writeErr != nil {
			return writeErr
		}
		return err
	}
	result.Type = "result"
	result.StdoutCapReached = stdout.reached
	result.StderrCapReached = stderr.reached
	writeMu.Lock()
	writeErr := writeWorkspaceStdioFrame(output, result)
	writeMu.Unlock()
	return writeErr
}

func runWorkspaceProcess(
	rootPath string, request workspaceStdioRequest, stdout io.Writer, stderr io.Writer,
) (workspaceStdioMessage, error) {
	return runWorkspaceProcessWithInput(rootPath, request, nil, stdout, stderr)
}

func runWorkspaceProcessWithInput(
	rootPath string, request workspaceStdioRequest, stdin io.Reader, stdout io.Writer, stderr io.Writer,
) (workspaceStdioMessage, error) {
	if len(request.Command) == 0 || request.Command[0] == "" {
		return workspaceStdioMessage{}, fmt.Errorf("workspace process command must not be empty")
	}
	logicalCwd, err := workspaceLogicalPath(request.Path)
	if err != nil {
		return workspaceStdioMessage{}, err
	}
	rootPath, err = filepath.Abs(rootPath)
	if err != nil {
		return workspaceStdioMessage{}, fmt.Errorf("resolve workspace process root: %w", err)
	}
	relativeCwd, err := workspaceRelativePath(logicalCwd)
	if err != nil {
		return workspaceStdioMessage{}, err
	}
	cwd := filepath.Join(rootPath, filepath.FromSlash(relativeCwd))
	info, err := os.Stat(cwd)
	if err != nil {
		return workspaceStdioMessage{}, fmt.Errorf("resolve workspace process cwd: %w", err)
	}
	if !info.IsDir() {
		return workspaceStdioMessage{}, fmt.Errorf("workspace process cwd is not a directory")
	}

	ctx := context.Background()
	cancel := func() {}
	if !request.DisableTimeout {
		timeout := workspaceProcessDefaultTimeout
		if request.TimeoutMs > 0 {
			timeout = time.Duration(request.TimeoutMs) * time.Millisecond
		}
		ctx, cancel = context.WithTimeout(ctx, timeout)
	}
	defer cancel()

	command := exec.CommandContext(ctx, request.Command[0], request.Command[1:]...)
	command.Dir = cwd
	environment := make(map[string]string)
	for _, pair := range os.Environ() {
		if name, value, found := strings.Cut(pair, "="); found {
			environment[name] = value
		}
	}
	for name, value := range request.Environment {
		if value == nil {
			delete(environment, name)
		} else {
			environment[name] = *value
		}
	}
	command.Env = make([]string, 0, len(environment))
	for name, value := range environment {
		command.Env = append(command.Env, name+"="+value)
	}
	sort.Strings(command.Env)

	command.Stdout = stdout
	command.Stderr = stderr
	var childStdin io.WriteCloser
	if stdin != nil {
		childStdin, err = command.StdinPipe()
		if err != nil {
			return workspaceStdioMessage{}, err
		}
	}
	runErr := command.Start()
	if runErr == nil {
		if childStdin != nil {
			go func() {
				_, _ = io.Copy(childStdin, stdin)
				_ = childStdin.Close()
			}()
		}
		runErr = command.Wait()
		if closer, ok := stdin.(io.Closer); ok {
			_ = closer.Close()
		}
	}
	exitCode := 0
	if runErr != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			exitCode = 124
			_, _ = stderr.Write([]byte("process timed out\n"))
		} else if exitError, ok := runErr.(*exec.ExitError); ok {
			exitCode = exitError.ExitCode()
		} else {
			exitCode = 127
			_, _ = stderr.Write([]byte(runErr.Error() + "\n"))
		}
	}
	return workspaceStdioMessage{ExitCode: exitCode}, nil
}

func workspaceRelativePath(value string) (string, error) {
	logical, err := workspaceLogicalPath(value)
	if err != nil {
		return "", err
	}
	relative := strings.TrimPrefix(logical, "/workspace")
	relative = strings.TrimPrefix(relative, "/")
	if relative == "" {
		return ".", nil
	}
	return relative, nil
}

func workspaceMetadata(info fs.FileInfo) workspaceStdioMetadata {
	createdAt := info.ModTime()
	if stat, ok := info.Sys().(*syscall.Stat_t); ok {
		createdAt = time.Unix(stat.Ctim.Sec, stat.Ctim.Nsec)
	}
	return workspaceStdioMetadata{
		IsDirectory: info.IsDir(), IsFile: info.Mode().IsRegular(),
		IsSymlink:   info.Mode()&os.ModeSymlink != 0,
		CreatedAtMs: createdAt.UnixMilli(), ModifiedAtMs: info.ModTime().UnixMilli(),
	}
}

func workspaceRootMkdirAll(root *os.Root, relative string, mode fs.FileMode) error {
	if relative == "." || relative == "" {
		return nil
	}
	current := ""
	for _, segment := range strings.Split(relative, "/") {
		if segment == "" || segment == "." {
			continue
		}
		if current == "" {
			current = segment
		} else {
			current += "/" + segment
		}
		info, err := root.Lstat(current)
		if err == nil {
			if !info.IsDir() {
				return fmt.Errorf("workspace path is not a directory: %s", current)
			}
			continue
		}
		if !errors.Is(err, fs.ErrNotExist) {
			return err
		}
		if err := root.Mkdir(current, mode); err != nil {
			return err
		}
	}
	return nil
}

func workspaceRootRemove(root *os.Root, relative string, recursive bool) error {
	if relative == "." {
		return fmt.Errorf("cannot remove workspace root")
	}
	info, err := root.Lstat(relative)
	if err != nil {
		return err
	}
	if !recursive || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return root.Remove(relative)
	}
	directory, err := root.Open(relative)
	if err != nil {
		return err
	}
	names, err := directory.Readdirnames(-1)
	_ = directory.Close()
	if err != nil {
		return err
	}
	for _, name := range names {
		if err := workspaceRootRemove(root, path.Join(relative, name), true); err != nil {
			return err
		}
	}
	return root.Remove(relative)
}

func workspaceRootCopy(root *os.Root, source, destination string, recursive bool) error {
	info, err := root.Lstat(source)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("workspace stdio copy does not follow symbolic links")
	}
	if info.IsDir() {
		if !recursive {
			return fmt.Errorf("directory copies require recursive: true")
		}
		if _, err := root.Lstat(destination); err == nil {
			return fs.ErrExist
		} else if !errors.Is(err, fs.ErrNotExist) {
			return err
		}
		if err := workspaceRootMkdirAll(root, path.Dir(destination), 0o770); err != nil {
			return err
		}
		if err := root.Mkdir(destination, info.Mode().Perm()); err != nil {
			return err
		}
		directory, err := root.Open(source)
		if err != nil {
			return err
		}
		names, err := directory.Readdirnames(-1)
		_ = directory.Close()
		if err != nil {
			return err
		}
		for _, name := range names {
			if err := workspaceRootCopy(root, path.Join(source, name), path.Join(destination, name), true); err != nil {
				return err
			}
		}
		return nil
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("workspace stdio copy only supports files and directories")
	}
	if err := workspaceRootMkdirAll(root, path.Dir(destination), 0o770); err != nil {
		return err
	}
	input, err := root.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	output, err := root.OpenFile(destination, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, info.Mode().Perm())
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(output, input)
	closeErr := output.Close()
	if copyErr != nil {
		return copyErr
	}
	return closeErr
}

func workspaceLogicalPath(value string) (string, error) {
	if value == "/workspace" || strings.HasPrefix(value, "/workspace/") {
		clean := path.Clean(value)
		if clean == "/workspace" || strings.HasPrefix(clean, "/workspace/") {
			return clean, nil
		}
	}
	return "", fmt.Errorf("workspace stdio path is outside /workspace: %s", value)
}

// asyncWorkspaceStdioInput makes writes from QuickJS non-blocking. The Go
// protocol worker blocks on Read in its own goroutine instead of holding the VM.
type asyncWorkspaceStdioInput struct {
	mu     sync.Mutex
	buffer bytes.Buffer
	wake   chan struct{}
	closed bool
}

func newAsyncWorkspaceStdioInput() *asyncWorkspaceStdioInput {
	return &asyncWorkspaceStdioInput{wake: make(chan struct{}, 1)}
}

func (r *asyncWorkspaceStdioInput) Write(data []byte) error {
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return io.ErrClosedPipe
	}
	if r.buffer.Len()+len(data) > workspaceStdioBufferLimit {
		r.mu.Unlock()
		return fmt.Errorf("workspace stdio input buffer exceeds limit")
	}
	_, _ = r.buffer.Write(data)
	r.mu.Unlock()
	select {
	case r.wake <- struct{}{}:
	default:
	}
	return nil
}

func (r *asyncWorkspaceStdioInput) Read(data []byte) (int, error) {
	for {
		r.mu.Lock()
		if r.buffer.Len() > 0 {
			n, _ := r.buffer.Read(data)
			r.mu.Unlock()
			return n, nil
		}
		closed := r.closed
		r.mu.Unlock()
		if closed {
			return 0, io.EOF
		}
		<-r.wake
	}
}

func (r *asyncWorkspaceStdioInput) Close() {
	r.mu.Lock()
	r.closed = true
	r.mu.Unlock()
	select {
	case r.wake <- struct{}{}:
	default:
	}
}

type workspaceStdioSession struct {
	input  *asyncWorkspaceStdioInput
	mu     sync.Mutex
	output bytes.Buffer
	done   bool
	err    string
	notify func()
}

func newWorkspaceStdioSession(root string, notify func()) *workspaceStdioSession {
	session := &workspaceStdioSession{input: newAsyncWorkspaceStdioInput(), notify: notify}
	go func() {
		err := RunWorkspaceStdio(root, workspaceStdioProtocol, session.input, session)
		session.mu.Lock()
		if err != nil && !errors.Is(err, io.EOF) {
			session.err = err.Error()
		}
		session.done = true
		session.mu.Unlock()
		session.notify()
	}()
	return session
}

func (s *workspaceStdioSession) Write(data []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.output.Len()+len(data) > workspaceStdioBufferLimit {
		return 0, fmt.Errorf("workspace stdio output buffer exceeds limit")
	}
	n, err := s.output.Write(data)
	s.notify()
	return n, err
}

func (s *workspaceStdioSession) drain() ([]byte, bool, string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	data := append([]byte(nil), s.output.Bytes()...)
	s.output.Reset()
	return data, s.done, s.err
}

func (s *workspaceStdioSession) Close() { s.input.Close() }

func (h *hostRuntime) openWorkspaceStdio(id string) error {
	if id == "" {
		return fmt.Errorf("workspace stdio session id is required")
	}
	session := newWorkspaceStdioSession(h.rootPath, h.wakes.notify)
	h.mu.Lock()
	if h.closed || h.workspaceStdioSessions[id] != nil {
		h.mu.Unlock()
		session.Close()
		return fmt.Errorf("duplicate or closed workspace stdio session")
	}
	h.workspaceStdioSessions[id] = session
	h.mu.Unlock()
	return nil
}

func (h *hostRuntime) writeWorkspaceStdio(id string, values []int) error {
	h.mu.Lock()
	session := h.workspaceStdioSessions[id]
	h.mu.Unlock()
	if session == nil {
		return fmt.Errorf("unknown workspace stdio session: %s", id)
	}
	data := make([]byte, len(values))
	for index, value := range values {
		if value < 0 || value > 255 {
			return fmt.Errorf("workspace stdio input contains a non-byte value")
		}
		data[index] = byte(value)
	}
	return session.input.Write(data)
}

func (h *hostRuntime) drainWorkspaceStdio(id string) (map[string]any, error) {
	h.mu.Lock()
	session := h.workspaceStdioSessions[id]
	h.mu.Unlock()
	if session == nil {
		return nil, fmt.Errorf("unknown workspace stdio session: %s", id)
	}
	data, done, failure := session.drain()
	return map[string]any{"dataBytes": data, "done": done, "error": failure}, nil
}

func (h *hostRuntime) closeWorkspaceStdio(id string) {
	h.mu.Lock()
	session := h.workspaceStdioSessions[id]
	delete(h.workspaceStdioSessions, id)
	h.mu.Unlock()
	if session != nil {
		session.Close()
	}
}
