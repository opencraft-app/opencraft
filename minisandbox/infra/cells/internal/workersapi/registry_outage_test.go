package workersapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/rivet-dev/rivet/infra/cells/internal/workerregistry"
)

func TestRegistryOutageKeepsCachedObjectServingAndMissesFenced(t *testing.T) {
	for _, fault := range []string{"http_503", "tcp_disconnect"} {
		t.Run(fault, func(t *testing.T) {
			store, err := workerregistry.NewStore(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			ctx := context.Background()
			_, _, err = store.PutWorker(ctx, "private-namespace", "counter", workerregistry.PutWorkerRequest{
				MainModule: "main.js", CompatibilityDate: "2026-08-14",
				Modules:        map[string]string{"main.js": "export class Counter { fetch() { return new Response('ok') } }"},
				DurableObjects: map[string]string{"COUNTERS": "Counter"},
			})
			if err != nil {
				t.Fatal(err)
			}
			registryAPI := workerregistry.NewAPI(store, workerregistry.DefaultMaxRequestBytes)
			var unavailable atomic.Bool
			var registryCalls atomic.Int64
			registry := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				registryCalls.Add(1)
				if unavailable.Load() {
					if fault == "tcp_disconnect" {
						connection, _, hijackErr := w.(http.Hijacker).Hijack()
						if hijackErr != nil {
							t.Error(hijackErr)
							return
						}
						_ = connection.Close()
						return
					}
					writeJSON(w, http.StatusServiceUnavailable, registryErrorEnvelope{Code: "storage_error", Message: "unavailable"})
					return
				}
				registryAPI.ServeHTTP(w, r)
			}))
			t.Cleanup(registry.Close)
			var engineCreates atomic.Int64
			var engineFetches atomic.Int64
			engine := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch {
				case r.Method == http.MethodPut && r.URL.Path == "/actors":
					var input struct {
						Key string `json:"key"`
					}
					if err := json.NewDecoder(r.Body).Decode(&input); err != nil || len(input.Key) != 64 {
						t.Error("invalid Actor create request")
						w.WriteHeader(http.StatusBadRequest)
						return
					}
					engineCreates.Add(1)
					writeJSON(w, http.StatusOK, actorCreateResponse{Actor: actorState{ActorID: "actor-" + input.Key[:16]}})
				case strings.HasPrefix(r.URL.Path, "/gateway/"):
					engineFetches.Add(1)
					writeJSON(w, http.StatusOK, map[string]string{"actor": strings.Trim(strings.TrimPrefix(r.URL.Path, "/gateway/"), "/")})
				default:
					t.Errorf("unexpected Engine method/path: %s %s", r.Method, r.URL.Path)
					w.WriteHeader(http.StatusNotFound)
				}
			}))
			t.Cleanup(engine.Close)
			newReplica := func() *httptest.Server {
				api, err := NewAPI(Config{
					RegistryURL: registry.URL, EngineURLs: []string{engine.URL}, EngineCells: []string{"actor-bj-a01"},
					EngineCellUIDs: []string{"test-cell-uid"}, EnginePoolUIDs: []string{"test-pool-uid"},
					Datacenters: []string{"local-runtime-a"}, Namespace: "private-namespace",
					PlacementResolver:  newStaticPlacementResolver("local-runtime-a"),
					ActorCacheCapacity: 1, ActorCacheIdleTTL: time.Hour,
				})
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(api.Close)
				server := httptest.NewServer(api)
				t.Cleanup(server.Close)
				return server
			}
			warm := newReplica()
			fetch := func(server *httptest.Server, object string, want int) {
				t.Helper()
				request, err := http.NewRequest(http.MethodPost, server.URL+"/v1/workers/counter/objects/Counter/"+object+"/fetch", strings.NewReader("payload"))
				if err != nil {
					t.Fatal(err)
				}
				request.Header.Set(publicOriginalURLHeader, "https://counter.example/increment?by=1")
				response, err := server.Client().Do(request)
				if err != nil {
					t.Fatal(err)
				}
				defer response.Body.Close()
				if response.StatusCode != want {
					t.Fatalf("Object response=%d, want %d", response.StatusCode, want)
				}
				if want == http.StatusOK {
					var body map[string]string
					if err := json.NewDecoder(response.Body).Decode(&body); err != nil || body["actor"] != "actor-"+object[:16] {
						t.Fatal("Object was routed to the wrong Actor")
					}
					return
				}
				var body ErrorResponse
				if err := json.NewDecoder(response.Body).Decode(&body); err != nil || !body.Error.Retryable || body.Error.Code != "upstream_unavailable" {
					t.Fatal("Registry miss did not preserve a retryable public error")
				}
			}
			first, cached := testObjectID, strings.Repeat("b", 64)
			fetch(warm, first, http.StatusOK)
			fetch(warm, cached, http.StatusOK) // Capacity one deterministically evicts first.
			before, err := store.GetObject(ctx, "private-namespace", "counter", "Counter", first)
			if err != nil {
				t.Fatal(err)
			}
			callsBefore := registryCalls.Load()
			unavailable.Store(true)
			fetch(warm, cached, http.StatusOK)
			if registryCalls.Load() != callsBefore {
				t.Fatal("cached Object fetch contacted unavailable Registry")
			}
			response, err := warm.Client().Get(warm.URL + "/readyz")
			if err != nil {
				t.Fatal(err)
			}
			_, _ = io.Copy(io.Discard, response.Body)
			_ = response.Body.Close()
			if response.StatusCode != http.StatusOK || registryCalls.Load() != callsBefore {
				t.Errorf("shared Registry fault withdrew ready API: status=%d", response.StatusCode)
			}
			fetch(warm, first, http.StatusServiceUnavailable)
			fetch(newReplica(), cached, http.StatusServiceUnavailable)
			newObject := strings.Repeat("c", 64)
			fetch(warm, newObject, http.StatusServiceUnavailable)
			if _, err := store.GetObject(ctx, "private-namespace", "counter", "Counter", newObject); !errors.Is(err, workerregistry.ErrNotFound) {
				t.Fatal("Registry outage created a new durable Object record")
			}
			if engineCreates.Load() != 2 || engineFetches.Load() != 3 {
				t.Fatal("failed placement miss reached Engine or created another Actor")
			}
			unavailable.Store(false)
			fetch(warm, first, http.StatusOK)
			after, err := store.GetObject(ctx, "private-namespace", "counter", "Counter", first)
			if err != nil || !reflect.DeepEqual(before, after) || engineCreates.Load() != 2 {
				t.Fatal("recovery changed durable placement or Actor identity")
			}
			count, err := store.GetCellPlacementCount(ctx, "actor-bj-a01", "test-cell-uid")
			if err != nil || count != 2 {
				t.Fatal("failed miss or recovery changed placement accounting")
			}
		})
	}
}
