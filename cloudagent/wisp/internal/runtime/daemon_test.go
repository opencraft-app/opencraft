package runtime

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"wisp/internal/config"
)

func TestClassifyError(t *testing.T) {
	tests := []struct {
		name   string
		err    error
		status int
		code   string
	}{
		{
			name:   "container not found",
			err:    errors.New("container demo not found"),
			status: http.StatusNotFound,
			code:   "container_not_found",
		},
		{
			name:   "bootstrap required",
			err:    errors.New("runtime is not bootstrapped; run bootstrap first (missing: prepared crun binary)"),
			status: http.StatusPreconditionFailed,
			code:   "bootstrap_required",
		},
		{
			name:   "runtime not running",
			err:    errors.New("runtime is not started; run start first"),
			status: http.StatusConflict,
			code:   "runtime_not_running",
		},
		{
			name:   "dependency missing",
			err:    errors.New("could not prepare crun; configure CRUN_BINARY or install crun on the host"),
			status: http.StatusFailedDependency,
			code:   "dependency_missing",
		},
		{
			name:   "bad request",
			err:    badRequest("container name is required", nil),
			status: http.StatusBadRequest,
			code:   "invalid_request",
		},
		{
			name:   "already running",
			err:    errors.New("wisp daemon already running (pid 123)"),
			status: http.StatusConflict,
			code:   "already_running",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := classifyError(tc.err)
			if got.Status != tc.status || got.Code != tc.code {
				t.Fatalf("classifyError(%q) = status=%d code=%q; want status=%d code=%q",
					tc.err, got.Status, got.Code, tc.status, tc.code)
			}
		})
	}
}

func TestNormalizeWispPath(t *testing.T) {
	tests := []struct {
		in      string
		want    string
		wantErr bool
	}{
		{in: "/tmp/demo", want: "/tmp/demo"},
		{in: "/tmp//demo/../x", wantErr: true},
		{in: "tmp/demo", wantErr: true},
		{in: "/", want: "/"},
	}

	for _, tc := range tests {
		got, err := normalizeWispPath(tc.in)
		if tc.wantErr {
			if err == nil {
				t.Fatalf("normalizeWispPath(%q) expected error", tc.in)
			}
			continue
		}
		if err != nil {
			t.Fatalf("normalizeWispPath(%q): %v", tc.in, err)
		}
		if got != tc.want {
			t.Fatalf("normalizeWispPath(%q)=%q want %q", tc.in, got, tc.want)
		}
	}
}

func TestWispResourceFromStatus(t *testing.T) {
	cold := wispResourceFromStatus("demo", RuntimeStatus{})
	if cold.State != "cold" {
		t.Fatalf("cold.State=%q", cold.State)
	}
	running := wispResourceFromStatus("demo", RuntimeStatus{Running: true})
	if running.State != "running" {
		t.Fatalf("running.State=%q", running.State)
	}
	if !running.Capabilities["exec"] || !running.Capabilities["checkpoints"] || !running.Capabilities["filesystem"] {
		t.Fatalf("capabilities=%v", running.Capabilities)
	}
}

func TestParseBoolQuery(t *testing.T) {
	for _, raw := range []string{"force=1", "force=true", "force=yes", "force=on"} {
		req := httptest.NewRequest(http.MethodPost, "/v1/wisps/demo/stop?"+raw, nil)
		if !parseBoolQuery(req, "force") {
			t.Fatalf("parseBoolQuery(%q)=false", raw)
		}
	}
	req := httptest.NewRequest(http.MethodPost, "/v1/wisps/demo/stop?force=0", nil)
	if parseBoolQuery(req, "force") {
		t.Fatal("force=0 should be false")
	}
}

func TestDaemonWispLockIsolation(t *testing.T) {
	d := NewDaemon(&Runtime{})

	unlockA := d.lockWisp("a")
	defer unlockA()

	aLocked := make(chan struct{})
	go func() {
		unlock := d.lockWisp("a")
		close(aLocked)
		unlock()
	}()

	select {
	case <-aLocked:
		t.Fatal("same wisp lock should block")
	case <-time.After(50 * time.Millisecond):
	}

	bLocked := make(chan struct{})
	go func() {
		unlock := d.lockWisp("b")
		close(bLocked)
		unlock()
	}()

	select {
	case <-bLocked:
	case <-time.After(time.Second):
		t.Fatal("different wisp lock should not block")
	}
}

func TestRuntimeStatusIncludesRemoteBackend(t *testing.T) {
	rt := New(config.Config{
		WispName:        "demo",
		RemoteBackend:   "smh",
		AdminSocketPath: "/tmp/admin.sock",
		AdminListenAddr: "127.0.0.1:18527",
		EnvSocketPath:   "/.wisp/api.sock",
		JFSRoot:         "/mnt/mock",
	})
	status := rt.runtimeStatus(context.Background())
	if status.RemoteBackend != "smh" {
		t.Fatalf("RemoteBackend=%q", status.RemoteBackend)
	}
}
