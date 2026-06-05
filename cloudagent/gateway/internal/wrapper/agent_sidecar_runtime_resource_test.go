package wrapper

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestAgentSidecarWorkerCleansStaleRuntimeResources(t *testing.T) {
	ctx := context.Background()
	store, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	expiredAt := time.Now().UTC().Add(-time.Minute).Truncate(time.Second)
	futureAt := time.Now().UTC().Add(time.Minute).Truncate(time.Second)
	for _, rec := range []RuntimeResourceRecord{
		{
			SessionID:      "session_stale",
			Generation:     1,
			RuntimeID:      "runtime_stale",
			OwnerID:        "gateway_a",
			SandboxBackend: "ags",
			State:          "failed",
			OuterSandboxID: "outer_stale",
			InnerSandboxID: "inner_stale",
			ExpiresAt:      expiredAt,
			LastError:      "outer prepare failed",
		},
		{
			SessionID:      "session_future",
			Generation:     1,
			RuntimeID:      "runtime_future",
			OwnerID:        "gateway_a",
			SandboxBackend: "ags",
			State:          "creating",
			OuterSandboxID: "outer_future",
			InnerSandboxID: "inner_future",
			ExpiresAt:      futureAt,
		},
		{
			SessionID:      "session_bound",
			Generation:     1,
			RuntimeID:      "runtime_bound",
			OwnerID:        "gateway_a",
			SandboxBackend: "ags",
			State:          "bound",
			OuterSandboxID: "outer_bound",
			InnerSandboxID: "inner_bound",
			ExpiresAt:      expiredAt,
		},
	} {
		if err := store.UpsertRuntimeResource(ctx, rec); err != nil {
			t.Fatal(err)
		}
	}

	deletes, client := newDeletingAGSTestClient(t)
	worker, err := NewAgentSidecarWorker(AgentSidecarWorkerConfig{
		Client:           client,
		OuterTemplateID:  "outer-template",
		InnerTemplateID:  "inner-template",
		SidecarURL:       "https://example.com/cloudagent-sidecar",
		TokenHubAPIKey:   "tokenhub-key",
		WorkspaceService: store,
	})
	if err != nil {
		t.Fatal(err)
	}

	if err := worker.CleanupStaleRuntimeResources(ctx, 10); err != nil {
		t.Fatal(err)
	}
	gotDeletes := deletes()
	sort.Strings(gotDeletes)
	if strings.Join(gotDeletes, ",") != "inner_stale,outer_stale" {
		t.Fatalf("unexpected sandbox deletes: %#v", gotDeletes)
	}
	cleaned, ok, err := store.LoadRuntimeResource(ctx, "session_stale", 1)
	if err != nil {
		t.Fatal(err)
	}
	if !ok || cleaned.State != "cleaned" || cleaned.OuterSandboxID != "outer_stale" || cleaned.InnerSandboxID != "inner_stale" {
		t.Fatalf("stale runtime resource not marked cleaned with identities preserved: %+v ok=%v", cleaned, ok)
	}
	future, ok, err := store.LoadRuntimeResource(ctx, "session_future", 1)
	if err != nil {
		t.Fatal(err)
	}
	if !ok || future.State != "creating" {
		t.Fatalf("future resource should remain pending, got %+v ok=%v", future, ok)
	}
	bound, ok, err := store.LoadRuntimeResource(ctx, "session_bound", 1)
	if err != nil {
		t.Fatal(err)
	}
	if !ok || bound.State != "bound" {
		t.Fatalf("bound resource should not be cleaned by stale pending sweep, got %+v ok=%v", bound, ok)
	}
}

func TestAgentSidecarWorkerCleansStaleRuntimeResourcesOnRecordedBackend(t *testing.T) {
	ctx := context.Background()
	store, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := store.UpsertRuntimeResource(ctx, RuntimeResourceRecord{
		SessionID:      "session_talos_stale",
		Generation:     1,
		RuntimeID:      "runtime_talos_stale",
		OwnerID:        "gateway_a",
		SandboxBackend: "talos",
		State:          "creating",
		OuterSandboxID: "outer_talos",
		InnerSandboxID: "inner_talos",
		ExpiresAt:      time.Now().UTC().Add(-time.Minute).Truncate(time.Second),
	}); err != nil {
		t.Fatal(err)
	}

	agsDeletes, agsClient := newDeletingAGSTestClient(t)
	talosDeletes, talosClient := newDeletingAGSTestClient(t)
	worker, err := NewAgentSidecarWorker(AgentSidecarWorkerConfig{
		Client:          agsClient,
		OuterTemplateID: "ags-outer",
		InnerTemplateID: "ags-inner",
		SidecarURL:      "https://example.com/cloudagent-sidecar",
		TokenHubAPIKey:  "tokenhub-key",
		AdditionalBackends: []AgentSidecarBackendConfig{{
			Name:            "talos",
			Client:          talosClient,
			OuterTemplateID: "talos-outer",
			InnerTemplateID: "talos-inner",
		}},
		WorkspaceService: store,
	})
	if err != nil {
		t.Fatal(err)
	}

	if err := worker.CleanupStaleRuntimeResources(ctx, 10); err != nil {
		t.Fatal(err)
	}
	if got := agsDeletes(); len(got) != 0 {
		t.Fatalf("default backend must not clean talos runtime resources, got %#v", got)
	}
	gotTalosDeletes := talosDeletes()
	sort.Strings(gotTalosDeletes)
	if strings.Join(gotTalosDeletes, ",") != "inner_talos,outer_talos" {
		t.Fatalf("talos backend did not clean recorded sandboxes: %#v", gotTalosDeletes)
	}
}

func newDeletingAGSTestClient(t *testing.T) (func() []string, *AGSClient) {
	t.Helper()
	var mu sync.Mutex
	deleted := []string{}
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete || !strings.HasPrefix(r.URL.Path, "/sandboxes/") {
			t.Fatalf("unexpected AGS request %s %s", r.Method, r.URL.Path)
		}
		id, err := url.PathUnescape(path.Base(r.URL.Path))
		if err != nil {
			t.Fatal(err)
		}
		mu.Lock()
		deleted = append(deleted, id)
		mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(api.Close)
	client, err := NewAGSClient(AGSClientConfig{
		Domain:     "ap-shanghai.tencentags.com",
		APIURL:     api.URL,
		APIKey:     "ags-key",
		HTTPClient: api.Client(),
	})
	if err != nil {
		t.Fatal(err)
	}
	return func() []string {
		mu.Lock()
		defer mu.Unlock()
		return append([]string(nil), deleted...)
	}, client
}

func TestRuntimeResourceLedgerMigrationKeepsExistingRows(t *testing.T) {
	store, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	row := store.db.QueryRow(`SELECT name FROM sqlite_master WHERE type='table' AND name='runtime_resources'`)
	var table string
	if err := row.Scan(&table); err != nil {
		t.Fatal(err)
	}
	if table != "runtime_resources" {
		t.Fatalf("runtime resource table missing: %q", table)
	}
	columns := map[string]bool{}
	rows, err := store.db.Query(`PRAGMA table_info(runtime_resources)`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var cid int
		var name, typ string
		var notNull int
		var defaultValue any
		var pk int
		if err := rows.Scan(&cid, &name, &typ, &notNull, &defaultValue, &pk); err != nil {
			t.Fatal(err)
		}
		columns[name] = true
	}
	for _, want := range []string{"session_id", "generation", "runtime_id", "owner_id", "sandbox_backend", "outer_sandbox_id", "inner_sandbox_id", "expires_at"} {
		if !columns[want] {
			encoded, _ := json.Marshal(columns)
			t.Fatalf("runtime_resources missing column %s in %s", want, encoded)
		}
	}
}
