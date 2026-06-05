package wrapper

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"
)

func TestWarmRuntimePoolKeySeparatesVersionsAndArtifacts(t *testing.T) {
	base := RuntimePoolKeySpec{
		BackendName:       "ags",
		OuterRuntime:      "wisp",
		OuterTemplateID:   "outer-template",
		InnerTemplateID:   "inner-template",
		AgentVersion:      "builtin.v1",
		WorkspaceVersion:  "builtin.v1",
		SidecarURL:        "https://example.com/sidecar-a",
		SidecarSHA256:     strings.Repeat("a", 64),
		WispPackageURL:    "https://example.com/wisp.erofs",
		WispRootUpperSize: "5G",
		WispJFSPrefix:     "cloudagent-agent",
	}
	first := warmRuntimePoolKey(base)
	base.AgentVersion = "builtin.v2"
	if second := warmRuntimePoolKey(base); second == first {
		t.Fatalf("agent version must affect warm pool key")
	}
	base.AgentVersion = "builtin.v1"
	base.SidecarSHA256 = strings.Repeat("b", 64)
	if second := warmRuntimePoolKey(base); second == first {
		t.Fatalf("sidecar artifact must affect warm pool key")
	}
}

func TestWarmRuntimePoolClaimIsSingleWriter(t *testing.T) {
	store, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	host := validWarmRuntimeHost()
	item := WarmRuntimeItem{
		ItemID:  "warm_item_1",
		PoolKey: "pool_a",
		State:   warmRuntimePoolStateReady,
		Host:    host,
	}
	if err := store.UpsertWarmRuntimeItem(ctx, item); err != nil {
		t.Fatal(err)
	}
	claim, err := store.ClaimWarmRuntime(ctx, WarmRuntimeClaimRequest{
		PoolKey:    "pool_a",
		OwnerID:    "gateway_a",
		SessionID:  "session_a",
		Generation: 1,
		TTL:        time.Minute,
	})
	if err != nil {
		t.Fatalf("first claim failed: %v", err)
	}
	if claim.ItemID != item.ItemID || claim.Fence != 1 {
		t.Fatalf("claim=%+v, want item=%s fence=1", claim, item.ItemID)
	}
	_, err = store.ClaimWarmRuntime(ctx, WarmRuntimeClaimRequest{
		PoolKey:    "pool_a",
		OwnerID:    "gateway_b",
		SessionID:  "session_b",
		Generation: 1,
		TTL:        time.Minute,
	})
	if !errors.Is(err, ErrWarmRuntimePoolMiss) {
		t.Fatalf("second claim error=%v, want pool miss", err)
	}
	items, err := store.ListWarmRuntimeItems(ctx, WarmRuntimeListRequest{PoolKey: "pool_a", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].State != warmRuntimePoolStateClaimed || items[0].OwnerID != "gateway_a" {
		t.Fatalf("claimed item not persisted correctly: %+v", items)
	}
}

func TestWarmRuntimePoolReserveIsSharedStoreCapacityGate(t *testing.T) {
	root := t.TempDir()
	storeA, err := NewStore(root)
	if err != nil {
		t.Fatal(err)
	}
	storeB, err := NewStore(root)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	first, ok, err := storeA.ReserveWarmRuntimeItem(ctx, WarmRuntimeReserveRequest{
		PoolKey:      "pool_a",
		OwnerID:      "worker_a",
		DesiredReady: 1,
	})
	if err != nil {
		t.Fatalf("first reserve failed: %v", err)
	}
	if !ok || first.ItemID == "" || first.State != warmRuntimePoolStateCreating {
		t.Fatalf("first reserve = (%+v, %t), want creating item", first, ok)
	}
	second, ok, err := storeB.ReserveWarmRuntimeItem(ctx, WarmRuntimeReserveRequest{
		PoolKey:      "pool_a",
		OwnerID:      "worker_b",
		DesiredReady: 1,
	})
	if err != nil {
		t.Fatalf("second reserve failed: %v", err)
	}
	if ok {
		t.Fatalf("second reserve = (%+v, true), want capacity miss", second)
	}
	items, err := storeA.ListWarmRuntimeItems(ctx, WarmRuntimeListRequest{PoolKey: "pool_a", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].OwnerID != "worker_a" {
		t.Fatalf("items=%+v, want only worker_a reservation", items)
	}
}

func TestWarmRuntimePoolDiscardRequiresClaimFence(t *testing.T) {
	store, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if err := store.UpsertWarmRuntimeItem(ctx, WarmRuntimeItem{
		ItemID:  "warm_item_1",
		PoolKey: "pool_a",
		State:   warmRuntimePoolStateReady,
		Host:    validWarmRuntimeHost(),
	}); err != nil {
		t.Fatal(err)
	}
	claim, err := store.ClaimWarmRuntime(ctx, WarmRuntimeClaimRequest{
		PoolKey:    "pool_a",
		OwnerID:    "gateway_a",
		SessionID:  "session_a",
		Generation: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	wrongFence := claim
	wrongFence.Fence++
	if err := store.DiscardWarmRuntime(ctx, wrongFence, "wrong owner"); err == nil {
		t.Fatalf("discard with wrong fence should fail")
	}
	if err := store.DiscardWarmRuntime(ctx, claim, "consumed"); err != nil {
		t.Fatalf("discard with correct claim failed: %v", err)
	}
	items, err := store.ListWarmRuntimeItems(ctx, WarmRuntimeListRequest{PoolKey: "pool_a", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if items[0].State != warmRuntimePoolStateDiscarding {
		t.Fatalf("state=%s, want discarding", items[0].State)
	}
}

func TestWarmRuntimePoolConsumeDoesNotMarkDiscarding(t *testing.T) {
	store, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if err := store.UpsertWarmRuntimeItem(ctx, WarmRuntimeItem{
		ItemID:  "warm_item_1",
		PoolKey: "pool_a",
		State:   warmRuntimePoolStateReady,
		Host:    validWarmRuntimeHost(),
	}); err != nil {
		t.Fatal(err)
	}
	claim, err := store.ClaimWarmRuntime(ctx, WarmRuntimeClaimRequest{
		PoolKey:    "pool_a",
		OwnerID:    "gateway_a",
		SessionID:  "session_a",
		Generation: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.ConsumeWarmRuntime(ctx, claim); err != nil {
		t.Fatalf("consume failed: %v", err)
	}
	items, err := store.ListWarmRuntimeItems(ctx, WarmRuntimeListRequest{PoolKey: "pool_a", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if items[0].State != warmRuntimePoolStateConsumed {
		t.Fatalf("state=%s, want consumed", items[0].State)
	}
}

func TestWispOuterPrepareScriptSupportsHostOnly(t *testing.T) {
	script := wispOuterPrepareScript()
	hostOnly := `if [[ "${WISP_HOST_ONLY:-}" == "1" ]]; then`
	if !strings.Contains(script, hostOnly) || !strings.Contains(script, "WISP_HOST_READY") {
		t.Fatalf("prepare script must expose host-only mode")
	}
	if strings.Index(script, "WISP_HOST_READY") > strings.Index(script, "step_start wisp_create") {
		t.Fatalf("host-only mode must exit before wisp_create")
	}
	if strings.Index(script, "WISP_HOST_READY") > strings.Index(script, "step_start wisp_config_write") {
		t.Fatalf("host-only mode must exit before writing session-bound Wisp config")
	}
}

func TestWarmClaimPathAcquiresWispLeaseBeforePrepare(t *testing.T) {
	source := readTestSource(t, "runtime_pool_attach.go")
	claimPath := mustContainAfter(t, source, "func (w *AgentSidecarWorker) startSessionRuntimeFromWarmClaim")
	leaseCall := `resolveWispRuntimeForSpace(ctx, runtime, req, space, true)`
	prepareCall := `prepareWispRuntimeWithSpace(ctx, claimedBackend.host, outerSandbox, runtime, req, space, "outer", false)`
	if !strings.Contains(claimPath, leaseCall) {
		t.Fatalf("warm claim path must acquire the Wisp workspace lease with %s", leaseCall)
	}
	if strings.Index(claimPath, leaseCall) > strings.Index(claimPath, prepareCall) {
		t.Fatalf("warm claim path must acquire lease before Wisp prepare")
	}
}

func validWarmRuntimeHost() WarmRuntimeHost {
	return WarmRuntimeHost{
		SandboxBackend:       "ags",
		OuterSandboxID:       "outer",
		OuterEnvdAccessToken: "outer-token",
		InnerSandboxID:       "inner",
		InnerEnvdAccessToken: "inner-token",
		WispPackageURL:       "https://example.com/wisp.erofs",
		OuterWispInstallDir:  "/tmp/warm/outer/install",
		OuterWispClientPath:  "/tmp/warm/outer/install/bin/wispclient",
		InnerWispInstallDir:  "/tmp/warm/inner/install",
		InnerWispClientPath:  "/tmp/warm/inner/install/bin/wispclient",
	}
}

func readTestSource(t *testing.T, path string) string {
	t.Helper()
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(content)
}

func mustContainAfter(t *testing.T, source string, marker string) string {
	t.Helper()
	idx := strings.Index(source, marker)
	if idx < 0 {
		t.Fatalf("source missing marker %q", marker)
	}
	return source[idx:]
}
