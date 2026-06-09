package wrapper

import (
	"context"
	"errors"
	"fmt"
	"net/http/httptest"
	"testing"
	"time"

	redisstore "cloudagent/gateway/internal/store/redis"

	"github.com/alicebob/miniredis/v2"
)

func TestACPRedisWorkspaceLeaseSessionCloseReleasesForNextGateway(t *testing.T) {
	ctx := context.Background()
	workspaceID := "workspace_acp_redis_close"
	redisServer := miniredis.RunT(t)
	leaseStore := newRedisLockStoreForACPTest(t, redisServer)
	workspaceService := newRedisWorkspaceServiceForACPTest(t, leaseStore)
	managerA := &leaseBackedACPRuntimeManager{
		workspaceService: workspaceService,
		workspaceID:      workspaceID,
		provider:         "redis-e2e",
	}
	managerB := &leaseBackedACPRuntimeManager{
		workspaceService: workspaceService,
		workspaceID:      workspaceID,
		provider:         "redis-e2e",
	}
	serverA := newRedisWorkspaceACPTestServer(t, managerA, workspaceService)
	serverB := newRedisWorkspaceACPTestServer(t, managerB, workspaceService)
	tsA := httptest.NewServer(serverA.Handler())
	defer tsA.Close()
	tsB := httptest.NewServer(serverB.Handler())
	defer tsB.Close()

	clientA := dialACPWS(t, "ws"+trimHTTPPrefix(tsA.URL)+"/acp", map[string]string{"Authorization": "Bearer test-key"})
	defer clientA.close()
	initializeACPTestClient(t, clientA)
	sessionA := createACPTestSession(t, clientA, 2)
	leaseA, ok, err := workspaceService.GetLease(ctx, workspaceID)
	if err != nil || !ok {
		t.Fatalf("expected active workspace lease after first session/new, ok=%v err=%v", ok, err)
	}
	if leaseA.RuntimeID != "runtime_"+sessionA {
		t.Fatalf("lease runtime id = %q, want runtime_%s", leaseA.RuntimeID, sessionA)
	}

	clientA.writeJSON(t, map[string]any{
		"jsonrpc": "2.0",
		"id":      3,
		"method":  "session/close",
		"params":  map[string]any{"sessionId": sessionA},
	})
	closeResp := waitForRPCID(t, clientA, float64(3))
	if _, ok := closeResp["error"].(map[string]any); ok {
		t.Fatalf("session/close failed: %#v", closeResp)
	}
	released, ok, err := workspaceService.GetLease(ctx, workspaceID)
	if err != nil || !ok {
		t.Fatalf("expected released lease record after close, ok=%v err=%v", ok, err)
	}
	if released.State != "released" {
		t.Fatalf("workspace lease state after close = %q, want released", released.State)
	}

	clientB := dialACPWS(t, "ws"+trimHTTPPrefix(tsB.URL)+"/acp", map[string]string{"Authorization": "Bearer test-key"})
	defer clientB.close()
	initializeACPTestClient(t, clientB)
	sessionB := createACPTestSession(t, clientB, 2)
	leaseB, ok, err := workspaceService.GetLease(ctx, workspaceID)
	if err != nil || !ok {
		t.Fatalf("expected reacquired workspace lease, ok=%v err=%v", ok, err)
	}
	if leaseB.RuntimeID != "runtime_"+sessionB {
		t.Fatalf("reacquired lease runtime id = %q, want runtime_%s", leaseB.RuntimeID, sessionB)
	}
	if leaseB.FencingToken <= leaseA.FencingToken {
		t.Fatalf("fencing token must increase across close/recreate, first=%d second=%d", leaseA.FencingToken, leaseB.FencingToken)
	}
	if managerA.startCount() != 1 || managerB.startCount() != 1 {
		t.Fatalf("unexpected runtime starts: a=%d b=%d", managerA.startCount(), managerB.startCount())
	}
}

func TestACPRedisWorkspaceLeaseRejectsConcurrentGatewayAndLeavesNoSession(t *testing.T) {
	ctx := context.Background()
	workspaceID := "workspace_acp_redis_concurrent"
	redisServer := miniredis.RunT(t)
	leaseStoreA := newRedisLockStoreForACPTest(t, redisServer)
	leaseStoreB := newRedisLockStoreForACPTest(t, redisServer)
	workspaceServiceA := newRedisWorkspaceServiceForACPTest(t, leaseStoreA)
	workspaceServiceB := newRedisWorkspaceServiceForACPTest(t, leaseStoreB)
	managerA := &leaseBackedACPRuntimeManager{
		workspaceService: workspaceServiceA,
		workspaceID:      workspaceID,
		provider:         "redis-e2e",
	}
	managerB := &leaseBackedACPRuntimeManager{
		workspaceService: workspaceServiceB,
		workspaceID:      workspaceID,
		provider:         "redis-e2e",
	}
	serverA := newRedisWorkspaceACPTestServer(t, managerA, workspaceServiceA)
	serverB := newRedisWorkspaceACPTestServer(t, managerB, workspaceServiceB)
	tsA := httptest.NewServer(serverA.Handler())
	defer tsA.Close()
	tsB := httptest.NewServer(serverB.Handler())
	defer tsB.Close()

	clientA := dialACPWS(t, "ws"+trimHTTPPrefix(tsA.URL)+"/acp", map[string]string{"Authorization": "Bearer test-key"})
	defer clientA.close()
	initializeACPTestClient(t, clientA)
	sessionA := createACPTestSession(t, clientA, 2)
	leaseA, ok, err := workspaceServiceA.GetLease(ctx, workspaceID)
	if err != nil || !ok || leaseA.State != "active" {
		t.Fatalf("expected gateway A active lease, lease=%#v ok=%v err=%v", leaseA, ok, err)
	}

	clientB := dialACPWS(t, "ws"+trimHTTPPrefix(tsB.URL)+"/acp", map[string]string{"Authorization": "Bearer test-key"})
	defer clientB.close()
	initializeACPTestClient(t, clientB)
	clientB.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 2, "method": "session/new", "params": map[string]any{"cwd": "/workspace"}})
	failedCreate := waitForRPCID(t, clientB, float64(2))
	if _, ok := failedCreate["error"].(map[string]any); !ok {
		t.Fatalf("expected second gateway session/new to fail while lease is held: %#v", failedCreate)
	}
	if managerB.startCount() != 1 {
		t.Fatalf("second gateway should attempt one runtime start, got %d", managerB.startCount())
	}

	clientB.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 3, "method": "session/list", "params": map[string]any{}})
	listResp := waitForRPCID(t, clientB, float64(3))
	sessions := listResp["result"].(map[string]any)["sessions"].([]any)
	if len(sessions) != 0 {
		t.Fatalf("failed session/new must not leave a half-created session: %#v", sessions)
	}

	clientA.writeJSON(t, map[string]any{
		"jsonrpc": "2.0",
		"id":      3,
		"method":  "session/close",
		"params":  map[string]any{"sessionId": sessionA},
	})
	if closeResp := waitForRPCID(t, clientA, float64(3)); closeResp["error"] != nil {
		t.Fatalf("gateway A close failed: %#v", closeResp)
	}
	sessionB := createACPTestSession(t, clientB, 4)
	leaseB, ok, err := workspaceServiceB.GetLease(ctx, workspaceID)
	if err != nil || !ok || leaseB.State != "active" {
		t.Fatalf("expected gateway B active lease after A close, lease=%#v ok=%v err=%v", leaseB, ok, err)
	}
	if leaseB.RuntimeID != "runtime_"+sessionB {
		t.Fatalf("gateway B lease runtime id = %q, want runtime_%s", leaseB.RuntimeID, sessionB)
	}
	if leaseB.FencingToken <= leaseA.FencingToken {
		t.Fatalf("fence must increase after handoff, first=%d second=%d", leaseA.FencingToken, leaseB.FencingToken)
	}
}

func TestACPRedisWorkspaceLeaseExpiredOwnerAllowsGatewayHandoff(t *testing.T) {
	ctx := context.Background()
	workspaceID := "workspace_acp_redis_expired_handoff"
	redisServer := miniredis.RunT(t)
	leaseStoreA := newRedisLockStoreForACPTest(t, redisServer)
	leaseStoreB := newRedisLockStoreForACPTest(t, redisServer)
	workspaceServiceA := newRedisWorkspaceServiceForACPTest(t, leaseStoreA)
	workspaceServiceB := newRedisWorkspaceServiceForACPTest(t, leaseStoreB)
	managerA := &leaseBackedACPRuntimeManager{
		workspaceService: workspaceServiceA,
		workspaceID:      workspaceID,
		provider:         "redis-e2e",
		leaseTTL:         20 * time.Millisecond,
	}
	managerB := &leaseBackedACPRuntimeManager{
		workspaceService: workspaceServiceB,
		workspaceID:      workspaceID,
		provider:         "redis-e2e",
		leaseTTL:         time.Minute,
	}
	serverA := newRedisWorkspaceACPTestServer(t, managerA, workspaceServiceA)
	serverB := newRedisWorkspaceACPTestServer(t, managerB, workspaceServiceB)
	tsA := httptest.NewServer(serverA.Handler())
	defer tsA.Close()
	tsB := httptest.NewServer(serverB.Handler())
	defer tsB.Close()

	clientA := dialACPWS(t, "ws"+trimHTTPPrefix(tsA.URL)+"/acp", map[string]string{"Authorization": "Bearer test-key"})
	defer clientA.close()
	initializeACPTestClient(t, clientA)
	sessionA := createACPTestSession(t, clientA, 2)
	leaseA, ok, err := workspaceServiceA.GetLease(ctx, workspaceID)
	if err != nil || !ok || leaseA.State != "active" {
		t.Fatalf("expected short active lease, lease=%#v ok=%v err=%v", leaseA, ok, err)
	}
	time.Sleep(60 * time.Millisecond)

	clientB := dialACPWS(t, "ws"+trimHTTPPrefix(tsB.URL)+"/acp", map[string]string{"Authorization": "Bearer test-key"})
	defer clientB.close()
	initializeACPTestClient(t, clientB)
	sessionB := createACPTestSession(t, clientB, 2)
	leaseB, ok, err := workspaceServiceB.GetLease(ctx, workspaceID)
	if err != nil || !ok || leaseB.State != "active" {
		t.Fatalf("expected new active lease after expiry handoff, lease=%#v ok=%v err=%v", leaseB, ok, err)
	}
	if leaseB.RuntimeID != "runtime_"+sessionB {
		t.Fatalf("handoff lease runtime id = %q, want runtime_%s", leaseB.RuntimeID, sessionB)
	}
	if leaseB.RuntimeID == "runtime_"+sessionA {
		t.Fatalf("expired handoff did not replace previous runtime id: %#v", leaseB)
	}
	if leaseB.FencingToken <= leaseA.FencingToken {
		t.Fatalf("fence must increase when expired owner is replaced, first=%d second=%d", leaseA.FencingToken, leaseB.FencingToken)
	}
}

func TestACPRedisWorkspaceLeaseRenewalPreventsExpiredTTLSteal(t *testing.T) {
	ctx := context.Background()
	workspaceID := "workspace_acp_redis_renew_blocks_steal"
	redisServer := miniredis.RunT(t)
	leaseStoreA := newRedisLockStoreForACPTest(t, redisServer)
	leaseStoreB := newRedisLockStoreForACPTest(t, redisServer)
	workspaceServiceA := newRedisWorkspaceServiceForACPTest(t, leaseStoreA)
	workspaceServiceB := newRedisWorkspaceServiceForACPTest(t, leaseStoreB)
	managerA := &leaseBackedACPRuntimeManager{
		workspaceService: workspaceServiceA,
		workspaceID:      workspaceID,
		provider:         "redis-e2e",
		leaseTTL:         20 * time.Millisecond,
	}
	managerB := &leaseBackedACPRuntimeManager{
		workspaceService: workspaceServiceB,
		workspaceID:      workspaceID,
		provider:         "redis-e2e",
	}
	serverA := newRedisWorkspaceACPTestServer(t, managerA, workspaceServiceA)
	serverB := newRedisWorkspaceACPTestServer(t, managerB, workspaceServiceB)
	tsA := httptest.NewServer(serverA.Handler())
	defer tsA.Close()
	tsB := httptest.NewServer(serverB.Handler())
	defer tsB.Close()

	clientA := dialACPWS(t, "ws"+trimHTTPPrefix(tsA.URL)+"/acp", map[string]string{"Authorization": "Bearer test-key"})
	defer clientA.close()
	initializeACPTestClient(t, clientA)
	sessionA := createACPTestSession(t, clientA, 2)
	leaseA, ok, err := workspaceServiceA.GetLease(ctx, workspaceID)
	if err != nil || !ok || leaseA.State != "active" {
		t.Fatalf("expected short active lease, lease=%#v ok=%v err=%v", leaseA, ok, err)
	}
	renewed, err := workspaceServiceA.RenewLease(ctx, leaseA, 200*time.Millisecond)
	if err != nil {
		t.Fatalf("renew short lease: %v", err)
	}
	time.Sleep(60 * time.Millisecond)

	clientB := dialACPWS(t, "ws"+trimHTTPPrefix(tsB.URL)+"/acp", map[string]string{"Authorization": "Bearer test-key"})
	defer clientB.close()
	initializeACPTestClient(t, clientB)
	clientB.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 2, "method": "session/new", "params": map[string]any{"cwd": "/workspace"}})
	failedCreate := waitForRPCID(t, clientB, float64(2))
	if _, ok := failedCreate["error"].(map[string]any); !ok {
		t.Fatalf("expected renewed lease to block second gateway: %#v", failedCreate)
	}
	stillHeld, ok, err := workspaceServiceA.GetLease(ctx, workspaceID)
	if err != nil || !ok || stillHeld.State != "active" {
		t.Fatalf("expected renewed lease to remain active, lease=%#v ok=%v err=%v", stillHeld, ok, err)
	}
	if stillHeld.RuntimeID != "runtime_"+sessionA || stillHeld.FencingToken != renewed.FencingToken {
		t.Fatalf("renewed lease was unexpectedly replaced: lease=%#v renewed=%#v", stillHeld, renewed)
	}
}

func newRedisLockStoreForACPTest(t *testing.T, redisServer *miniredis.Miniredis) *redisstore.LockStore {
	t.Helper()
	store, err := redisstore.New(redisstore.Config{
		Addr:      redisServer.Addr(),
		KeyPrefix: "acp-e2e:",
	})
	if err != nil {
		t.Fatalf("new redis lock store: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store
}

func newRedisWorkspaceServiceForACPTest(t *testing.T, store *redisstore.LockStore) *redisWorkspaceServiceForACPTest {
	t.Helper()
	fallback, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatalf("new fallback store: %v", err)
	}
	return &redisWorkspaceServiceForACPTest{store: store, fallback: fallback}
}

func newRedisWorkspaceACPTestServer(t *testing.T, manager *leaseBackedACPRuntimeManager, workspaceService WorkspaceService) *Server {
	t.Helper()
	store, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatalf("new wrapper store: %v", err)
	}
	server := newACPTestServerWithRuntimeAndStore(store, manager)
	server.SetExternalLockStores(ExternalLockStores{WorkspaceService: workspaceService})
	return server
}

func initializeACPTestClient(t *testing.T, client *acpWSClient) {
	t.Helper()
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{}})
	if resp := waitForRPCID(t, client, float64(1)); resp["error"] != nil {
		t.Fatalf("initialize failed: %#v", resp)
	}
}

func createACPTestSession(t *testing.T, client *acpWSClient, id int) string {
	t.Helper()
	client.writeJSON(t, map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"method":  "session/new",
		"params":  map[string]any{"cwd": "/workspace"},
	})
	resp := waitForRPCID(t, client, float64(id))
	if _, ok := resp["error"].(map[string]any); ok {
		t.Fatalf("session/new failed: %#v", resp)
	}
	result := resp["result"].(map[string]any)
	sessionID, _ := result["sessionId"].(string)
	if sessionID == "" {
		t.Fatalf("session/new did not return sessionId: %#v", resp)
	}
	return sessionID
}

type leaseBackedACPRuntimeManager struct {
	recordingACPRuntimeManager
	workspaceService WorkspaceService
	workspaceID      string
	provider         string
	leaseTTL         time.Duration
}

func (m *leaseBackedACPRuntimeManager) StartSessionRuntime(ctx context.Context, req ACPSessionRuntimeStartRequest) (ACPSessionRuntime, error) {
	m.mu.Lock()
	m.starts = append(m.starts, req)
	m.mu.Unlock()
	workspaceID := m.workspaceID
	if workspaceID == "" {
		workspaceID = "workspace_" + req.SessionID
	}
	runtimeID := "runtime_" + req.SessionID
	lease, err := m.workspaceService.AcquireLease(ctx, WorkspaceLeaseRequest{
		WorkspaceID: workspaceID,
		RuntimeID:   runtimeID,
		Provider:    m.provider,
		TTL:         m.leaseDuration(),
	})
	if err != nil {
		return ACPSessionRuntime{}, err
	}
	return ACPSessionRuntime{
		RuntimeID:          runtimeID,
		SandboxBackend:     req.SandboxBackend,
		OuterRuntime:       outerRuntimeWisp,
		RuntimeRecovery:    runtimeRecoveryReattachOrRecreate,
		AgentVersion:       normalizeRuntimeVersion(req.AgentVersion, defaultAgentVersion),
		WorkspaceVersion:   normalizeRuntimeVersion(req.WorkspaceVersion, defaultWorkspaceVersion),
		OuterSandboxID:     "outer_" + req.SessionID,
		DaemonAddr:         "fake",
		RemoteBinary:       "/tmp/hermes-sidecar",
		WispName:           "wisp_" + workspaceID,
		WispWorkspaceID:    workspaceID,
		WispSMHSpaceID:     "space_" + workspaceID,
		WispOwnsSMHSpace:   true,
		WispLeaseID:        lease.LeaseID,
		WispLeaseFence:     lease.FencingToken,
		WispLeaseUntil:     lease.ExpiresAt,
		WorkspaceID:        workspaceID,
		WorkspaceRuntimeID: runtimeID,
	}, nil
}

func (m *leaseBackedACPRuntimeManager) leaseDuration() time.Duration {
	if m.leaseTTL > 0 {
		return m.leaseTTL
	}
	return time.Minute
}

func (m *leaseBackedACPRuntimeManager) CloseSessionRuntime(ctx context.Context, runtime ACPSessionRuntime) error {
	if err := m.recordingACPRuntimeManager.CloseSessionRuntime(ctx, runtime); err != nil {
		return err
	}
	if runtime.WorkspaceID == "" || runtime.WispLeaseID == "" {
		return nil
	}
	return m.workspaceService.ReleaseLease(ctx, WorkspaceLease{
		WorkspaceID:  runtime.WorkspaceID,
		RuntimeID:    runtime.RuntimeID,
		LeaseID:      runtime.WispLeaseID,
		FencingToken: runtime.WispLeaseFence,
		State:        "active",
		ExpiresAt:    runtime.WispLeaseUntil,
		HeartbeatAt:  time.Now().UTC(),
		CreatedAt:    time.Now().UTC(),
		UpdatedAt:    time.Now().UTC(),
	})
}

type redisWorkspaceServiceForACPTest struct {
	store    *redisstore.LockStore
	fallback *Store
}

func (s *redisWorkspaceServiceForACPTest) EnsureWorkspace(ctx context.Context, rec WorkspaceRecord) error {
	return s.fallback.EnsureWorkspace(ctx, rec)
}

func (s *redisWorkspaceServiceForACPTest) AcquireLease(ctx context.Context, req WorkspaceLeaseRequest) (WorkspaceLease, error) {
	lease, err := s.store.AcquireLease(ctx, redisstore.WorkspaceLeaseRequest{
		WorkspaceID: req.WorkspaceID,
		RuntimeID:   req.RuntimeID,
		Provider:    req.Provider,
		TTL:         req.TTL,
	})
	if err != nil {
		var held redisstore.WorkspaceLeaseHeldError
		if errors.As(err, &held) {
			return WorkspaceLease{}, WorkspaceLeaseHeldError{
				WorkspaceID: held.WorkspaceID,
				RuntimeID:   held.RuntimeID,
				LeaseID:     held.LeaseID,
				ExpiresAt:   held.ExpiresAt,
			}
		}
		return WorkspaceLease{}, err
	}
	return workspaceLeaseFromRedisForACPTest(lease), nil
}

func (s *redisWorkspaceServiceForACPTest) RenewLease(ctx context.Context, lease WorkspaceLease, ttl time.Duration) (WorkspaceLease, error) {
	renewed, err := s.store.RenewLease(ctx, redisWorkspaceLeaseForACPTest(lease), ttl)
	if err != nil {
		var held redisstore.WorkspaceLeaseHeldError
		if errors.As(err, &held) {
			return WorkspaceLease{}, WorkspaceLeaseHeldError{
				WorkspaceID: held.WorkspaceID,
				RuntimeID:   held.RuntimeID,
				LeaseID:     held.LeaseID,
				ExpiresAt:   held.ExpiresAt,
			}
		}
		return WorkspaceLease{}, err
	}
	return workspaceLeaseFromRedisForACPTest(renewed), nil
}

func (s *redisWorkspaceServiceForACPTest) ReleaseLease(ctx context.Context, lease WorkspaceLease) error {
	return s.store.ReleaseLease(ctx, redisWorkspaceLeaseForACPTest(lease))
}

func (s *redisWorkspaceServiceForACPTest) GetLease(ctx context.Context, workspaceID string) (WorkspaceLease, bool, error) {
	lease, ok, err := s.store.GetLease(ctx, workspaceID)
	if err != nil || !ok {
		return WorkspaceLease{}, ok, err
	}
	return workspaceLeaseFromRedisForACPTest(lease), true, nil
}

func workspaceLeaseFromRedisForACPTest(lease redisstore.WorkspaceLease) WorkspaceLease {
	return WorkspaceLease{
		WorkspaceID:  lease.WorkspaceID,
		RuntimeID:    lease.RuntimeID,
		LeaseID:      lease.LeaseID,
		FencingToken: lease.FencingToken,
		State:        lease.State,
		ExpiresAt:    lease.ExpiresAt,
		HeartbeatAt:  lease.HeartbeatAt,
		CreatedAt:    lease.CreatedAt,
		UpdatedAt:    lease.UpdatedAt,
	}
}

func redisWorkspaceLeaseForACPTest(lease WorkspaceLease) redisstore.WorkspaceLease {
	return redisstore.WorkspaceLease{
		WorkspaceID:  lease.WorkspaceID,
		RuntimeID:    lease.RuntimeID,
		LeaseID:      lease.LeaseID,
		FencingToken: lease.FencingToken,
		State:        lease.State,
		ExpiresAt:    lease.ExpiresAt,
		HeartbeatAt:  lease.HeartbeatAt,
		CreatedAt:    lease.CreatedAt,
		UpdatedAt:    lease.UpdatedAt,
	}
}

var _ WorkspaceService = (*redisWorkspaceServiceForACPTest)(nil)

func (m *leaseBackedACPRuntimeManager) String() string {
	return fmt.Sprintf("lease-backed-acp-runtime-manager:%s", m.workspaceID)
}
