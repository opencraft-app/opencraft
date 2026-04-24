package provider

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"cvm-mock-e2b/internal/core"
)

func TestTencentCloudProviderLiveCreateAndTerminateInstance(t *testing.T) {
	if strings.TrimSpace(os.Getenv("SANDBOX_TENCENT_LIVE")) != "1" {
		t.Skip("set SANDBOX_TENCENT_LIVE=1 to run against a real Tencent Cloud account")
	}

	p, err := NewTencentCloudProviderFromEnv()
	if err != nil {
		t.Fatalf("init tencent provider from env: %v", err)
	}

	pool := core.Pool{
		ID:             "live-smoke-pool",
		Name:           "live-smoke-pool",
		BaseImage:      requiredLiveEnv(t, "SANDBOX_TENCENT_LIVE_IMAGE_ID"),
		DesiredCap:     1,
		InstanceType:   firstNonEmptyEnv("SANDBOX_TENCENT_LIVE_INSTANCE_TYPE", "TENCENT_INSTANCE_TYPE"),
		Status:         core.PoolStatusActive,
		VpcID:          requiredLiveEnv(t, "SANDBOX_TENCENT_LIVE_VPC_ID"),
		SubnetID:       requiredLiveEnv(t, "SANDBOX_TENCENT_LIVE_SUBNET_ID"),
		Zone:           firstNonEmptyEnv("SANDBOX_TENCENT_LIVE_ZONE", "TENCENT_ZONE"),
		SecurityGroups: splitLiveEnv(requiredLiveEnv(t, "SANDBOX_TENCENT_LIVE_SECURITY_GROUPS")),
	}

	if strings.TrimSpace(pool.InstanceType) == "" {
		t.Fatal("missing SANDBOX_TENCENT_LIVE_INSTANCE_TYPE or TENCENT_INSTANCE_TYPE")
	}
	if strings.TrimSpace(pool.Zone) == "" {
		t.Fatal("missing SANDBOX_TENCENT_LIVE_ZONE or TENCENT_ZONE")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()

	cloudID, addr, err := p.CreateInstance(ctx, pool)
	if err != nil {
		t.Fatalf("live CreateInstance failed: %v", err)
	}
	if cloudID == "" {
		t.Fatal("live CreateInstance returned empty cloudID")
	}
	if addr == "" {
		t.Fatal("live CreateInstance returned empty address")
	}
	t.Logf("live tencent instance created cloud_id=%s addr=%s", cloudID, addr)

	defer func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Minute)
		defer cleanupCancel()
		if err := p.TerminateInstance(cleanupCtx, cloudID); err != nil {
			t.Fatalf("live TerminateInstance failed for %s: %v", cloudID, err)
		}
		t.Logf("live tencent instance terminated cloud_id=%s", cloudID)
	}()

	status, err := p.DescribeInstance(ctx, cloudID)
	if err != nil {
		t.Fatalf("live DescribeInstance failed: %v", err)
	}
	if strings.TrimSpace(status) == "" {
		t.Fatal("live DescribeInstance returned empty status")
	}
	t.Logf("live tencent instance status=%s", status)
}

func requiredLiveEnv(t *testing.T, key string) string {
	t.Helper()
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		t.Fatalf("missing required live env %s", key)
	}
	return value
}

func firstNonEmptyEnv(keys ...string) string {
	for _, key := range keys {
		if value := strings.TrimSpace(os.Getenv(key)); value != "" {
			return value
		}
	}
	return ""
}

func splitLiveEnv(value string) []string {
	parts := strings.Split(value, ",")
	items := make([]string, 0, len(parts))
	for _, part := range parts {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			items = append(items, trimmed)
		}
	}
	return items
}

func RequiredLiveEnv(t *testing.T, key string) string {
	t.Helper()
	return requiredLiveEnv(t, key)
}

func FirstNonEmptyEnv(keys ...string) string {
	return firstNonEmptyEnv(keys...)
}

func SplitLiveEnv(value string) []string {
	return splitLiveEnv(value)
}
