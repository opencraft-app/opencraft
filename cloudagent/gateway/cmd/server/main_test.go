package main

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestGatewayServerDrainsOnSIGTERM(t *testing.T) {
	if os.Getenv("CLOUDAGENT_GATEWAY_HELPER_PROCESS") == "1" {
		main()
		return
	}

	port := pickTestPort(t)
	addr := "127.0.0.1:" + port
	cmd := exec.Command(os.Args[0], "-test.run=TestGatewayServerDrainsOnSIGTERM", "--")
	cmd.Env = append(os.Environ(),
		"CLOUDAGENT_GATEWAY_HELPER_PROCESS=1",
		"GATEWAY_ADDR="+addr,
		"GATEWAY_DATA_DIR="+t.TempDir(),
		"GATEWAY_WORKER_MODE=fake",
		"GATEWAY_DRAIN_DELAY_SECONDS=2",
		"GATEWAY_SHUTDOWN_TIMEOUT_SECONDS=5",
	)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
			_, _ = cmd.Process.Wait()
		}
	})
	logsCh := make(chan string, 1)
	go func() {
		out, _ := io.ReadAll(io.MultiReader(stdout, stderr))
		logsCh <- string(out)
	}()

	waitHTTPStatus(t, "http://"+addr+"/readyz", http.StatusOK, 5*time.Second)
	if err := cmd.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatalf("send SIGTERM: %v", err)
	}
	waitHTTPStatus(t, "http://"+addr+"/readyz", http.StatusServiceUnavailable, 2*time.Second)
	waitHTTPStatus(t, "http://"+addr+"/healthz", http.StatusOK, 2*time.Second)

	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("server did not exit cleanly after drain: %v logs=%s", err, <-logsCh)
		}
	case <-time.After(8 * time.Second):
		t.Fatalf("server did not exit after SIGTERM")
	}
	logs := <-logsCh
	if !strings.Contains(logs, "gateway.draining") {
		t.Fatalf("drain log missing gateway.draining in logs:\n%s", logs)
	}
}

func pickTestPort(t *testing.T) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	return fmt.Sprint(listener.Addr().(*net.TCPAddr).Port)
}

func waitHTTPStatus(t *testing.T, rawURL string, want int, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	var last string
	for time.Now().Before(deadline) {
		ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
		if err != nil {
			cancel()
			t.Fatal(err)
		}
		resp, err := http.DefaultClient.Do(req)
		if err == nil {
			body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
			_ = resp.Body.Close()
			last = fmt.Sprintf("status=%d body=%s", resp.StatusCode, string(body))
			cancel()
			if resp.StatusCode == want {
				return
			}
		} else {
			last = err.Error()
			cancel()
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s status=%d last=%s", rawURL, want, last)
}
