package gateway

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRecordSetReconcileFactsDoesNotRegisterSet(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})

	result, err := svc.RecordSetReconcileFacts(t.Context(), RecordSetReconcileFactsInput{
		Source:    "kro",
		Namespace: "llmgateway-kro-demo",
		Fleet:     "fleet-demo",
		Sets: []SetReconcileFactInput{
			{SetID: "set-a", Name: "Set A", BaseURL: "http://fleet-demo-set-a-newapi:3000", ShardRef: "shard-a"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Recorded != 1 {
		t.Fatalf("recorded = %d, want 1", result.Recorded)
	}

	sets, err := svc.ListSets(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if len(sets) != 0 {
		t.Fatalf("recording facts should not register sets, got %+v", sets)
	}

	facts, err := store.ListSetReconcileFacts(t.Context(), SetReconcileFactListOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(facts) != 1 || facts[0].Status != SetReconcileStatusPending {
		t.Fatalf("unexpected facts: %+v", facts)
	}
}

func TestReconcileSetFactsDoesNotReactivateDrainingSet(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	mustSaveSet(t, store, Set{
		ID: "set-a", BaseURL: "http://set-a.internal", Status: SetStatusDraining,
		LifecycleGeneration: 7,
	})
	if err := store.SaveSetReconcileFact(t.Context(), SetReconcileFact{
		Source: "prod", Namespace: "llmgateway", Fleet: "prod", SetID: "set-a",
		Name: "set-a", BaseURL: "http://set-a.internal", Status: SetReconcileStatusPending,
	}); err != nil {
		t.Fatal(err)
	}

	result, err := svc.ReconcileSetReconcileFacts(t.Context(), ReconcileSetReconcileFactsInput{
		Source: "prod", Namespace: "llmgateway", Fleet: "prod",
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Managed != 1 || result.Failed != 0 {
		t.Fatalf("reconcile result = %+v", result)
	}
	set, ok, err := store.GetSet(t.Context(), "set-a")
	if err != nil || !ok {
		t.Fatalf("set lookup ok=%v err=%v", ok, err)
	}
	if set.Status != SetStatusDraining || set.LifecycleGeneration != 7 {
		t.Fatalf("draining lifecycle was overwritten: %+v", set)
	}
}

func TestRecordSetReconcileFactsRejectsDuplicateRuntimeLease(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	_, err := svc.RecordSetReconcileFacts(t.Context(), RecordSetReconcileFactsInput{
		Source:    "prod",
		Namespace: "llmgateway",
		Fleet:     "prod",
		Sets: []SetReconcileFactInput{{
			SetID:        "set-a",
			Name:         "Set A",
			BaseURL:      "http://prod-set-a-newapi:3000",
			ShardRef:     "shard-a",
			DatabaseName: "newapi_set_a",
			RedisDB:      "12",
		}},
	})
	if err != nil {
		t.Fatal(err)
	}

	_, err = svc.RecordSetReconcileFacts(t.Context(), RecordSetReconcileFactsInput{
		Source:    "prod",
		Namespace: "llmgateway",
		Fleet:     "prod",
		Sets: []SetReconcileFactInput{{
			SetID:        "set-b",
			Name:         "Set B",
			BaseURL:      "http://prod-set-b-newapi:3000",
			ShardRef:     "shard-a",
			DatabaseName: "newapi_set_b",
			RedisDB:      "12",
		}},
	})
	if err == nil {
		t.Fatal("expected duplicate redis db from set fact to fail")
	}
	if got := err.Error(); got != `redis db 12 on shard shard-a is already leased by set set-a` {
		t.Fatalf("error = %q", got)
	}
}

func TestReconcileSetReconcileFactsRegistersAndBootstrapsPendingSet(t *testing.T) {
	upstream := newBootstrapTestServer(t)
	defer upstream.Close()

	store := NewMemoryStore()
	svc := NewService(store, nil, Options{RootUsername: "set-root", RootPassword: "test-local-password"})
	if _, err := svc.RecordSetReconcileFacts(t.Context(), RecordSetReconcileFactsInput{
		Source:    "kro",
		Namespace: "llmgateway-kro-demo",
		Fleet:     "fleet-demo",
		Sets: []SetReconcileFactInput{
			{SetID: "set-a", Name: "Set A", BaseURL: upstream.URL, ShardRef: "shard-a"},
		},
	}); err != nil {
		t.Fatal(err)
	}

	result, err := svc.ReconcileSetReconcileFacts(t.Context(), ReconcileSetReconcileFactsInput{})
	if err != nil {
		t.Fatal(err)
	}
	if result.Managed != 1 || result.Failed != 0 {
		t.Fatalf("unexpected reconcile result: %+v", result)
	}

	set, ok, err := store.GetSet(t.Context(), "set-a")
	if err != nil || !ok {
		t.Fatalf("set not saved: ok=%v err=%v", ok, err)
	}
	if !set.Setup || set.AdminAccessToken != "set-admin-token" {
		t.Fatalf("unexpected managed set: %+v", set)
	}

	fact, ok, err := store.GetSetReconcileFact(t.Context(), "kro", "llmgateway-kro-demo", "fleet-demo", "set-a")
	if err != nil || !ok {
		t.Fatalf("fact not saved: ok=%v err=%v", ok, err)
	}
	if fact.Status != SetReconcileStatusManaged || fact.LastError != "" || fact.LastReconciledAt.IsZero() {
		t.Fatalf("unexpected reconciled fact: %+v", fact)
	}
}

func TestReconcileSetFactsInitializesGenerationOneRuntimeRoute(t *testing.T) {
	upstream := newBootstrapTestServer(t)
	defer upstream.Close()

	store := NewMemoryStore()
	routeCache := NewMemoryAPIKeyRouteCache(0, 100)
	svc := NewService(store, nil, Options{
		RootUsername: "set-root", RootPassword: "test-local-password", KeyRouteCache: routeCache,
	})
	image := "registry/new-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	if _, err := svc.RecordSetReconcileFacts(t.Context(), RecordSetReconcileFactsInput{
		Source: "kro", Namespace: "llmgateway-kro-demo", Fleet: "fleet-demo",
		Sets: []SetReconcileFactInput{{
			SetID: "set-a", Name: "Set A", BaseURL: upstream.URL,
			TrafficBaseURL:    "http://fleet-demo-set-a-g1-newapi-traffic:3000",
			RuntimeGeneration: 1, RuntimeImage: image, ShardRef: "shard-a",
		}},
	}); err != nil {
		t.Fatal(err)
	}
	result, err := svc.ReconcileSetReconcileFacts(t.Context(), ReconcileSetReconcileFactsInput{})
	if err != nil || result.Managed != 1 {
		t.Fatalf("result=%+v err=%v", result, err)
	}
	set, ok, err := store.GetSet(t.Context(), "set-a")
	if err != nil || !ok || set.ActiveRuntimeGeneration != 1 || set.RouteRevision != 1 {
		t.Fatalf("set=%+v ok=%v err=%v", set, ok, err)
	}
	runtime, ok, err := store.GetSetRuntime(t.Context(), "set-a", 1)
	if err != nil || !ok || runtime.Image != image || runtime.Status != SetRuntimeStatusActive {
		t.Fatalf("runtime=%+v ok=%v err=%v", runtime, ok, err)
	}
	route, ok, err := routeCache.GetSetRuntime(t.Context(), "set-a")
	if err != nil || !ok || route.RuntimeGeneration != 1 || route.RouteRevision != 1 {
		t.Fatalf("route=%+v ok=%v err=%v", route, ok, err)
	}
}

func TestReconcileSetReconcileFactsAppliesExistingBundlesToNewManagedSet(t *testing.T) {
	var optionKeys []string
	var channelCreated bool
	var channelUpdated bool
	upstream := newAutoManagedSetTestServer(t, &optionKeys, &channelCreated, &channelUpdated)
	defer upstream.Close()

	store := NewMemoryStore()
	svc := NewService(store, upstream.Client().Transport, Options{RootUsername: "set-root", RootPassword: "test-local-password"})
	if _, err := svc.UpsertChannelBundle(t.Context(), ChannelBundle{
		ID:   "golden",
		Name: "Golden config",
		Spec: ChannelBundleSpec{
			Options: []ChannelBundleOption{
				{Key: "ModelRatio", Value: `{"auto":1,"llmgw-mock-chat":1}`},
				{Key: "CompletionRatio", Value: `{"auto":1,"llmgw-mock-chat":1}`},
			},
			Channels: []ChannelBundleChannel{{
				ID:      "mock",
				Name:    "Mock",
				Type:    1,
				Key:     "sk-provider",
				BaseURL: "http://mockllm:8080",
				Models:  "auto",
				Group:   "default",
				Status:  ChannelSpecStatusEnabled,
			}},
		},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.RecordSetReconcileFacts(t.Context(), RecordSetReconcileFactsInput{
		Source:    "kro",
		Namespace: "llmgateway-kro-demo",
		Fleet:     "fleet-demo",
		Sets: []SetReconcileFactInput{
			{SetID: "set-auto-000001", Name: "Set Auto 1", BaseURL: upstream.URL, ShardRef: "shard-a"},
		},
	}); err != nil {
		t.Fatal(err)
	}

	result, err := svc.ReconcileSetReconcileFacts(t.Context(), ReconcileSetReconcileFactsInput{})
	if err != nil {
		t.Fatal(err)
	}
	if result.Managed != 1 || result.Failed != 0 {
		t.Fatalf("unexpected reconcile result: %+v", result)
	}
	if !strings.Contains(strings.Join(optionKeys, ","), "CompletionRatio,ModelRatio") {
		t.Fatalf("option keys = %+v", optionKeys)
	}
	if !channelCreated || !channelUpdated {
		t.Fatalf("channel created=%v updated=%v, want both true", channelCreated, channelUpdated)
	}
	state, ok, err := store.GetChannelBundleSyncState(t.Context(), "golden", "set-auto-000001")
	if err != nil || !ok {
		t.Fatalf("bundle state ok=%v err=%v", ok, err)
	}
	if state.Status != ChannelSyncStatusSynced || state.AppliedFingerprint == "" {
		t.Fatalf("unexpected bundle state: %+v", state)
	}
}

func TestReconcileSetReconcileFactsCreatesUpstreamPlansForNewManagedSet(t *testing.T) {
	var createdPlanTitle string
	upstream := newAutoPlanSetTestServer(t, &createdPlanTitle)
	defer upstream.Close()

	store := NewMemoryStore()
	svc := NewService(store, upstream.Client().Transport, Options{RootUsername: "set-root", RootPassword: "test-local-password"})
	if err := svc.RegisterPlan(t.Context(), Plan{
		ID:            "plan-pro",
		Name:          "Plan Pro",
		MonthlyTokens: 100000,
		PeriodValue:   1,
		PeriodUnit:    "months",
		IsActive:      true,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.RecordSetReconcileFacts(t.Context(), RecordSetReconcileFactsInput{
		Source:    "prod",
		Namespace: "llmgateway",
		Fleet:     "prod",
		Sets: []SetReconcileFactInput{
			{SetID: "set-auto-000001", Name: "Set Auto 1", BaseURL: upstream.URL, ShardRef: "shard-a"},
		},
	}); err != nil {
		t.Fatal(err)
	}

	result, err := svc.ReconcileSetReconcileFacts(t.Context(), ReconcileSetReconcileFactsInput{})
	if err != nil {
		t.Fatal(err)
	}
	if result.Managed != 1 || result.Failed != 0 {
		t.Fatalf("unexpected reconcile result: %+v", result)
	}
	setPlan, ok, err := store.GetSetPlan(t.Context(), "plan-pro", "set-auto-000001")
	if err != nil || !ok {
		t.Fatalf("get set plan ok=%v err=%v", ok, err)
	}
	if setPlan.UpstreamPlanID != 99 || setPlan.Status != SetPlanStatusReady {
		t.Fatalf("unexpected set plan: %+v", setPlan)
	}
	if createdPlanTitle != "Plan Pro" {
		t.Fatalf("created plan title = %q", createdPlanTitle)
	}
}

func TestReconcileSetReconcileFactsMarksMatchingProvisionRequestConfiguredWithoutAdmission(t *testing.T) {
	upstream := newBootstrapTestServer(t)
	defer upstream.Close()

	store := NewMemoryStore()
	svc := NewService(store, nil, Options{RootUsername: "set-root", RootPassword: "test-local-password"})
	if err := store.SaveSetProvisionRequest(t.Context(), SetProvisionRequest{
		ID:             "kro/llmgateway-kro-demo/fleet-demo/set-auto-000001",
		Source:         "kro",
		Namespace:      "llmgateway-kro-demo",
		Fleet:          "fleet-demo",
		SetID:          "set-auto-000001",
		ShardRef:       "shard-a",
		Status:         SetProvisionStatusPending,
		MaxUsersPerSet: 50,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.RecordSetReconcileFacts(t.Context(), RecordSetReconcileFactsInput{
		Source:    "kro",
		Namespace: "llmgateway-kro-demo",
		Fleet:     "fleet-demo",
		Sets: []SetReconcileFactInput{
			{SetID: "set-auto-000001", Name: "Set Auto 1", BaseURL: upstream.URL, ShardRef: "shard-a"},
		},
	}); err != nil {
		t.Fatal(err)
	}

	result, err := svc.ReconcileSetReconcileFacts(t.Context(), ReconcileSetReconcileFactsInput{})
	if err != nil {
		t.Fatal(err)
	}
	if result.Managed != 1 || result.Failed != 0 {
		t.Fatalf("unexpected reconcile result: %+v", result)
	}
	request, ok, err := store.GetSetProvisionRequest(t.Context(), "kro/llmgateway-kro-demo/fleet-demo/set-auto-000001")
	if err != nil || !ok {
		t.Fatalf("request ok=%v err=%v", ok, err)
	}
	if request.Status != SetProvisionStatusConfigured || request.LastStatusAt.IsZero() {
		t.Fatalf("unexpected request after reconcile: %+v", request)
	}
	set, ok, err := store.GetSet(t.Context(), "set-auto-000001")
	if err != nil || !ok {
		t.Fatalf("set ok=%v err=%v", ok, err)
	}
	if set.MaxUsers != 50 {
		t.Fatalf("set max users = %d, want provision request max 50", set.MaxUsers)
	}
	if set.AdmissionStatus == SetAdmissionStatusPassed {
		t.Fatalf("configured set passed admission before slave runtime was ready: %+v", set)
	}
}

func TestSetAdmissionWaitsForManagedProvisionRuntime(t *testing.T) {
	upstream := newBootstrapTestServer(t)
	defer upstream.Close()
	response, err := http.Post(upstream.URL+"/api/setup", "application/json", strings.NewReader(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()

	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	mustSaveSet(t, store, Set{
		ID: "set-a", BaseURL: upstream.URL, Status: SetStatusActive, Setup: true,
		AdminUserID: 1, AdminAccessToken: "admin-token", AdmissionStatus: SetAdmissionStatusPending,
	})
	request := SetProvisionRequest{
		ID: "req-a", Source: "kro", Namespace: "prod", Fleet: "prod", SetID: "set-a",
		Status: SetProvisionStatusConfigured,
	}
	if err := store.SaveSetProvisionRequest(t.Context(), request); err != nil {
		t.Fatal(err)
	}

	if _, err := svc.CheckSetAdmission(t.Context(), "set-a"); err == nil || !strings.Contains(err.Error(), "runtime is not managed") {
		t.Fatalf("configured runtime admission error = %v", err)
	}
	request.Status = SetProvisionStatusManaged
	if err := store.SaveSetProvisionRequest(t.Context(), request); err != nil {
		t.Fatal(err)
	}
	result, err := svc.CheckSetAdmission(t.Context(), "set-a")
	if err != nil || result.Status != SetAdmissionStatusPassed {
		t.Fatalf("managed runtime admission result=%+v err=%v", result, err)
	}
}

func TestRecordSetReconcileFactsRependsWhenDesiredStateChanges(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})

	input := RecordSetReconcileFactsInput{
		Source:    "kro",
		Namespace: "llmgateway-kro-demo",
		Fleet:     "fleet-demo",
		Sets: []SetReconcileFactInput{
			{SetID: "set-a", Name: "Set A", BaseURL: "http://set-a:3000", ShardRef: "shard-a"},
		},
	}
	if _, err := svc.RecordSetReconcileFacts(t.Context(), input); err != nil {
		t.Fatal(err)
	}
	fact, ok, err := store.GetSetReconcileFact(t.Context(), "kro", "llmgateway-kro-demo", "fleet-demo", "set-a")
	if err != nil || !ok {
		t.Fatalf("fact not saved: ok=%v err=%v", ok, err)
	}
	fact.Status = SetReconcileStatusManaged
	if err := store.SaveSetReconcileFact(t.Context(), fact); err != nil {
		t.Fatal(err)
	}

	if _, err := svc.RecordSetReconcileFacts(t.Context(), input); err != nil {
		t.Fatal(err)
	}
	unchanged, _, err := store.GetSetReconcileFact(t.Context(), "kro", "llmgateway-kro-demo", "fleet-demo", "set-a")
	if err != nil {
		t.Fatal(err)
	}
	if unchanged.Status != SetReconcileStatusManaged {
		t.Fatalf("unchanged fact status = %s, want managed", unchanged.Status)
	}

	input.Sets[0].BaseURL = "http://set-a-v2:3000"
	if _, err := svc.RecordSetReconcileFacts(t.Context(), input); err != nil {
		t.Fatal(err)
	}
	changed, _, err := store.GetSetReconcileFact(t.Context(), "kro", "llmgateway-kro-demo", "fleet-demo", "set-a")
	if err != nil {
		t.Fatal(err)
	}
	if changed.Status != SetReconcileStatusPending || changed.LastError != "" {
		t.Fatalf("changed fact was not marked pending: %+v", changed)
	}
}

func newBootstrapTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	initialized := false
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "GET /api/setup":
			writeTestJSON(t, w, map[string]any{"success": true, "data": map[string]any{"status": initialized, "root_init": initialized}})
		case "POST /api/setup":
			initialized = true
			writeTestJSON(t, w, map[string]any{"success": true})
		case "POST /api/user/login":
			http.SetCookie(w, &http.Cookie{Name: "session", Value: "root-session", Path: "/"})
			writeTestJSON(t, w, map[string]any{"success": true, "data": map[string]any{"id": 1, "username": "set-root", "role": 100, "status": 1, "group": "default"}})
		case "POST /api/option/payment_compliance":
			writeTestJSON(t, w, map[string]any{"success": true})
		case "PUT /api/option/":
			writeTestJSON(t, w, map[string]any{"success": true})
		case "POST /api/user/2fa/setup":
			writeTestJSON(t, w, map[string]any{"success": true, "data": map[string]any{"secret": "JBSWY3DPEHPK3PXP"}})
		case "POST /api/user/2fa/enable":
			writeTestJSON(t, w, map[string]any{"success": true})
		case "GET /api/user/token":
			writeTestJSON(t, w, map[string]any{"success": true, "data": "set-admin-token"})
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
}

func newAutoManagedSetTestServer(t *testing.T, optionKeys *[]string, channelCreated *bool, channelUpdated *bool) *httptest.Server {
	t.Helper()
	initialized := false
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "GET /api/setup":
			writeTestJSON(t, w, map[string]any{"success": true, "data": map[string]any{"status": initialized, "root_init": initialized}})
		case "POST /api/setup":
			initialized = true
			writeTestJSON(t, w, map[string]any{"success": true})
		case "POST /api/user/login":
			http.SetCookie(w, &http.Cookie{Name: "session", Value: "root-session", Path: "/"})
			writeTestJSON(t, w, map[string]any{"success": true, "data": map[string]any{"id": 1, "username": "set-root", "role": 100, "status": 1, "group": "default"}})
		case "POST /api/option/payment_compliance":
			writeTestJSON(t, w, map[string]any{"success": true})
		case "PUT /api/option/":
			var req struct {
				Key string `json:"key"`
			}
			decodeGatewayChannelJSON(t, r, &req)
			*optionKeys = append(*optionKeys, req.Key)
			writeTestJSON(t, w, map[string]any{"success": true})
		case "POST /api/user/2fa/setup":
			writeTestJSON(t, w, map[string]any{"success": true, "data": map[string]any{"secret": "JBSWY3DPEHPK3PXP"}})
		case "POST /api/user/2fa/enable":
			writeTestJSON(t, w, map[string]any{"success": true})
		case "GET /api/user/token":
			writeTestJSON(t, w, map[string]any{"success": true, "data": "set-admin-token"})
		case "GET /api/channel/search":
			items := []map[string]any{}
			if *channelCreated {
				items = append(items, map[string]any{
					"id":       21,
					"name":     "llmgw:mock:Mock",
					"type":     1,
					"status":   1,
					"models":   "auto",
					"group":    "default",
					"base_url": "http://mockllm:8080",
				})
			}
			writeTestJSON(t, w, map[string]any{"success": true, "data": map[string]any{"items": items, "total": len(items)}})
		case "POST /api/channel/":
			*channelCreated = true
			writeTestJSON(t, w, map[string]any{"success": true})
		case "PUT /api/channel/":
			*channelUpdated = true
			writeTestJSON(t, w, map[string]any{"success": true})
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
}

func newAutoPlanSetTestServer(t *testing.T, createdPlanTitle *string) *httptest.Server {
	t.Helper()
	initialized := false
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "GET /api/setup":
			writeTestJSON(t, w, map[string]any{"success": true, "data": map[string]any{"status": initialized, "root_init": initialized}})
		case "POST /api/setup":
			initialized = true
			writeTestJSON(t, w, map[string]any{"success": true})
		case "POST /api/user/login":
			http.SetCookie(w, &http.Cookie{Name: "session", Value: "root-session", Path: "/"})
			writeTestJSON(t, w, map[string]any{"success": true, "data": map[string]any{"id": 1, "username": "set-root", "role": 100, "status": 1, "group": "default"}})
		case "POST /api/option/payment_compliance":
			writeTestJSON(t, w, map[string]any{"success": true})
		case "PUT /api/option/":
			writeTestJSON(t, w, map[string]any{"success": true})
		case "POST /api/user/2fa/setup":
			writeTestJSON(t, w, map[string]any{"success": true, "data": map[string]any{"secret": "JBSWY3DPEHPK3PXP"}})
		case "POST /api/user/2fa/enable":
			writeTestJSON(t, w, map[string]any{"success": true})
		case "GET /api/user/token":
			writeTestJSON(t, w, map[string]any{"success": true, "data": "set-admin-token"})
		case "GET /api/subscription/admin/plans":
			writeTestJSON(t, w, map[string]any{"success": true, "data": []any{}})
		case "POST /api/subscription/admin/plans":
			var req struct {
				Plan struct {
					Title string `json:"title"`
				} `json:"plan"`
			}
			decodeGatewayChannelJSON(t, r, &req)
			*createdPlanTitle = req.Plan.Title
			writeTestJSON(t, w, map[string]any{"success": true, "data": map[string]any{"id": 99}})
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
}

func TestRecordSetFactsProjectsRuntimeConfigWithoutReconcile(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	if err := store.SaveSet(t.Context(), Set{ID: "set-a", Name: "Set A", BaseURL: "http://set-a", Status: SetStatusActive, SQLMaxOpenConns: 5, SubscriptionWriteConcurrency: 4}); err != nil {
		t.Fatal(err)
	}
	input := SetReconcileFactInput{
		SetID: "set-a", Name: "Set A", BaseURL: "http://set-a", TrafficBaseURL: "http://set-a-traffic",
		ShardRef: "shard-a", DatabaseName: "newapi_set_a", RedisDB: "10",
		SQLMaxOpenConns: 32, SQLMaxIdleConns: 2, SQLMaxLifetimeSeconds: 60,
		TrafficSQLMaxOpenConns: 32, TrafficSQLMaxIdleConns: 2, TrafficSQLMaxLifetimeSeconds: 60,
		SubscriptionWriteConcurrency: 8,
	}
	existing := SetReconcileFact{
		Source: "prod", Namespace: "llmgateway", Fleet: "prod", SetID: input.SetID,
		DesiredHash: setReconcileDesiredHash("prod", "llmgateway", "prod", input), Status: SetReconcileStatusManaged,
	}
	if err := store.SaveSetReconcileFact(t.Context(), existing); err != nil {
		t.Fatal(err)
	}
	result, err := svc.RecordSetReconcileFacts(t.Context(), RecordSetReconcileFactsInput{
		Source: "prod", Namespace: "llmgateway", Fleet: "prod", Sets: []SetReconcileFactInput{input},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Facts) != 1 || result.Facts[0].Status != SetReconcileStatusManaged {
		t.Fatalf("runtime-only fact unexpectedly requested reconcile: %+v", result.Facts)
	}
	set, ok, err := store.GetSet(t.Context(), "set-a")
	if err != nil || !ok {
		t.Fatalf("get set ok=%v err=%v", ok, err)
	}
	if set.ShardID != "shard-a" || set.SQLMaxOpenConns != 32 || set.TrafficSQLMaxOpenConns != 32 || set.SubscriptionWriteConcurrency != 8 {
		t.Fatalf("runtime projection = %+v", set)
	}
}
