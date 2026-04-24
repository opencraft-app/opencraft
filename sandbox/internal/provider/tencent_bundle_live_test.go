package provider

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"
)

func LiveBundleTestInputs(t *testing.T) (region, zone, vpcID, subnetID string, securityGroups []string) {
	t.Helper()
	region = FirstNonEmptyEnv("SANDBOX_TENCENT_LIVE_REGION", "TENCENT_REGION")
	zone = RequiredLiveEnv(t, "SANDBOX_TENCENT_LIVE_ZONE")
	vpcID = RequiredLiveEnv(t, "SANDBOX_TENCENT_LIVE_VPC_ID")
	subnetID = RequiredLiveEnv(t, "SANDBOX_TENCENT_LIVE_SUBNET_ID")
	securityGroups = SplitLiveEnv(RequiredLiveEnv(t, "SANDBOX_TENCENT_LIVE_SECURITY_GROUPS"))
	if len(securityGroups) == 0 {
		t.Fatal("SANDBOX_TENCENT_LIVE_SECURITY_GROUPS produced no security groups")
	}
	return region, zone, vpcID, subnetID, securityGroups
}

func TestTencentCloudProviderLiveProvisionCapacityBundle(t *testing.T) {
	if strings.TrimSpace(os.Getenv("SANDBOX_TENCENT_LIVE_BUNDLE")) != "1" {
		t.Skip("set SANDBOX_TENCENT_LIVE_BUNDLE=1 to run real Tencent bundle provisioning")
	}

	p, err := NewTencentCloudProviderFromEnv()
	if err != nil {
		t.Fatalf("init tencent provider from env: %v", err)
	}

	region, zone, vpcID, subnetID, securityGroups := LiveBundleTestInputs(t)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()

	bundle, err := p.ProvisionCapacityBundle(ctx, CapacityBundleProvisionRequest{
		TemplateClassID:        "live-sg-shard",
		Region:                 region,
		Zone:                   zone,
		SourceVpcID:            vpcID,
		SourceSubnetID:         subnetID,
		SourceSecurityGroupIDs: securityGroups,
	})
	if err != nil {
		t.Fatalf("live ProvisionCapacityBundle failed: %v", err)
	}
	if bundle.ID == "" || len(bundle.SecurityGroupIDs) == 0 {
		t.Fatalf("unexpected bundle: %+v", bundle)
	}
	t.Logf("live bundle created id=%s sg_ids=%v", bundle.ID, bundle.SecurityGroupIDs)

	defer func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cleanupCancel()
		for _, sgID := range bundle.SecurityGroupIDs {
			if err := p.deleteSecurityGroup(cleanupCtx, region, sgID); err != nil {
				t.Fatalf("delete cloned security group %s failed: %v", sgID, err)
			}
			t.Logf("deleted cloned security group %s", sgID)
		}
	}()

	for _, sgID := range bundle.SecurityGroupIDs {
		for _, sourceID := range securityGroups {
			if sgID == sourceID {
				t.Fatalf("expected cloned security group id to differ from source %s", sourceID)
			}
		}
	}
}
