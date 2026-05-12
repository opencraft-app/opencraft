package billingapi

import (
	"strings"
	"testing"

	"shadow/internal/cloudladder"
)

func TestNewTencentClientCloudLadderRejectsUnsupportedEndpoint(t *testing.T) {
	_, err := NewTencentClient(Options{
		Endpoint:  "billing.tencentcloudapi.com",
		Region:    "ap-guangzhou",
		SecretID:  "secret-id",
		SecretKey: "secret-key",
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
