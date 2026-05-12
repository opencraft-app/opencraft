package platform

import (
	"strings"
	"testing"

	"shadow/internal/cloudladder"
)

func TestNewTencentCloudProvider_RequiresExplicitEndpoints(t *testing.T) {
	_, err := NewTencentCloudProvider(TencentCloudOptions{
		Platform:  "shadow_test",
		SecretID:  "secret-id",
		SecretKey: "secret-key",
	})
	if err == nil {
		t.Fatalf("expected missing endpoint error")
	}
}

func TestNewTencentCloudProvider_CloudLadderRejectsUnsupportedEndpoint(t *testing.T) {
	_, err := NewTencentCloudProvider(TencentCloudOptions{
		Platform:        "shadow_test",
		SecretID:        "secret-id",
		SecretKey:       "secret-key",
		Region:          "ap-guangzhou",
		AccountEndpoint: "account.tencentcloudapi.com",
		CAMEndpoint:     "cam.test.tencentcloudapi.com",
		STSEndpoint:     "sts.test.tencentcloudapi.com",
		CloudLadder: cloudladder.Options{
			Enabled:        true,
			GatewayBaseURL: "http://81.71.196.13",
			Caller:         "shadow",
			Secret:         "secret",
		},
	})
	if err == nil || !strings.Contains(err.Error(), "unsupported cloudladder tencentcloud endpoint") {
		t.Fatalf("expected unsupported cloudladder endpoint error, got %v", err)
	}
}
