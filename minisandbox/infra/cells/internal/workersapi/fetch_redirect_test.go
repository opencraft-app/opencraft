package workersapi

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func newRedirectBoundaryAPI(t *testing.T, handler http.Handler) *API {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	api, err := NewAPI(Config{
		RegistryURL: server.URL + "/registry",
		EngineURLs:  []string{server.URL + "/engine"}, EngineCells: []string{"actor-bj-a01"},
		EngineCellUIDs: []string{"test-cell-uid"}, EnginePoolUIDs: []string{"test-pool-uid"},
		EngineTokens: []string{"fixture-engine-capability"}, Datacenters: []string{"local-runtime-a"},
		Namespace: "private-namespace", StatelessExecutorURLs: []string{server.URL + "/executor"},
		StatelessExecutorTokens: []string{"abcdef0123456789abcdef0123456789"},
		PlacementResolver:       newStaticPlacementResolver("local-runtime-a"), PrepareTimeout: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(api.Close)
	return api
}

func TestFetchRedirectDoesNotEscapeCapabilityBoundary(t *testing.T) {
	for _, kind := range []string{"stateless", "durable"} {
		for _, status := range []int{301, 302, 303, 307, 308} {
			t.Run(fmt.Sprintf("%s/%d", kind, status), func(t *testing.T) {
				var redirected atomic.Int32
				var leaked atomic.Bool
				target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					redirected.Add(1)
					if r.Header.Get(statelessExecutorTokenHeader) != "" || r.Header.Get("Authorization") != "" ||
						r.Header.Get(internalOriginalURLHeader) != "" {
						leaked.Store(true)
					}
					w.WriteHeader(http.StatusOK)
				}))
				t.Cleanup(target.Close)
				location := target.URL + "/user-controlled"
				fake := &fakeBackends{testing: t, version: testVersionOne, active: testVersionOne,
					exports: map[string]registryExport{"Counter": {Type: "durable_object", Storage: "sqlite"}}}
				var executions atomic.Int32
				api := newRedirectBoundaryAPI(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					isFetch := strings.HasPrefix(r.URL.Path, "/engine/gateway/") ||
						(strings.HasPrefix(r.URL.Path, "/executor/") && strings.HasSuffix(r.URL.Path, "/dispatch"))
					if !isFetch {
						fake.serveHTTP(w, r)
						return
					}
					executions.Add(1)
					w.Header().Set("Location", location)
					w.Header().Set("X-Worker-Response", "preserved")
					w.WriteHeader(status)
					_, _ = io.WriteString(w, "user redirect body")
				}))
				path := "/v1/workers/counter/dispatch"
				if kind == "durable" {
					path = "/v1/workers/counter/objects/Counter/" + testObjectID + "/fetch"
				}
				request := httptest.NewRequest(http.MethodGet, path, nil)
				request.Header.Set(publicOriginalURLHeader, "https://counter.example/increment?by=1")
				response := httptest.NewRecorder()
				api.ServeHTTP(response, request)
				if redirected.Load() != 0 || leaked.Load() {
					t.Fatalf("redirect escaped: outbound=%d capability_leaked=%t", redirected.Load(), leaked.Load())
				}
				if response.Code != status || response.Header().Get("Location") != location ||
					response.Header().Get("X-Worker-Response") != "preserved" || response.Body.String() != "user redirect body" {
					t.Fatalf("user redirect was not preserved: status=%d", response.Code)
				}
				if executions.Load() != 1 {
					t.Fatalf("Worker executions=%d, want one", executions.Load())
				}
			})
		}
	}
}

func TestPrepareRedirectCannotValidateOrActivateVersion(t *testing.T) {
	for _, status := range []int{301, 302, 303, 307, 308} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			var redirected atomic.Int32
			target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				redirected.Add(1)
				w.WriteHeader(http.StatusNoContent)
			}))
			t.Cleanup(target.Close)
			fake := &fakeBackends{testing: t, version: testVersionTwo, active: testVersionOne}
			var prepares atomic.Int32
			api := newRedirectBoundaryAPI(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if strings.HasPrefix(r.URL.Path, "/executor/") && strings.HasSuffix(r.URL.Path, "/prepare") {
					prepares.Add(1)
					w.Header().Set("Location", target.URL+"/not-a-workerd-prepare")
					w.WriteHeader(status)
					return
				}
				fake.serveHTTP(w, r)
			}))
			response := performJSON(t, api, http.MethodPost, "/v1/workers/counter/deployments", CreateDeploymentRequest{
				VersionID: testVersionTwo,
			})
			if redirected.Load() != 0 || prepares.Load() != 1 || response.Code != http.StatusUnprocessableEntity {
				t.Fatalf("prepare redirect was not rejected: outbound=%d prepares=%d status=%d",
					redirected.Load(), prepares.Load(), response.Code)
			}
			var failure ErrorResponse
			decodeForTest(t, response.Body, &failure)
			if failure.Error.Code != "worker_prepare_failed" || failure.Error.Retryable {
				t.Fatalf("prepare rejection changed error contract: %#v", failure.Error)
			}
			fake.mu.Lock()
			defer fake.mu.Unlock()
			if fake.active != testVersionOne || contains(fake.events, "deployment") || fake.actorCreates != 0 {
				t.Fatal("redirected canary changed active Deployment or created a durable Actor")
			}
		})
	}
}
