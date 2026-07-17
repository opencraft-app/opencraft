package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"git.woa.com/wisp/mono2/llmgateway/internal/gateway"
)

func TestAdminSetUpgradeCreateAndGet(t *testing.T) {
	store := gateway.NewMemoryStore()
	if err := store.SaveSet(t.Context(), gateway.Set{
		ID: "set-a", Status: gateway.SetStatusActive, ActiveRuntimeGeneration: 12, RouteRevision: 20,
	}); err != nil {
		t.Fatal(err)
	}
	svc := gateway.NewService(store, nil, gateway.Options{})
	handler := NewServer(svc, Config{AdminToken: "cluster-token"})
	body := `{"set_ids":["set-a"],"target_image":"example.com/new-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","drain_timeout_seconds":15,"rollback_window_seconds":10}`
	req := httptest.NewRequest(http.MethodPost, "/api/admin/set-upgrades", bytes.NewBufferString(body))
	req.Header.Set("Authorization", "Bearer cluster-token")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("create status=%d body=%s", rec.Code, rec.Body.String())
	}
	var created struct {
		Success bool                    `json:"success"`
		Data    gateway.SetUpgradeBatch `json:"data"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&created); err != nil {
		t.Fatal(err)
	}
	if !created.Success || len(created.Data.Runs) != 1 {
		t.Fatalf("created response=%+v", created)
	}

	getReq := httptest.NewRequest(http.MethodGet, "/api/admin/set-upgrades/"+created.Data.ID, nil)
	getReq.Header.Set("Authorization", "Bearer cluster-token")
	getRec := httptest.NewRecorder()
	handler.ServeHTTP(getRec, getReq)
	if getRec.Code != http.StatusOK || !bytes.Contains(getRec.Body.Bytes(), []byte(`"to_generation":13`)) {
		t.Fatalf("get status=%d body=%s", getRec.Code, getRec.Body.String())
	}
}

func TestAdminSetUpgradeRejectsUnpinnedImage(t *testing.T) {
	store := gateway.NewMemoryStore()
	if err := store.SaveSet(t.Context(), gateway.Set{ID: "set-a", Status: gateway.SetStatusActive}); err != nil {
		t.Fatal(err)
	}
	handler := NewServer(gateway.NewService(store, nil, gateway.Options{}), Config{AdminToken: "cluster-token"})
	req := httptest.NewRequest(http.MethodPost, "/api/admin/set-upgrades", bytes.NewBufferString(`{"set_ids":["set-a"],"target_image":"new-api:latest"}`))
	req.Header.Set("Authorization", "Bearer cluster-token")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestAdminSetUpgradeEndpointsRequireAdmin(t *testing.T) {
	handler := NewServer(gateway.NewService(gateway.NewMemoryStore(), nil, gateway.Options{}), Config{AdminToken: "cluster-token"})
	req := httptest.NewRequest(http.MethodGet, "/api/admin/set-upgrades/missing", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d, want 401", rec.Code)
	}
}

func TestInternalSetUpgradeWorkflowClaimsProbesAndSwitches(t *testing.T) {
	store := gateway.NewMemoryStore()
	if err := store.SaveSet(t.Context(), gateway.Set{
		ID: "set-a", Status: gateway.SetStatusActive, ActiveRuntimeGeneration: 12, RouteRevision: 20,
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveSetRuntime(t.Context(), gateway.SetRuntime{
		SetID: "set-a", Generation: 12,
		Image:          "old@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		TrafficBaseURL: "http://set-a-g12:3000", Status: gateway.SetRuntimeStatusActive,
	}); err != nil {
		t.Fatal(err)
	}
	cache := gateway.NewMemoryAPIKeyRouteCache(0, 10)
	svc := gateway.NewService(store, nil, gateway.Options{KeyRouteCache: cache})
	batch, err := svc.CreateSetUpgradeBatch(t.Context(), gateway.CreateSetUpgradeBatchInput{
		SetIDs: []string{"set-a"}, TargetImage: "example.com/new-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	})
	if err != nil {
		t.Fatal(err)
	}
	runID := batch.Runs[0].ID
	handler := NewServer(svc, Config{InternalToken: "internal-token"})
	post := func(path, body string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(http.MethodPost, path, bytes.NewBufferString(body))
		req.Header.Set("Authorization", "Bearer internal-token")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		return rec
	}

	claim := post("/api/internal/set-manager/set-upgrade-runs/"+runID+"/claim", `{"owner":"manager-a","lease_seconds":600}`)
	if claim.Code != http.StatusOK {
		t.Fatalf("claim status=%d body=%s", claim.Code, claim.Body.String())
	}
	precheck := post("/api/internal/set-manager/set-upgrade-runs/"+runID+"/precheck-complete", `{"owner":"manager-a","success":true,"summary":"expand-compatible"}`)
	if precheck.Code != http.StatusNotFound {
		t.Fatalf("removed precheck endpoint status=%d body=%s", precheck.Code, precheck.Body.String())
	}
	master := post("/api/internal/set-manager/set-upgrade-runs/"+runID+"/master-complete", `{"owner":"manager-a","success":true}`)
	if master.Code != http.StatusOK {
		t.Fatalf("master status=%d body=%s", master.Code, master.Body.String())
	}
	compatibility := post("/api/internal/set-manager/set-upgrade-runs/"+runID+"/compatibility-complete", `{"owner":"manager-a","success":true}`)
	if compatibility.Code != http.StatusOK {
		t.Fatalf("compatibility status=%d body=%s", compatibility.Code, compatibility.Body.String())
	}
	prepare := post("/api/internal/set-manager/set-upgrade-runs/"+runID+"/candidate", `{"owner":"manager-a","traffic_base_url":"http://set-a-g13:3000"}`)
	if prepare.Code != http.StatusOK {
		t.Fatalf("prepare status=%d body=%s", prepare.Code, prepare.Body.String())
	}
	for i := 0; i < 3; i++ {
		probe := post("/api/internal/set-manager/set-upgrade-runs/"+runID+"/probe", `{"owner":"manager-a","success":true}`)
		if probe.Code != http.StatusOK {
			t.Fatalf("probe %d status=%d body=%s", i+1, probe.Code, probe.Body.String())
		}
	}
	switchRec := post("/api/internal/set-manager/set-upgrade-runs/"+runID+"/switch", `{"owner":"manager-a"}`)
	if switchRec.Code != http.StatusOK {
		t.Fatalf("switch status=%d body=%s", switchRec.Code, switchRec.Body.String())
	}
	runtime, ok, err := cache.GetSetRuntime(t.Context(), "set-a")
	if err != nil || !ok || runtime.RouteRevision != 21 || runtime.RuntimeGeneration != 13 {
		t.Fatalf("runtime=%+v ok=%v err=%v", runtime, ok, err)
	}
	run, _, _ := svc.GetSetUpgradeRun(t.Context(), runID)
	if run.Status != gateway.SetUpgradeRunStatusDraining {
		t.Fatalf("run status=%q, want draining", run.Status)
	}
}
