package workersapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// The deployment watch logs concurrently with requests. Capture complete writes
// without racing the logger or relying on timing to observe its first failure.
type diagnosticLogBuffer struct {
	mu      sync.Mutex
	buffer  bytes.Buffer
	written chan struct{}
}

func (logs *diagnosticLogBuffer) Write(data []byte) (int, error) {
	logs.mu.Lock()
	defer logs.mu.Unlock()
	n, err := logs.buffer.Write(data)
	select {
	case logs.written <- struct{}{}:
	default:
	}
	return n, err
}

func (logs *diagnosticLogBuffer) String() string {
	logs.mu.Lock()
	defer logs.mu.Unlock()
	return logs.buffer.String()
}

func captureDiagnosticLogs(t *testing.T) *diagnosticLogBuffer {
	t.Helper()
	logs := &diagnosticLogBuffer{written: make(chan struct{}, 1)}
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(logs, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })
	return logs
}

func diagnosticTestAPI(t *testing.T, handler http.Handler) *API {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	api, err := NewAPI(Config{
		RegistryURL:             server.URL + "/registry",
		EngineURLs:              []string{server.URL + "/engine"},
		EngineCells:             []string{"actor-bj-a01"},
		EngineCellUIDs:          []string{"test-cell-uid"},
		EnginePoolUIDs:          []string{"test-pool-uid"},
		Datacenters:             []string{"local-runtime-a"},
		Namespace:               "private-namespace",
		InternalToken:           "private-service-token",
		StatelessExecutorURLs:   []string{server.URL + "/executor"},
		StatelessExecutorTokens: []string{"private-executor-token"},
		PrepareTimeout:          time.Second,
		PlacementResolver:       newStaticPlacementResolver("local-runtime-a"),
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(api.Close)
	return api
}

func assertDiagnosticRecord(t *testing.T, logs *diagnosticLogBuffer, message, class string) {
	t.Helper()
	found := false
	for _, line := range strings.Split(strings.TrimSpace(logs.String()), "\n") {
		var record map[string]any
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			t.Fatal(err)
		}
		if record["msg"] == message {
			found = true
			if record["error"] != class {
				t.Fatalf("error class = %v, want %s", record["error"], class)
			}
			if (strings.Contains(message, "transport failed") || strings.Contains(message, "stream failed")) && record["request_id"] != "diagnostic-regression" {
				t.Fatal("fetch diagnostic lost request correlation")
			}
		}
	}
	if !found {
		t.Fatalf("missing diagnostic %q", message)
	}
	for _, forbidden := range []string{
		"http://", "https://", "/gateway/", "/internal/v1/", testVersionOne,
		"private-body", "private-query", "private-header", "private-response",
		"private-service-token", "private-executor-token", "private-code", "private-message",
		"Authorization", "Bearer ",
	} {
		if strings.Contains(logs.String(), forbidden) {
			t.Fatalf("diagnostic exposes %q", forbidden)
		}
	}
}

func TestFetchFailureDiagnosticsAreSanitizedWithoutReplay(t *testing.T) {
	for _, kind := range []string{"stateless", "durable"} {
		for _, truncated := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/truncated=%t", kind, truncated), func(t *testing.T) {
				logs := captureDiagnosticLogs(t)
				fake := &fakeBackends{testing: t, version: testVersionOne, active: testVersionOne,
					exports: map[string]registryExport{"Counter": {Type: "durable_object", Storage: "sqlite"}}}
				var executions atomic.Int32
				api := diagnosticTestAPI(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					isFetch := strings.HasPrefix(r.URL.Path, "/engine/gateway/") ||
						(strings.HasPrefix(r.URL.Path, "/executor/") && strings.HasSuffix(r.URL.Path, "/dispatch"))
					if !isFetch {
						fake.serveHTTP(w, r)
						return
					}
					executions.Add(1)
					body, err := io.ReadAll(r.Body)
					if err != nil || string(body) != "private-body" || r.Method != http.MethodPost {
						t.Error("upstream did not receive the original POST body")
					}
					if r.Header.Get(internalOriginalURLHeader) != "https://counter.example/private-query" {
						t.Error("upstream lost the original URL")
					}
					connection, buffered, err := w.(http.Hijacker).Hijack()
					if err != nil {
						t.Error(err)
						return
					}
					defer connection.Close()
					if truncated {
						if _, err := buffered.WriteString("HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nprivate-response"); err != nil {
							t.Error(err)
						}
						if err := buffered.Flush(); err != nil {
							t.Error(err)
						}
					}
				}))
				path, message := "/v1/workers/counter/dispatch", "stateless Worker"
				if kind == "durable" {
					path, message = "/v1/workers/counter/objects/Counter/"+testObjectID+"/fetch", "Worker"
				}
				request := httptest.NewRequest(http.MethodPost, path, strings.NewReader("private-body"))
				request.Header.Set(publicOriginalURLHeader, "https://counter.example/private-query")
				request.Header.Set("X-Private-Test", "private-header")
				request.Header.Set("X-Request-ID", "diagnostic-regression")
				response := httptest.NewRecorder()
				var recovered any
				func() {
					defer func() { recovered = recover() }()
					api.ServeHTTP(response, request)
				}()
				if executions.Load() != 1 {
					t.Fatalf("POST executions = %d, want one", executions.Load())
				}
				if truncated {
					if recovered != http.ErrAbortHandler || response.Code != http.StatusOK || response.Body.String() != "private-response" {
						t.Fatal("truncated response did not preserve the partial body and abort")
					}
					message += " response stream failed"
				} else {
					if recovered != nil || response.Code != http.StatusBadGateway {
						t.Fatalf("unexpected disconnect result: panic=%v status=%d", recovered, response.Code)
					}
					var failure ErrorResponse
					decodeForTest(t, response.Body, &failure)
					if failure.Error.Code != "indeterminate_result" || failure.Error.Retryable {
						t.Fatalf("changed uncertain-result semantics: %#v", failure)
					}
					if kind == "durable" {
						message += " fetch"
					}
					message += " transport failed"
				}
				assertDiagnosticRecord(t, logs, message, "eof")
			})
		}
	}
}

func TestCleanupDiagnosticsDoNotExposeUpstreamMessageOrCode(t *testing.T) {
	for _, rejected := range []bool{false, true} {
		t.Run(fmt.Sprintf("rejected-activation=%t", rejected), func(t *testing.T) {
			logs := captureDiagnosticLogs(t)
			fake := &fakeBackends{testing: t, version: testVersionOne, active: testVersionOne,
				exports: map[string]registryExport{"Counter": {Type: "durable_object", Storage: "sqlite"}}}
			var deletes atomic.Int32
			api := diagnosticTestAPI(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if strings.HasPrefix(r.URL.Path, "/engine/actors/") && r.Method == http.MethodDelete {
					deletes.Add(1)
					writeJSON(w, 503, registryErrorEnvelope{Code: "private-code", Message: "private-message https://private-query"})
					return
				}
				if rejected && strings.HasSuffix(r.URL.Path, "/activate") {
					writeJSON(w, 409, registryErrorEnvelope{Code: "private-code", Message: "private-message"})
					return
				}
				fake.serveHTTP(w, r)
			}))
			message := "delete Worker prepare Actor"
			if rejected {
				_, failure := api.ensureActor(context.Background(), "counter", "Counter", testObjectID)
				if failure == nil {
					t.Fatal("activation unexpectedly succeeded")
				}
				message = "delete rejected Durable Object Actor"
			} else {
				failure := api.prepareEntrypoint(context.Background(), "diagnostic-regression", "counter", testVersionOne, "Counter", 0)
				if failure == nil || failure.Code != "prepare_cleanup_failed" {
					t.Fatalf("lost cleanup failure: %v", failure)
				}
			}
			if deletes.Load() != 1 {
				t.Fatalf("cleanup attempts=%d, want one", deletes.Load())
			}
			assertDiagnosticRecord(t, logs, message, "upstream_error")
		})
	}
}

func TestWatchDiagnosticsDoNotExposeUpstreamMessageOrCode(t *testing.T) {
	logs := captureDiagnosticLogs(t)
	fake := &fakeBackends{testing: t, version: testVersionOne, active: testVersionOne}
	api := diagnosticTestAPI(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/deployment-cursor") {
			writeJSON(w, 503, registryErrorEnvelope{Code: "private-code", Message: "private-message"})
			return
		}
		fake.serveHTTP(w, r)
	}))
	api.startDeploymentWatcher()
	select {
	case <-logs.written:
	case <-time.After(time.Second):
		t.Fatal("deployment watch did not report the real HTTP failure")
	}
	api.Close()
	assertDiagnosticRecord(t, logs, "Worker deployment watch unavailable", "upstream_error")
}

func TestPlacementDiagnosticsDoNotExposeWrappedMessages(t *testing.T) {
	logs := captureDiagnosticLogs(t)
	failure := placementUpstreamError(fmt.Errorf("private-message https://private-query: %w", ErrNoAdmissionCapacity))
	if failure.Code != "no_admission_capacity" || !failure.Retryable {
		t.Fatal("changed placement failure semantics")
	}
	assertDiagnosticRecord(t, logs, "Agent placement unavailable", "no_admission_capacity")
}
