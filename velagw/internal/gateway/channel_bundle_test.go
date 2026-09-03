package gateway

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"git.woa.com/wisp/mono2/llmgateway/internal/newapi"
)

func TestChannelBundlePlanIgnoresChannelsOwnedByOtherBundles(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Header.Get("Authorization") != "Bearer set-admin-token" || r.Header.Get("New-Api-User") != "1" {
			t.Fatalf("missing admin auth headers for %s %s", r.Method, r.URL.Path)
		}
		if r.Method != http.MethodGet || r.URL.Path != "/api/channel/search" {
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		writeGatewayChannelJSON(t, w, map[string]any{
			"success": true,
			"data": map[string]any{
				"items": []map[string]any{
					{
						"id":       99,
						"name":     "llmgw:legacy:Legacy",
						"type":     1,
						"status":   1,
						"models":   "legacy-model",
						"group":    "default",
						"base_url": "https://legacy.example.com",
					},
				},
				"total": 1,
			},
		})
	}))
	defer upstream.Close()

	store := NewMemoryStore()
	svc := NewService(store, upstream.Client().Transport, Options{})
	saveReadySet(t, store, "set-a", upstream.URL)

	bundle, err := svc.UpsertChannelBundle(t.Context(), ChannelBundle{
		ID:   "golden",
		Name: "Golden channels",
		Spec: ChannelBundleSpec{
			Channels: []ChannelBundleChannel{
				{
					ID:      "minimax",
					Name:    "MiniMax",
					Type:    1,
					Key:     "sk-provider",
					BaseURL: "https://tokenhub.tencentmaas.com",
					Models:  "minimax-m2.7",
					Group:   "default",
					Status:  ChannelSpecStatusEnabled,
				},
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	plan, err := svc.PlanChannelBundleForSet(t.Context(), bundle.ID, "set-a", ChannelBundlePlanOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if plan.Status != ChannelSyncStatusPending {
		t.Fatalf("plan status = %s, want pending", plan.Status)
	}
	if len(plan.Steps) != 1 || plan.Steps[0].Kind != ChannelBundleStepCreateChannel || plan.Steps[0].ResourceID != "minimax" {
		t.Fatalf("unexpected steps: %+v", plan.Steps)
	}
	if len(plan.Diff.Added) != 1 || plan.Diff.Added[0].ID != "minimax" {
		t.Fatalf("unexpected added diff: %+v", plan.Diff.Added)
	}
	if len(plan.Diff.Extra) != 0 {
		t.Fatalf("unrelated managed channels should not be reported as this bundle's extras: %+v", plan.Diff.Extra)
	}
	if strings.Contains(string(mustMarshalBundleTest(t, plan)), "sk-provider") {
		t.Fatalf("plan response leaked provider key: %+v", plan)
	}
}

func TestChannelBundlePlanFindsDesiredChannelBeyondFirstSearchPage(t *testing.T) {
	desiredName := "llmgw:platform:Platform"
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method != http.MethodGet || r.URL.Path != "/api/channel/search" {
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		items := make([]map[string]any, 0, 100)
		switch r.URL.Query().Get("keyword") {
		case "":
			for i := 0; i < 100; i++ {
				items = append(items, map[string]any{
					"id":       1000 + i,
					"name":     "llmgw:byok-user-" + string(rune('a'+i%26)),
					"type":     1,
					"status":   1,
					"models":   "auto",
					"group":    "byok",
					"base_url": "https://byok.example.com",
				})
			}
		case desiredName:
			items = append(items, map[string]any{
				"id":       42,
				"name":     desiredName,
				"type":     1,
				"status":   1,
				"models":   "auto",
				"group":    "default",
				"base_url": "https://platform.example.com",
			})
		default:
			t.Fatalf("unexpected channel search keyword %q", r.URL.Query().Get("keyword"))
		}
		writeGatewayChannelJSON(t, w, map[string]any{"success": true, "data": map[string]any{"items": items, "total": len(items)}})
	}))
	defer upstream.Close()

	store := NewMemoryStore()
	svc := NewService(store, upstream.Client().Transport, Options{})
	saveReadySet(t, store, "set-a", upstream.URL)

	bundle, err := svc.UpsertChannelBundle(t.Context(), ChannelBundle{
		ID:   "golden",
		Name: "Golden channels",
		Spec: ChannelBundleSpec{
			Channels: []ChannelBundleChannel{{
				ID:      "platform",
				Name:    "Platform",
				Type:    1,
				Key:     "sk-provider",
				BaseURL: "https://platform.example.com",
				Models:  "auto",
				Group:   "default",
				Status:  ChannelSpecStatusEnabled,
			}},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	desired := channelBundleDesiredSpecs(bundle)[0]
	if err := store.SaveChannelSyncState(t.Context(), ChannelSyncState{
		ChannelID:          desired.ID,
		SetID:              "set-a",
		Status:             ChannelSyncStatusSynced,
		RemoteChannelID:    42,
		AppliedFingerprint: desired.Fingerprint,
		LastAppliedKeyHash: desired.KeyHash,
	}); err != nil {
		t.Fatal(err)
	}

	plan, err := svc.PlanChannelBundleForSet(t.Context(), bundle.ID, "set-a", ChannelBundlePlanOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if plan.Status != ChannelSyncStatusSynced {
		t.Fatalf("plan status = %s, want synced; diff=%+v steps=%+v", plan.Status, plan.Diff, plan.Steps)
	}
	if len(plan.Diff.Added) != 0 || len(plan.Steps) != 1 || plan.Steps[0].Action != "noop" {
		t.Fatalf("desired channel should be found by exact search, diff=%+v steps=%+v", plan.Diff, plan.Steps)
	}
}

func TestChannelBundlePlanReportsPreviouslyOwnedRemovedChannelAsExtra(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method != http.MethodGet || r.URL.Path != "/api/channel/search" {
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		writeGatewayChannelJSON(t, w, map[string]any{
			"success": true,
			"data": map[string]any{
				"items": []map[string]any{
					{
						"id":       21,
						"name":     "llmgw:minimax:MiniMax",
						"type":     1,
						"status":   1,
						"models":   "minimax-m2.7",
						"group":    "default",
						"base_url": "https://tokenhub.tencentmaas.com",
					},
					{
						"id":       99,
						"name":     "llmgw:legacy:Legacy",
						"type":     1,
						"status":   1,
						"models":   "legacy-model",
						"group":    "default",
						"base_url": "https://legacy.example.com",
					},
				},
				"total": 2,
			},
		})
	}))
	defer upstream.Close()

	store := NewMemoryStore()
	svc := NewService(store, upstream.Client().Transport, Options{})
	saveReadySet(t, store, "set-a", upstream.URL)

	bundle, err := svc.UpsertChannelBundle(t.Context(), ChannelBundle{
		ID:   "golden",
		Name: "Golden channels",
		Spec: ChannelBundleSpec{
			Channels: []ChannelBundleChannel{
				{
					ID:      "minimax",
					Name:    "MiniMax",
					Type:    1,
					Key:     "sk-provider",
					BaseURL: "https://tokenhub.tencentmaas.com",
					Models:  "minimax-m2.7",
					Group:   "default",
					Status:  ChannelSpecStatusEnabled,
				},
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	spec := channelBundleDesiredSpecs(bundle)[0]
	if err := store.SaveChannelSyncState(t.Context(), ChannelSyncState{
		ChannelID:          spec.ID,
		SetID:              "set-a",
		Status:             ChannelSyncStatusSynced,
		DesiredFingerprint: spec.Fingerprint,
		AppliedFingerprint: spec.Fingerprint,
		RemoteFingerprint:  spec.Fingerprint,
		LastAppliedKeyHash: spec.KeyHash,
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveChannelBundleSyncState(t.Context(), ChannelBundleSyncState{
		BundleID:            bundle.ID,
		SetID:               "set-a",
		Status:              ChannelSyncStatusSynced,
		RemoteResourcesJSON: `{"llmgw:minimax:MiniMax":21,"llmgw:legacy:Legacy":99}`,
	}); err != nil {
		t.Fatal(err)
	}

	plan, err := svc.PlanChannelBundleForSet(t.Context(), bundle.ID, "set-a", ChannelBundlePlanOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if plan.Status != ChannelSyncStatusDrift {
		t.Fatalf("plan status = %s, want drift", plan.Status)
	}
	if len(plan.Diff.Extra) != 1 || plan.Diff.Extra[0].RemoteID != 99 {
		t.Fatalf("unexpected extra diff: %+v", plan.Diff.Extra)
	}
}

func TestChannelBundleApplyCreatesMissingRemoteChannel(t *testing.T) {
	var remoteCreated bool
	var remoteUpdated bool
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "GET /api/channel/search":
			items := []map[string]any{}
			if remoteCreated {
				items = append(items, map[string]any{
					"id":       21,
					"name":     "llmgw:minimax:MiniMax",
					"type":     1,
					"status":   1,
					"models":   "minimax-m2.7",
					"group":    "default",
					"base_url": "https://tokenhub.tencentmaas.com",
				})
			}
			writeGatewayChannelJSON(t, w, map[string]any{"success": true, "data": map[string]any{"items": items, "total": len(items)}})
		case "POST /api/channel/":
			var req struct {
				Mode    string `json:"mode"`
				Channel struct {
					Name string `json:"name"`
					Key  string `json:"key"`
				} `json:"channel"`
			}
			decodeGatewayChannelJSON(t, r, &req)
			if req.Mode != "single" || req.Channel.Name != "llmgw:minimax:MiniMax" || req.Channel.Key != "sk-provider" {
				t.Fatalf("unexpected create payload: %+v", req)
			}
			remoteCreated = true
			writeGatewayChannelJSON(t, w, map[string]any{"success": true})
		case "PUT /api/channel/":
			var req struct {
				ID   int    `json:"id"`
				Name string `json:"name"`
				Key  string `json:"key"`
			}
			decodeGatewayChannelJSON(t, r, &req)
			if req.ID != 21 || req.Name != "llmgw:minimax:MiniMax" || req.Key != "sk-provider" {
				t.Fatalf("unexpected update payload: %+v", req)
			}
			remoteUpdated = true
			writeGatewayChannelJSON(t, w, map[string]any{"success": true})
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer upstream.Close()

	store := NewMemoryStore()
	svc := NewService(store, upstream.Client().Transport, Options{})
	saveReadySet(t, store, "set-a", upstream.URL)

	bundle, err := svc.UpsertChannelBundle(t.Context(), ChannelBundle{
		ID:   "golden",
		Name: "Golden channels",
		Spec: ChannelBundleSpec{
			Channels: []ChannelBundleChannel{
				{
					ID:      "minimax",
					Name:    "MiniMax",
					Type:    1,
					Key:     "sk-provider",
					BaseURL: "https://tokenhub.tencentmaas.com",
					Models:  "minimax-m2.7",
					Group:   "default",
					Status:  ChannelSpecStatusEnabled,
				},
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	state, err := svc.ApplyChannelBundleToSet(t.Context(), bundle.ID, "set-a", ChannelBundleApplyOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if !remoteCreated || !remoteUpdated {
		t.Fatalf("remote created=%v updated=%v, want both true", remoteCreated, remoteUpdated)
	}
	if state.Status != ChannelSyncStatusSynced || state.AppliedFingerprint != bundle.Fingerprint {
		t.Fatalf("bundle sync state = %+v, want synced with applied fingerprint", state)
	}
	spec, ok, err := store.GetChannelSpec(t.Context(), "minimax")
	if err != nil || !ok {
		t.Fatalf("stored channel spec ok=%v err=%v", ok, err)
	}
	if spec.KeyHash == "" || spec.Key != "sk-provider" {
		t.Fatalf("unexpected stored channel spec: %+v", spec)
	}
}

func TestChannelBundleApplyDoesNotMarkDriftedChannelSyncedWithoutForce(t *testing.T) {
	remoteExists := false
	remoteModels := "minimax-m2.7"
	updateCount := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "GET /api/channel/search":
			items := []map[string]any{}
			if remoteExists {
				items = append(items, map[string]any{
					"id":       21,
					"name":     "llmgw:minimax:MiniMax",
					"type":     1,
					"status":   1,
					"models":   remoteModels,
					"group":    "default",
					"base_url": "https://tokenhub.tencentmaas.com",
				})
			}
			writeGatewayChannelJSON(t, w, map[string]any{"success": true, "data": map[string]any{"items": items, "total": len(items)}})
		case "POST /api/channel/":
			remoteExists = true
			writeGatewayChannelJSON(t, w, map[string]any{"success": true})
		case "PUT /api/channel/":
			updateCount++
			remoteModels = "minimax-m2.7"
			writeGatewayChannelJSON(t, w, map[string]any{"success": true})
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer upstream.Close()

	store := NewMemoryStore()
	svc := NewService(store, upstream.Client().Transport, Options{})
	saveReadySet(t, store, "set-a", upstream.URL)
	bundle, err := svc.UpsertChannelBundle(t.Context(), ChannelBundle{
		ID:   "golden",
		Name: "Golden channels",
		Spec: ChannelBundleSpec{
			Channels: []ChannelBundleChannel{{
				ID:      "minimax",
				Name:    "MiniMax",
				Type:    1,
				Key:     "sk-provider",
				BaseURL: "https://tokenhub.tencentmaas.com",
				Models:  "minimax-m2.7",
				Group:   "default",
				Status:  ChannelSpecStatusEnabled,
			}},
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	firstState, err := svc.ApplyChannelBundleToSet(t.Context(), bundle.ID, "set-a", ChannelBundleApplyOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if firstState.Status != ChannelSyncStatusSynced || updateCount == 0 {
		t.Fatalf("initial apply state=%+v updateCount=%d, want synced with remote update", firstState, updateCount)
	}
	updateCount = 0
	remoteModels = "manual-drift"

	driftState, err := svc.ApplyChannelBundleToSet(t.Context(), bundle.ID, "set-a", ChannelBundleApplyOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if driftState.Status != ChannelSyncStatusDrift {
		t.Fatalf("bundle state = %+v, want drift when remote was manually changed", driftState)
	}
	if updateCount != 0 || remoteModels != "manual-drift" {
		t.Fatalf("drifted remote was overwritten without force: updateCount=%d remoteModels=%q", updateCount, remoteModels)
	}

	forcedState, err := svc.ApplyChannelBundleToSet(t.Context(), bundle.ID, "set-a", ChannelBundleApplyOptions{ForceDrift: true})
	if err != nil {
		t.Fatal(err)
	}
	if forcedState.Status != ChannelSyncStatusSynced {
		t.Fatalf("forced apply state = %+v, want synced", forcedState)
	}
	if updateCount != 1 || remoteModels != "minimax-m2.7" {
		t.Fatalf("forced apply did not overwrite drift: updateCount=%d remoteModels=%q", updateCount, remoteModels)
	}
}

func TestChannelBundlePlanReportsManualRemoteDrift(t *testing.T) {
	remoteExists := false
	remoteModels := "minimax-m2.7"
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "GET /api/channel/search":
			items := []map[string]any{}
			if remoteExists {
				items = append(items, map[string]any{
					"id":       21,
					"name":     "llmgw:minimax:MiniMax",
					"type":     1,
					"status":   1,
					"models":   remoteModels,
					"group":    "default",
					"base_url": "https://tokenhub.tencentmaas.com",
				})
			}
			writeGatewayChannelJSON(t, w, map[string]any{"success": true, "data": map[string]any{"items": items, "total": len(items)}})
		case "POST /api/channel/":
			remoteExists = true
			writeGatewayChannelJSON(t, w, map[string]any{"success": true})
		case "PUT /api/channel/":
			remoteModels = "minimax-m2.7"
			writeGatewayChannelJSON(t, w, map[string]any{"success": true})
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer upstream.Close()

	store := NewMemoryStore()
	emitter, telemetryEvents := captureTelemetryEvents()
	svc := NewService(store, upstream.Client().Transport, Options{TelemetryEmitter: emitter})
	saveReadySet(t, store, "set-a", upstream.URL)
	bundle, err := svc.UpsertChannelBundle(t.Context(), ChannelBundle{
		ID:   "golden",
		Name: "Golden channels",
		Spec: ChannelBundleSpec{
			Channels: []ChannelBundleChannel{{
				ID:      "minimax",
				Name:    "MiniMax",
				Type:    1,
				Key:     "sk-provider",
				BaseURL: "https://tokenhub.tencentmaas.com",
				Models:  "minimax-m2.7",
				Group:   "default",
				Status:  ChannelSpecStatusEnabled,
			}},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ApplyChannelBundleToSet(t.Context(), bundle.ID, "set-a", ChannelBundleApplyOptions{}); err != nil {
		t.Fatal(err)
	}
	*telemetryEvents = nil
	remoteModels = "manual-drift"

	plan, err := svc.PlanChannelBundleForSet(t.Context(), bundle.ID, "set-a", ChannelBundlePlanOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if plan.Status != ChannelSyncStatusDrift {
		t.Fatalf("plan status = %s, want drift for manually changed remote: %+v", plan.Status, plan)
	}
	if len(plan.Steps) != 1 || !plan.Steps[0].RequiresForce {
		t.Fatalf("drift plan should require force overwrite: %+v", plan.Steps)
	}
	foundDrift := false
	for _, event := range *telemetryEvents {
		if event.event.Name == "llmgateway.config.drift_detected" {
			foundDrift = true
			requireTelemetryString(t, event.event, "llmgateway.set.id", "set-a")
			requireTelemetryString(t, event.event, "llmgateway.channel_bundle.id", "golden")
		}
	}
	if !foundDrift {
		t.Fatalf("missing drift telemetry: %+v", *telemetryEvents)
	}
}

func TestChannelBundlePlanReportsGlobalOptionDrift(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "GET /api/channel/search":
			writeGatewayChannelJSON(t, w, map[string]any{"success": true, "data": map[string]any{"items": []any{}, "total": 0}})
		case "GET /api/option/":
			writeGatewayChannelJSON(t, w, map[string]any{"success": true, "data": []map[string]any{
				{"key": "ModelRatio", "value": `{"existing":1}`},
			}})
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer upstream.Close()

	store := NewMemoryStore()
	svc := NewService(store, upstream.Client().Transport, Options{})
	saveReadySet(t, store, "set-a", upstream.URL)
	bundle, err := svc.UpsertChannelBundle(t.Context(), ChannelBundle{
		ID: "golden-channels", Name: "Golden", Spec: ChannelBundleSpec{
			Options: []ChannelBundleOption{{Key: "ModelRatio", Value: `{"existing":1,"regression":1}`}},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SaveChannelBundleSyncState(t.Context(), ChannelBundleSyncState{
		BundleID: bundle.ID, SetID: "set-a", Status: ChannelSyncStatusSynced,
		DesiredFingerprint: bundle.Fingerprint, AppliedFingerprint: bundle.Fingerprint,
	}); err != nil {
		t.Fatal(err)
	}

	plan, err := svc.PlanChannelBundleForSet(t.Context(), bundle.ID, "set-a", ChannelBundlePlanOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if plan.Status != ChannelSyncStatusDrift {
		t.Fatalf("plan status = %q, want drift for remote global option mismatch: %+v", plan.Status, plan)
	}
	if len(plan.Actual.Options) != 1 || plan.Actual.Options[0].Key != "ModelRatio" {
		t.Fatalf("actual options = %+v, want remote ModelRatio snapshot", plan.Actual.Options)
	}
	if len(plan.Steps) != 1 || plan.Steps[0].Kind != "update_option" || !plan.Steps[0].RequiresForce {
		t.Fatalf("option drift step = %+v, want force-required update_option", plan.Steps)
	}
}

func TestChannelBundleApplyRequiresForceForGlobalOptionDrift(t *testing.T) {
	remoteModelRatio := `{"manual":1}`
	updateCount := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "GET /api/channel/search":
			writeGatewayChannelJSON(t, w, map[string]any{"success": true, "data": map[string]any{"items": []any{}, "total": 0}})
		case "GET /api/option/":
			writeGatewayChannelJSON(t, w, map[string]any{"success": true, "data": []map[string]any{{"key": "ModelRatio", "value": remoteModelRatio}}})
		case "PUT /api/option/":
			var req struct {
				Key   string `json:"key"`
				Value string `json:"value"`
			}
			decodeGatewayChannelJSON(t, r, &req)
			updateCount++
			remoteModelRatio = req.Value
			writeGatewayChannelJSON(t, w, map[string]any{"success": true})
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer upstream.Close()

	store := NewMemoryStore()
	svc := NewService(store, upstream.Client().Transport, Options{})
	saveReadySet(t, store, "set-a", upstream.URL)
	bundle, err := svc.UpsertChannelBundle(t.Context(), ChannelBundle{
		ID: "golden-channels", Name: "Golden", Spec: ChannelBundleSpec{
			Options: []ChannelBundleOption{{Key: "ModelRatio", Value: `{"golden":1}`}},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SaveChannelBundleSyncState(t.Context(), ChannelBundleSyncState{
		BundleID: bundle.ID, SetID: "set-a", Status: ChannelSyncStatusSynced,
		DesiredFingerprint: bundle.Fingerprint, AppliedFingerprint: bundle.Fingerprint,
	}); err != nil {
		t.Fatal(err)
	}

	state, err := svc.ApplyChannelBundleToSet(t.Context(), bundle.ID, "set-a", ChannelBundleApplyOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if state.Status != ChannelSyncStatusDrift || updateCount != 0 || remoteModelRatio != `{"manual":1}` {
		t.Fatalf("non-forced apply state=%+v updates=%d remote=%s", state, updateCount, remoteModelRatio)
	}
	state, err = svc.ApplyChannelBundleToSet(t.Context(), bundle.ID, "set-a", ChannelBundleApplyOptions{ForceDrift: true})
	if err != nil {
		t.Fatal(err)
	}
	if state.Status != ChannelSyncStatusSynced || updateCount != 1 || remoteModelRatio != `{"golden":1}` {
		t.Fatalf("forced apply state=%+v updates=%d remote=%s", state, updateCount, remoteModelRatio)
	}
}

func TestChannelBundleApplySkipsDisabledSetWithoutCallingRemote(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatalf("disabled set should not call remote new-api, got %s %s", r.Method, r.URL.Path)
	}))
	defer upstream.Close()

	store := NewMemoryStore()
	svc := NewService(store, upstream.Client().Transport, Options{})
	if err := store.SaveSet(t.Context(), Set{
		ID:               "set-a",
		Name:             "set-a",
		BaseURL:          upstream.URL,
		Status:           SetStatusDisabled,
		Setup:            true,
		AdminUserID:      1,
		AdminAccessToken: "set-admin-token",
	}); err != nil {
		t.Fatal(err)
	}
	bundle, err := svc.UpsertChannelBundle(t.Context(), ChannelBundle{
		ID:   "golden",
		Name: "Golden channels",
		Spec: ChannelBundleSpec{
			Channels: []ChannelBundleChannel{{
				ID:      "minimax",
				Name:    "MiniMax",
				Type:    1,
				Key:     "sk-provider",
				BaseURL: "https://tokenhub.tencentmaas.com",
				Models:  "minimax-m2.7",
				Group:   "default",
				Status:  ChannelSpecStatusEnabled,
			}},
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	plan, err := svc.PlanChannelBundleForSet(t.Context(), bundle.ID, "set-a", ChannelBundlePlanOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if plan.Status != ChannelSyncStatusSkipped {
		t.Fatalf("disabled set plan = %+v, want skipped", plan)
	}
	state, err := svc.ApplyChannelBundleToSet(t.Context(), bundle.ID, "set-a", ChannelBundleApplyOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if state.Status != ChannelSyncStatusSkipped || state.LastError == "" {
		t.Fatalf("disabled set apply state = %+v, want skipped with reason", state)
	}
}

func TestChannelBundleApplyRecordsPartialFailureAfterEarlierChannelSynced(t *testing.T) {
	remoteCreated := map[string]bool{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "GET /api/channel/search":
			items := []map[string]any{}
			for id, created := range remoteCreated {
				if !created {
					continue
				}
				name := "Alpha"
				model := "alpha-model"
				if id == "broken" {
					name = "Broken"
					model = "broken-model"
				}
				items = append(items, map[string]any{
					"id":       map[string]int{"alpha": 41, "broken": 42}[id],
					"name":     "llmgw:" + id + ":" + name,
					"type":     1,
					"status":   1,
					"models":   model,
					"group":    "default",
					"base_url": "https://provider.example.com",
				})
			}
			writeGatewayChannelJSON(t, w, map[string]any{"success": true, "data": map[string]any{"items": items, "total": len(items)}})
		case "POST /api/channel/":
			var req struct {
				Channel struct {
					Name string `json:"name"`
				} `json:"channel"`
			}
			decodeGatewayChannelJSON(t, r, &req)
			if req.Channel.Name == "llmgw:broken:Broken" {
				http.Error(w, `{"success":false,"message":"broken create failed"}`, http.StatusBadGateway)
				return
			}
			remoteCreated["alpha"] = true
			writeGatewayChannelJSON(t, w, map[string]any{"success": true})
		case "PUT /api/channel/":
			writeGatewayChannelJSON(t, w, map[string]any{"success": true})
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer upstream.Close()

	store := NewMemoryStore()
	svc := NewService(store, upstream.Client().Transport, Options{})
	saveReadySet(t, store, "set-a", upstream.URL)
	bundle, err := svc.UpsertChannelBundle(t.Context(), ChannelBundle{
		ID:   "golden",
		Name: "Golden channels",
		Spec: ChannelBundleSpec{
			Channels: []ChannelBundleChannel{
				{
					ID:      "alpha",
					Name:    "Alpha",
					Type:    1,
					Key:     "sk-alpha",
					BaseURL: "https://provider.example.com",
					Models:  "alpha-model",
					Group:   "default",
					Status:  ChannelSpecStatusEnabled,
				},
				{
					ID:      "broken",
					Name:    "Broken",
					Type:    1,
					Key:     "sk-broken",
					BaseURL: "https://provider.example.com",
					Models:  "broken-model",
					Group:   "default",
					Status:  ChannelSpecStatusEnabled,
				},
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	state, err := svc.ApplyChannelBundleToSet(t.Context(), bundle.ID, "set-a", ChannelBundleApplyOptions{})
	if err == nil {
		t.Fatal("expected partial channel sync failure")
	}
	if state.Status != ChannelSyncStatusError || !strings.Contains(state.LastError, "returned 502") {
		t.Fatalf("bundle state = %+v err=%v, want error with broken reason", state, err)
	}
	alphaState, ok, err := store.GetChannelSyncState(t.Context(), "alpha", "set-a")
	if err != nil || !ok {
		t.Fatalf("alpha state ok=%v err=%v", ok, err)
	}
	if alphaState.Status != ChannelSyncStatusSynced {
		t.Fatalf("alpha state = %+v, want synced despite later failure", alphaState)
	}
	brokenState, ok, err := store.GetChannelSyncState(t.Context(), "broken", "set-a")
	if err != nil || !ok {
		t.Fatalf("broken state ok=%v err=%v", ok, err)
	}
	if brokenState.Status != ChannelSyncStatusError {
		t.Fatalf("broken state = %+v, want error", brokenState)
	}
}

func TestChannelBundleFailedReleaseKeepsStableSetAndIsolatesOnlyPartialRemoteUpdate(t *testing.T) {
	type remoteState struct {
		models           string
		mutateBeforeFail bool
	}
	newRemote := func(state *remoteState) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			switch r.Method + " " + r.URL.Path {
			case "GET /api/setup":
				writeGatewayChannelJSON(t, w, map[string]any{"success": true, "data": map[string]any{"status": true, "root_init": true}})
			case "GET /api/option/":
				writeGatewayChannelJSON(t, w, map[string]any{"success": true, "data": []map[string]any{
					{"key": "ModelRatio", "value": `{"model-v1":1,"model-v2":1}`},
					{"key": "CompletionRatio", "value": `{"model-v1":1,"model-v2":1}`},
				}})
			case "PUT /api/option/":
				writeGatewayChannelJSON(t, w, map[string]any{"success": true})
			case "GET /api/channel/search":
				writeGatewayChannelJSON(t, w, map[string]any{"success": true, "data": map[string]any{
					"items": []map[string]any{{
						"id": 23, "name": "llmgw:platform:Platform", "type": 1, "status": 1,
						"models": state.models, "group": "default", "base_url": "https://provider.example.com",
					}},
					"total": 1,
				}})
			case "PUT /api/channel/":
				var req struct {
					Models string `json:"models"`
				}
				decodeGatewayChannelJSON(t, r, &req)
				if state.mutateBeforeFail {
					state.models = req.Models
				}
				http.Error(w, `{"success":false,"message":"simulated publish failure"}`, http.StatusBadGateway)
			default:
				t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
			}
		}))
	}

	safeRemote := &remoteState{models: "model-v1"}
	partialRemote := &remoteState{models: "model-v1", mutateBeforeFail: true}
	safeUpstream := newRemote(safeRemote)
	defer safeUpstream.Close()
	partialUpstream := newRemote(partialRemote)
	defer partialUpstream.Close()

	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	for _, set := range []Set{
		{ID: "set-safe", BaseURL: safeUpstream.URL, Status: SetStatusActive, Setup: true, AdminUserID: 1, AdminAccessToken: "admin-token", AdmissionStatus: SetAdmissionStatusPassed},
		{ID: "set-partial", BaseURL: partialUpstream.URL, Status: SetStatusActive, Setup: true, AdminUserID: 1, AdminAccessToken: "admin-token", AdmissionStatus: SetAdmissionStatusPassed},
	} {
		if err := store.SaveSet(t.Context(), set); err != nil {
			t.Fatal(err)
		}
	}
	stable, err := svc.UpsertChannelBundle(t.Context(), ChannelBundle{
		ID: "golden", Name: "Golden v1", Spec: ChannelBundleSpec{
			Version: 1,
			Kind:    ChannelBundleKind,
			Options: []ChannelBundleOption{
				{Key: "ModelRatio", Value: `{"model-v1":1,"model-v2":1}`},
				{Key: "CompletionRatio", Value: `{"model-v1":1,"model-v2":1}`},
			},
			Channels: []ChannelBundleChannel{{
				ID: "platform", Name: "Platform", Type: 1, Key: "sk-stable", BaseURL: "https://provider.example.com", Models: "model-v1", Group: "default", Status: ChannelSpecStatusEnabled,
			}},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	stableSpec := channelBundleDesiredSpecs(stable)[0]
	for _, setID := range []string{"set-safe", "set-partial"} {
		if err := store.SaveChannelBundleSyncState(t.Context(), ChannelBundleSyncState{
			BundleID: stable.ID, SetID: setID, Status: ChannelSyncStatusSynced,
			DesiredFingerprint: stable.Fingerprint, AppliedFingerprint: stable.Fingerprint,
		}); err != nil {
			t.Fatal(err)
		}
		if err := store.SaveChannelSyncState(t.Context(), ChannelSyncState{
			ChannelID: stableSpec.ID, SetID: setID, Status: ChannelSyncStatusSynced,
			DesiredFingerprint: stableSpec.Fingerprint, AppliedFingerprint: stableSpec.Fingerprint,
			LastAppliedKeyHash: stableSpec.KeyHash,
		}); err != nil {
			t.Fatal(err)
		}
	}
	next, err := svc.UpsertChannelBundle(t.Context(), ChannelBundle{
		ID: "golden", Name: "Golden v2", Spec: ChannelBundleSpec{
			Version: 1,
			Kind:    ChannelBundleKind,
			Options: stable.Spec.Options,
			Channels: []ChannelBundleChannel{{
				ID: "platform", Name: "Platform", Type: 1, Key: "sk-stable", BaseURL: "https://provider.example.com", Models: "model-v2", Group: "default", Status: ChannelSpecStatusEnabled,
			}},
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	safeState, safeErr := svc.ApplyChannelBundleToSet(t.Context(), next.ID, "set-safe", ChannelBundleApplyOptions{})
	if safeErr == nil {
		t.Fatal("expected simulated safe publish failure")
	}
	if safeState.Status != ChannelSyncStatusPending || safeState.AppliedFingerprint != stable.Fingerprint {
		t.Fatalf("safe failed release state = %+v err=%v, want pending on stable applied revision", safeState, safeErr)
	}
	partialState, partialErr := svc.ApplyChannelBundleToSet(t.Context(), next.ID, "set-partial", ChannelBundleApplyOptions{})
	if partialErr == nil {
		t.Fatal("expected simulated partial publish failure")
	}
	if partialState.Status != ChannelSyncStatusError || partialState.AppliedFingerprint != stable.Fingerprint {
		t.Fatalf("partial failed release state = %+v err=%v, want isolated error", partialState, partialErr)
	}
	safeSet, ok, err := store.GetSet(t.Context(), "set-safe")
	if err != nil || !ok {
		t.Fatalf("get safe set ok=%v err=%v", ok, err)
	}
	if safeSet.AdmissionStatus != SetAdmissionStatusPassed {
		t.Fatalf("safe set admission changed immediately after failed publish: %+v", safeSet)
	}
	partialSet, ok, err := store.GetSet(t.Context(), "set-partial")
	if err != nil || !ok {
		t.Fatalf("get partial set ok=%v err=%v", ok, err)
	}
	if partialSet.AdmissionStatus != SetAdmissionStatusFailed || !strings.Contains(partialSet.AdmissionError, "remote no longer matches") {
		t.Fatalf("partial set was not isolated immediately: %+v", partialSet)
	}

	safeAdmission, err := svc.CheckSetAdmission(t.Context(), "set-safe")
	if err != nil || safeAdmission.Status != SetAdmissionStatusPassed {
		t.Fatalf("safe set admission = %+v err=%v, want passed", safeAdmission, err)
	}
	partialAdmission, err := svc.CheckSetAdmission(t.Context(), "set-partial")
	if err == nil || partialAdmission.Status != SetAdmissionStatusFailed {
		t.Fatalf("partial set admission = %+v err=%v, want failed", partialAdmission, err)
	}
}

func TestChannelBundleApplySyncsOptionsBeforeChannels(t *testing.T) {
	var optionKeys []string
	var channelCreated bool
	var optionSessionLoggedIn bool
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "POST /api/user/login":
			optionSessionLoggedIn = true
			http.SetCookie(w, &http.Cookie{Name: "session", Value: "root-session", Path: "/"})
			writeGatewayChannelJSON(t, w, map[string]any{"success": true, "data": map[string]any{"id": 1, "username": "set-root", "role": 100, "status": 1, "group": "default", "access_token": "fresh-admin-token"}})
		case "GET /api/channel/search":
			items := []map[string]any{}
			if channelCreated {
				items = append(items, map[string]any{
					"id":       33,
					"name":     "llmgw:mock:Mock",
					"type":     1,
					"status":   1,
					"models":   "auto",
					"group":    "default",
					"base_url": "http://mockllm:8080",
				})
			}
			writeGatewayChannelJSON(t, w, map[string]any{"success": true, "data": map[string]any{"items": items, "total": len(items)}})
		case "GET /api/option/":
			writeGatewayChannelJSON(t, w, map[string]any{"success": true, "data": []any{}})
		case "PUT /api/option/":
			if r.Header.Get("Authorization") != "Bearer fresh-admin-token" || !optionSessionLoggedIn {
				t.Fatalf("bundle options must use login access token, authorization=%q logged_in=%v", r.Header.Get("Authorization"), optionSessionLoggedIn)
			}
			if channelCreated {
				t.Fatal("bundle options must be synced before channels")
			}
			var req struct {
				Key   string `json:"key"`
				Value any    `json:"value"`
			}
			decodeGatewayChannelJSON(t, r, &req)
			optionKeys = append(optionKeys, req.Key)
			writeGatewayChannelJSON(t, w, map[string]any{"success": true})
		case "POST /api/channel/":
			channelCreated = true
			writeGatewayChannelJSON(t, w, map[string]any{"success": true})
		case "PUT /api/channel/":
			writeGatewayChannelJSON(t, w, map[string]any{"success": true})
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer upstream.Close()

	store := NewMemoryStore()
	svc := NewService(store, upstream.Client().Transport, Options{RootUsername: "set-root", RootPassword: "Qq373866172!"})
	if err := store.SaveSet(t.Context(), Set{
		ID:               "set-a",
		Name:             "set-a",
		BaseURL:          upstream.URL,
		Status:           SetStatusActive,
		Setup:            true,
		AdminUserID:      1,
		AdminUsername:    "set-root",
		AdminAccessToken: "set-admin-token",
	}); err != nil {
		t.Fatal(err)
	}

	_, err := svc.UpsertChannelBundle(t.Context(), ChannelBundle{
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
	})
	if err != nil {
		t.Fatal(err)
	}

	state, err := svc.ApplyChannelBundleToSet(t.Context(), "golden", "set-a", ChannelBundleApplyOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if state.Status != ChannelSyncStatusSynced {
		t.Fatalf("state = %+v, want synced", state)
	}
	if strings.Join(optionKeys, ",") != "CompletionRatio,ModelRatio" {
		t.Fatalf("option keys = %+v", optionKeys)
	}
	if !channelCreated {
		t.Fatal("channel was not created")
	}
}

func TestChannelBundleApplyPreservesLocalBYOKGroupRatios(t *testing.T) {
	remoteGroupRatio := `{"legacy":2,"byok_remote_orphan":0}`
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "GET /api/channel/search":
			writeGatewayChannelJSON(t, w, map[string]any{"success": true, "data": map[string]any{"items": []any{}, "total": 0}})
		case "GET /api/option/":
			writeGatewayChannelJSON(t, w, map[string]any{"success": true, "data": []map[string]any{{"key": "GroupRatio", "value": remoteGroupRatio}}})
		case "PUT /api/option/":
			var req struct {
				Key   string `json:"key"`
				Value any    `json:"value"`
			}
			decodeGatewayChannelJSON(t, r, &req)
			if req.Key != "GroupRatio" {
				t.Fatalf("updated option = %q, want GroupRatio", req.Key)
			}
			value, ok := req.Value.(string)
			if !ok {
				raw, err := json.Marshal(req.Value)
				if err != nil {
					t.Fatal(err)
				}
				value = string(raw)
			}
			remoteGroupRatio = value
			writeGatewayChannelJSON(t, w, map[string]any{"success": true})
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer upstream.Close()

	store := NewMemoryStore()
	svc := NewService(store, upstream.Client().Transport, Options{})
	saveReadySet(t, store, "set-a", upstream.URL)
	intent := testBYOKSyncIntent("user-a", "set-a", true)
	intent.GroupName = "byok_user_a"
	if _, err := store.SaveBYOKSyncIntent(t.Context(), intent); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.UpsertChannelBundle(t.Context(), ChannelBundle{
		ID: "golden", Name: "Golden", Spec: ChannelBundleSpec{
			Options: []ChannelBundleOption{{Key: "GroupRatio", Value: `{"default":1}`}},
		},
	}); err != nil {
		t.Fatal(err)
	}

	state, err := svc.ApplyChannelBundleToSet(t.Context(), "golden", "set-a", ChannelBundleApplyOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if state.Status != ChannelSyncStatusSynced {
		t.Fatalf("state = %+v, want synced", state)
	}
	var got map[string]float64
	if err := json.Unmarshal([]byte(remoteGroupRatio), &got); err != nil {
		t.Fatal(err)
	}
	byokRatio, byokExists := got["byok_user_a"]
	if got["default"] != 1 || !byokExists || byokRatio != 0 {
		t.Fatalf("GroupRatio = %#v, want platform ratios plus preserved byok entry", got)
	}
	if _, exists := got["legacy"]; exists {
		t.Fatalf("GroupRatio = %#v, stale platform entry should be removed", got)
	}
	if _, exists := got["byok_remote_orphan"]; exists {
		t.Fatalf("GroupRatio = %#v, remote-only BYOK entry must not be merged", got)
	}
}

func TestChannelBundleRejectsReservedBYOKGroupRatioKeys(t *testing.T) {
	svc := NewService(NewMemoryStore(), nil, Options{})
	_, err := svc.UpsertChannelBundle(t.Context(), ChannelBundle{
		ID: "golden", Name: "Golden", Spec: ChannelBundleSpec{
			Options: []ChannelBundleOption{{Key: "GroupRatio", Value: `{"default":1,"byok_platform":0}`}},
		},
	})
	if err == nil || !strings.Contains(err.Error(), "byok_") {
		t.Fatalf("error = %v, want reserved byok_ prefix rejection", err)
	}
}

func TestChannelBundleApplyCompletesTwoFALoginForOptionSync(t *testing.T) {
	var twoFACompleted bool
	var optionUpdated bool
	var channelCreated bool
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "POST /api/user/login":
			writeGatewayChannelJSON(t, w, map[string]any{"success": true, "data": map[string]any{
				"require_2fa": true,
				"flow_token":  "flow-123",
			}})
		case "POST /api/user/login/2fa":
			var req struct {
				Code      string `json:"code"`
				FlowToken string `json:"flow_token"`
			}
			decodeGatewayChannelJSON(t, r, &req)
			if req.FlowToken != "flow-123" || strings.TrimSpace(req.Code) == "" {
				t.Fatalf("unexpected 2fa login request: %+v", req)
			}
			twoFACompleted = true
			writeGatewayChannelJSON(t, w, map[string]any{"success": true, "data": map[string]any{"id": 1, "username": "set-root", "role": 100, "status": 1, "group": "default", "access_token": "fresh-admin-token"}})
		case "GET /api/channel/search":
			items := []map[string]any{}
			if channelCreated {
				items = append(items, map[string]any{
					"id":       33,
					"name":     "llmgw:mock:Mock",
					"type":     1,
					"status":   1,
					"models":   "llmgw-mock-chat",
					"group":    "default",
					"base_url": "http://mockllm:8080",
				})
			}
			writeGatewayChannelJSON(t, w, map[string]any{"success": true, "data": map[string]any{"items": items, "total": len(items)}})
		case "GET /api/option/":
			writeGatewayChannelJSON(t, w, map[string]any{"success": true, "data": []any{}})
		case "PUT /api/option/":
			if r.Header.Get("Authorization") != "Bearer fresh-admin-token" || !twoFACompleted {
				t.Fatalf("bundle options must use completed login access token, authorization=%q twoFACompleted=%v", r.Header.Get("Authorization"), twoFACompleted)
			}
			optionUpdated = true
			writeGatewayChannelJSON(t, w, map[string]any{"success": true})
		case "POST /api/channel/":
			channelCreated = true
			writeGatewayChannelJSON(t, w, map[string]any{"success": true})
		case "PUT /api/channel/":
			writeGatewayChannelJSON(t, w, map[string]any{"success": true})
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer upstream.Close()

	store := NewMemoryStore()
	svc := NewService(store, upstream.Client().Transport, Options{RootUsername: "set-root", RootPassword: "Qq373866172!"})
	if err := store.SaveSet(t.Context(), Set{
		ID:               "set-a",
		Name:             "set-a",
		BaseURL:          upstream.URL,
		Status:           SetStatusActive,
		Setup:            true,
		AdminUserID:      1,
		AdminUsername:    "set-root",
		AdminAccessToken: "set-admin-token",
		AdminTOTPSecret:  "JBSWY3DPEHPK3PXP",
	}); err != nil {
		t.Fatal(err)
	}
	_, err := svc.UpsertChannelBundle(t.Context(), ChannelBundle{
		ID:   "golden",
		Name: "Golden config",
		Spec: ChannelBundleSpec{
			Options: []ChannelBundleOption{{Key: "ModelRatio", Value: `{"llmgw-mock-chat":1}`}},
			Channels: []ChannelBundleChannel{{
				ID:      "mock",
				Name:    "Mock",
				Type:    1,
				Key:     "sk-provider",
				BaseURL: "http://mockllm:8080",
				Models:  "llmgw-mock-chat",
				Group:   "default",
				Status:  ChannelSpecStatusEnabled,
			}},
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	state, err := svc.ApplyChannelBundleToSet(t.Context(), "golden", "set-a", ChannelBundleApplyOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if state.Status != ChannelSyncStatusSynced || !twoFACompleted || !optionUpdated {
		t.Fatalf("state=%+v twoFACompleted=%v optionUpdated=%v", state, twoFACompleted, optionUpdated)
	}
}

func TestImportChannelBundleFromSetReadsRemoteChannelsAndSecrets(t *testing.T) {
	var keyFetched bool
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "GET /api/channel/search":
			writeGatewayChannelJSON(t, w, map[string]any{
				"success": true,
				"data": map[string]any{
					"items": []map[string]any{
						{
							"id":       17,
							"name":     "MiniMax",
							"type":     1,
							"status":   1,
							"models":   "minimax-m2.7",
							"group":    "default",
							"base_url": "https://tokenhub.tencentmaas.com",
						},
						{
							"id":       18,
							"name":     "llmgw-byok-private-provider",
							"type":     1,
							"status":   1,
							"models":   "private-model",
							"group":    "byok_private_user",
							"base_url": "https://private.example.com",
						},
					},
					"total": 2,
				},
			})
		case "GET /api/option/":
			writeGatewayChannelJSON(t, w, map[string]any{
				"success": true,
				"data": []map[string]any{
					{"key": "ModelRatio", "value": `{"minimax-m2.7":1,"auto":1}`},
					{"key": "CompletionRatio", "value": `{"minimax-m2.7":1,"auto":1}`},
					{"key": "SystemName", "value": "must-not-be-imported"},
				},
			})
		case "POST /api/verify":
			var req struct {
				Method string `json:"method"`
				Code   string `json:"code"`
			}
			decodeGatewayChannelJSON(t, r, &req)
			if req.Method != "2fa" || req.Code == "" {
				t.Fatalf("unexpected verify request: %+v", req)
			}
			writeGatewayChannelJSON(t, w, map[string]any{"success": true, "data": map[string]any{"verified": true}})
		case "POST /api/channel/17/key":
			keyFetched = true
			writeGatewayChannelJSON(t, w, map[string]any{"success": true, "data": map[string]any{"key": "sk-provider"}})
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer upstream.Close()

	store := NewMemoryStore()
	svc := NewService(store, upstream.Client().Transport, Options{})
	saveReadySet(t, store, "set-a", upstream.URL)
	set, ok, err := store.GetSet(t.Context(), "set-a")
	if err != nil || !ok {
		t.Fatalf("set ok=%v err=%v", ok, err)
	}
	set.AdminTOTPSecret = "JBSWY3DPEHPK3PXP"
	if err := store.SaveSet(t.Context(), set); err != nil {
		t.Fatal(err)
	}

	bundle, err := svc.ImportChannelBundleFromSet(t.Context(), ImportChannelBundleInput{
		SourceSetID: "set-a",
		ID:          "golden",
		Name:        "Golden channels",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !keyFetched {
		t.Fatal("remote channel key was not fetched")
	}
	if bundle.SourceSetID != "set-a" || len(bundle.Spec.Channels) != 1 {
		t.Fatalf("unexpected imported bundle: %+v", bundle)
	}
	if len(bundle.Spec.Options) != 2 || bundle.Spec.Options[0].Key != "CompletionRatio" || bundle.Spec.Options[1].Key != "ModelRatio" {
		t.Fatalf("unexpected imported pricing options: %+v", bundle.Spec.Options)
	}
	channel := bundle.Spec.Channels[0]
	if channel.ID != "minimax" || channel.Name != "MiniMax" || channel.Key != "sk-provider" || channel.KeyHash == "" {
		t.Fatalf("unexpected imported channel: %+v", channel)
	}
	if strings.Contains(string(mustMarshalBundleTest(t, bundle)), "sk-provider") {
		t.Fatalf("imported bundle response leaked provider key: %+v", bundle)
	}
}

func TestDesiredConfigExportAndImportPreservesPlaintextKeys(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "GET /api/channel/search":
			writeGatewayChannelJSON(t, w, map[string]any{
				"success": true,
				"data": map[string]any{"items": []map[string]any{{
					"id": 17, "name": "DeepSeek", "type": 1, "status": 1,
					"models": "auto,deepseek-v4-pro-202606", "group": "default",
					"base_url":      "https://tokenhub.tencentmaas.com",
					"model_mapping": `{"auto":"deepseek-v4-pro-202606"}`,
				}}, "total": 1},
			})
		case "GET /api/option/":
			writeGatewayChannelJSON(t, w, map[string]any{
				"success": true,
				"data": []map[string]any{
					{"key": "ModelRatio", "value": `{"auto":1,"deepseek-v4-pro-202606":1}`},
					{"key": "CompletionRatio", "value": `{"auto":1,"deepseek-v4-pro-202606":1}`},
				},
			})
		case "POST /api/verify":
			writeGatewayChannelJSON(t, w, map[string]any{"success": true})
		case "POST /api/channel/17/key":
			writeGatewayChannelJSON(t, w, map[string]any{"success": true, "data": map[string]any{"key": "sk-plain-backup"}})
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer upstream.Close()

	sourceStore := NewMemoryStore()
	sourceService := NewService(sourceStore, upstream.Client().Transport, Options{})
	saveReadySet(t, sourceStore, "set-a", upstream.URL)
	set, _, _ := sourceStore.GetSet(t.Context(), "set-a")
	set.AdminTOTPSecret = "JBSWY3DPEHPK3PXP"
	if err := sourceStore.SaveSet(t.Context(), set); err != nil {
		t.Fatal(err)
	}

	manifest, err := sourceService.ExportDesiredConfigFromSet(t.Context(), ImportChannelBundleInput{
		SourceSetID: "set-a",
		ID:          "production",
		Name:        "Production channels",
	})
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"key":"sk-plain-backup"`) {
		t.Fatalf("desired config export did not contain plaintext key: %s", raw)
	}
	if len(manifest.GlobalOptions) != 2 || len(manifest.ChannelBundles) != 1 {
		t.Fatalf("unexpected desired config export: %+v", manifest)
	}

	targetStore := NewMemoryStore()
	targetService := NewService(targetStore, nil, Options{})
	imported, err := targetService.ImportDesiredConfig(t.Context(), manifest)
	if err != nil {
		t.Fatal(err)
	}
	if len(imported) != 1 {
		t.Fatalf("imported bundles = %d, want 1", len(imported))
	}
	stored, ok, err := targetStore.GetChannelBundle(t.Context(), "production")
	if err != nil || !ok {
		t.Fatalf("stored bundle ok=%v err=%v", ok, err)
	}
	if got := stored.Spec.Channels[0].Key; got != "sk-plain-backup" {
		t.Fatalf("restored plaintext key = %q", got)
	}
	if len(stored.Spec.Options) != 2 {
		t.Fatalf("restored global options = %+v", stored.Spec.Options)
	}
}

func TestDesiredConfigExportRetriesWhenProviderKeyChangesMidSnapshot(t *testing.T) {
	keyReads := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "GET /api/channel/search":
			writeGatewayChannelJSON(t, w, map[string]any{"success": true, "data": map[string]any{
				"items": []map[string]any{{"id": 17, "name": "Provider", "type": 1, "status": 1, "models": "auto", "group": "default"}},
				"total": 1,
			}})
		case "GET /api/option/":
			writeGatewayChannelJSON(t, w, map[string]any{"success": true, "data": []map[string]any{}})
		case "POST /api/verify":
			writeGatewayChannelJSON(t, w, map[string]any{"success": true})
		case "POST /api/channel/17/key":
			keyReads++
			key := "sk-new"
			if keyReads == 1 {
				key = "sk-old"
			}
			writeGatewayChannelJSON(t, w, map[string]any{"success": true, "data": map[string]any{"key": key}})
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer upstream.Close()

	store := NewMemoryStore()
	svc := NewService(store, upstream.Client().Transport, Options{})
	saveReadySet(t, store, "set-a", upstream.URL)
	set, _, _ := store.GetSet(t.Context(), "set-a")
	set.AdminTOTPSecret = "JBSWY3DPEHPK3PXP"
	if err := store.SaveSet(t.Context(), set); err != nil {
		t.Fatal(err)
	}

	manifest, err := svc.ExportDesiredConfigFromSet(t.Context(), ImportChannelBundleInput{SourceSetID: "set-a", ID: "golden", Name: "Golden"})
	if err != nil {
		t.Fatal(err)
	}
	if keyReads != 4 {
		t.Fatalf("key reads = %d, want two inconsistent reads followed by two stable reads", keyReads)
	}
	if got := manifest.ChannelBundles[0].Channels[0].Key; got != "sk-new" {
		t.Fatalf("exported mixed-time key %q", got)
	}
}

func TestChannelBundleChannelFromRemotePreservesDesiredConfiguration(t *testing.T) {
	autoBan := 0
	tag := "production"
	setting := `{"region":"ap-beijing"}`
	paramOverride := `{"service_tier":"auto"}`
	headerOverride := `{"X-Tenant":"vela"}`
	remark := "primary provider"
	statusCodeMapping := `{"429":503}`
	organization := "org-vela"
	testModel := "deepseek-v4-pro-202606"
	baseURL := "https://provider.example.com"
	modelMapping := `{"auto":"deepseek-v4-pro-202606"}`
	priority := int64(0)
	weight := uint(0)

	channel := channelBundleChannelFromRemote(newapi.Channel{
		ID:                 17,
		Type:               1,
		Status:             newapi.ChannelStatusAutoDisabled,
		Name:               "DeepSeek",
		Weight:             &weight,
		BaseURL:            &baseURL,
		Models:             "auto,deepseek-v4-pro-202606",
		Group:              "default",
		ModelMapping:       &modelMapping,
		Priority:           &priority,
		AutoBan:            &autoBan,
		Tag:                &tag,
		Setting:            &setting,
		ParamOverride:      &paramOverride,
		HeaderOverride:     &headerOverride,
		Remark:             &remark,
		Other:              "ap-beijing",
		StatusCodeMapping:  &statusCodeMapping,
		OtherSettings:      `{"azure_responses_version":"2025-04-01-preview"}`,
		OpenAIOrganization: &organization,
		TestModel:          &testModel,
		ChannelInfo: newapi.ChannelInfo{
			IsMultiKey:   true,
			MultiKeyMode: "random",
		},
	}, "sk-one\nsk-two", map[string]int{})

	if channel.Status != ChannelSpecStatusEnabled {
		t.Fatalf("auto-disabled runtime status became desired status %q", channel.Status)
	}
	if channel.AutoBan == nil || *channel.AutoBan != 0 || channel.Tag != tag || channel.Other != "ap-beijing" || channel.StatusCodeMapping != statusCodeMapping {
		t.Fatalf("extended channel fields were not preserved: %+v", channel)
	}
	if channel.OtherSettings == "" || channel.OpenAIOrganization != organization || channel.TestModel != testModel {
		t.Fatalf("provider channel fields were not preserved: %+v", channel)
	}
	if !channel.IsMultiKey || channel.MultiKeyMode != "random" {
		t.Fatalf("multi-key configuration was not preserved: %+v", channel)
	}
}

func TestChannelBundleDesiredSpecsCanonicalizesLegacyAutoBanDefault(t *testing.T) {
	legacy := ChannelBundle{
		ID:   "legacy",
		Name: "Legacy bundle",
		Spec: ChannelBundleSpec{
			Channels: []ChannelBundleChannel{{
				ID:      "platform",
				Name:    "Platform",
				Type:    1,
				BaseURL: "https://provider.example.com",
				Models:  "auto",
				Group:   "default",
				Status:  ChannelSpecStatusEnabled,
			}},
		},
	}

	spec := channelBundleDesiredSpecs(legacy)[0]
	if spec.AutoBan == nil || *spec.AutoBan != 1 {
		t.Fatalf("legacy auto_ban was not canonicalized: %+v", spec.AutoBan)
	}
	remote := newAPIChannelFromSpec(spec, 17, false)
	if got := remoteChannelFingerprint(remote); got != spec.Fingerprint {
		t.Fatalf("canonical desired fingerprint %q differs from equivalent remote %q", spec.Fingerprint, got)
	}
}

func TestChannelSyncConvergesStaleAppliedFingerprintWhenRemoteMatchesDesired(t *testing.T) {
	autoBan := 1
	baseURL := "https://provider.example.com"
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/api/channel/search" {
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		writeGatewayChannelJSON(t, w, map[string]any{
			"success": true,
			"data": map[string]any{
				"items": []newapi.Channel{{
					ID:      17,
					Name:    "llmgw:platform:Platform",
					Type:    1,
					Status:  newapi.ChannelStatusEnabled,
					BaseURL: &baseURL,
					Models:  "auto",
					Group:   "default",
					AutoBan: &autoBan,
				}},
				"total": 1,
			},
		})
	}))
	defer upstream.Close()

	store := NewMemoryStore()
	svc := NewService(store, upstream.Client().Transport, Options{})
	saveReadySet(t, store, "set-a", upstream.URL)
	spec := channelSpecFromBundleChannel(ChannelBundleChannel{
		ID:      "platform",
		Name:    "Platform",
		Type:    1,
		Key:     "sk-provider",
		BaseURL: baseURL,
		Models:  "auto",
		Group:   "default",
		Status:  ChannelSpecStatusEnabled,
	})
	if err := store.SaveChannelSyncState(t.Context(), ChannelSyncState{
		ChannelID:          spec.ID,
		SetID:              "set-a",
		Status:             ChannelSyncStatusSynced,
		AppliedFingerprint: "legacy-fingerprint",
		LastAppliedKeyHash: spec.KeyHash,
	}); err != nil {
		t.Fatal(err)
	}

	state, err := svc.syncChannelSpecToSet(t.Context(), spec, "set-a", ChannelSyncOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if state.Status != ChannelSyncStatusSynced || state.AppliedFingerprint != spec.Fingerprint {
		t.Fatalf("equivalent remote did not converge stale state: %+v", state)
	}
}

func TestNewAPIChannelFromSpecCanClearOptionalFieldsAndDisableChannel(t *testing.T) {
	autoBan := 0
	channel := newAPIChannelFromSpec(ChannelSpec{
		ID: "platform", DesiredRemoteName: "llmgw:platform:Platform", Name: "Platform",
		Type: 1, Status: ChannelSpecStatusDisabled, Models: "auto", Group: "default",
		AutoBan: &autoBan,
	}, 17, false)

	if channel.Status != newapi.ChannelStatusManuallyDisabled {
		t.Fatalf("disabled desired channel status = %d, want %d", channel.Status, newapi.ChannelStatusManuallyDisabled)
	}
	if channel.Priority == nil || *channel.Priority != 0 || channel.Weight == nil || *channel.Weight != 0 {
		t.Fatalf("zero numeric values must be explicit pointers: %+v", channel)
	}
	for name, value := range map[string]*string{
		"base_url": channel.BaseURL, "model_mapping": channel.ModelMapping,
		"setting": channel.Setting, "param_override": channel.ParamOverride,
		"header_override": channel.HeaderOverride, "remark": channel.Remark,
		"tag": channel.Tag, "status_code_mapping": channel.StatusCodeMapping,
		"openai_organization": channel.OpenAIOrganization, "test_model": channel.TestModel,
	} {
		if value == nil || *value != "" {
			t.Errorf("%s cannot be explicitly cleared: %#v", name, value)
		}
	}
}

func TestImportedChannelBundleOptionsCoversBillingRoutingAndChannelPolicy(t *testing.T) {
	required := []string{
		"ModelPrice", "GroupGroupRatio", "UserUsableGroups",
		"billing_setting.billing_mode", "billing_setting.billing_expr",
		"QuotaPerUnit", "quota_setting.enable_free_model_pre_consume",
		"group_ratio_setting.group_special_usable_group",
		"AutoGroups", "DefaultUseAutoGroup", "tool_price_setting.prices",
		"AutomaticDisableChannelEnabled", "AutomaticEnableChannelEnabled",
		"ChannelDisableThreshold", "AutomaticDisableKeywords",
		"AutomaticDisableStatusCodes", "AutomaticRetryStatusCodes",
		"RetryTimes", "PreConsumedQuota", "SelfUseModeEnabled",
		"global.pass_through_request_enabled", "claude.default_max_tokens",
		"gemini.version_settings", "channel_affinity_setting.enabled",
	}
	remote := make([]newapi.Option, 0, len(required)+1)
	for _, key := range required {
		value := `{}`
		if key == "AutoGroups" {
			value = `[]`
		}
		remote = append(remote, newapi.Option{Key: key, Value: value})
	}
	remote = append(remote, newapi.Option{Key: "StripeApiSecret", Value: "must-not-export"})

	options, err := importedChannelBundleOptions(remote)
	if err != nil {
		t.Fatal(err)
	}
	got := make(map[string]bool, len(options))
	for _, option := range options {
		got[option.Key] = true
	}
	for _, key := range required {
		if !got[key] {
			t.Errorf("required desired option %q was omitted", key)
		}
	}
	if got["StripeApiSecret"] {
		t.Fatal("unrelated payment secret was exported")
	}
}

func TestImportedChannelBundleOptionsRemovesPerTenantBYOKGroups(t *testing.T) {
	options, err := importedChannelBundleOptions([]newapi.Option{
		{Key: "GroupRatio", Value: `{"default":1,"byok_user_1":0}`},
		{Key: "UserUsableGroups", Value: `{"default":"Default","byok_user_1":"Private"}`},
		{Key: "AutoGroups", Value: `["default","byok_user_1"]`},
		{Key: "GroupGroupRatio", Value: `{"default":{"default":1,"byok_user_1":0},"byok_user_1":{"default":0}}`},
		{Key: "group_ratio_setting.group_special_usable_group", Value: `{"default":{"append":"default","private":"byok_user_1"},"byok_user_1":{"append":"default"}}`},
	})
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(options)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "byok_user_1") {
		t.Fatalf("per-tenant BYOK group leaked into platform desired config: %s", raw)
	}
}

func saveReadySet(t *testing.T, store Store, id string, baseURL string) {
	t.Helper()
	if err := store.SaveSet(t.Context(), Set{
		ID:               id,
		Name:             id,
		BaseURL:          baseURL,
		Status:           SetStatusActive,
		Setup:            true,
		AdminUserID:      1,
		AdminAccessToken: "set-admin-token",
	}); err != nil {
		t.Fatal(err)
	}
}

func mustMarshalBundleTest(t *testing.T, value any) []byte {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return data
}
