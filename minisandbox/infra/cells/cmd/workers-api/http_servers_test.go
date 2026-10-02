package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

type httpHelperEvent struct {
	Kind            string   `json:"kind"`
	Endpoint        int      `json:"endpoint,omitempty"`
	Addresses       []string `json:"addresses,omitempty"`
	Calls           []int32  `json:"calls,omitempty"`
	Completed       []bool   `json:"completed,omitempty"`
	Deadline        bool     `json:"deadline,omitempty"`
	ListenerFailure bool     `json:"listenerFailure,omitempty"`
}

// The subprocess runs the same listener lifecycle with real TCP and SIGTERM.
// Gates hold real requests; no HTTP server or process method is mocked.
func TestWorkersAPIHTTPHelperProcess(t *testing.T) {
	if os.Getenv("WORKERS_API_HTTP_HELPER") != "1" {
		return
	}
	count, err := strconv.Atoi(os.Getenv("WORKERS_API_HTTP_ENDPOINTS"))
	if err != nil || count < 1 || count > 2 {
		os.Exit(2)
	}
	var outputMu sync.Mutex
	encoder := json.NewEncoder(os.Stdout)
	emit := func(event httpHelperEvent) {
		outputMu.Lock()
		defer outputMu.Unlock()
		if encoder.Encode(event) != nil {
			os.Exit(2)
		}
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM)
	defer stop()
	releases := make([]chan struct{}, count)
	closeOnce := make([]sync.Once, count)
	calls := make([]atomic.Int32, count)
	completed := make([]atomic.Bool, count)
	servers := make([]*http.Server, count)
	for index := range servers {
		releases[index] = make(chan struct{})
		servers[index] = &http.Server{
			Addr: "127.0.0.1:0",
			Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls[index].Add(1)
				_, _ = io.WriteString(w, "begin\n")
				w.(http.Flusher).Flush()
				select {
				case <-releases[index]:
					_, _ = io.WriteString(w, "end\n")
					completed[index].Store(true)
				case <-r.Context().Done():
				}
			}),
			ReadHeaderTimeout: time.Second,
		}
		servers[index].RegisterOnShutdown(func() {
			emit(httpHelperEvent{Kind: "shutdown", Endpoint: index})
		})
	}
	endpoints, err := bindHTTPServers(servers)
	if err != nil {
		os.Exit(2)
	}
	go func() {
		scanner := bufio.NewScanner(os.Stdin)
		for scanner.Scan() {
			switch scanner.Text() {
			case "release-public":
				closeOnce[0].Do(func() { close(releases[0]) })
			case "release-private":
				if count == 2 {
					closeOnce[1].Do(func() { close(releases[1]) })
				}
			case "close-public-listener":
				_ = endpoints[0].listener.Close()
			}
		}
	}()
	addresses := make([]string, count)
	for index, endpoint := range endpoints {
		addresses[index] = "http://" + endpoint.listener.Addr().String()
	}
	emit(httpHelperEvent{Kind: "ready", Addresses: addresses})
	drainTimeout := 5 * time.Second
	if os.Getenv("WORKERS_API_HTTP_TIMEOUT") == "1" {
		drainTimeout = 200 * time.Millisecond
	}
	err = runHTTPServers(ctx, slog.New(slog.NewJSONHandler(io.Discard, nil)), 1, endpoints, drainTimeout)
	callCounts := make([]int32, count)
	completedRequests := make([]bool, count)
	for index := range calls {
		callCounts[index] = calls[index].Load()
		completedRequests[index] = completed[index].Load()
	}
	emit(httpHelperEvent{
		Kind: "stopped", Calls: callCounts, Completed: completedRequests,
		Deadline:        errors.Is(err, context.DeadlineExceeded),
		ListenerFailure: errors.Is(err, net.ErrClosed),
	})
	os.Exit(0)
}

type httpHelper struct {
	command   *exec.Cmd
	input     io.WriteCloser
	events    chan httpHelperEvent
	done      chan struct{}
	waitError error
	addresses []string
}

func startHTTPHelper(t *testing.T, count int, timeout bool) *httpHelper {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	command := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestWorkersAPIHTTPHelperProcess$", "-test.timeout=15s")
	command.Env = append(os.Environ(), "WORKERS_API_HTTP_HELPER=1", fmt.Sprintf("WORKERS_API_HTTP_ENDPOINTS=%d", count))
	if timeout {
		command.Env = append(command.Env, "WORKERS_API_HTTP_TIMEOUT=1")
	} else {
		command.Env = append(command.Env, "WORKERS_API_HTTP_TIMEOUT=0")
	}
	// An owned pipe lets the decoder drain all bytes after process exit. Cmd.Wait must not
	// close StdoutPipe before its reader consumes the final lifecycle event.
	stdout, output, err := os.Pipe()
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	command.Stdout = output
	input, err := command.StdinPipe()
	if err != nil {
		_ = stdout.Close()
		_ = output.Close()
		cancel()
		t.Fatal(err)
	}
	if err := command.Start(); err != nil {
		_ = stdout.Close()
		_ = output.Close()
		cancel()
		t.Fatal(err)
	}
	_ = output.Close()
	helper := &httpHelper{command: command, input: input, events: make(chan httpHelperEvent, 16), done: make(chan struct{})}
	go func() {
		defer stdout.Close()
		decoder := json.NewDecoder(stdout)
		for {
			var event httpHelperEvent
			if decoder.Decode(&event) != nil {
				close(helper.events)
				return
			}
			helper.events <- event
		}
	}()
	go func() {
		helper.waitError = command.Wait()
		close(helper.done)
	}()
	t.Cleanup(func() {
		cancel()
		_ = input.Close()
		<-helper.done
	})
	ready := helper.nextEvent(t)
	if ready.Kind != "ready" || len(ready.Addresses) != count {
		t.Fatalf("expected exact listener readiness, got %+v", ready)
	}
	helper.addresses = ready.Addresses
	return helper
}

func (helper *httpHelper) nextEvent(t *testing.T) httpHelperEvent {
	t.Helper()
	select {
	case event, ok := <-helper.events:
		if !ok {
			t.Fatal("API process exited before the required drain event")
		}
		return event
	case <-time.After(8 * time.Second):
		t.Fatal("API process did not produce the required drain event")
		return httpHelperEvent{}
	}
}

func (helper *httpHelper) send(t *testing.T, command string) {
	t.Helper()
	if _, err := io.WriteString(helper.input, command+"\n"); err != nil {
		t.Fatal(err)
	}
}

func (helper *httpHelper) awaitShutdown(t *testing.T, count int) {
	t.Helper()
	seen := make(map[int]bool, count)
	for len(seen) < count {
		event := helper.nextEvent(t)
		if event.Kind != "shutdown" || event.Endpoint < 0 || event.Endpoint >= count {
			t.Fatalf("process must stop both listeners before returning, got %+v", event)
		}
		seen[event.Endpoint] = true
	}
	for _, address := range helper.addresses {
		connection, err := net.DialTimeout("tcp", strings.TrimPrefix(address, "http://"), time.Second)
		if connection != nil {
			_ = connection.Close()
			t.Fatalf("draining listener still accepted a fresh connection: %s", address)
		}
		if err == nil {
			t.Fatal("fresh connection unexpectedly admitted during drain")
		}
	}
}

type heldFetchResult struct {
	body string
	err  error
}

func holdHTTPFetch(t *testing.T, address string) <-chan heldFetchResult {
	t.Helper()
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DisableKeepAlives = true
	client := &http.Client{Transport: transport, Timeout: 8 * time.Second}
	t.Cleanup(transport.CloseIdleConnections)
	response, err := client.Post(address, "text/plain", strings.NewReader("drain-probe"))
	if err != nil {
		t.Fatal(err)
	}
	reader := bufio.NewReader(response.Body)
	if start, err := reader.ReadString('\n'); err != nil || start != "begin\n" {
		_ = response.Body.Close()
		t.Fatalf("request was not admitted: start=%q error=%v", start, err)
	}
	done := make(chan heldFetchResult, 1)
	go func() {
		body, err := io.ReadAll(reader)
		_ = response.Body.Close()
		done <- heldFetchResult{body: string(body), err: err}
	}()
	return done
}

func assertHTTPFetchComplete(t *testing.T, done <-chan heldFetchResult) {
	t.Helper()
	select {
	case result := <-done:
		if result.err != nil || result.body != "end\n" {
			t.Fatalf("drain truncated an admitted request: %+v", result)
		}
	case <-time.After(8 * time.Second):
		t.Fatal("admitted request did not finish after its release")
	}
}

func awaitHTTPHelperStopped(t *testing.T, helper *httpHelper) httpHelperEvent {
	t.Helper()
	event := helper.nextEvent(t)
	if event.Kind != "stopped" {
		t.Fatalf("expected stopped event, got %+v", event)
	}
	select {
	case <-helper.done:
		if helper.waitError != nil {
			t.Fatalf("HTTP helper process failed: %v", helper.waitError)
		}
	case <-time.After(8 * time.Second):
		t.Fatal("HTTP helper did not exit within its drain budget")
	}
	for _, calls := range event.Calls {
		if calls != 1 {
			t.Fatalf("request replayed or lost: calls=%v", event.Calls)
		}
	}
	if len(event.Calls) != len(helper.addresses) || len(event.Completed) != len(helper.addresses) {
		t.Fatalf("missing exact request accounting: %+v", event)
	}
	if !event.Deadline {
		for _, completed := range event.Completed {
			if !completed {
				t.Fatalf("listener lifecycle returned before a held request completed: %+v", event)
			}
		}
	}
	return event
}

func TestHTTPServersSIGTERMDrainsAllListeners(t *testing.T) {
	for _, count := range []int{1, 2} {
		t.Run(strconv.Itoa(count), func(t *testing.T) {
			helper := startHTTPHelper(t, count, false)
			public := holdHTTPFetch(t, helper.addresses[0])
			var private <-chan heldFetchResult
			if count == 2 {
				private = holdHTTPFetch(t, helper.addresses[1])
			}
			if err := helper.command.Process.Signal(syscall.SIGTERM); err != nil {
				t.Fatal(err)
			}
			helper.awaitShutdown(t, count)
			helper.send(t, "release-public")
			assertHTTPFetchComplete(t, public)
			if count == 2 {
				helper.send(t, "release-private")
				assertHTTPFetchComplete(t, private)
			}
			stopped := awaitHTTPHelperStopped(t, helper)
			if stopped.Deadline || stopped.ListenerFailure {
				t.Fatalf("graceful drain unexpectedly failed: %+v", stopped)
			}
		})
	}
}

func TestHTTPServersListenerFailureStillDrainsPeer(t *testing.T) {
	helper := startHTTPHelper(t, 2, false)
	public := holdHTTPFetch(t, helper.addresses[0])
	private := holdHTTPFetch(t, helper.addresses[1])
	helper.send(t, "close-public-listener")
	helper.awaitShutdown(t, 2)
	helper.send(t, "release-public")
	assertHTTPFetchComplete(t, public)
	helper.send(t, "release-private")
	assertHTTPFetchComplete(t, private)
	if stopped := awaitHTTPHelperStopped(t, helper); !stopped.ListenerFailure || stopped.Deadline {
		t.Fatalf("original listener failure was not preserved: %+v", stopped)
	}
}

func TestHTTPServersDrainTimeoutClosesHeldConnections(t *testing.T) {
	helper := startHTTPHelper(t, 2, true)
	public := holdHTTPFetch(t, helper.addresses[0])
	private := holdHTTPFetch(t, helper.addresses[1])
	if err := helper.command.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	helper.awaitShutdown(t, 2)
	if stopped := awaitHTTPHelperStopped(t, helper); !stopped.Deadline {
		t.Fatalf("held stream must end at the common deadline: %+v", stopped)
	}
	for _, done := range []<-chan heldFetchResult{public, private} {
		select {
		case result := <-done:
			if result.err == nil {
				t.Fatal("timed-out stream was silently returned as a clean truncated response")
			}
			if result.body == "end\n" {
				t.Fatal("unreleased stream unexpectedly completed")
			}
		case <-time.After(time.Second):
			t.Fatal("timed-out connection survived process shutdown")
		}
	}
}
