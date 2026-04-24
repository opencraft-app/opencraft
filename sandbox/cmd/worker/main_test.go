package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"cvm-mock-e2b/internal/core"
	"cvm-mock-e2b/internal/faultinject"
	"cvm-mock-e2b/internal/provider"
	"cvm-mock-e2b/internal/service"
	"cvm-mock-e2b/internal/store"
)

const (
	testVpcID    = "vpc-test"
	testSubnetID = "subnet-test"
	testZone     = "ap-beijing-8"
)

var testSecurityGroups = []string{"sg-test"}

// stubProvider lets tests script TerminateInstance results while satisfying the interface.
type stubProvider struct {
	createCloudIDs []string
	createAddrs    []string
	createErrs     []error
	createCalls    int
	bundleCalls    int

	terminateErrs  []error
	terminateCalls int

	reinstallErr   error
	reinstallCalls int

	verifyErrs  []error
	verifyErr   error
	verifyCalls int
}

func (p *stubProvider) nextErr() error {
	if len(p.terminateErrs) == 0 {
		return nil
	}
	err := p.terminateErrs[0]
	p.terminateErrs = p.terminateErrs[1:]
	return err
}

func (p *stubProvider) nextCreateErr() error {
	if len(p.createErrs) == 0 {
		return nil
	}
	err := p.createErrs[0]
	p.createErrs = p.createErrs[1:]
	return err
}

func (p *stubProvider) nextVerifyErr() error {
	if len(p.verifyErrs) == 0 {
		return p.verifyErr
	}
	err := p.verifyErrs[0]
	p.verifyErrs = p.verifyErrs[1:]
	return err
}

func (p *stubProvider) CreateInstance(ctx context.Context, pool core.Pool) (string, string, error) {
	p.createCalls++
	err := p.nextCreateErr()
	if err != nil {
		return "", "", err
	}
	cloudID := "cloud-default"
	if len(p.createCloudIDs) >= p.createCalls {
		cloudID = p.createCloudIDs[p.createCalls-1]
	}
	addr := "10.0.0.10"
	if len(p.createAddrs) >= p.createCalls {
		addr = p.createAddrs[p.createCalls-1]
	}
	return cloudID, addr, nil
}

func (p *stubProvider) ReinstallInstance(ctx context.Context, cloudID string, imageID string) error {
	p.reinstallCalls++
	return p.reinstallErr
}

func (p *stubProvider) DescribeInstance(ctx context.Context, cloudID string) (string, error) {
	return "", errors.New("not implemented")
}

func (p *stubProvider) TerminateInstance(ctx context.Context, cloudID string) error {
	p.terminateCalls++
	return p.nextErr()
}

func (p *stubProvider) VerifyInstance(ctx context.Context, address string) error {
	p.verifyCalls++
	return p.nextVerifyErr()
}

func (p *stubProvider) ProvisionCapacityBundle(ctx context.Context, req provider.CapacityBundleProvisionRequest) (core.CapacityBundle, error) {
	p.bundleCalls++
	now := time.Now().UTC()
	suffix := req.TemplateClassID
	if suffix == "" {
		suffix = "default"
	}
	suffix = fmt.Sprintf("%s-%d", suffix, p.bundleCalls)
	return core.CapacityBundle{
		ID:               "bundle-" + suffix,
		Region:           req.Region,
		Zone:             testZone,
		VpcID:            testVpcID,
		SubnetID:         testSubnetID,
		SecurityGroupIDs: testSecurityGroups,
		Status:           core.CapacityBundleStatusWarm,
		LineageTags: map[string]string{
			"template_class_id": req.TemplateClassID,
		},
		CreatedAt: now,
		UpdatedAt: now,
	}, nil
}

type janitorProvider struct {
	stubProvider
	shards  []provider.ManagedSecurityGroupShard
	deleted []string
}

func (p *janitorProvider) ListManagedPendingSecurityGroupShards(context.Context, string) ([]provider.ManagedSecurityGroupShard, error) {
	return append([]provider.ManagedSecurityGroupShard(nil), p.shards...), nil
}

func (p *janitorProvider) DeleteSecurityGroup(_ context.Context, _ string, securityGroupID string) error {
	p.deleted = append(p.deleted, securityGroupID)
	return nil
}

type liveProvisionOnlyProvider struct {
	real *provider.TencentCloudProvider
}

func (p *liveProvisionOnlyProvider) CreateInstance(context.Context, core.Pool) (string, string, error) {
	return "", "", errors.New("[TencentCloudSDKException] code:LimitExceeded.CvmsVifsPerSecGroupLimitExceeded message:security group eni limit exceeded")
}

func (p *liveProvisionOnlyProvider) ReinstallInstance(context.Context, string, string) error {
	return errors.New("not implemented")
}

func (p *liveProvisionOnlyProvider) DescribeInstance(context.Context, string) (string, error) {
	return "", errors.New("not implemented")
}

func (p *liveProvisionOnlyProvider) TerminateInstance(context.Context, string) error {
	return errors.New("not implemented")
}

func (p *liveProvisionOnlyProvider) VerifyInstance(context.Context, string) error {
	return errors.New("not implemented")
}

func (p *liveProvisionOnlyProvider) ProvisionCapacityBundle(ctx context.Context, req provider.CapacityBundleProvisionRequest) (core.CapacityBundle, error) {
	return p.real.ProvisionCapacityBundle(ctx, req)
}

func requiredWorkerLiveEnv(t *testing.T, key string) string {
	t.Helper()
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		t.Fatalf("missing required live env %s", key)
	}
	return value
}

func firstNonEmptyWorkerLiveEnv(keys ...string) string {
	for _, key := range keys {
		if value := strings.TrimSpace(os.Getenv(key)); value != "" {
			return value
		}
	}
	return ""
}

func splitWorkerLiveEnv(value string) []string {
	parts := strings.Split(value, ",")
	items := make([]string, 0, len(parts))
	for _, part := range parts {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			items = append(items, trimmed)
		}
	}
	return items
}

type recordingStore struct {
	store.Store
	lastStates []core.InstanceState
}

func (s *recordingStore) ListInstancesByStates(ctx context.Context, poolID string, states []core.InstanceState, limit int) ([]core.Instance, error) {
	s.lastStates = append([]core.InstanceState(nil), states...)
	return s.Store.ListInstancesByStates(ctx, poolID, states, limit)
}

func mustGetSKU(t *testing.T, svc *service.Service, skuID string) core.SKU {
	t.Helper()
	sku, err := svc.GetSKU(context.Background(), skuID)
	if err != nil {
		t.Fatalf("get sku %s: %v", skuID, err)
	}
	return sku
}

func TestCleanupDeletingRetriesThenSucceeds(t *testing.T) {
	ctx := context.Background()
	svc := service.NewService(store.NewMemoryStore())
	verifyOK := func(context.Context, string) error { return nil }
	pool, err := svc.CreatePool(ctx, "p1", "desc", "img", 0, testVpcID, testSubnetID, testZone, testSecurityGroups)
	if err != nil {
		t.Fatalf("create pool: %v", err)
	}
	insts, err := svc.RefillVerified(ctx, pool.ID, 1, nil, []string{"cloud-1"}, verifyOK)
	if err != nil {
		t.Fatalf("refill: %v", err)
	}
	inst := insts[0]
	if _, err := svc.AdvanceState(ctx, inst.ID, core.StateDeleting); err != nil {
		t.Fatalf("advance to deleting: %v", err)
	}

	cp := &stubProvider{terminateErrs: []error{errors.New("cloud fail"), nil}}

	cleanupDeleting(ctx, svc, cp, pool)
	if cp.terminateCalls != 1 {
		t.Fatalf("expected 1 terminate call after first retry, got %d", cp.terminateCalls)
	}
	got, err := svc.GetInstance(ctx, inst.ID)
	if err != nil {
		t.Fatalf("get instance after first retry: %v", err)
	}
	if got.State != core.StateDeleting {
		t.Fatalf("expected state DELETING after failed terminate, got %s", got.State)
	}

	cleanupDeleting(ctx, svc, cp, pool)
	if cp.terminateCalls != 2 {
		t.Fatalf("expected 2 terminate calls after second retry, got %d", cp.terminateCalls)
	}
	if _, err := svc.GetInstance(ctx, inst.ID); !errors.Is(err, core.ErrInstanceNotFound) {
		t.Fatalf("expected instance removed after successful delete, got state err=%v", err)
	}
}

func TestCleanupStaleInflightMarksFailed(t *testing.T) {
	defer func(old time.Duration) { creatingStaleAfter = old }(creatingStaleAfter)
	defer func(old time.Duration) { resettingStaleAfter = old }(resettingStaleAfter)
	creatingStaleAfter = 0
	resettingStaleAfter = 0

	ctx := context.Background()
	svc := service.NewService(store.NewMemoryStore())
	pool, err := svc.CreatePool(ctx, "p2", "desc", "img", 0, testVpcID, testSubnetID, testZone, testSecurityGroups)
	if err != nil {
		t.Fatalf("create pool: %v", err)
	}
	insts, err := svc.InsertCreating(ctx, pool.ID, 2)
	if err != nil {
		t.Fatalf("insert creating: %v", err)
	}
	creatingInst := insts[0]
	cleanCandidate := insts[1]
	if _, err := svc.FinalizeCreating(ctx, cleanCandidate.ID, core.StateClean, "1.1.1.1", "cloud-x"); err != nil {
		t.Fatalf("finalize creating to clean: %v", err)
	}
	reinstallInst, err := svc.Allocate(ctx, pool.ID)
	if err != nil {
		t.Fatalf("allocate: %v", err)
	}
	if _, err := svc.Release(ctx, reinstallInst.ID); err != nil {
		t.Fatalf("release: %v", err)
	}
	if _, err := svc.AdvanceState(ctx, reinstallInst.ID, core.StateResetting); err != nil {
		t.Fatalf("advance to resetting: %v", err)
	}

	cleanupStaleInflightStates(ctx, svc, pool, []inflightStaleRule{
		{State: core.StateCreating, StaleAfter: creatingStaleAfter, Target: core.StateFailed, Name: "creating"},
		{State: core.StateResetting, StaleAfter: resettingStaleAfter, Target: core.StateFailed, Name: "resetting"},
	})

	gotCreating, err := svc.GetInstance(ctx, creatingInst.ID)
	if err != nil {
		t.Fatalf("get creating instance: %v", err)
	}
	if gotCreating.State != core.StateFailed {
		t.Fatalf("expected creating instance state FAILED after stale cleanup, got %s", gotCreating.State)
	}
	gotResetting, err := svc.GetInstance(ctx, reinstallInst.ID)
	if err != nil {
		t.Fatalf("get resetting instance: %v", err)
	}
	if gotResetting.State != core.StateFailed {
		t.Fatalf("expected resetting instance state FAILED after stale cleanup, got %s", gotResetting.State)
	}
}

func TestCheckWaterlineDoesNotScanAllocated(t *testing.T) {
	ctx := context.Background()
	rec := &recordingStore{Store: store.NewMemoryStore()}
	svc := service.NewService(rec)
	verifyOK := func(context.Context, string) error { return nil }

	pool, err := svc.CreatePool(ctx, "p-waterline", "desc", "img", 1, testVpcID, testSubnetID, testZone, testSecurityGroups)
	if err != nil {
		t.Fatalf("create pool: %v", err)
	}
	insts, err := svc.RefillVerified(ctx, pool.ID, 1, []string{"1.1.1.1"}, []string{"cloud-1"}, verifyOK)
	if err != nil {
		t.Fatalf("refill: %v", err)
	}
	if _, err := svc.Allocate(ctx, pool.ID); err != nil {
		t.Fatalf("allocate: %v", err)
	}

	checkWaterline(ctx, svc, &stubProvider{}, nil, pool, 0)

	if len(rec.lastStates) == 0 {
		t.Fatalf("expected waterline to request tracked states")
	}
	for _, st := range rec.lastStates {
		if st == core.StateAllocated {
			t.Fatalf("expected waterline to skip ALLOCATED state, got states=%v instance=%s", rec.lastStates, insts[0].ID)
		}
	}
}

func TestDesiredCapacityTargetForShardSplitsTotalAcrossShards(t *testing.T) {
	tests := []struct {
		name       string
		desired    int
		shardTotal int
		shardIndex int
		want       int
	}{
		{name: "unsharded uses total", desired: 24, shardTotal: 0, shardIndex: 0, want: 24},
		{name: "even split", desired: 24, shardTotal: 8, shardIndex: 0, want: 3},
		{name: "remainder first shard", desired: 25, shardTotal: 8, shardIndex: 0, want: 4},
		{name: "remainder middle shard", desired: 25, shardTotal: 8, shardIndex: 1, want: 3},
		{name: "more shards than desired", desired: 3, shardTotal: 8, shardIndex: 4, want: 0},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := desiredCapacityTargetForShard(tt.desired, tt.shardTotal, tt.shardIndex)
			if got != tt.want {
				t.Fatalf("desiredCapacityTargetForShard(%d, %d, %d)=%d want=%d", tt.desired, tt.shardTotal, tt.shardIndex, got, tt.want)
			}
		})
	}
}

func TestDoRefillSkipsPausedPool(t *testing.T) {
	ctx := context.Background()
	svc := service.NewService(store.NewMemoryStore())
	pool, err := svc.CreatePool(ctx, "paused-pool", "desc", "img", 24, testVpcID, testSubnetID, testZone, testSecurityGroups)
	if err != nil {
		t.Fatalf("create pool: %v", err)
	}
	pool.Status = core.PoolStatusPaused
	pool.PauseReason = "manual"
	if _, err := svc.UpdatePool(ctx, pool); err != nil {
		t.Fatalf("pause pool: %v", err)
	}

	cp := &stubProvider{}
	if err := doRefill(ctx, svc, cp, nil, pool.ID, 0, 1); err != nil {
		t.Fatalf("refill: %v", err)
	}
	if cp.createCalls != 0 {
		t.Fatalf("expected paused pool to skip create, got %d create calls", cp.createCalls)
	}
}

func TestReconcileOrphanSecurityGroupShardsDeletesOnlyUnreferencedPendingOlderThanTTL(t *testing.T) {
	ctx := context.Background()
	svc := service.NewService(store.NewMemoryStore())
	now := time.Now().UTC()
	old := now.Add(-101 * time.Second)

	pool, err := svc.CreatePool(ctx, "pool-ref", "desc", "img", 1, testVpcID, testSubnetID, testZone, []string{"sg-pool-ref"})
	if err != nil {
		t.Fatalf("create pool: %v", err)
	}
	pool.TemplateClassID = "tc-1"
	pool.SKUID = "sku-1"
	if _, err := svc.UpdatePool(ctx, pool); err != nil {
		t.Fatalf("update pool: %v", err)
	}
	if _, err := svc.UpsertCapacityBundle(ctx, core.CapacityBundle{
		ID:               "bundle-ref",
		Region:           "ap-beijing",
		Zone:             testZone,
		VpcID:            testVpcID,
		SubnetID:         testSubnetID,
		SecurityGroupIDs: []string{"sg-bundle-ref"},
		Status:           core.CapacityBundleStatusWarm,
		CreatedAt:        old,
		UpdatedAt:        old,
	}); err != nil {
		t.Fatalf("upsert bundle: %v", err)
	}

	cp := &janitorProvider{
		shards: []provider.ManagedSecurityGroupShard{
			{ID: "sg-orphan-old", Region: "ap-beijing", Description: "k=sg,st=pending,src=sg-src,tc=fi-1", State: "pending", CreatedAt: old},
			{ID: "sg-young", Region: "ap-beijing", Description: "k=sg,st=pending,src=sg-src,tc=fi-2", State: "pending", CreatedAt: now.Add(-30 * time.Second)},
			{ID: "sg-pool-ref", Region: "ap-beijing", Description: "k=sg,st=pending,src=sg-src,tc=fi-3", State: "pending", CreatedAt: old},
			{ID: "sg-bundle-ref", Region: "ap-beijing", Description: "k=sg,st=pending,src=sg-src,tc=fi-4", State: "pending", CreatedAt: old},
		},
	}

	deleted, err := reconcileOrphanSecurityGroupShards(ctx, svc, cp, 100*time.Second, "")
	if err != nil {
		t.Fatalf("reconcile orphan sg shards: %v", err)
	}
	if deleted != 1 {
		t.Fatalf("expected 1 deleted orphan, got %d", deleted)
	}
	if len(cp.deleted) != 1 || cp.deleted[0] != "sg-orphan-old" {
		t.Fatalf("expected only sg-orphan-old to be deleted, got %v", cp.deleted)
	}
}

func TestShouldEmitRefillSkippedDedupesByPoolAndReason(t *testing.T) {
	refillSkippedStateMu.Lock()
	refillSkippedState = map[string]string{}
	refillSkippedStateMu.Unlock()

	pool := core.Pool{ID: "pool-a", PauseReason: "manual"}
	if !shouldEmitRefillSkipped(pool) {
		t.Fatalf("expected first paused observation to emit")
	}
	if shouldEmitRefillSkipped(pool) {
		t.Fatalf("expected repeated paused observation with same reason to suppress emission")
	}

	pool.PauseReason = "operator-confirmed"
	if !shouldEmitRefillSkipped(pool) {
		t.Fatalf("expected reason change to emit again")
	}

	clearRefillSkipped(pool.ID)
	if !shouldEmitRefillSkipped(pool) {
		t.Fatalf("expected cleared paused state to emit again")
	}
}

func TestRefillCreatedSummaries(t *testing.T) {
	items, truncated := refillCreatedSummaries([]core.Instance{
		{
			ID:      "inst-1",
			CloudID: "cloud-1",
			Address: "10.0.0.1",
			State:   core.StateClean,
		},
		{
			ID:      "inst-2",
			CloudID: "cloud-2",
			Address: "10.0.0.2",
			State:   core.StateClean,
		},
	})
	if truncated {
		t.Fatalf("expected non-truncated sample for 2 instances")
	}
	if len(items) != 2 {
		t.Fatalf("expected 2 refill summaries, got %d", len(items))
	}
	if items[0].InstanceID != "inst-1" || items[0].CloudID != "cloud-1" || items[0].Address != "10.0.0.1" || items[0].State != core.StateClean {
		t.Fatalf("unexpected first refill summary: %+v", items[0])
	}
	if items[1].InstanceID != "inst-2" || items[1].CloudID != "cloud-2" || items[1].Address != "10.0.0.2" || items[1].State != core.StateClean {
		t.Fatalf("unexpected second refill summary: %+v", items[1])
	}
}

func TestRefillCreatedSummariesTruncatesLargePayload(t *testing.T) {
	insts := make([]core.Instance, 0, refillCreatedSampleLimit+2)
	for i := 0; i < refillCreatedSampleLimit+2; i++ {
		insts = append(insts, core.Instance{
			ID:      fmt.Sprintf("inst-%d", i),
			CloudID: fmt.Sprintf("cloud-%d", i),
			Address: fmt.Sprintf("10.0.0.%d", i),
			State:   core.StateClean,
		})
	}

	items, truncated := refillCreatedSummaries(insts)
	if !truncated {
		t.Fatalf("expected truncated sample for oversized payload")
	}
	if len(items) != refillCreatedSampleLimit {
		t.Fatalf("expected %d refill summaries, got %d", refillCreatedSampleLimit, len(items))
	}
	if items[0].InstanceID != "inst-0" || items[refillCreatedSampleLimit-1].InstanceID != fmt.Sprintf("inst-%d", refillCreatedSampleLimit-1) {
		t.Fatalf("unexpected truncated sample boundaries: first=%+v last=%+v", items[0], items[len(items)-1])
	}
}

func TestDoRefillPausesPoolAfterTencentDocumentedTerminalCreateErrors(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		errMsg   string
		wantCode string
	}{
		{
			name:     "security group eni limit exceeded",
			errMsg:   "[TencentCloudSDKException] code:LimitExceeded.CvmsVifsPerSecGroupLimitExceeded message:security group eni limit exceeded",
			wantCode: "LimitExceeded.CvmsVifsPerSecGroupLimitExceeded",
		},
		{
			name:     "subnet no available ip",
			errMsg:   "[TencentCloudSDKException] code:FailedOperation.NoAvailableIpAddressCountInSubnet message:no available ip address in subnet",
			wantCode: "FailedOperation.NoAvailableIpAddressCountInSubnet",
		},
		{
			name:     "instance quota exceeded",
			errMsg:   "[TencentCloudSDKException] code:InstancesQuotaLimitExceeded message:instance quota exceeded",
			wantCode: "InstancesQuotaLimitExceeded",
		},
		{
			name:     "availability zone sold out",
			errMsg:   "[TencentCloudSDKException] code:ResourceInsufficient.AvailabilityZoneSoldOut message:availability zone sold out",
			wantCode: "ResourceInsufficient.AvailabilityZoneSoldOut",
		},
		{
			name:     "zone mismatch",
			errMsg:   "[TencentCloudSDKException] code:InvalidZone.MismatchRegion message:zone mismatch",
			wantCode: "InvalidZone.MismatchRegion",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			ctx := context.Background()
			svc := service.NewService(store.NewMemoryStore())
			pool, err := svc.CreatePool(ctx, "terminal-pool", "desc", "img", 1, testVpcID, testSubnetID, testZone, testSecurityGroups)
			if err != nil {
				t.Fatalf("create pool: %v", err)
			}

			cp := &stubProvider{
				createErrs: []error{errors.New(tt.errMsg)},
			}
			if err := doRefill(ctx, svc, cp, nil, pool.ID, 0, 1); err != nil {
				t.Fatalf("refill: %v", err)
			}

			got, err := svc.GetPool(ctx, pool.ID)
			if err != nil {
				t.Fatalf("get pool: %v", err)
			}
			if got.Status != core.PoolStatusPaused {
				t.Fatalf("expected pool to be paused after terminal error, got %q", got.Status)
			}
			if got.LastRefillErrorCode != tt.wantCode {
				t.Fatalf("expected refill error code %q, got %q", tt.wantCode, got.LastRefillErrorCode)
			}
			if got.PauseReason == "" {
				t.Fatalf("expected pause reason to be recorded")
			}
		})
	}
}

func TestDoRefillDoesNotPausePoolAfterRetryableTencentCreateError(t *testing.T) {
	ctx := context.Background()
	svc := service.NewService(store.NewMemoryStore())
	pool, err := svc.CreatePool(ctx, "retryable-pool", "desc", "img", 1, testVpcID, testSubnetID, testZone, testSecurityGroups)
	if err != nil {
		t.Fatalf("create pool: %v", err)
	}

	cp := &stubProvider{
		createErrs: []error{errors.New("[TencentCloudSDKException] code:RequestLimitExceeded message:rate limited")},
	}
	if err := doRefill(ctx, svc, cp, nil, pool.ID, 0, 1); err != nil {
		t.Fatalf("refill: %v", err)
	}

	got, err := svc.GetPool(ctx, pool.ID)
	if err != nil {
		t.Fatalf("get pool: %v", err)
	}
	if got.Status == core.PoolStatusPaused {
		t.Fatalf("expected retryable create error to keep pool active")
	}
	if got.LastRefillErrorCode != "RequestLimitExceeded" {
		t.Fatalf("expected refill error code RequestLimitExceeded, got %q", got.LastRefillErrorCode)
	}
}

func TestDoRefillAutoProvisionsNewShardPoolOnSecurityGroupLimit(t *testing.T) {
	ctx := context.Background()
	svc := service.NewService(store.NewMemoryStore())
	if _, err := svc.UpsertTemplateClass(ctx, core.TemplateClass{
		ID:             "openclaw-default",
		Region:         "ap-beijing",
		ResolutionMode: core.ResolutionModeSandboxPrimary,
	}); err != nil {
		t.Fatalf("upsert template class: %v", err)
	}
	if _, err := svc.UpsertSKU(ctx, core.SKU{
		ID:                     "sku-default",
		Name:                   "Default SKU",
		TemplateClassID:        "openclaw-default",
		BaseImage:              "img-old",
		DesiredImageID:         "img-new",
		InstanceType:           "SA9.MEDIUM2",
		NetworkTemplateID:      "network-template-a",
		DefaultDesiredCapacity: 1,
		RolloutState:           core.SKURolloutStateStable,
	}); err != nil {
		t.Fatalf("upsert sku: %v", err)
	}
	if _, err := svc.ReplaceTemplateSkuBindings(ctx, "openclaw-default", []core.TemplateSkuBinding{{
		SKUID:              "sku-default",
		Priority:           1,
		Weight:             1,
		AdmissionState:     "active",
		RolloutEligibility: true,
	}}); err != nil {
		t.Fatalf("replace template sku bindings: %v", err)
	}

	pool, err := svc.CreatePool(ctx, "sg-limit-pool", "desc", "img-old", 1, testVpcID, testSubnetID, testZone, testSecurityGroups)
	if err != nil {
		t.Fatalf("create pool: %v", err)
	}
	pool.TemplateClassID = "openclaw-default"
	pool.SKUID = "sku-default"
	if _, err := svc.UpdatePool(ctx, pool); err != nil {
		t.Fatalf("update pool: %v", err)
	}

	cp := &stubProvider{
		createErrs: []error{errors.New("[TencentCloudSDKException] code:LimitExceeded.CvmsVifsPerSecGroupLimitExceeded message:security group eni limit exceeded")},
	}
	if err := doRefill(ctx, svc, cp, nil, pool.ID, 0, 1); err != nil {
		t.Fatalf("refill: %v", err)
	}
	if cp.bundleCalls != 1 {
		t.Fatalf("expected sg limit to trigger one bundle provision, got %d", cp.bundleCalls)
	}

	pools, err := svc.ListPoolsForSKU(ctx, "sku-default")
	if err != nil {
		t.Fatalf("list pools for sku: %v", err)
	}
	if len(pools) != 2 {
		t.Fatalf("expected original pool plus new shard pool, got %d", len(pools))
	}
	foundNew := false
	for _, item := range pools {
		if item.ID == pool.ID {
			continue
		}
		foundNew = true
		if item.CapacityBundleID == "" {
			t.Fatalf("expected new shard pool to reference a capacity bundle")
		}
		if len(item.SecurityGroups) == 0 {
			t.Fatalf("expected new shard pool to carry cloned security groups")
		}
	}
	if !foundNew {
		t.Fatalf("expected a new shard pool to be created")
	}

	got, err := svc.GetPool(ctx, pool.ID)
	if err != nil {
		t.Fatalf("get source pool: %v", err)
	}
	if got.Status != core.PoolStatusPaused {
		t.Fatalf("expected source pool to be paused after sg limit, got %q", got.Status)
	}
	if got.LastAutoscaleAction != "sg_shard_recovery_pending" {
		t.Fatalf("expected sg shard recovery lease to be recorded, got %q", got.LastAutoscaleAction)
	}
}

func TestAttemptSGShardScaleOutDedupesPerSourcePool(t *testing.T) {
	ctx := context.Background()
	svc := service.NewService(store.NewMemoryStore())
	if _, err := svc.UpsertTemplateClass(ctx, core.TemplateClass{
		ID:             "openclaw-default",
		Region:         "ap-beijing",
		ResolutionMode: core.ResolutionModeSandboxPrimary,
	}); err != nil {
		t.Fatalf("upsert template class: %v", err)
	}
	if _, err := svc.UpsertSKU(ctx, core.SKU{
		ID:                     "sku-default",
		Name:                   "Default SKU",
		TemplateClassID:        "openclaw-default",
		BaseImage:              "img-old",
		DesiredImageID:         "img-new",
		InstanceType:           "SA9.MEDIUM2",
		NetworkTemplateID:      "network-template-a",
		DefaultDesiredCapacity: 1,
		RolloutState:           core.SKURolloutStateStable,
	}); err != nil {
		t.Fatalf("upsert sku: %v", err)
	}
	if _, err := svc.ReplaceTemplateSkuBindings(ctx, "openclaw-default", []core.TemplateSkuBinding{{
		SKUID:              "sku-default",
		Priority:           1,
		Weight:             1,
		AdmissionState:     "active",
		RolloutEligibility: true,
	}}); err != nil {
		t.Fatalf("replace template sku bindings: %v", err)
	}
	pool, err := svc.CreatePool(ctx, "sg-limit-pool", "desc", "img-old", 1, testVpcID, testSubnetID, testZone, testSecurityGroups)
	if err != nil {
		t.Fatalf("create pool: %v", err)
	}
	pool.TemplateClassID = "openclaw-default"
	pool.SKUID = "sku-default"
	if _, err := svc.UpdatePool(ctx, pool); err != nil {
		t.Fatalf("update pool: %v", err)
	}
	cp := &stubProvider{}

	if _, err := faultinject.TriggerSGLimitRecovery(ctx, svc, cp, pool, "LimitExceeded.CvmsVifsPerSecGroupLimitExceeded"); err != nil {
		t.Fatalf("first TriggerSGLimitRecovery: %v", err)
	}
	if _, err := faultinject.TriggerSGLimitRecovery(ctx, svc, cp, pool, "LimitExceeded.CvmsVifsPerSecGroupLimitExceeded"); err != nil {
		t.Fatalf("second TriggerSGLimitRecovery: %v", err)
	}
	if cp.bundleCalls != 1 {
		t.Fatalf("expected sg shard recovery to provision only one bundle, got %d", cp.bundleCalls)
	}
}

func TestDoRefillLiveFaultInjectionAutoProvisionsNewShardPool(t *testing.T) {
	if strings.TrimSpace(os.Getenv("SANDBOX_TENCENT_LIVE_FAULT_INJECTION")) != "1" {
		t.Skip("set SANDBOX_TENCENT_LIVE_FAULT_INJECTION=1 to run the live SG-limit auto-recovery test")
	}

	realProvider, err := provider.NewTencentCloudProviderFromEnv()
	if err != nil {
		t.Fatalf("init tencent provider from env: %v", err)
	}
	region := firstNonEmptyWorkerLiveEnv("SANDBOX_TENCENT_LIVE_REGION", "TENCENT_REGION")
	zone := requiredWorkerLiveEnv(t, "SANDBOX_TENCENT_LIVE_ZONE")
	vpcID := requiredWorkerLiveEnv(t, "SANDBOX_TENCENT_LIVE_VPC_ID")
	subnetID := requiredWorkerLiveEnv(t, "SANDBOX_TENCENT_LIVE_SUBNET_ID")
	securityGroups := splitWorkerLiveEnv(requiredWorkerLiveEnv(t, "SANDBOX_TENCENT_LIVE_SECURITY_GROUPS"))

	for _, key := range []string{
		"SANDBOX_VPC_ID",
		"SANDBOX_POOL_BJ8_SUBNET_ID",
		"SANDBOX_POOL_BJ8_ZONE",
		"SANDBOX_POOL_BJ8_SECURITY_GROUPS",
	} {
		_ = os.Unsetenv(key)
	}
	t.Setenv("SANDBOX_TENCENT_LIVE_VPC_ID", vpcID)
	t.Setenv("SANDBOX_TENCENT_LIVE_SUBNET_ID", subnetID)
	t.Setenv("SANDBOX_TENCENT_LIVE_ZONE", zone)
	t.Setenv("SANDBOX_TENCENT_LIVE_SECURITY_GROUPS", strings.Join(securityGroups, ","))

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	svc := service.NewService(store.NewMemoryStore())
	if _, err := svc.UpsertTemplateClass(ctx, core.TemplateClass{
		ID:             "openclaw-default",
		Region:         region,
		ResolutionMode: core.ResolutionModeSandboxPrimary,
	}); err != nil {
		t.Fatalf("upsert template class: %v", err)
	}
	if _, err := svc.UpsertSKU(ctx, core.SKU{
		ID:                     "sku-default",
		Name:                   "Default SKU",
		TemplateClassID:        "openclaw-default",
		BaseImage:              requiredWorkerLiveEnv(t, "SANDBOX_TENCENT_LIVE_IMAGE_ID"),
		DesiredImageID:         requiredWorkerLiveEnv(t, "SANDBOX_TENCENT_LIVE_IMAGE_ID"),
		InstanceType:           firstNonEmptyWorkerLiveEnv("SANDBOX_TENCENT_LIVE_INSTANCE_TYPE", "TENCENT_INSTANCE_TYPE"),
		NetworkTemplateID:      "network-template-a",
		DefaultDesiredCapacity: 1,
		RolloutState:           core.SKURolloutStateStable,
	}); err != nil {
		t.Fatalf("upsert sku: %v", err)
	}
	if _, err := svc.ReplaceTemplateSkuBindings(ctx, "openclaw-default", []core.TemplateSkuBinding{{
		SKUID:              "sku-default",
		Priority:           1,
		Weight:             1,
		AdmissionState:     "active",
		RolloutEligibility: true,
	}}); err != nil {
		t.Fatalf("replace template sku bindings: %v", err)
	}

	pool, err := svc.CreatePool(ctx, "live-sg-limit-pool", "live", requiredWorkerLiveEnv(t, "SANDBOX_TENCENT_LIVE_IMAGE_ID"), 1, vpcID, subnetID, zone, securityGroups)
	if err != nil {
		t.Fatalf("create pool: %v", err)
	}
	pool.TemplateClassID = "openclaw-default"
	pool.SKUID = "sku-default"
	if _, err := svc.UpdatePool(ctx, pool); err != nil {
		t.Fatalf("update pool: %v", err)
	}

	liveProvider := &liveProvisionOnlyProvider{real: realProvider}
	if err := doRefill(ctx, svc, liveProvider, nil, pool.ID, 0, 1); err != nil {
		t.Fatalf("doRefill live fault injection: %v", err)
	}

	pools, err := svc.ListPoolsForSKU(ctx, "sku-default")
	if err != nil {
		t.Fatalf("list pools for sku: %v", err)
	}
	if len(pools) != 2 {
		t.Fatalf("expected original pool plus new shard pool, got %d", len(pools))
	}

	var clonedSGs []string
	for _, item := range pools {
		if item.ID == pool.ID {
			continue
		}
		clonedSGs = append(clonedSGs, item.SecurityGroups...)
		if item.CapacityBundleID == "" {
			t.Fatalf("expected new shard pool to reference a capacity bundle")
		}
	}
	if len(clonedSGs) == 0 {
		t.Fatalf("expected live fault injection to clone at least one SG")
	}

	defer func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cleanupCancel()
		for _, sgID := range clonedSGs {
			if err := realProvider.DeleteSecurityGroup(cleanupCtx, region, sgID); err != nil {
				t.Fatalf("delete cloned security group %s failed: %v", sgID, err)
			}
		}
	}()
}

func TestDoRefillLiveDBFaultInjectionAutoProvisionsNewShardPool(t *testing.T) {
	if strings.TrimSpace(os.Getenv("SANDBOX_TENCENT_LIVE_DB_FAULT_INJECTION")) != "1" {
		t.Skip("set SANDBOX_TENCENT_LIVE_DB_FAULT_INJECTION=1 to run the live DB + SG-limit auto-recovery test")
	}

	dsn := requiredWorkerLiveEnv(t, "MYSQL_DSN")
	mysqlStore, err := store.NewMySQLStore(dsn)
	if err != nil {
		t.Fatalf("init mysql store: %v", err)
	}
	sqlDB, err := sql.Open("mysql", dsn)
	if err != nil {
		t.Fatalf("open mysql db: %v", err)
	}
	defer sqlDB.Close()

	realProvider, err := provider.NewTencentCloudProviderFromEnv()
	if err != nil {
		t.Fatalf("init tencent provider from env: %v", err)
	}
	region := firstNonEmptyWorkerLiveEnv("SANDBOX_TENCENT_LIVE_REGION", "TENCENT_REGION")
	zone := requiredWorkerLiveEnv(t, "SANDBOX_TENCENT_LIVE_ZONE")
	vpcID := requiredWorkerLiveEnv(t, "SANDBOX_TENCENT_LIVE_VPC_ID")
	subnetID := requiredWorkerLiveEnv(t, "SANDBOX_TENCENT_LIVE_SUBNET_ID")
	securityGroups := splitWorkerLiveEnv(requiredWorkerLiveEnv(t, "SANDBOX_TENCENT_LIVE_SECURITY_GROUPS"))

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()
	svc := service.NewService(mysqlStore)
	suffix := fmt.Sprintf("live-fi-%d", time.Now().UnixNano())
	templateClassID := "openclaw-" + suffix
	skuID := "sku-" + suffix
	sourcePoolID := "pool-" + suffix

	var clonedSGs []string
	var bundleIDs []string
	var poolIDs []string
	defer func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cleanupCancel()
		for _, sgID := range clonedSGs {
			if err := realProvider.DeleteSecurityGroup(cleanupCtx, region, sgID); err != nil {
				t.Fatalf("delete cloned security group %s failed: %v", sgID, err)
			}
		}
		for _, bundleID := range bundleIDs {
			_, _ = sqlDB.ExecContext(cleanupCtx, `DELETE FROM capacity_bundles WHERE id = ?`, bundleID)
		}
		for _, poolID := range poolIDs {
			_, _ = sqlDB.ExecContext(cleanupCtx, `DELETE FROM template_pool_bindings WHERE pool_id = ?`, poolID)
			_, _ = sqlDB.ExecContext(cleanupCtx, `DELETE FROM instances WHERE pool_id = ?`, poolID)
			_, _ = sqlDB.ExecContext(cleanupCtx, `DELETE FROM pools WHERE id = ?`, poolID)
		}
		_, _ = sqlDB.ExecContext(cleanupCtx, `DELETE FROM template_sku_bindings WHERE template_class_id = ?`, templateClassID)
		_, _ = sqlDB.ExecContext(cleanupCtx, `DELETE FROM skus WHERE id = ?`, skuID)
		_, _ = sqlDB.ExecContext(cleanupCtx, `DELETE FROM template_classes WHERE id = ?`, templateClassID)
	}()

	if _, err := svc.UpsertTemplateClass(ctx, core.TemplateClass{
		ID:             templateClassID,
		Name:           templateClassID,
		Region:         region,
		ResolutionMode: core.ResolutionModeSandboxPrimary,
	}); err != nil {
		t.Fatalf("upsert template class: %v", err)
	}
	if _, err := svc.UpsertSKU(ctx, core.SKU{
		ID:                     skuID,
		Name:                   skuID,
		TemplateClassID:        templateClassID,
		BaseImage:              requiredWorkerLiveEnv(t, "SANDBOX_TENCENT_LIVE_IMAGE_ID"),
		DesiredImageID:         requiredWorkerLiveEnv(t, "SANDBOX_TENCENT_LIVE_IMAGE_ID"),
		InstanceType:           firstNonEmptyWorkerLiveEnv("SANDBOX_TENCENT_LIVE_INSTANCE_TYPE", "TENCENT_INSTANCE_TYPE"),
		NetworkTemplateID:      "network-template-a",
		DefaultDesiredCapacity: 1,
		RolloutState:           core.SKURolloutStateStable,
	}); err != nil {
		t.Fatalf("upsert sku: %v", err)
	}
	if _, err := svc.ReplaceTemplateSkuBindings(ctx, templateClassID, []core.TemplateSkuBinding{{
		SKUID:              skuID,
		Priority:           1,
		Weight:             1,
		AdmissionState:     "active",
		RolloutEligibility: true,
	}}); err != nil {
		t.Fatalf("replace template sku bindings: %v", err)
	}

	sourcePool := core.Pool{
		ID:              sourcePoolID,
		Name:            sourcePoolID,
		BaseImage:       requiredWorkerLiveEnv(t, "SANDBOX_TENCENT_LIVE_IMAGE_ID"),
		DesiredCap:      1,
		InstanceType:    firstNonEmptyWorkerLiveEnv("SANDBOX_TENCENT_LIVE_INSTANCE_TYPE", "TENCENT_INSTANCE_TYPE"),
		Status:          core.PoolStatusActive,
		VpcID:           vpcID,
		SubnetID:        subnetID,
		Zone:            zone,
		SecurityGroups:  securityGroups,
		TemplateClassID: templateClassID,
		SKUID:           skuID,
		CapacityState:   core.PoolCapacityStateActive,
		CreatedAt:       time.Now().UTC(),
	}
	if _, err := mysqlStore.CreatePool(ctx, sourcePool); err != nil {
		t.Fatalf("create source pool: %v", err)
	}
	poolIDs = append(poolIDs, sourcePoolID)

	liveProvider := &liveProvisionOnlyProvider{real: realProvider}
	if err := doRefill(ctx, svc, liveProvider, nil, sourcePoolID, 0, 1); err != nil {
		t.Fatalf("doRefill live db fault injection: %v", err)
	}

	pools, err := svc.ListPoolsForSKU(ctx, skuID)
	if err != nil {
		t.Fatalf("list pools for sku: %v", err)
	}
	if len(pools) != 2 {
		t.Fatalf("expected original pool plus new shard pool, got %d", len(pools))
	}
	foundNew := false
	for _, item := range pools {
		if item.ID == sourcePoolID {
			continue
		}
		foundNew = true
		poolIDs = append(poolIDs, item.ID)
		bundleIDs = append(bundleIDs, item.CapacityBundleID)
		clonedSGs = append(clonedSGs, item.SecurityGroups...)
		if item.CapacityBundleID == "" {
			t.Fatalf("expected new shard pool to reference a capacity bundle")
		}
	}
	if !foundNew {
		t.Fatalf("expected a new shard pool to be created")
	}

	bindings, err := svc.ListTemplatePoolBindings(ctx, templateClassID)
	if err != nil {
		t.Fatalf("list template pool bindings: %v", err)
	}
	if len(bindings) == 0 {
		t.Fatalf("expected template pool binding to be persisted in real DB")
	}

	got, err := svc.GetPool(ctx, sourcePoolID)
	if err != nil {
		t.Fatalf("get source pool: %v", err)
	}
	if got.Status != core.PoolStatusPaused {
		t.Fatalf("expected source pool to be paused after sg limit, got %q", got.Status)
	}
}

func TestDoRefillUsesShardShareOfTotalDesiredCapacity(t *testing.T) {
	ctx := store.WithShard(context.Background(), 8, 0)
	svc := service.NewService(store.NewMemoryStore())
	pool, err := svc.CreatePool(ctx, "p-refill-total", "desc", "img", 24, testVpcID, testSubnetID, testZone, testSecurityGroups)
	if err != nil {
		t.Fatalf("create pool: %v", err)
	}

	cp := &stubProvider{}
	if err := doRefill(ctx, svc, cp, nil, pool.ID, 0, 10); err != nil {
		t.Fatalf("doRefill: %v", err)
	}
	if cp.createCalls != 3 {
		t.Fatalf("expected shard 0 to create 3 instances for desired total 24 across 8 shards, got %d", cp.createCalls)
	}
}

func TestEnsureWarmCapacityBundlesCreatesDeficit(t *testing.T) {
	ctx := context.Background()
	svc := service.NewService(store.NewMemoryStore())
	if _, err := svc.UpsertTemplateClass(ctx, core.TemplateClass{
		ID:             "openclaw-default",
		Region:         "ap-beijing",
		ResolutionMode: core.ResolutionModeSandboxPrimary,
	}); err != nil {
		t.Fatalf("upsert template class: %v", err)
	}
	if _, err := svc.UpsertPoolAutoscalePolicy(ctx, core.PoolAutoscalePolicy{
		TemplateClassID:  "openclaw-default",
		WarmBundleTarget: 2,
	}); err != nil {
		t.Fatalf("upsert autoscale policy: %v", err)
	}
	if _, err := svc.UpsertSKU(ctx, core.SKU{
		ID:                          "sku-default",
		Name:                        "Default SKU",
		TemplateClassID:             "openclaw-default",
		BaseImage:                   "img-old",
		DesiredImageID:              "img-new",
		InstanceType:                "SA9.MEDIUM2",
		NetworkTemplateID:           "network-template-a",
		SecurityGroupRuleTemplateID: "sg-template-a",
		RolloutState:                core.SKURolloutStateStable,
	}); err != nil {
		t.Fatalf("upsert sku: %v", err)
	}
	if _, err := svc.ReplaceTemplateSkuBindings(ctx, "openclaw-default", []core.TemplateSkuBinding{{
		SKUID:              "sku-default",
		Priority:           1,
		Weight:             1,
		AdmissionState:     "active",
		RolloutEligibility: true,
	}}); err != nil {
		t.Fatalf("replace template sku bindings: %v", err)
	}

	cp := &stubProvider{}
	created, err := svc.EnsureWarmCapacityBundles(ctx, cp)
	if err != nil {
		t.Fatalf("ensure warm capacity bundles: %v", err)
	}
	if created != 2 {
		t.Fatalf("expected 2 created bundles, got %d", created)
	}
	bundles, err := svc.ListCapacityBundles(ctx)
	if err != nil {
		t.Fatalf("list capacity bundles: %v", err)
	}
	if len(bundles) != 2 {
		t.Fatalf("expected 2 persisted bundles, got %d", len(bundles))
	}
	for _, bundle := range bundles {
		if bundle.LineageTags["sku_id"] != "sku-default" {
			t.Fatalf("expected bundle to be tagged with sku-default, got %+v", bundle.LineageTags)
		}
	}
}

func TestEnsureWarmCapacityBundlesCreatesNewVPCShardWhenExistingShardIsExhausted(t *testing.T) {
	ctx := context.Background()
	svc := service.NewService(store.NewMemoryStore())

	wd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	tmp := t.TempDir()
	if err := os.MkdirAll(filepath.Join(tmp, "config"), 0o755); err != nil {
		t.Fatalf("mkdir config: %v", err)
	}
	blueprintPath := filepath.Join(tmp, "config", "vpc-shard-blueprint.yaml")
	blueprintBody := `
schema_version: v1alpha1
source_region: ap-beijing
network_template_id: network-template-a
vpc_cidr: 10.20.0.0/16
support_subnet:
  name: support
  cidr: 10.20.0.0/24
  zone: ap-beijing-8
  role: support
  ordinal: 0
workload_subnets:
  - name: workload-a
    cidr: 10.20.1.0/24
    zone: ap-beijing-8
    role: workload
    ordinal: 1
  - name: workload-b
    cidr: 10.20.2.0/24
    zone: ap-beijing-7
    role: workload
    ordinal: 2
nat_shape:
  mode: single
  gateways:
    - name: nat-main
      zone: ap-beijing-8
      subnet: support
route_shape:
  route_tables:
    - name: rt-main
      main: true
      associations:
        - target: support
        - target: workload:1
        - target: workload:2
      routes:
        - destination: 10.20.0.0/16
          next_hop_type: LOCAL
          next_hop_ref: local
          enabled: true
        - destination: 0.0.0.0/0
          next_hop_type: NAT
          next_hop_ref: nat-main
          enabled: true
`
	if err := os.WriteFile(blueprintPath, []byte(blueprintBody), 0o644); err != nil {
		t.Fatalf("write blueprint: %v", err)
	}
	if err := os.Chdir(tmp); err != nil {
		t.Fatalf("chdir tempdir: %v", err)
	}
	t.Cleanup(func() {
		_ = os.Chdir(wd)
	})

	if _, err := svc.UpsertTemplateClass(ctx, core.TemplateClass{
		ID:             "openclaw-default",
		Region:         "ap-beijing",
		ResolutionMode: core.ResolutionModeSandboxPrimary,
	}); err != nil {
		t.Fatalf("upsert template class: %v", err)
	}
	if _, err := svc.UpsertPoolAutoscalePolicy(ctx, core.PoolAutoscalePolicy{
		TemplateClassID:   "openclaw-default",
		WarmBundleTarget:  1,
		SlowHorizonTarget: 2,
	}); err != nil {
		t.Fatalf("upsert autoscale policy: %v", err)
	}
	if _, err := svc.UpsertSKU(ctx, core.SKU{
		ID:                          "sku-default",
		Name:                        "Default SKU",
		TemplateClassID:             "openclaw-default",
		BaseImage:                   "img-old",
		DesiredImageID:              "img-new",
		StableImageID:               "img-old",
		InstanceType:                "SA9.MEDIUM2",
		NetworkTemplateID:           "network-template-a",
		SecurityGroupRuleTemplateID: "sg-template-a",
		DefaultDesiredCapacity:      1,
		RolloutState:                core.SKURolloutStateStable,
	}); err != nil {
		t.Fatalf("upsert sku: %v", err)
	}
	if _, err := svc.ReplaceTemplateSkuBindings(ctx, "openclaw-default", []core.TemplateSkuBinding{{
		SKUID:              "sku-default",
		Priority:           1,
		Weight:             1,
		AdmissionState:     "active",
		RolloutEligibility: true,
	}}); err != nil {
		t.Fatalf("replace template sku bindings: %v", err)
	}

	pool, err := svc.CreatePool(ctx, "existing", "", "img-old", 1, testVpcID, testSubnetID, testZone, testSecurityGroups)
	if err != nil {
		t.Fatalf("create existing pool: %v", err)
	}
	pool.SKUID = "sku-default"
	if _, err := svc.UpdatePool(ctx, pool); err != nil {
		t.Fatalf("update existing pool: %v", err)
	}

	snapshot, err := svc.UpsertVPCShardBlueprintSnapshot(ctx, core.VPCShardBlueprintSnapshot{
		ID:                   "snap-old",
		SchemaVersion:        "v1alpha1",
		SourceRegion:         "ap-beijing",
		NetworkTemplateID:    "network-template-a",
		BlueprintFingerprint: "fp-old",
		TopologyJSON:         string([]byte(`{"schema_version":"v1alpha1","source_region":"ap-beijing","network_template_id":"network-template-a","vpc_cidr":"10.0.0.0/16","support_subnet":{"cidr":"10.0.0.0/24","zone":"ap-beijing-8","role":"support"},"workload_subnets":[{"cidr":"10.0.1.0/24","zone":"ap-beijing-8","role":"workload","ordinal":1}],"nat_shape":{"mode":"single","gateways":[{"name":"nat-main"}]},"route_shape":{"route_tables":[{"name":"rt-main","routes":[{"destination":"10.0.0.0/16","next_hop_type":"LOCAL","next_hop_ref":"local","enabled":true}]}]}}`)),
		ValidationState:      "valid",
		CreatedAt:            time.Now().UTC(),
	})
	if err != nil {
		t.Fatalf("upsert snapshot: %v", err)
	}
	oldShard, err := svc.UpsertVPCShard(ctx, core.VPCShard{
		BlueprintSnapshotID:  snapshot.ID,
		BlueprintFingerprint: snapshot.BlueprintFingerprint,
		TemplateClassID:      "openclaw-default",
		SKUID:                "sku-default",
		NetworkTemplateID:    "network-template-a",
		Region:               "ap-beijing",
		VpcID:                "vpc-old",
		State:                core.VPCShardStateActive,
		ActiveSubnetMemberID: "subnet-active",
	})
	if err != nil {
		t.Fatalf("upsert old shard: %v", err)
	}
	if _, err := svc.ReplaceVPCShardSubnets(ctx, oldShard.ID, []core.VPCShardSubnet{
		{ID: "subnet-active", SubnetID: "subnet-old-a", Zone: "ap-beijing-8", Role: core.VPCShardSubnetRoleWorkload, Ordinal: 1, ReservationState: core.VPCShardSubnetReservationActive, NearWaterline: true},
		{ID: "subnet-exhausted", SubnetID: "subnet-old-b", Zone: "ap-beijing-7", Role: core.VPCShardSubnetRoleWorkload, Ordinal: 2, ReservationState: core.VPCShardSubnetReservationExhausted, NearWaterline: true},
	}); err != nil {
		t.Fatalf("replace old shard subnets: %v", err)
	}

	cp := provider.NewMockCloudProvider()
	createdBundles, err := svc.EnsureWarmCapacityBundles(ctx, cp)
	if err != nil {
		t.Fatalf("ensure warm capacity bundles: %v", err)
	}
	if createdBundles != 1 {
		t.Fatalf("expected 1 created bundle, got %d", createdBundles)
	}

	shards, err := svc.ListVPCShards(ctx)
	if err != nil {
		t.Fatalf("list vpc shards: %v", err)
	}
	if len(shards) != 2 {
		t.Fatalf("expected exhausted shard plus new shard, got %d", len(shards))
	}
	var newShard core.VPCShard
	for _, shard := range shards {
		if shard.ID == oldShard.ID {
			continue
		}
		newShard = shard
	}
	if newShard.ID == "" || newShard.ActiveSubnetMemberID == "" || newShard.VpcID == "" {
		t.Fatalf("expected a new active shard, got %+v", newShard)
	}

	bundles, err := svc.ListCapacityBundles(ctx)
	if err != nil {
		t.Fatalf("list capacity bundles: %v", err)
	}
	if len(bundles) != 1 {
		t.Fatalf("expected 1 warm bundle, got %d", len(bundles))
	}
	if bundles[0].LineageTags["vpc_shard_id"] != newShard.ID {
		t.Fatalf("expected warm bundle to come from new shard, got %+v", bundles[0].LineageTags)
	}

	createdPools, err := svc.EnsurePoolsFromWarmCapacityBundles(ctx)
	if err != nil {
		t.Fatalf("ensure pools from warm capacity bundles: %v", err)
	}
	if createdPools != 1 {
		t.Fatalf("expected 1 derived pool from new shard bundle, got %d", createdPools)
	}
	pools, err := svc.ListPoolsForSKU(ctx, "sku-default")
	if err != nil {
		t.Fatalf("list pools for sku: %v", err)
	}
	if len(pools) != 2 {
		t.Fatalf("expected existing pool plus new derived pool, got %d", len(pools))
	}
}

func TestEnsureWarmCapacityBundlesSwitchesSubnetBeforeCreatingNewVPCShard(t *testing.T) {
	ctx := context.Background()
	svc := service.NewService(store.NewMemoryStore())

	wd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	tmp := t.TempDir()
	if err := os.MkdirAll(filepath.Join(tmp, "config"), 0o755); err != nil {
		t.Fatalf("mkdir config: %v", err)
	}
	blueprintPath := filepath.Join(tmp, "config", "vpc-shard-blueprint.yaml")
	blueprintBody := `
schema_version: v1alpha1
source_region: ap-beijing
network_template_id: network-template-a
vpc_cidr: 10.21.0.0/16
support_subnet:
  name: support
  cidr: 10.21.0.0/24
  zone: ap-beijing-8
  role: support
  ordinal: 0
workload_subnets:
  - name: workload-a
    cidr: 10.21.1.0/24
    zone: ap-beijing-8
    role: workload
    ordinal: 1
  - name: workload-b
    cidr: 10.21.2.0/24
    zone: ap-beijing-7
    role: workload
    ordinal: 2
nat_shape:
  mode: single
  gateways:
    - name: nat-main
      zone: ap-beijing-8
      subnet: support
route_shape:
  route_tables:
    - name: rt-main
      main: true
      associations:
        - target: support
        - target: workload:1
        - target: workload:2
      routes:
        - destination: 10.21.0.0/16
          next_hop_type: LOCAL
          next_hop_ref: local
          enabled: true
        - destination: 0.0.0.0/0
          next_hop_type: NAT
          next_hop_ref: nat-main
          enabled: true
`
	if err := os.WriteFile(blueprintPath, []byte(blueprintBody), 0o644); err != nil {
		t.Fatalf("write blueprint: %v", err)
	}
	if err := os.Chdir(tmp); err != nil {
		t.Fatalf("chdir tempdir: %v", err)
	}
	t.Cleanup(func() {
		_ = os.Chdir(wd)
	})

	if _, err := svc.UpsertTemplateClass(ctx, core.TemplateClass{
		ID:             "openclaw-default",
		Region:         "ap-beijing",
		ResolutionMode: core.ResolutionModeSandboxPrimary,
	}); err != nil {
		t.Fatalf("upsert template class: %v", err)
	}
	if _, err := svc.UpsertPoolAutoscalePolicy(ctx, core.PoolAutoscalePolicy{
		TemplateClassID:   "openclaw-default",
		WarmBundleTarget:  1,
		SlowHorizonTarget: 2,
	}); err != nil {
		t.Fatalf("upsert autoscale policy: %v", err)
	}
	if _, err := svc.UpsertSKU(ctx, core.SKU{
		ID:                          "sku-default",
		Name:                        "Default SKU",
		TemplateClassID:             "openclaw-default",
		BaseImage:                   "img-old",
		DesiredImageID:              "img-new",
		StableImageID:               "img-old",
		InstanceType:                "SA9.MEDIUM2",
		NetworkTemplateID:           "network-template-a",
		SecurityGroupRuleTemplateID: "sg-template-a",
		DefaultDesiredCapacity:      1,
		RolloutState:                core.SKURolloutStateStable,
	}); err != nil {
		t.Fatalf("upsert sku: %v", err)
	}
	if _, err := svc.ReplaceTemplateSkuBindings(ctx, "openclaw-default", []core.TemplateSkuBinding{{
		SKUID:              "sku-default",
		Priority:           1,
		Weight:             1,
		AdmissionState:     "active",
		RolloutEligibility: true,
	}}); err != nil {
		t.Fatalf("replace template sku bindings: %v", err)
	}

	pool, err := svc.CreatePool(ctx, "existing", "", "img-old", 1, testVpcID, testSubnetID, testZone, testSecurityGroups)
	if err != nil {
		t.Fatalf("create existing pool: %v", err)
	}
	pool.SKUID = "sku-default"
	if _, err := svc.UpdatePool(ctx, pool); err != nil {
		t.Fatalf("update existing pool: %v", err)
	}

	snapshot, err := svc.UpsertVPCShardBlueprintSnapshot(ctx, core.VPCShardBlueprintSnapshot{
		ID:                   "snap-switch-worker",
		SchemaVersion:        "v1alpha1",
		SourceRegion:         "ap-beijing",
		NetworkTemplateID:    "network-template-a",
		BlueprintFingerprint: "fp-switch-worker",
		TopologyJSON:         string([]byte(`{"schema_version":"v1alpha1","source_region":"ap-beijing","network_template_id":"network-template-a","vpc_cidr":"10.21.0.0/16","support_subnet":{"cidr":"10.21.0.0/24","zone":"ap-beijing-8","role":"support"},"workload_subnets":[{"cidr":"10.21.1.0/24","zone":"ap-beijing-8","role":"workload","ordinal":1},{"cidr":"10.21.2.0/24","zone":"ap-beijing-7","role":"workload","ordinal":2}],"nat_shape":{"mode":"single","gateways":[{"name":"nat-main"}]},"route_shape":{"route_tables":[{"name":"rt-main","routes":[{"destination":"10.21.0.0/16","next_hop_type":"LOCAL","next_hop_ref":"local","enabled":true}]}]}}`)),
		ValidationState:      "valid",
		CreatedAt:            time.Now().UTC(),
	})
	if err != nil {
		t.Fatalf("upsert snapshot: %v", err)
	}
	oldShard, err := svc.UpsertVPCShard(ctx, core.VPCShard{
		BlueprintSnapshotID:  snapshot.ID,
		BlueprintFingerprint: snapshot.BlueprintFingerprint,
		TemplateClassID:      "openclaw-default",
		SKUID:                "sku-default",
		NetworkTemplateID:    "network-template-a",
		Region:               "ap-beijing",
		VpcID:                "vpc-old",
		State:                core.VPCShardStateActive,
		ActiveSubnetMemberID: "subnet-active",
	})
	if err != nil {
		t.Fatalf("upsert old shard: %v", err)
	}
	if _, err := svc.ReplaceVPCShardSubnets(ctx, oldShard.ID, []core.VPCShardSubnet{
		{ID: "subnet-active", SubnetID: "subnet-old-a", Zone: "ap-beijing-8", Role: core.VPCShardSubnetRoleWorkload, Ordinal: 1, ReservationState: core.VPCShardSubnetReservationActive, NearWaterline: true},
		{ID: "subnet-next", SubnetID: "subnet-old-b", Zone: "ap-beijing-7", Role: core.VPCShardSubnetRoleWorkload, Ordinal: 2, ReservationState: core.VPCShardSubnetReservationAvailable},
	}); err != nil {
		t.Fatalf("replace old shard subnets: %v", err)
	}

	cp := provider.NewMockCloudProvider()
	createdBundles, err := svc.EnsureWarmCapacityBundles(ctx, cp)
	if err != nil {
		t.Fatalf("ensure warm capacity bundles: %v", err)
	}
	if createdBundles != 1 {
		t.Fatalf("expected 1 created bundle, got %d", createdBundles)
	}

	shards, err := svc.ListVPCShards(ctx)
	if err != nil {
		t.Fatalf("list vpc shards: %v", err)
	}
	if len(shards) != 1 {
		t.Fatalf("expected subnet switch to stay within one shard, got %d shards", len(shards))
	}
	updatedShard, err := svc.GetVPCShard(ctx, oldShard.ID)
	if err != nil {
		t.Fatalf("get updated shard: %v", err)
	}
	if updatedShard.ActiveSubnetMemberID != "subnet-next" {
		t.Fatalf("expected active subnet to switch, got %+v", updatedShard)
	}

	bundles, err := svc.ListCapacityBundles(ctx)
	if err != nil {
		t.Fatalf("list capacity bundles: %v", err)
	}
	if len(bundles) != 1 {
		t.Fatalf("expected 1 warm bundle, got %d", len(bundles))
	}
	if bundles[0].LineageTags["vpc_shard_id"] != oldShard.ID || bundles[0].LineageTags["subnet_member_id"] != "subnet-next" {
		t.Fatalf("expected warm bundle from switched subnet, got %+v", bundles[0].LineageTags)
	}
}

func TestEnsureWarmCapacityBundlesPrefersLiveSKUsOverColdFallback(t *testing.T) {
	ctx := context.Background()
	svc := service.NewService(store.NewMemoryStore())
	if _, err := svc.UpsertTemplateClass(ctx, core.TemplateClass{
		ID:             "openclaw-default",
		Region:         "ap-beijing",
		ResolutionMode: core.ResolutionModeSandboxPrimary,
	}); err != nil {
		t.Fatalf("upsert template class: %v", err)
	}
	if _, err := svc.UpsertPoolAutoscalePolicy(ctx, core.PoolAutoscalePolicy{
		TemplateClassID:  "openclaw-default",
		WarmBundleTarget: 1,
	}); err != nil {
		t.Fatalf("upsert autoscale policy: %v", err)
	}
	for _, sku := range []core.SKU{
		{
			ID:                          "sku-live",
			Name:                        "Live SKU",
			TemplateClassID:             "openclaw-default",
			BaseImage:                   "img-live",
			DesiredImageID:              "img-live",
			InstanceType:                "SA9.MEDIUM2",
			NetworkTemplateID:           "network-live",
			SecurityGroupRuleTemplateID: "sg-live",
		},
		{
			ID:                          "sku-cold",
			Name:                        "Cold SKU",
			TemplateClassID:             "openclaw-default",
			BaseImage:                   "img-cold",
			DesiredImageID:              "img-cold",
			InstanceType:                "SA9.MEDIUM2",
			NetworkTemplateID:           "network-cold",
			SecurityGroupRuleTemplateID: "sg-cold",
		},
	} {
		if _, err := svc.UpsertSKU(ctx, sku); err != nil {
			t.Fatalf("upsert sku %s: %v", sku.ID, err)
		}
	}
	if _, err := svc.ReplaceTemplateSkuBindings(ctx, "openclaw-default", []core.TemplateSkuBinding{
		{
			SKUID:              "sku-cold",
			Priority:           1,
			Weight:             1,
			AdmissionState:     "active",
			RolloutEligibility: true,
		},
		{
			SKUID:              "sku-live",
			Priority:           10,
			Weight:             1,
			AdmissionState:     "active",
			RolloutEligibility: true,
		},
	}); err != nil {
		t.Fatalf("replace template sku bindings: %v", err)
	}
	pool, err := svc.CreatePool(ctx, "live-pool", "", "img-live", 1, testVpcID, testSubnetID, testZone, testSecurityGroups)
	if err != nil {
		t.Fatalf("create live pool: %v", err)
	}
	pool.SKUID = "sku-live"
	if _, err := svc.UpdatePool(ctx, pool); err != nil {
		t.Fatalf("update live pool: %v", err)
	}

	cp := &stubProvider{}
	created, err := svc.EnsureWarmCapacityBundles(ctx, cp)
	if err != nil {
		t.Fatalf("ensure warm capacity bundles: %v", err)
	}
	if created != 1 {
		t.Fatalf("expected 1 created bundle, got %d", created)
	}
	bundles, err := svc.ListCapacityBundles(ctx)
	if err != nil {
		t.Fatalf("list capacity bundles: %v", err)
	}
	if len(bundles) != 1 {
		t.Fatalf("expected 1 bundle, got %d", len(bundles))
	}
	if bundles[0].LineageTags["sku_id"] != "sku-live" {
		t.Fatalf("expected live sku to receive warm bundle, got %+v", bundles[0].LineageTags)
	}
}

func TestEnsurePoolsFromWarmCapacityBundlesCreatesDerivedPool(t *testing.T) {
	ctx := context.Background()
	svc := service.NewService(store.NewMemoryStore())
	if _, err := svc.UpsertTemplateClass(ctx, core.TemplateClass{
		ID:             "openclaw-default",
		Region:         "ap-beijing",
		ResolutionMode: core.ResolutionModeSandboxPrimary,
	}); err != nil {
		t.Fatalf("upsert template class: %v", err)
	}
	if _, err := svc.UpsertPoolAutoscalePolicy(ctx, core.PoolAutoscalePolicy{
		TemplateClassID: "openclaw-default",
		MinPoolCount:    1,
	}); err != nil {
		t.Fatalf("upsert autoscale policy: %v", err)
	}
	if _, err := svc.UpsertSKU(ctx, core.SKU{
		ID:                          "sku-default",
		Name:                        "Default SKU",
		TemplateClassID:             "openclaw-default",
		BaseImage:                   "img-old",
		DesiredImageID:              "img-new",
		InstanceType:                "SA9.MEDIUM2",
		NetworkTemplateID:           "network-template-a",
		SecurityGroupRuleTemplateID: "sg-template-a",
		DefaultDesiredCapacity:      3,
		RolloutState:                core.SKURolloutStateStable,
	}); err != nil {
		t.Fatalf("upsert sku: %v", err)
	}
	if _, err := svc.ReplaceTemplateSkuBindings(ctx, "openclaw-default", []core.TemplateSkuBinding{{
		SKUID:              "sku-default",
		Priority:           1,
		Weight:             1,
		AdmissionState:     "active",
		RolloutEligibility: true,
	}}); err != nil {
		t.Fatalf("replace template sku bindings: %v", err)
	}
	if _, err := svc.UpsertCapacityBundle(ctx, core.CapacityBundle{
		ID:               "bundle-a",
		Region:           "ap-beijing",
		Zone:             testZone,
		VpcID:            testVpcID,
		SubnetID:         testSubnetID,
		SecurityGroupIDs: testSecurityGroups,
		Status:           core.CapacityBundleStatusWarm,
		LineageTags: map[string]string{
			"template_class_id": "openclaw-default",
			"sku_id":            "sku-default",
		},
		CreatedAt: time.Now().UTC(),
		UpdatedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatalf("upsert capacity bundle: %v", err)
	}

	created, err := svc.EnsurePoolsFromWarmCapacityBundles(ctx)
	if err != nil {
		t.Fatalf("ensure pools from warm capacity bundles: %v", err)
	}
	if created != 1 {
		t.Fatalf("expected 1 created pool, got %d", created)
	}
	pools, err := svc.ListPoolsForSKU(ctx, "sku-default")
	if err != nil {
		t.Fatalf("list pools for sku: %v", err)
	}
	if len(pools) != 1 {
		t.Fatalf("expected 1 derived pool, got %d", len(pools))
	}
	if pools[0].BaseImage != "img-new" {
		t.Fatalf("expected derived pool image img-new, got %q", pools[0].BaseImage)
	}
	if pools[0].DesiredCap != 3 {
		t.Fatalf("expected desired capacity 3, got %d", pools[0].DesiredCap)
	}
	bindings, err := svc.ListTemplatePoolBindings(ctx, "openclaw-default")
	if err != nil {
		t.Fatalf("list template pool bindings: %v", err)
	}
	if len(bindings) != 1 || bindings[0].PoolID != pools[0].ID {
		t.Fatalf("expected derived pool binding, got %+v", bindings)
	}
}

func TestEnsurePoolsFromWarmCapacityBundlesRespectsMaxPoolCount(t *testing.T) {
	ctx := context.Background()
	svc := service.NewService(store.NewMemoryStore())
	if _, err := svc.UpsertTemplateClass(ctx, core.TemplateClass{
		ID:             "openclaw-default",
		Region:         "ap-beijing",
		ResolutionMode: core.ResolutionModeSandboxPrimary,
	}); err != nil {
		t.Fatalf("upsert template class: %v", err)
	}
	if _, err := svc.UpsertPoolAutoscalePolicy(ctx, core.PoolAutoscalePolicy{
		TemplateClassID: "openclaw-default",
		MinPoolCount:    2,
		MaxPoolCount:    1,
	}); err != nil {
		t.Fatalf("upsert autoscale policy: %v", err)
	}
	if _, err := svc.UpsertSKU(ctx, core.SKU{
		ID:                     "sku-default",
		Name:                   "Default SKU",
		TemplateClassID:        "openclaw-default",
		BaseImage:              "img-old",
		DesiredImageID:         "img-new",
		InstanceType:           "SA9.MEDIUM2",
		DefaultDesiredCapacity: 1,
	}); err != nil {
		t.Fatalf("upsert sku: %v", err)
	}
	if _, err := svc.ReplaceTemplateSkuBindings(ctx, "openclaw-default", []core.TemplateSkuBinding{{
		SKUID:              "sku-default",
		Priority:           1,
		Weight:             1,
		AdmissionState:     "active",
		RolloutEligibility: true,
	}}); err != nil {
		t.Fatalf("replace template sku bindings: %v", err)
	}
	pool, err := svc.CreatePool(ctx, "existing", "", "img-new", 1, testVpcID, testSubnetID, testZone, testSecurityGroups)
	if err != nil {
		t.Fatalf("create existing pool: %v", err)
	}
	pool.SKUID = "sku-default"
	if _, err := svc.UpdatePool(ctx, pool); err != nil {
		t.Fatalf("update existing pool: %v", err)
	}
	if _, err := svc.UpsertCapacityBundle(ctx, core.CapacityBundle{
		ID:               "bundle-a",
		Region:           "ap-beijing",
		Zone:             testZone,
		VpcID:            testVpcID,
		SubnetID:         testSubnetID,
		SecurityGroupIDs: testSecurityGroups,
		Status:           core.CapacityBundleStatusWarm,
		LineageTags: map[string]string{
			"template_class_id": "openclaw-default",
			"sku_id":            "sku-default",
		},
		CreatedAt: time.Now().UTC(),
		UpdatedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatalf("upsert capacity bundle: %v", err)
	}

	created, err := svc.EnsurePoolsFromWarmCapacityBundles(ctx)
	if err != nil {
		t.Fatalf("ensure pools from warm capacity bundles: %v", err)
	}
	if created != 0 {
		t.Fatalf("expected no new pool under max_pool_count, got %d", created)
	}
	pools, err := svc.ListPoolsForSKU(ctx, "sku-default")
	if err != nil {
		t.Fatalf("list pools for sku: %v", err)
	}
	if len(pools) != 1 {
		t.Fatalf("expected existing pool only, got %d", len(pools))
	}
}

func TestEnsurePoolsFromWarmCapacityBundlesKeepsRolloutCursorStable(t *testing.T) {
	ctx := context.Background()
	svc := service.NewService(store.NewMemoryStore())
	if _, err := svc.UpsertTemplateClass(ctx, core.TemplateClass{
		ID:             "openclaw-default",
		Region:         "ap-beijing",
		ResolutionMode: core.ResolutionModeSandboxPrimary,
	}); err != nil {
		t.Fatalf("upsert template class: %v", err)
	}
	if _, err := svc.UpsertPoolAutoscalePolicy(ctx, core.PoolAutoscalePolicy{
		TemplateClassID:   "openclaw-default",
		SlowHorizonTarget: 2,
	}); err != nil {
		t.Fatalf("upsert autoscale policy: %v", err)
	}
	if _, err := svc.UpsertSKU(ctx, core.SKU{
		ID:                     "sku-default",
		Name:                   "Default SKU",
		TemplateClassID:        "openclaw-default",
		BaseImage:              "img-old",
		DesiredImageID:         "img-new",
		StableImageID:          "img-old",
		InstanceType:           "SA9.MEDIUM2",
		DefaultDesiredCapacity: 1,
		RolloutState:           core.SKURolloutStateRolling,
	}); err != nil {
		t.Fatalf("upsert sku: %v", err)
	}
	if _, err := svc.ReplaceTemplateSkuBindings(ctx, "openclaw-default", []core.TemplateSkuBinding{{
		SKUID:              "sku-default",
		Priority:           1,
		Weight:             1,
		AdmissionState:     "active",
		RolloutEligibility: true,
	}}); err != nil {
		t.Fatalf("replace template sku bindings: %v", err)
	}
	existingPool, err := svc.CreatePool(ctx, "existing", "", "img-old", 1, testVpcID, testSubnetID, testZone, testSecurityGroups)
	if err != nil {
		t.Fatalf("create existing pool: %v", err)
	}
	existingPool.SKUID = "sku-default"
	if _, err := svc.UpdatePool(ctx, existingPool); err != nil {
		t.Fatalf("update existing pool: %v", err)
	}
	sku := mustGetSKU(t, svc, "sku-default")
	sku.RolloutCursorPoolID = existingPool.ID
	if _, err := svc.UpsertSKU(ctx, sku); err != nil {
		t.Fatalf("update sku cursor: %v", err)
	}
	if _, err := svc.UpsertCapacityBundle(ctx, core.CapacityBundle{
		ID:               "bundle-growth",
		Region:           "ap-beijing",
		Zone:             testZone,
		VpcID:            testVpcID,
		SubnetID:         testSubnetID,
		SecurityGroupIDs: testSecurityGroups,
		Status:           core.CapacityBundleStatusWarm,
		LineageTags: map[string]string{
			"template_class_id": "openclaw-default",
			"sku_id":            "sku-default",
		},
		CreatedAt: time.Now().UTC(),
		UpdatedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatalf("upsert capacity bundle: %v", err)
	}

	created, err := svc.EnsurePoolsFromWarmCapacityBundles(ctx)
	if err != nil {
		t.Fatalf("ensure pools from warm capacity bundles: %v", err)
	}
	if created != 1 {
		t.Fatalf("expected 1 created pool, got %d", created)
	}
	pools, err := svc.ListPoolsForSKU(ctx, "sku-default")
	if err != nil {
		t.Fatalf("list pools for sku: %v", err)
	}
	if len(pools) != 2 {
		t.Fatalf("expected 2 pools after growth, got %d", len(pools))
	}
	foundNew := false
	for _, pool := range pools {
		if pool.ID == existingPool.ID {
			continue
		}
		foundNew = true
		if pool.BaseImage != "img-new" {
			t.Fatalf("expected growth pool to use desired image img-new, got %q", pool.BaseImage)
		}
	}
	if !foundNew {
		t.Fatalf("expected a new growth pool to be created")
	}
	sku = mustGetSKU(t, svc, "sku-default")
	if sku.RolloutCursorPoolID != existingPool.ID {
		t.Fatalf("expected rollout cursor to remain on %s, got %q", existingPool.ID, sku.RolloutCursorPoolID)
	}
}

func TestEnsurePoolsFromWarmCapacityBundlesIsIdempotentAcrossRuns(t *testing.T) {
	ctx := context.Background()
	svc := service.NewService(store.NewMemoryStore())
	if _, err := svc.UpsertTemplateClass(ctx, core.TemplateClass{
		ID:             "openclaw-default",
		Region:         "ap-beijing",
		ResolutionMode: core.ResolutionModeSandboxPrimary,
	}); err != nil {
		t.Fatalf("upsert template class: %v", err)
	}
	if _, err := svc.UpsertPoolAutoscalePolicy(ctx, core.PoolAutoscalePolicy{
		TemplateClassID: "openclaw-default",
		MinPoolCount:    1,
	}); err != nil {
		t.Fatalf("upsert autoscale policy: %v", err)
	}
	if _, err := svc.UpsertSKU(ctx, core.SKU{
		ID:                     "sku-default",
		Name:                   "Default SKU",
		TemplateClassID:        "openclaw-default",
		BaseImage:              "img-old",
		DesiredImageID:         "img-new",
		InstanceType:           "SA9.MEDIUM2",
		DefaultDesiredCapacity: 1,
	}); err != nil {
		t.Fatalf("upsert sku: %v", err)
	}
	if _, err := svc.ReplaceTemplateSkuBindings(ctx, "openclaw-default", []core.TemplateSkuBinding{{
		SKUID:              "sku-default",
		Priority:           1,
		Weight:             1,
		AdmissionState:     "active",
		RolloutEligibility: true,
	}}); err != nil {
		t.Fatalf("replace template sku bindings: %v", err)
	}
	if _, err := svc.UpsertCapacityBundle(ctx, core.CapacityBundle{
		ID:               "bundle-a",
		Region:           "ap-beijing",
		Zone:             testZone,
		VpcID:            testVpcID,
		SubnetID:         testSubnetID,
		SecurityGroupIDs: testSecurityGroups,
		Status:           core.CapacityBundleStatusWarm,
		LineageTags: map[string]string{
			"template_class_id": "openclaw-default",
			"sku_id":            "sku-default",
		},
		CreatedAt: time.Now().UTC(),
		UpdatedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatalf("upsert capacity bundle: %v", err)
	}

	created, err := svc.EnsurePoolsFromWarmCapacityBundles(ctx)
	if err != nil {
		t.Fatalf("first ensure pools from warm capacity bundles: %v", err)
	}
	if created != 1 {
		t.Fatalf("expected first run to create 1 pool, got %d", created)
	}
	created, err = svc.EnsurePoolsFromWarmCapacityBundles(ctx)
	if err != nil {
		t.Fatalf("second ensure pools from warm capacity bundles: %v", err)
	}
	if created != 0 {
		t.Fatalf("expected second run to create 0 pools, got %d", created)
	}
	pools, err := svc.ListPoolsForSKU(ctx, "sku-default")
	if err != nil {
		t.Fatalf("list pools for sku: %v", err)
	}
	if len(pools) != 1 {
		t.Fatalf("expected one stable derived pool, got %d", len(pools))
	}
}

func TestAdvanceSingleSKURolloutProgressesOnePoolAtATime(t *testing.T) {
	ctx := context.Background()
	svc := service.NewService(store.NewMemoryStore())
	verifyOK := func(context.Context, string) error { return nil }

	if _, err := svc.UpsertTemplateClass(ctx, core.TemplateClass{
		ID:             "openclaw-default",
		ResolutionMode: core.ResolutionModeSandboxPrimary,
	}); err != nil {
		t.Fatalf("upsert template class: %v", err)
	}
	if _, err := svc.UpsertSKU(ctx, core.SKU{
		ID:              "sku-default",
		Name:            "Default SKU",
		TemplateClassID: "openclaw-default",
		BaseImage:       "img-old",
		DesiredImageID:  "img-new",
		StableImageID:   "img-old",
		InstanceType:    "SA9.MEDIUM2",
		RolloutState:    core.SKURolloutStateStable,
	}); err != nil {
		t.Fatalf("upsert sku: %v", err)
	}

	poolA, err := svc.CreatePool(ctx, "pool-a", "", "img-old", 1, testVpcID, testSubnetID, testZone, testSecurityGroups)
	if err != nil {
		t.Fatalf("create poolA: %v", err)
	}
	poolA.SKUID = "sku-default"
	if _, err := svc.UpdatePool(ctx, poolA); err != nil {
		t.Fatalf("update poolA: %v", err)
	}
	if _, err := svc.RefillVerified(ctx, poolA.ID, 1, []string{"10.0.0.41"}, []string{"cloud-a"}, verifyOK); err != nil {
		t.Fatalf("refill poolA: %v", err)
	}

	poolB, err := svc.CreatePool(ctx, "pool-b", "", "img-old", 1, testVpcID, testSubnetID, testZone, testSecurityGroups)
	if err != nil {
		t.Fatalf("create poolB: %v", err)
	}
	poolB.SKUID = "sku-default"
	if _, err := svc.UpdatePool(ctx, poolB); err != nil {
		t.Fatalf("update poolB: %v", err)
	}
	if _, err := svc.RefillVerified(ctx, poolB.ID, 1, []string{"10.0.0.42"}, []string{"cloud-b"}, verifyOK); err != nil {
		t.Fatalf("refill poolB: %v", err)
	}

	changed, err := advanceSingleSKURollout(ctx, svc, mustGetSKU(t, svc, "sku-default"))
	if err != nil || !changed {
		t.Fatalf("first rollout advance failed changed=%v err=%v", changed, err)
	}
	sku := mustGetSKU(t, svc, "sku-default")
	if sku.RolloutCursorPoolID != poolA.ID {
		t.Fatalf("expected cursor on first pool, got %q", sku.RolloutCursorPoolID)
	}
	gotPoolA, err := svc.GetPool(ctx, poolA.ID)
	if err != nil {
		t.Fatalf("get poolA: %v", err)
	}
	if gotPoolA.BaseImage != "img-new" {
		t.Fatalf("expected first pool image updated, got %q", gotPoolA.BaseImage)
	}

	if _, err := svc.RefillVerified(ctx, poolA.ID, 1, []string{"10.0.0.43"}, []string{"cloud-a2"}, verifyOK); err != nil {
		t.Fatalf("refill poolA post-rollout: %v", err)
	}
	changed, err = advanceSingleSKURollout(ctx, svc, sku)
	if err != nil || !changed {
		t.Fatalf("second rollout advance failed changed=%v err=%v", changed, err)
	}
	sku = mustGetSKU(t, svc, "sku-default")
	if sku.RolloutCursorPoolID != poolB.ID {
		t.Fatalf("expected cursor to advance to second pool, got %q", sku.RolloutCursorPoolID)
	}
	gotPoolB, err := svc.GetPool(ctx, poolB.ID)
	if err != nil {
		t.Fatalf("get poolB: %v", err)
	}
	if gotPoolB.BaseImage != "img-old" {
		t.Fatalf("expected second pool image unchanged until next loop, got %q", gotPoolB.BaseImage)
	}

	changed, err = advanceSingleSKURollout(ctx, svc, sku)
	if err != nil || !changed {
		t.Fatalf("third rollout advance failed changed=%v err=%v", changed, err)
	}
	gotPoolB, err = svc.GetPool(ctx, poolB.ID)
	if err != nil {
		t.Fatalf("get poolB after update: %v", err)
	}
	if gotPoolB.BaseImage != "img-new" {
		t.Fatalf("expected second pool image updated, got %q", gotPoolB.BaseImage)
	}

	if _, err := svc.RefillVerified(ctx, poolB.ID, 1, []string{"10.0.0.44"}, []string{"cloud-b2"}, verifyOK); err != nil {
		t.Fatalf("refill poolB post-rollout: %v", err)
	}
	changed, err = advanceSingleSKURollout(ctx, svc, mustGetSKU(t, svc, "sku-default"))
	if err != nil || !changed {
		t.Fatalf("final rollout advance failed changed=%v err=%v", changed, err)
	}
	sku = mustGetSKU(t, svc, "sku-default")
	if sku.RolloutState != core.SKURolloutStateStable {
		t.Fatalf("expected stable rollout state, got %s", sku.RolloutState)
	}
	if sku.StableImageID != "img-new" {
		t.Fatalf("expected stable image to converge, got %q", sku.StableImageID)
	}
	if sku.RolloutCursorPoolID != "" {
		t.Fatalf("expected empty rollout cursor after convergence, got %q", sku.RolloutCursorPoolID)
	}
}

func TestAdvanceSingleSKURolloutSkipsPausedPoolWhenSelectingTarget(t *testing.T) {
	ctx := context.Background()
	svc := service.NewService(store.NewMemoryStore())

	if _, err := svc.UpsertTemplateClass(ctx, core.TemplateClass{
		ID:             "openclaw-default",
		ResolutionMode: core.ResolutionModeSandboxPrimary,
	}); err != nil {
		t.Fatalf("upsert template class: %v", err)
	}
	if _, err := svc.UpsertSKU(ctx, core.SKU{
		ID:              "sku-default",
		Name:            "Default SKU",
		TemplateClassID: "openclaw-default",
		BaseImage:       "img-old",
		DesiredImageID:  "img-new",
		StableImageID:   "img-old",
		InstanceType:    "SA9.MEDIUM2",
		RolloutState:    core.SKURolloutStateStable,
	}); err != nil {
		t.Fatalf("upsert sku: %v", err)
	}
	pausedPool, err := svc.CreatePool(ctx, "pool-a", "", "img-old", 0, testVpcID, testSubnetID, testZone, testSecurityGroups)
	if err != nil {
		t.Fatalf("create paused pool: %v", err)
	}
	pausedPool.SKUID = "sku-default"
	pausedPool.Status = core.PoolStatusPaused
	if _, err := svc.UpdatePool(ctx, pausedPool); err != nil {
		t.Fatalf("update paused pool: %v", err)
	}
	activePool, err := svc.CreatePool(ctx, "pool-b", "", "img-old", 0, testVpcID, testSubnetID, testZone, testSecurityGroups)
	if err != nil {
		t.Fatalf("create active pool: %v", err)
	}
	activePool.SKUID = "sku-default"
	if _, err := svc.UpdatePool(ctx, activePool); err != nil {
		t.Fatalf("update active pool: %v", err)
	}

	changed, err := advanceSingleSKURollout(ctx, svc, mustGetSKU(t, svc, "sku-default"))
	if err != nil || !changed {
		t.Fatalf("advance rollout failed changed=%v err=%v", changed, err)
	}
	sku := mustGetSKU(t, svc, "sku-default")
	if sku.RolloutCursorPoolID != activePool.ID {
		t.Fatalf("expected active pool chosen as cursor, got %q", sku.RolloutCursorPoolID)
	}
}

func TestAdvanceSingleSKURolloutBlocksOnStuckCursorTimeout(t *testing.T) {
	defer func(old time.Duration) { skuRolloutTimeout = old }(skuRolloutTimeout)
	skuRolloutTimeout = 0

	ctx := context.Background()
	svc := service.NewService(store.NewMemoryStore())
	if _, err := svc.UpsertTemplateClass(ctx, core.TemplateClass{
		ID:             "openclaw-default",
		ResolutionMode: core.ResolutionModeSandboxPrimary,
	}); err != nil {
		t.Fatalf("upsert template class: %v", err)
	}
	cursorPool, err := svc.CreatePool(ctx, "pool-a", "", "img-new", 1, testVpcID, testSubnetID, testZone, testSecurityGroups)
	if err != nil {
		t.Fatalf("create cursor pool: %v", err)
	}
	cursorPool.SKUID = "sku-default"
	if _, err := svc.UpdatePool(ctx, cursorPool); err != nil {
		t.Fatalf("update cursor pool: %v", err)
	}
	pendingPool, err := svc.CreatePool(ctx, "pool-b", "", "img-old", 1, testVpcID, testSubnetID, testZone, testSecurityGroups)
	if err != nil {
		t.Fatalf("create pending pool: %v", err)
	}
	pendingPool.SKUID = "sku-default"
	if _, err := svc.UpdatePool(ctx, pendingPool); err != nil {
		t.Fatalf("update pending pool: %v", err)
	}
	startedAt := time.Now().UTC().Add(-time.Minute)
	if _, err := svc.UpsertSKU(ctx, core.SKU{
		ID:                   "sku-default",
		Name:                 "Default SKU",
		TemplateClassID:      "openclaw-default",
		BaseImage:            "img-old",
		DesiredImageID:       "img-new",
		StableImageID:        "img-old",
		InstanceType:         "SA9.MEDIUM2",
		RolloutState:         core.SKURolloutStateRolling,
		RolloutCursorPoolID:  cursorPool.ID,
		LastRolloutStartedAt: &startedAt,
	}); err != nil {
		t.Fatalf("upsert sku: %v", err)
	}

	changed, err := advanceSingleSKURollout(ctx, svc, mustGetSKU(t, svc, "sku-default"))
	if err != nil || !changed {
		t.Fatalf("advance rollout failed changed=%v err=%v", changed, err)
	}
	sku := mustGetSKU(t, svc, "sku-default")
	if sku.RolloutState != core.SKURolloutStateBlocked {
		t.Fatalf("expected blocked rollout state, got %s", sku.RolloutState)
	}
}

func TestDefaultCreatingStaleAfterAllowsSlowCloudProvisioning(t *testing.T) {
	const minProvisioningWindow = 10 * time.Minute
	if defaultCreatingStaleAfter < minProvisioningWindow {
		t.Fatalf("default creating stale window too small: got %s want >= %s", defaultCreatingStaleAfter, minProvisioningWindow)
	}
}

func TestProcessPool_VerifyBeforeClean_Success(t *testing.T) {
	defer func(old time.Duration) { reinstallVerifyDelay = old }(reinstallVerifyDelay)
	reinstallVerifyDelay = 0

	ctx := context.Background()
	svc := service.NewService(store.NewMemoryStore())
	verifyOK := func(context.Context, string) error { return nil }
	pool, err := svc.CreatePool(ctx, "p3", "desc", "img", 0, testVpcID, testSubnetID, testZone, testSecurityGroups)
	if err != nil {
		t.Fatalf("create pool: %v", err)
	}
	insts, err := svc.RefillVerified(ctx, pool.ID, 1, []string{"1.1.1.1"}, []string{"cloud-1"}, verifyOK)
	if err != nil {
		t.Fatalf("refill: %v", err)
	}
	alloc, err := svc.Allocate(ctx, pool.ID)
	if err != nil {
		t.Fatalf("allocate: %v", err)
	}
	if alloc.ID != insts[0].ID {
		t.Fatalf("expected allocated instance %s got %s", insts[0].ID, alloc.ID)
	}
	if _, err := svc.Release(ctx, alloc.ID); err != nil {
		t.Fatalf("release: %v", err)
	}

	cp := &stubProvider{}
	processPool(ctx, svc, cp, pool, "", 1)

	got, err := svc.GetInstance(ctx, alloc.ID)
	if err != nil {
		t.Fatalf("get instance: %v", err)
	}
	if got.State != core.StateClean {
		t.Fatalf("expected state CLEAN, got %s", got.State)
	}
	if cp.reinstallCalls != 1 {
		t.Fatalf("expected 1 reinstall call, got %d", cp.reinstallCalls)
	}
	if cp.verifyCalls != 1 {
		t.Fatalf("expected 1 verify call, got %d", cp.verifyCalls)
	}
}

func TestProcessPool_VerifyBeforeClean_VerifyFailureKeepsResetting(t *testing.T) {
	defer func(old time.Duration) { reinstallVerifyDelay = old }(reinstallVerifyDelay)
	reinstallVerifyDelay = 0

	ctx := context.Background()
	svc := service.NewService(store.NewMemoryStore())
	verifyOK := func(context.Context, string) error { return nil }
	pool, err := svc.CreatePool(ctx, "p4", "desc", "img", 0, testVpcID, testSubnetID, testZone, testSecurityGroups)
	if err != nil {
		t.Fatalf("create pool: %v", err)
	}
	insts, err := svc.RefillVerified(ctx, pool.ID, 1, []string{"1.1.1.1"}, []string{"cloud-1"}, verifyOK)
	if err != nil {
		t.Fatalf("refill: %v", err)
	}
	alloc, err := svc.Allocate(ctx, pool.ID)
	if err != nil {
		t.Fatalf("allocate: %v", err)
	}
	if alloc.ID != insts[0].ID {
		t.Fatalf("expected allocated instance %s got %s", insts[0].ID, alloc.ID)
	}
	if _, err := svc.Release(ctx, alloc.ID); err != nil {
		t.Fatalf("release: %v", err)
	}

	cp := &stubProvider{verifyErr: errors.New("verify failed")}
	processPool(ctx, svc, cp, pool, "", 1)

	got, err := svc.GetInstance(ctx, alloc.ID)
	if err != nil {
		t.Fatalf("get instance: %v", err)
	}
	if got.State != core.StateResetting {
		t.Fatalf("expected state RESETTING, got %s", got.State)
	}
	if cp.reinstallCalls != 1 {
		t.Fatalf("expected 1 reinstall call, got %d", cp.reinstallCalls)
	}
	if cp.verifyCalls != 1 {
		t.Fatalf("expected 1 verify call, got %d", cp.verifyCalls)
	}
}

func TestProcessPool_DoesNotMarkCleanBeforeReinstallVerifyDelay(t *testing.T) {
	defer func(old time.Duration) { reinstallVerifyDelay = old }(reinstallVerifyDelay)
	reinstallVerifyDelay = 30 * time.Second

	ctx := context.Background()
	svc := service.NewService(store.NewMemoryStore())
	verifyOK := func(context.Context, string) error { return nil }
	pool, err := svc.CreatePool(ctx, "p5", "desc", "img", 0, testVpcID, testSubnetID, testZone, testSecurityGroups)
	if err != nil {
		t.Fatalf("create pool: %v", err)
	}
	insts, err := svc.RefillVerified(ctx, pool.ID, 1, []string{"1.1.1.1"}, []string{"cloud-1"}, verifyOK)
	if err != nil {
		t.Fatalf("refill: %v", err)
	}
	alloc, err := svc.Allocate(ctx, pool.ID)
	if err != nil {
		t.Fatalf("allocate: %v", err)
	}
	if alloc.ID != insts[0].ID {
		t.Fatalf("expected allocated instance %s got %s", insts[0].ID, alloc.ID)
	}
	if _, err := svc.Release(ctx, alloc.ID); err != nil {
		t.Fatalf("release: %v", err)
	}
	if _, err := svc.AdvanceState(ctx, alloc.ID, core.StateResetting); err != nil {
		t.Fatalf("advance to resetting: %v", err)
	}

	cp := &stubProvider{}
	processPool(ctx, svc, cp, pool, "", 1)

	got, err := svc.GetInstance(ctx, alloc.ID)
	if err != nil {
		t.Fatalf("get instance: %v", err)
	}
	if got.State != core.StateResetting {
		t.Fatalf("expected state RESETTING, got %s", got.State)
	}
	if cp.verifyCalls != 0 {
		t.Fatalf("expected 0 verify calls (gated by reinstallVerifyDelay), got %d", cp.verifyCalls)
	}
}

func TestCreateBatch_RetriesTransientVerifyFailure(t *testing.T) {
	defer func(oldRetries int, oldBackoff, oldMaxWait time.Duration) {
		createVerifyRetries = oldRetries
		createVerifyBackoff = oldBackoff
		createVerifyMaxWait = oldMaxWait
	}(createVerifyRetries, createVerifyBackoff, createVerifyMaxWait)
	createVerifyRetries = 3
	createVerifyBackoff = 0
	createVerifyMaxWait = 0

	ctx := context.Background()
	svc := service.NewService(store.NewMemoryStore())
	pool, err := svc.CreatePool(ctx, "p6", "desc", "img", 0, testVpcID, testSubnetID, testZone, testSecurityGroups)
	if err != nil {
		t.Fatalf("create pool: %v", err)
	}

	cp := &stubProvider{
		createCloudIDs: []string{"cloud-1"},
		createAddrs:    []string{"10.0.0.20"},
		verifyErrs:     []error{errors.New("transient verify timeout"), nil},
	}

	result, err := createBatch(ctx, svc, cp, nil, pool, 1, 1)
	if err != nil {
		t.Fatalf("create batch: %v", err)
	}
	if len(result.created) != 1 {
		t.Fatalf("expected 1 created instance after retry, got %d", len(result.created))
	}
	if cp.verifyCalls != 2 {
		t.Fatalf("expected 2 verify calls, got %d", cp.verifyCalls)
	}
	if cp.terminateCalls != 0 {
		t.Fatalf("expected 0 terminate calls on transient verify failure, got %d", cp.terminateCalls)
	}

	insts, err := svc.ListInstances(ctx, pool.ID)
	if err != nil {
		t.Fatalf("list instances: %v", err)
	}
	if len(insts) != 1 {
		t.Fatalf("expected 1 instance record, got %d", len(insts))
	}
	if insts[0].State != core.StateClean {
		t.Fatalf("expected instance to be CLEAN after retry, got %s", insts[0].State)
	}
}

func TestCreateBatch_OnlyFailsAfterVerifyThreshold(t *testing.T) {
	defer func(oldRetries int, oldBackoff, oldMaxWait time.Duration) {
		createVerifyRetries = oldRetries
		createVerifyBackoff = oldBackoff
		createVerifyMaxWait = oldMaxWait
	}(createVerifyRetries, createVerifyBackoff, createVerifyMaxWait)
	createVerifyRetries = 3
	createVerifyBackoff = 0
	createVerifyMaxWait = 0

	ctx := context.Background()
	svc := service.NewService(store.NewMemoryStore())
	pool, err := svc.CreatePool(ctx, "p7", "desc", "img", 0, testVpcID, testSubnetID, testZone, testSecurityGroups)
	if err != nil {
		t.Fatalf("create pool: %v", err)
	}

	cp := &stubProvider{
		createCloudIDs: []string{"cloud-1"},
		createAddrs:    []string{"10.0.0.21"},
		verifyErrs: []error{
			errors.New("verify timeout 1"),
			errors.New("verify timeout 2"),
			errors.New("verify timeout 3"),
		},
	}

	result, err := createBatch(ctx, svc, cp, nil, pool, 1, 1)
	if err != nil {
		t.Fatalf("create batch: %v", err)
	}
	if len(result.created) != 0 {
		t.Fatalf("expected 0 created instances after exhausting verify retries, got %d", len(result.created))
	}
	if cp.verifyCalls != 3 {
		t.Fatalf("expected 3 verify calls before fail, got %d", cp.verifyCalls)
	}
	if cp.terminateCalls != 1 {
		t.Fatalf("expected 1 terminate call after exhausting verify retries, got %d", cp.terminateCalls)
	}

	insts, err := svc.ListInstances(ctx, pool.ID)
	if err != nil {
		t.Fatalf("list instances: %v", err)
	}
	if len(insts) != 1 {
		t.Fatalf("expected 1 instance record, got %d", len(insts))
	}
	if insts[0].State != core.StateFailed {
		t.Fatalf("expected instance to be FAILED after exhausting retries, got %s", insts[0].State)
	}
}
