package runtime

import (
	"context"
	"io"
	"net"
	"net/http"
	"sync/atomic"
	"testing"
	"time"

	"git.woa.com/wisp/mono2/llmgateway/internal/lifecycle"
)

func TestServeDrainsReadinessAndWaitsForInFlightRequest(t *testing.T) {
	state := lifecycle.NewState()
	started := make(chan struct{})
	release := make(chan struct{})
	var closed atomic.Bool

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/readyz":
			if state.IsDraining() {
				http.Error(w, "draining", http.StatusServiceUnavailable)
				return
			}
			_, _ = w.Write([]byte("ready"))
		case "/slow":
			close(started)
			<-release
			_, _ = w.Write([]byte("done"))
		default:
			http.NotFound(w, r)
		}
	})

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan error, 1)
	go func() {
		done <- Serve(ctx, &http.Server{Handler: handler}, listener, state, Options{
			DrainWait:       500 * time.Millisecond,
			ShutdownTimeout: 2 * time.Second,
			Close: func() error {
				closed.Store(true)
				return nil
			},
		})
	}()

	client := &http.Client{Timeout: 2 * time.Second}
	baseURL := "http://" + listener.Addr().String()
	slowDone := make(chan string, 1)
	go func() {
		resp, err := client.Get(baseURL + "/slow")
		if err != nil {
			slowDone <- err.Error()
			return
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		slowDone <- string(body)
	}()

	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("slow request did not reach server")
	}

	cancel()
	waitForStatus(t, client, baseURL+"/readyz", http.StatusServiceUnavailable)

	select {
	case err := <-done:
		t.Fatalf("server exited before in-flight request completed: %v", err)
	case <-time.After(50 * time.Millisecond):
	}

	close(release)
	if body := <-slowDone; body != "done" {
		t.Fatalf("slow body = %q, want done", body)
	}
	if err := <-done; err != nil {
		t.Fatalf("serve returned error: %v", err)
	}
	if !closed.Load() {
		t.Fatal("close hook was not called")
	}
}

func waitForStatus(t *testing.T, client *http.Client, endpoint string, status int) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		resp, err := client.Get(endpoint)
		if err == nil {
			_, _ = io.Copy(io.Discard, resp.Body)
			_ = resp.Body.Close()
			if resp.StatusCode == status {
				return
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("%s did not return status %d", endpoint, status)
}
