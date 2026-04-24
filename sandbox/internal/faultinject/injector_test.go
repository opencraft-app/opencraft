package faultinject

import (
	"context"
	"database/sql"
	"strings"
	"testing"
	"time"

	"cvm-mock-e2b/internal/core"
	"cvm-mock-e2b/internal/provider"
	"cvm-mock-e2b/internal/service"
	"cvm-mock-e2b/internal/store"
)

type stubProvisionProvider struct{}

func (p *stubProvisionProvider) CreateInstance(context.Context, core.Pool) (string, string, error) {
	return "", "", nil
}

func (p *stubProvisionProvider) ReinstallInstance(context.Context, string, string) error {
	return nil
}

func (p *stubProvisionProvider) DescribeInstance(context.Context, string) (string, error) {
	return "", nil
}

func (p *stubProvisionProvider) TerminateInstance(context.Context, string) error {
	return nil
}

func (p *stubProvisionProvider) VerifyInstance(context.Context, string) error {
	return nil
}

func (p *stubProvisionProvider) ProvisionCapacityBundle(ctx context.Context, req provider.CapacityBundleProvisionRequest) (core.CapacityBundle, error) {
	now := time.Now().UTC()
	return core.CapacityBundle{
		ID:               "bundle-" + req.TemplateClassID,
		Region:           req.Region,
		Zone:             req.Zone,
		VpcID:            req.SourceVpcID,
		SubnetID:         req.SourceSubnetID,
		SecurityGroupIDs: append([]string(nil), req.SourceSecurityGroupIDs...),
		Status:           core.CapacityBundleStatusWarm,
		LineageTags: map[string]string{
			"template_class_id": req.TemplateClassID,
			"sku_id":            "sku-" + req.TemplateClassID,
		},
		CreatedAt: now,
		UpdatedAt: now,
	}, nil
}

type stubCleanupProvider struct {
	stubProvisionProvider
	terminated []string
	deletedSGs []string
	deleteErrs []error
}

func (p *stubCleanupProvider) TerminateInstance(_ context.Context, cloudID string) error {
	p.terminated = append(p.terminated, cloudID)
	return nil
}

func (p *stubCleanupProvider) DeleteSecurityGroup(_ context.Context, _ string, securityGroupID string) error {
	p.deletedSGs = append(p.deletedSGs, securityGroupID)
	if len(p.deleteErrs) == 0 {
		return nil
	}
	err := p.deleteErrs[0]
	p.deleteErrs = p.deleteErrs[1:]
	return err
}

func TestInjectSGLimitWaitsForRecoveredPoolCleanBeforeAllocating(t *testing.T) {
	ctx := context.Background()
	svc := service.NewService(store.NewMemoryStore())
	injector := NewInjector(svc, &stubProvisionProvider{}, (*sql.DB)(nil))
	injector.waitForCleanTimeout = 2 * time.Second
	injector.waitForCleanPollInterval = 10 * time.Millisecond

	done := make(chan struct{})
	go func() {
		defer close(done)
		deadline := time.Now().Add(time.Second)
		for time.Now().Before(deadline) {
			pools, err := svc.ListPools(ctx)
			if err != nil {
				time.Sleep(10 * time.Millisecond)
				continue
			}
			for _, pool := range pools {
				if strings.TrimSpace(pool.CapacityBundleID) == "" {
					continue
				}
				if _, err := svc.RefillVerified(ctx, pool.ID, 1, []string{"10.0.0.10"}, []string{"cloud-recovered"}, func(context.Context, string) error { return nil }); err == nil {
					return
				}
			}
			time.Sleep(10 * time.Millisecond)
		}
	}()

	result, err := injector.InjectSGLimit(ctx, SGLimitRequest{
		BaseImage:      "img-1",
		InstanceType:   "SA9.MEDIUM2",
		Region:         "ap-beijing",
		Zone:           "ap-beijing-8",
		VpcID:          "vpc-1",
		SubnetID:       "subnet-1",
		SecurityGroups: []string{"sg-1"},
		AutoCleanup:    false,
	})
	if err != nil {
		t.Fatalf("InjectSGLimit: %v", err)
	}
	<-done

	if result.NewPoolID == "" {
		t.Fatalf("expected recovered pool id in result")
	}
	if result.AllocatedPoolID != result.NewPoolID {
		t.Fatalf("expected allocation from recovered pool %s, got %s", result.NewPoolID, result.AllocatedPoolID)
	}
	if result.AllocatedInstanceID == "" || result.SandboxID == "" {
		t.Fatalf("expected sandbox allocation details, got %+v", result)
	}
}

func TestInjectSGLimitFailsWhenRecoveredPoolNeverGetsCleanInventory(t *testing.T) {
	ctx := context.Background()
	svc := service.NewService(store.NewMemoryStore())
	injector := NewInjector(svc, &stubProvisionProvider{}, (*sql.DB)(nil))
	injector.waitForCleanTimeout = 50 * time.Millisecond
	injector.waitForCleanPollInterval = 5 * time.Millisecond

	_, err := injector.InjectSGLimit(ctx, SGLimitRequest{
		BaseImage:      "img-1",
		InstanceType:   "SA9.MEDIUM2",
		Region:         "ap-beijing",
		Zone:           "ap-beijing-8",
		VpcID:          "vpc-1",
		SubnetID:       "subnet-1",
		SecurityGroups: []string{"sg-1"},
		AutoCleanup:    false,
	})
	if err == nil {
		t.Fatalf("expected wait for CLEAN inventory to fail")
	}
	if !strings.Contains(err.Error(), "wait for recovered pool CLEAN inventory") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestCleanupTerminatesInstancesBeforeDeletingSecurityGroups(t *testing.T) {
	ctx := context.Background()
	svc := service.NewService(store.NewMemoryStore())
	cp := &stubCleanupProvider{
		deleteErrs: []error{
			context.DeadlineExceeded, // overwritten below to keep compile? no
		},
	}
	cp.deleteErrs = []error{
		assertCleanupResourceInUseError(),
		nil,
	}
	injector := NewInjector(svc, cp, (*sql.DB)(nil))
	injector.cleanupDeleteRetryDelay = 5 * time.Millisecond
	injector.cleanupDeleteMaxAttempts = 2

	pool, err := svc.CreatePool(ctx, "cleanup-pool", "desc", "img-1", 1, "vpc-1", "subnet-1", "ap-beijing-8", []string{"sg-src"})
	if err != nil {
		t.Fatalf("create pool: %v", err)
	}
	insts, err := svc.RefillVerified(ctx, pool.ID, 1, []string{"10.0.0.10"}, []string{"cloud-cleanup"}, func(context.Context, string) error { return nil })
	if err != nil {
		t.Fatalf("refill: %v", err)
	}
	allocated, err := svc.Allocate(ctx, pool.ID)
	if err != nil {
		t.Fatalf("allocate: %v", err)
	}
	sb, err := svc.CreateSandbox(ctx, core.Sandbox{InstanceID: allocated.ID, PoolID: pool.ID})
	if err != nil {
		t.Fatalf("create sandbox: %v", err)
	}

	if err := injector.cleanup(ctx, SGLimitResult{
		SourcePoolID:         pool.ID,
		NewPoolID:            pool.ID,
		SandboxID:            sb.ID,
		AllocatedInstanceID:  insts[0].ID,
		ClonedSecurityGroups: []string{"sg-cloned"},
	}); err != nil {
		t.Fatalf("cleanup: %v", err)
	}
	if len(cp.terminated) != 1 || cp.terminated[0] != "cloud-cleanup" {
		t.Fatalf("expected cleanup to terminate cloud-cleanup, got %v", cp.terminated)
	}
	if len(cp.deletedSGs) != 2 {
		t.Fatalf("expected cleanup to retry delete security group twice, got %v", cp.deletedSGs)
	}
	if _, err := svc.GetSandbox(ctx, sb.ID); err == nil {
		t.Fatalf("expected sandbox record deleted")
	}
	if _, err := svc.GetInstance(ctx, allocated.ID); err == nil {
		t.Fatalf("expected instance record deleted")
	}
}

func assertCleanupResourceInUseError() error {
	return &cleanupResourceInUseError{}
}

type cleanupResourceInUseError struct{}

func (e *cleanupResourceInUseError) Error() string {
	return "[TencentCloudSDKError] Code=ResourceInUse, Message=security group still attached"
}
