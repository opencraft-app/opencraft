package gateway

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestReconcileSetGroupRatiosUsesOnlyLocalDesiredState(t *testing.T) {
	var optionReads atomic.Int32
	var optionWrites atomic.Int32
	var written string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method + " " + r.URL.Path {
		case "GET /api/option/":
			optionReads.Add(1)
			writeGatewayChannelJSON(t, w, map[string]any{
				"success": true,
				"data":    []map[string]any{{"key": "GroupRatio", "value": `{"default":1}`}},
			})
		case "PUT /api/option/":
			optionWrites.Add(1)
			var request struct {
				Key   string `json:"key"`
				Value string `json:"value"`
			}
			decodeGatewayChannelJSON(t, r, &request)
			if request.Key != newAPIGroupRatioOptionKey {
				t.Fatalf("option key = %q, want %q", request.Key, newAPIGroupRatioOptionKey)
			}
			written = request.Value
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
	if _, err := store.ReplacePlatformGroupRatios(t.Context(), "set-a", "bundle-stable", map[string]float64{"default": 1, "vip": 2}); err != nil {
		t.Fatal(err)
	}
	for _, userID := range []string{"user-a", "user-b"} {
		if _, err := store.SaveBYOKSyncIntent(t.Context(), testBYOKSyncIntent(userID, "set-a", true)); err != nil {
			t.Fatal(err)
		}
	}

	set, _, err := store.GetSet(t.Context(), "set-a")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.reconcileSetGroupRatios(t.Context(), set); err != nil {
		t.Fatal(err)
	}
	if optionReads.Load() != 0 {
		t.Fatalf("new-api option reads = %d, want 0", optionReads.Load())
	}
	if optionWrites.Load() != 1 {
		t.Fatalf("new-api option writes = %d, want 1", optionWrites.Load())
	}
	var ratios map[string]float64
	if err := json.Unmarshal([]byte(written), &ratios); err != nil {
		t.Fatal(err)
	}
	want := map[string]float64{
		"default":                  1,
		"vip":                      2,
		byokGroupForUser("user-a"): 0,
		byokGroupForUser("user-b"): 0,
	}
	if comparableChannelBundleOptionValue(ratios) != comparableChannelBundleOptionValue(want) {
		t.Fatalf("written GroupRatio = %#v, want %#v", ratios, want)
	}
	state, ok, err := store.GetGroupRatioApplyState(t.Context(), "set-a")
	if err != nil || !ok {
		t.Fatalf("get apply state = %v, %v", ok, err)
	}
	if state.Status != GroupRatioApplyStatusSynced || state.AppliedVersion != state.DesiredVersion || state.AppliedFingerprint == "" {
		t.Fatalf("unexpected apply state: %+v", state)
	}
	foundTelemetry := false
	for _, event := range *telemetryEvents {
		if event.event.Name == "llmgateway.config.state_changed" {
			entity, _ := telemetryAttributeValue(event.event, "llmgateway.entity.type")
			if entity.AsString() == "group_ratio_apply" {
				foundTelemetry = true
				requireTelemetryString(t, event.event, "llmgateway.set.id", "set-a")
			}
		}
	}
	if !foundTelemetry {
		t.Fatalf("missing GroupRatio committed telemetry: %+v", *telemetryEvents)
	}
}

func TestReconcileSetGroupRatiosKeepsPendingWhenIntentChangesDuringPush(t *testing.T) {
	store := NewMemoryStore()
	var changed atomic.Bool
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut || r.URL.Path != "/api/option/" {
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		if changed.CompareAndSwap(false, true) {
			if _, err := store.SaveBYOKSyncIntent(r.Context(), testBYOKSyncIntent("user-late", "set-a", true)); err != nil {
				t.Fatal(err)
			}
		}
		writeGatewayChannelJSON(t, w, map[string]any{"success": true})
	}))
	defer upstream.Close()

	svc := NewService(store, upstream.Client().Transport, Options{})
	saveReadySet(t, store, "set-a", upstream.URL)
	if _, err := store.ReplacePlatformGroupRatios(t.Context(), "set-a", "bundle-stable", map[string]float64{"default": 1}); err != nil {
		t.Fatal(err)
	}
	set, _, _ := store.GetSet(t.Context(), "set-a")
	result, err := svc.reconcileSetGroupRatios(t.Context(), set)
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != GroupRatioApplyStatusPending || result.DesiredVersion <= result.AppliedVersion {
		t.Fatalf("apply result = %+v, want newer desired version pending", result)
	}
	if _, err := svc.reconcileSetGroupRatios(t.Context(), set); err != nil {
		t.Fatal(err)
	}
	state, _, _ := store.GetGroupRatioApplyState(t.Context(), "set-a")
	if state.Status != GroupRatioApplyStatusSynced || state.DesiredVersion != state.AppliedVersion {
		t.Fatalf("second reconcile did not converge: %+v", state)
	}
}

func TestSaveBYOKSyncIntentMovesUserAndDirtiesBothSets(t *testing.T) {
	store := NewMemoryStore()
	if _, err := store.SaveBYOKSyncIntent(t.Context(), testBYOKSyncIntent("user-a", "set-a", true)); err != nil {
		t.Fatal(err)
	}
	beforeA, _, _ := store.GetGroupRatioApplyState(t.Context(), "set-a")
	if _, err := store.SaveBYOKSyncIntent(t.Context(), testBYOKSyncIntent("user-a", "set-b", true)); err != nil {
		t.Fatal(err)
	}
	afterA, _, _ := store.GetGroupRatioApplyState(t.Context(), "set-a")
	afterB, _, _ := store.GetGroupRatioApplyState(t.Context(), "set-b")
	if afterA.DesiredVersion != beforeA.DesiredVersion+1 || afterA.Status != GroupRatioApplyStatusPending {
		t.Fatalf("old Set was not dirtied: before=%+v after=%+v", beforeA, afterA)
	}
	if afterB.DesiredVersion != 1 || afterB.Status != GroupRatioApplyStatusPending {
		t.Fatalf("new Set was not dirtied: %+v", afterB)
	}
	oldSnapshot, err := store.GetGroupRatioSnapshot(t.Context(), "set-a")
	if err != nil {
		t.Fatal(err)
	}
	newSnapshot, err := store.GetGroupRatioSnapshot(t.Context(), "set-b")
	if err != nil {
		t.Fatal(err)
	}
	if len(oldSnapshot.Entries) != 0 || len(newSnapshot.Entries) != 1 || newSnapshot.Entries[0].ExternalUserID != "user-a" {
		t.Fatalf("unexpected moved projection: old=%+v new=%+v", oldSnapshot, newSnapshot)
	}
}

func TestReplacePlatformGroupRatiosPreservesLocalBYOKRows(t *testing.T) {
	store := NewMemoryStore()
	if _, err := store.SaveBYOKSyncIntent(t.Context(), testBYOKSyncIntent("user-a", "set-a", true)); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReplacePlatformGroupRatios(t.Context(), "set-a", "bundle-v1", map[string]float64{"legacy": 3, "default": 1}); err != nil {
		t.Fatal(err)
	}
	before, _, _ := store.GetGroupRatioApplyState(t.Context(), "set-a")
	if _, err := store.ReplacePlatformGroupRatios(t.Context(), "set-a", "bundle-v2", map[string]float64{"default": 2}); err != nil {
		t.Fatal(err)
	}
	snapshot, err := store.GetGroupRatioSnapshot(t.Context(), "set-a")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]float64{}
	for _, entry := range snapshot.Entries {
		got[entry.GroupName] = entry.Ratio
	}
	if _, ok := got["legacy"]; ok {
		t.Fatalf("stale platform ratio survived replacement: %+v", got)
	}
	if got["default"] != 2 {
		t.Fatalf("platform ratio was not replaced: %+v", got)
	}
	if ratio, ok := got[byokGroupForUser("user-a")]; !ok || ratio != 0 {
		t.Fatalf("BYOK ratio was lost: %+v", got)
	}
	after, _, _ := store.GetGroupRatioApplyState(t.Context(), "set-a")
	if after.DesiredVersion != before.DesiredVersion+1 {
		t.Fatalf("desired version = %d, want %d", after.DesiredVersion, before.DesiredVersion+1)
	}
}

func TestEnqueueUserLLMSettingsSyncPersistsGroupIntentBeforeWorker(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	intent := testBYOKSyncIntent("user-a", "set-a", true)
	if err := store.SaveUserLLMSettings(t.Context(), intent.Settings); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveUserBinding(t.Context(), UserBinding{
		ExternalUserID: "user-a", SetID: "set-a", Username: "user-a", CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatal(err)
	}

	result, err := svc.EnqueueUserLLMSettingsSync(t.Context(), "user-a")
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != BYOKSyncTaskStatusPending || result.RequestedVersion != 1 {
		t.Fatalf("unexpected enqueue result: %+v", result)
	}
	snapshot, err := store.GetGroupRatioSnapshot(t.Context(), "set-a")
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Entries) != 1 || snapshot.Entries[0].GroupName != byokGroupForUser("user-a") {
		t.Fatalf("group intent was not persisted before worker: %+v", snapshot)
	}
	settings, _, _ := store.GetUserLLMSettings(t.Context(), "user-a")
	if settings.Providers[0].SyncStatus != LLMProviderSyncPending {
		t.Fatalf("provider status = %q, want pending", settings.Providers[0].SyncStatus)
	}
}

func TestEnqueueUserLLMSettingsSyncRemovesGroupWhenAllProvidersDisabled(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	active := testBYOKSyncIntent("user-a", "set-a", true)
	active.Settings.BYOKGroup = active.GroupName
	active.Settings.BYOKUpstreamKey = "sk-old-byok"
	active.Settings.BYOKUpstreamKeyID = 77
	if _, err := store.SaveBYOKSyncIntent(t.Context(), active); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveUserBinding(t.Context(), UserBinding{
		ExternalUserID: "user-a", SetID: "set-a", Username: "user-a", CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatal(err)
	}
	disabled := testBYOKSyncIntent("user-a", "set-a", false).Settings
	if _, err := svc.SaveUserLLMSettings(t.Context(), "user-a", disabled); err != nil {
		t.Fatal(err)
	}
	before, _, _ := store.GetGroupRatioApplyState(t.Context(), "set-a")

	if _, err := svc.EnqueueUserLLMSettingsSync(t.Context(), "user-a"); err != nil {
		t.Fatal(err)
	}
	snapshot, err := store.GetGroupRatioSnapshot(t.Context(), "set-a")
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Entries) != 0 {
		t.Fatalf("disabled BYOK group still desired: %+v", snapshot.Entries)
	}
	saved, _, _ := store.GetUserLLMSettings(t.Context(), "user-a")
	if saved.BYOKGroup != "" || saved.BYOKUpstreamKey != "" || saved.BYOKUpstreamKeyID != 0 {
		t.Fatalf("disabled BYOK route was retained: %+v", saved)
	}
	after, _, _ := store.GetGroupRatioApplyState(t.Context(), "set-a")
	if after.DesiredVersion != before.DesiredVersion+1 || after.Status != GroupRatioApplyStatusPending {
		t.Fatalf("deletion did not dirty Set: before=%+v after=%+v", before, after)
	}
}

func TestSyncUserLLMSettingsMovesDisabledBYOKUserBackToDefaultGroup(t *testing.T) {
	var updatedGroup string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method + " " + r.URL.Path {
		case "PUT /api/option/":
			writeGatewayChannelJSON(t, w, map[string]any{"success": true})
		case "GET /api/user/search":
			writeGatewayChannelJSON(t, w, map[string]any{"success": true, "data": map[string]any{
				"items": []map[string]any{{"id": 42, "username": "user-a", "display_name": "User A", "role": 1, "status": 1, "group": byokGroupForUser("user-a")}},
			}})
		case "PUT /api/user/":
			var request struct {
				Group string `json:"group"`
			}
			decodeGatewayChannelJSON(t, r, &request)
			updatedGroup = request.Group
			writeGatewayChannelJSON(t, w, map[string]any{"success": true})
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer upstream.Close()
	store := NewMemoryStore()
	svc := NewService(store, upstream.Client().Transport, Options{})
	saveReadySet(t, store, "set-a", upstream.URL)
	if _, err := store.ReplacePlatformGroupRatios(t.Context(), "set-a", "stable", map[string]float64{"default": 1}); err != nil {
		t.Fatal(err)
	}
	active := testBYOKSyncIntent("user-a", "set-a", true)
	active.Settings.BYOKGroup = active.GroupName
	active.Settings.BYOKUpstreamKey = "sk-old-byok"
	active.Settings.BYOKUpstreamKeyID = 77
	if _, err := store.SaveBYOKSyncIntent(t.Context(), active); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveUserBinding(t.Context(), UserBinding{
		ExternalUserID: "user-a", SetID: "set-a", UpstreamUserID: 42, Username: "user-a",
		ProvisionStatus: BindingProvisionStatusTokenReady, CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.SaveUserLLMSettings(t.Context(), "user-a", testBYOKSyncIntent("user-a", "set-a", false).Settings); err != nil {
		t.Fatal(err)
	}
	result, err := svc.SyncUserLLMSettings(t.Context(), "user-a")
	if err != nil {
		t.Fatal(err)
	}
	if updatedGroup != newAPIDefaultGroup || result.BYOKGroup != "" {
		t.Fatalf("updated group=%q result=%+v, want default with no BYOK group", updatedGroup, result)
	}
}

func TestApplyChannelBundleGroupRatioUsesAuthoritativeProjection(t *testing.T) {
	var optionReads atomic.Int32
	var written string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method + " " + r.URL.Path {
		case "GET /api/option/":
			optionReads.Add(1)
			writeGatewayChannelJSON(t, w, map[string]any{"success": true, "data": []any{}})
		case "PUT /api/option/":
			var request struct {
				Key   string `json:"key"`
				Value string `json:"value"`
			}
			decodeGatewayChannelJSON(t, r, &request)
			written = request.Value
			writeGatewayChannelJSON(t, w, map[string]any{"success": true})
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer upstream.Close()

	store := NewMemoryStore()
	svc := NewService(store, upstream.Client().Transport, Options{})
	saveReadySet(t, store, "set-a", upstream.URL)
	if _, err := store.SaveBYOKSyncIntent(t.Context(), testBYOKSyncIntent("user-a", "set-a", true)); err != nil {
		t.Fatal(err)
	}
	bundle := ChannelBundle{
		ID: "stable", Name: "Stable", Fingerprint: "fp-stable",
		Spec: ChannelBundleSpec{Options: []ChannelBundleOption{{Key: newAPIGroupRatioOptionKey, Value: `{"default":1,"vip":2}`}}},
	}
	if err := svc.applyChannelBundleOptions(t.Context(), bundle, "set-a"); err != nil {
		t.Fatal(err)
	}
	if optionReads.Load() != 0 {
		t.Fatalf("channel apply read new-api GroupRatio %d times", optionReads.Load())
	}
	var got map[string]float64
	if err := json.Unmarshal([]byte(written), &got); err != nil {
		t.Fatal(err)
	}
	if got["default"] != 1 || got["vip"] != 2 {
		t.Fatalf("platform ratios missing: %+v", got)
	}
	if ratio, ok := got[byokGroupForUser("user-a")]; !ok || ratio != 0 {
		t.Fatalf("local BYOK ratio missing: %+v", got)
	}
}

func TestBYOKWorkerPreparesSetFromLocalSnapshotWithoutOptionRead(t *testing.T) {
	var optionReads atomic.Int32
	var optionWrites atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method + " " + r.URL.Path {
		case "GET /api/option/":
			optionReads.Add(1)
			writeGatewayChannelJSON(t, w, map[string]any{"success": true, "data": []any{}})
		case "PUT /api/option/":
			optionWrites.Add(1)
			writeGatewayChannelJSON(t, w, map[string]any{"success": true})
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer upstream.Close()

	store := NewMemoryStore()
	svc := NewService(store, upstream.Client().Transport, Options{})
	saveReadySet(t, store, "set-a", upstream.URL)
	if _, err := store.ReplacePlatformGroupRatios(t.Context(), "set-a", "stable", map[string]float64{"default": 1}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.SaveBYOKSyncIntent(t.Context(), testBYOKSyncIntent("user-a", "set-a", true)); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan error, 1)
	result := make(chan BYOKWorkerResult, 1)
	go func() {
		done <- svc.runBYOKWorker(ctx, "worker-a", BYOKWorkerOptions{
			PollInterval: time.Millisecond, LeaseTTL: time.Minute, MaxConcurrency: 1, SetConcurrency: 1, CandidateBatch: 1,
		}, func(context.Context, string) error { return nil }, func(workerResult BYOKWorkerResult) {
			result <- workerResult
			cancel()
		})
	}()
	select {
	case workerResult := <-result:
		if workerResult.Err != nil {
			t.Fatal(workerResult.Err)
		}
	case <-time.After(time.Second):
		cancel()
		t.Fatal("BYOK worker did not process task")
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if optionReads.Load() != 0 || optionWrites.Load() != 1 {
		t.Fatalf("new-api option reads=%d writes=%d, want 0/1", optionReads.Load(), optionWrites.Load())
	}
}

func TestReconcileSetGroupRatiosBootstrapsPlatformFromAppliedBundle(t *testing.T) {
	var written string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut || r.URL.Path != "/api/option/" {
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		var request struct {
			Value string `json:"value"`
		}
		decodeGatewayChannelJSON(t, r, &request)
		written = request.Value
		writeGatewayChannelJSON(t, w, map[string]any{"success": true})
	}))
	defer upstream.Close()

	store := NewMemoryStore()
	svc := NewService(store, upstream.Client().Transport, Options{})
	saveReadySet(t, store, "set-a", upstream.URL)
	bundle, err := svc.UpsertChannelBundle(t.Context(), ChannelBundle{
		ID: "stable", Name: "Stable",
		Spec: ChannelBundleSpec{Options: []ChannelBundleOption{{Key: newAPIGroupRatioOptionKey, Value: `{"default":1,"vip":2}`}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SaveChannelBundleSyncState(t.Context(), ChannelBundleSyncState{
		BundleID: bundle.ID, SetID: "set-a", Status: ChannelSyncStatusSynced,
		AppliedFingerprint: bundle.Fingerprint, DesiredFingerprint: bundle.Fingerprint,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.SaveBYOKSyncIntent(t.Context(), testBYOKSyncIntent("user-a", "set-a", true)); err != nil {
		t.Fatal(err)
	}
	set, _, _ := store.GetSet(t.Context(), "set-a")
	if _, err := svc.reconcileSetGroupRatios(t.Context(), set); err != nil {
		t.Fatal(err)
	}
	var got map[string]float64
	if err := json.Unmarshal([]byte(written), &got); err != nil {
		t.Fatal(err)
	}
	if got["default"] != 1 || got["vip"] != 2 {
		t.Fatalf("stable platform ratios were not bootstrapped: %+v", got)
	}
	if ratio, ok := got[byokGroupForUser("user-a")]; !ok || ratio != 0 {
		t.Fatalf("BYOK ratio missing after bootstrap: %+v", got)
	}
}

func TestReconcileSetGroupRatiosRefusesPushWithoutPlatformTruth(t *testing.T) {
	var writes atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writes.Add(1)
		writeGatewayChannelJSON(t, w, map[string]any{"success": true})
	}))
	defer upstream.Close()
	store := NewMemoryStore()
	svc := NewService(store, upstream.Client().Transport, Options{})
	saveReadySet(t, store, "set-a", upstream.URL)
	if _, err := store.SaveBYOKSyncIntent(t.Context(), testBYOKSyncIntent("user-a", "set-a", true)); err != nil {
		t.Fatal(err)
	}
	set, _, _ := store.GetSet(t.Context(), "set-a")
	if _, err := svc.reconcileSetGroupRatios(t.Context(), set); err == nil || !strings.Contains(err.Error(), "platform GroupRatio") {
		t.Fatalf("error = %v, want missing platform truth", err)
	}
	if writes.Load() != 0 {
		t.Fatalf("new-api writes = %d, want 0", writes.Load())
	}
	state, _, _ := store.GetGroupRatioApplyState(t.Context(), "set-a")
	if state.Status != GroupRatioApplyStatusError || !strings.Contains(state.LastError, "platform GroupRatio") {
		t.Fatalf("missing platform truth was not recorded: %+v", state)
	}
}

func TestReconcileSetGroupRatiosRefusesConflictingAppliedPlatformTruth(t *testing.T) {
	var writes atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writes.Add(1)
		writeGatewayChannelJSON(t, w, map[string]any{"success": true})
	}))
	defer upstream.Close()

	store := NewMemoryStore()
	svc := NewService(store, upstream.Client().Transport, Options{})
	saveReadySet(t, store, "set-a", upstream.URL)
	for _, item := range []struct {
		id    string
		ratio float64
	}{
		{id: "stable-a", ratio: 1},
		{id: "stable-b", ratio: 2},
	} {
		bundle, err := svc.UpsertChannelBundle(t.Context(), ChannelBundle{
			ID: item.id, Name: item.id,
			Spec: ChannelBundleSpec{Options: []ChannelBundleOption{{Key: newAPIGroupRatioOptionKey, Value: map[string]float64{"default": item.ratio}}}},
		})
		if err != nil {
			t.Fatal(err)
		}
		if err := store.SaveChannelBundleSyncState(t.Context(), ChannelBundleSyncState{
			BundleID: bundle.ID, SetID: "set-a", Status: ChannelSyncStatusSynced,
			AppliedFingerprint: bundle.Fingerprint, DesiredFingerprint: bundle.Fingerprint,
		}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := store.SaveBYOKSyncIntent(t.Context(), testBYOKSyncIntent("user-a", "set-a", true)); err != nil {
		t.Fatal(err)
	}
	set, _, _ := store.GetSet(t.Context(), "set-a")
	if _, err := svc.reconcileSetGroupRatios(t.Context(), set); err == nil || !strings.Contains(err.Error(), "conflicts") {
		t.Fatalf("error = %v, want conflicting platform truth", err)
	}
	if writes.Load() != 0 {
		t.Fatalf("new-api writes = %d, want 0", writes.Load())
	}
	state, _, _ := store.GetGroupRatioApplyState(t.Context(), "set-a")
	if state.Status != GroupRatioApplyStatusError || !strings.Contains(state.LastError, "conflicts") {
		t.Fatalf("platform conflict was not recorded: %+v", state)
	}
}

func TestReconcileSetGroupRatiosRendersTenThousandBYOKGroupsInOneWrite(t *testing.T) {
	const userCount = 10_000
	var writes atomic.Int32
	var written string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut || r.URL.Path != "/api/option/" {
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		writes.Add(1)
		var request struct {
			Value string `json:"value"`
		}
		decodeGatewayChannelJSON(t, r, &request)
		written = request.Value
		writeGatewayChannelJSON(t, w, map[string]any{"success": true})
	}))
	defer upstream.Close()

	store := NewMemoryStore()
	svc := NewService(store, upstream.Client().Transport, Options{})
	saveReadySet(t, store, "set-a", upstream.URL)
	if _, err := store.ReplacePlatformGroupRatios(t.Context(), "set-a", "stable", map[string]float64{"default": 1}); err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	for i := 0; i < userCount; i++ {
		userID := fmt.Sprintf("user-%05d", i)
		if _, err := store.SaveBYOKSyncIntent(t.Context(), testBYOKSyncIntent(userID, "set-a", true)); err != nil {
			t.Fatal(err)
		}
	}
	intentDuration := time.Since(started)
	set, _, _ := store.GetSet(t.Context(), "set-a")
	started = time.Now()
	if _, err := svc.reconcileSetGroupRatios(t.Context(), set); err != nil {
		t.Fatal(err)
	}
	reconcileDuration := time.Since(started)
	if writes.Load() != 1 {
		t.Fatalf("new-api writes = %d, want 1", writes.Load())
	}
	var ratios map[string]float64
	if err := json.Unmarshal([]byte(written), &ratios); err != nil {
		t.Fatal(err)
	}
	if len(ratios) != userCount+1 {
		t.Fatalf("rendered groups = %d, want %d", len(ratios), userCount+1)
	}
	if len(written) > 2<<20 {
		t.Fatalf("GroupRatio payload = %d bytes, want <= 2 MiB", len(written))
	}
	t.Logf("10k BYOK projection: intents=%s reconcile=%s payload=%d bytes", intentDuration, reconcileDuration, len(written))
}

func TestCompleteGroupRatioApplyHealsBackfilledEmptyFingerprint(t *testing.T) {
	store := NewMemoryStore()
	if _, err := store.ReplacePlatformGroupRatios(t.Context(), "set-a", "stable", map[string]float64{"default": 1}); err != nil {
		t.Fatal(err)
	}
	snapshot, err := store.GetGroupRatioSnapshot(t.Context(), "set-a")
	if err != nil {
		t.Fatal(err)
	}
	fingerprint, err := groupRatioFingerprint(snapshot.Entries)
	if err != nil {
		t.Fatal(err)
	}
	store.mu.Lock()
	state := store.groupRatioStates["set-a"]
	state.DesiredFingerprint = ""
	store.groupRatioStates["set-a"] = state
	store.mu.Unlock()

	state, err = store.CompleteGroupRatioApply(t.Context(), GroupRatioApplyCompletion{
		SetID: "set-a", Version: state.DesiredVersion, Fingerprint: fingerprint, AppliedAt: time.Now().UTC(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if state.Status != GroupRatioApplyStatusSynced || state.DesiredFingerprint != fingerprint {
		t.Fatalf("backfilled state did not heal: %+v", state)
	}
}

func TestGroupRatioIntentWritesDeferFingerprintToReconciler(t *testing.T) {
	store := NewMemoryStore()
	state, err := store.ReplacePlatformGroupRatios(t.Context(), "set-a", "stable", map[string]float64{"default": 1})
	if err != nil {
		t.Fatal(err)
	}
	if state.DesiredFingerprint != "" {
		t.Fatalf("platform intent eagerly rendered fingerprint %q", state.DesiredFingerprint)
	}
	if _, err := store.SaveBYOKSyncIntent(t.Context(), testBYOKSyncIntent("user-a", "set-a", true)); err != nil {
		t.Fatal(err)
	}
	state, _, _ = store.GetGroupRatioApplyState(t.Context(), "set-a")
	if state.DesiredFingerprint != "" || state.Status != GroupRatioApplyStatusPending {
		t.Fatalf("BYOK intent eagerly rendered full snapshot: %+v", state)
	}
}

func TestGroupRatioApplyStateIsExposedAsSetLevelMetrics(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	saveReadySet(t, store, "set-a", "http://set-a")
	if _, err := store.ReplacePlatformGroupRatios(t.Context(), "set-a", "stable", map[string]float64{"default": 1}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.SaveBYOKSyncIntent(t.Context(), testBYOKSyncIntent("user-a", "set-a", true)); err != nil {
		t.Fatal(err)
	}
	metrics := svc.PrometheusMetrics()
	for _, want := range []string{
		`llmgateway_group_ratio_apply_state{set_id="set-a",status="pending"} 1`,
		`llmgateway_group_ratio_desired_version{set_id="set-a"} 2`,
		`llmgateway_group_ratio_applied_version{set_id="set-a"} 0`,
		`llmgateway_group_ratio_version_lag{set_id="set-a"} 2`,
	} {
		if !strings.Contains(metrics, want) {
			t.Fatalf("metrics missing %q:\n%s", want, metrics)
		}
	}
}

func TestReconcileGroupRatiosWorkerJobSkipsInactiveSets(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	if err := store.SaveSet(t.Context(), Set{ID: "set-disabled", BaseURL: "http://set-disabled", Status: SetStatusDisabled}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReplacePlatformGroupRatios(t.Context(), "set-disabled", "stable", map[string]float64{"default": 1}); err != nil {
		t.Fatal(err)
	}
	run, err := svc.RunWorkerJobNow(t.Context(), WorkerJobReconcileGroupRatios)
	if err != nil {
		t.Fatal(err)
	}
	if run.Status != WorkerJobStatusSuccess || !strings.Contains(run.Detail, "synced=0 failed=0") {
		t.Fatalf("inactive Set should be skipped without failing the job: %+v", run)
	}
	metrics := svc.PrometheusMetrics()
	if strings.Contains(metrics, `llmgateway_group_ratio_apply_state{set_id="set-disabled"`) {
		t.Fatalf("inactive Set leaked into GroupRatio alert metrics:\n%s", metrics)
	}
}

func TestReconcileGroupRatiosWorkerJobProcessesPendingSets(t *testing.T) {
	var writes atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut || r.URL.Path != "/api/option/" {
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		writes.Add(1)
		writeGatewayChannelJSON(t, w, map[string]any{"success": true})
	}))
	defer upstream.Close()
	store := NewMemoryStore()
	svc := NewService(store, upstream.Client().Transport, Options{})
	for _, setID := range []string{"set-a", "set-b"} {
		saveReadySet(t, store, setID, upstream.URL)
		if _, err := store.ReplacePlatformGroupRatios(t.Context(), setID, "stable", map[string]float64{"default": 1}); err != nil {
			t.Fatal(err)
		}
	}
	run, err := svc.RunWorkerJobNow(t.Context(), WorkerJobReconcileGroupRatios)
	if err != nil {
		t.Fatal(err)
	}
	if run.Status != WorkerJobStatusSuccess || !strings.Contains(run.Detail, "synced=2") {
		t.Fatalf("unexpected worker run: %+v", run)
	}
	if writes.Load() != 2 {
		t.Fatalf("new-api writes = %d, want 2", writes.Load())
	}
	for _, setID := range []string{"set-a", "set-b"} {
		state, _, _ := store.GetGroupRatioApplyState(t.Context(), setID)
		if state.Status != GroupRatioApplyStatusSynced {
			t.Fatalf("Set %s did not converge: %+v", setID, state)
		}
	}
}

func testBYOKSyncIntent(userID string, setID string, enabled bool) BYOKSyncIntent {
	providers := []UserLLMProvider{}
	if enabled {
		providers = append(providers, UserLLMProvider{
			ID:            "private",
			Name:          "Private",
			Protocol:      LLMProviderProtocolOpenAICompatible,
			BaseURL:       "https://example.invalid/v1",
			APIKey:        "sk-private",
			ModelMappings: map[string]string{"auto": "upstream-model"},
			Enabled:       true,
		})
	}
	now := time.Now().UTC()
	return BYOKSyncIntent{
		Settings: UserLLMSettings{
			ExternalUserID: userID,
			Routing:        UserLLMRouting{Mode: LLMRouteBYOKFirst},
			Providers:      providers,
			CreatedAt:      now,
			UpdatedAt:      now,
		},
		Task: BYOKSyncTask{
			ExternalUserID: userID,
			SetID:          setID,
			Status:         BYOKSyncTaskStatusPending,
			NextRunAt:      now,
		},
		GroupName: byokGroupForUser(userID),
		Enabled:   enabled,
	}
}
