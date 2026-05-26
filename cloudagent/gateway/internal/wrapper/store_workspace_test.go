package wrapper

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestStoreWorkspaceLeaseAcquireConflictRelease(t *testing.T) {
	ctx := context.Background()
	store, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	first, err := store.AcquireLease(ctx, WorkspaceLeaseRequest{
		WorkspaceID: "space_1",
		RuntimeID:   "runtime_1",
		Provider:    "ags",
		TTL:         time.Minute,
	})
	if err != nil {
		t.Fatal(err)
	}
	if first.WorkspaceID != "space_1" || first.RuntimeID != "runtime_1" || first.FencingToken != 1 {
		t.Fatalf("unexpected first lease: %+v", first)
	}
	if _, err := store.AcquireLease(ctx, WorkspaceLeaseRequest{
		WorkspaceID: "space_1",
		RuntimeID:   "runtime_2",
		Provider:    "ags",
		TTL:         time.Minute,
	}); !errors.Is(err, ErrWorkspaceLeaseHeld) {
		t.Fatalf("expected held lease conflict, got %v", err)
	}
	if err := store.ReleaseLease(ctx, first); err != nil {
		t.Fatal(err)
	}
	second, err := store.AcquireLease(ctx, WorkspaceLeaseRequest{
		WorkspaceID: "space_1",
		RuntimeID:   "runtime_2",
		Provider:    "ags",
		TTL:         time.Minute,
	})
	if err != nil {
		t.Fatal(err)
	}
	if second.FencingToken != 2 {
		t.Fatalf("fencing token=%d, want 2", second.FencingToken)
	}
}

func TestStoreWorkspaceAuthoritativeMetadataAndLifecycle(t *testing.T) {
	ctx := context.Background()
	store, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	retryAt := time.Now().UTC().Add(time.Minute).Truncate(time.Second)
	rec := WorkspaceRecord{
		WorkspaceID:           "workspace_meta",
		Backend:               "smh",
		ProviderWorkspaceID:   "space_meta",
		State:                 "ready",
		OwnerSessionID:        "session_meta",
		WorkspaceVersion:      "builtin.v1",
		ProviderRegion:        "ap-shanghai",
		WispName:              "wisp-workspace-meta",
		WispSMHSpaceID:        "space_meta",
		WispOwnsSMHSpace:      true,
		WispPackageURL:        "https://example.test/wisp.tar.gz",
		WispJFSPrefix:         "cloudagent-workspace",
		WispRootUpperSize:     "5G",
		CleanupState:          "close_failed",
		LastCleanupError:      "stop failed",
		CleanupRetryAfter:     retryAt,
		DeleteState:           "",
		OuterCleanupPending:   true,
		LastOuterCleanupError: "outer delete pending",
	}
	if err := store.EnsureWorkspace(ctx, rec); err != nil {
		t.Fatal(err)
	}
	loaded, ok, err := store.LoadWorkspace(ctx, rec.WorkspaceID)
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("workspace not loaded")
	}
	if loaded.ProviderWorkspaceID != rec.ProviderWorkspaceID ||
		loaded.OwnerSessionID != rec.OwnerSessionID ||
		loaded.WispSMHSpaceID != rec.WispSMHSpaceID ||
		!loaded.WispOwnsSMHSpace ||
		loaded.CleanupState != rec.CleanupState ||
		loaded.LastCleanupError != rec.LastCleanupError ||
		!loaded.OuterCleanupPending {
		t.Fatalf("workspace metadata not authoritative: %+v", loaded)
	}
	if !loaded.CleanupRetryAfter.Equal(retryAt) {
		t.Fatalf("cleanup retry mismatch: got %s want %s", loaded.CleanupRetryAfter, retryAt)
	}
	if err := store.UpdateWorkspaceLifecycle(ctx, rec.WorkspaceID, "delete_failed", "", "", "delete_failed", "anchor delete failed", false); err != nil {
		t.Fatal(err)
	}
	loaded, ok, err = store.LoadWorkspace(ctx, rec.WorkspaceID)
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("workspace not loaded after lifecycle update")
	}
	if loaded.State != "delete_failed" || loaded.DeleteState != "delete_failed" || loaded.LastDeleteError != "anchor delete failed" || loaded.OuterCleanupPending {
		t.Fatalf("workspace lifecycle update not persisted: %+v", loaded)
	}
}

func TestStoreWorkspaceLeaseRenewRequiresExactFence(t *testing.T) {
	ctx := context.Background()
	store, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	lease, err := store.AcquireLease(ctx, WorkspaceLeaseRequest{
		WorkspaceID: "space_renew",
		RuntimeID:   "runtime_renew",
		Provider:    "wisp",
		TTL:         time.Minute,
	})
	if err != nil {
		t.Fatal(err)
	}
	renewed, err := store.RenewLease(ctx, lease, 2*time.Minute)
	if err != nil {
		t.Fatalf("renew lease: %v", err)
	}
	if !renewed.ExpiresAt.After(lease.ExpiresAt) || renewed.FencingToken != lease.FencingToken {
		t.Fatalf("unexpected renewed lease: old=%+v renewed=%+v", lease, renewed)
	}
	stale := renewed
	stale.FencingToken++
	if _, err := store.RenewLease(ctx, stale, time.Minute); !errors.Is(err, ErrWorkspaceLeaseHeld) {
		t.Fatalf("expected stale fence renewal to fail with held error, got %v", err)
	}
}

func TestStoreRuntimeOwnershipAcquireConflictReleaseAndExpire(t *testing.T) {
	ctx := context.Background()
	store, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	first, err := store.AcquireRuntimeOwnership(ctx, RuntimeOwnershipRequest{
		SessionID:  "session_owner",
		Generation: 7,
		RunID:      "job_first",
		OwnerID:    "gateway_a",
		Operation:  "prompt",
		TTL:        time.Minute,
	})
	if err != nil {
		t.Fatalf("acquire first ownership: %v", err)
	}
	if first.FencingToken != 1 {
		t.Fatalf("fencing token=%d, want 1", first.FencingToken)
	}
	if _, err := store.AcquireRuntimeOwnership(ctx, RuntimeOwnershipRequest{
		SessionID:  "session_owner",
		Generation: 7,
		RunID:      "job_second",
		OwnerID:    "gateway_b",
		Operation:  "prompt",
		TTL:        time.Minute,
	}); !errors.Is(err, ErrRuntimeOwnershipHeld) {
		t.Fatalf("expected ownership held conflict, got %v", err)
	}
	if err := store.ReleaseRuntimeOwnership(ctx, first); err != nil {
		t.Fatalf("release first ownership: %v", err)
	}
	second, err := store.AcquireRuntimeOwnership(ctx, RuntimeOwnershipRequest{
		SessionID:  "session_owner",
		Generation: 7,
		RunID:      "job_second",
		OwnerID:    "gateway_b",
		Operation:  "prompt",
		TTL:        time.Millisecond,
	})
	if err != nil {
		t.Fatalf("acquire second ownership: %v", err)
	}
	if second.FencingToken != 2 {
		t.Fatalf("fencing token=%d, want 2", second.FencingToken)
	}
	time.Sleep(5 * time.Millisecond)
	third, err := store.AcquireRuntimeOwnership(ctx, RuntimeOwnershipRequest{
		SessionID:  "session_owner",
		Generation: 8,
		RunID:      "restore_third",
		OwnerID:    "gateway_c",
		Operation:  "restore",
		TTL:        time.Minute,
	})
	if err != nil {
		t.Fatalf("expired ownership should be stealable: %v", err)
	}
	if third.FencingToken != 3 {
		t.Fatalf("fencing token=%d, want 3", third.FencingToken)
	}
	held, err := store.RuntimeOwnershipHeld(ctx, second)
	if err != nil {
		t.Fatalf("check stale ownership: %v", err)
	}
	if held {
		t.Fatal("stale ownership should not be considered held after takeover")
	}
}

func TestStorePersistsWispLeaseFields(t *testing.T) {
	store, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	session := &acpSession{
		SessionID:         "session_lease",
		Scope:             Scope{TenantID: "tenant", ProjectID: "project"},
		CWD:               "/workspace",
		Model:             "agent-sidecar-chat",
		State:             acpRuntimeStateReady,
		RuntimeGeneration: 1,
		CreatedAt:         time.Now().UTC(),
		UpdatedAt:         time.Now().UTC(),
		Runtime: ACPSessionRuntime{
			RuntimeID:            "runtime_lease",
			OuterRuntime:         outerRuntimeWisp,
			RuntimeRecovery:      runtimeRecoveryReattachOrRecreate,
			WispName:             "wisp-session",
			WispWorkspaceID:      "space_lease",
			WispSMHSpaceID:       "space_lease",
			WispLeaseID:          "lease_123",
			WispLeaseFence:       7,
			WispLeaseUntil:       time.Now().UTC().Add(time.Hour),
			WorkspaceID:          "workspace_lease",
			WorkspaceRuntimeID:   "workspace_runtime_1",
			WorkspaceLeaseID:     "workspace_lease_123",
			WorkspaceFence:       11,
			WorkspaceLeaseUntil:  time.Now().UTC().Add(30 * time.Minute),
			WorkspaceAttachState: "bound",
			OuterSandboxID:       "outer_1",
			DaemonAddr:           "http://127.0.0.1:38001",
			RemoteBinary:         "/tmp/hermes-sidecar",
			WispPackageURL:       defaultWispPackageURL,
			WispInstallDir:       "/tmp/wisp/install",
			WispClientPath:       "/tmp/wisp/install/bin/wispclient",
			WispJFSPrefix:        "cloudagent-agent",
			WispRootUpperSize:    "5G",
		},
	}
	if err := store.SaveACPSession(session); err != nil {
		t.Fatal(err)
	}
	loaded, err := store.LoadACPSession(session.Scope, session.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	if loaded == nil {
		t.Fatal("session not loaded")
	}
	if loaded.Runtime.WispLeaseID != session.Runtime.WispLeaseID ||
		loaded.Runtime.WispLeaseFence != session.Runtime.WispLeaseFence ||
		!loaded.Runtime.WispLeaseUntil.Equal(session.Runtime.WispLeaseUntil) {
		t.Fatalf("wisp lease fields not persisted: %+v", loaded.Runtime)
	}
	if loaded.Runtime.WorkspaceID != session.Runtime.WorkspaceID ||
		loaded.Runtime.WorkspaceRuntimeID != session.Runtime.WorkspaceRuntimeID ||
		loaded.Runtime.WorkspaceLeaseID != session.Runtime.WorkspaceLeaseID ||
		loaded.Runtime.WorkspaceFence != session.Runtime.WorkspaceFence ||
		loaded.Runtime.WorkspaceAttachState != session.Runtime.WorkspaceAttachState ||
		!loaded.Runtime.WorkspaceLeaseUntil.Equal(session.Runtime.WorkspaceLeaseUntil) {
		t.Fatalf("workspace runtime fields not persisted: %+v", loaded.Runtime)
	}
}
