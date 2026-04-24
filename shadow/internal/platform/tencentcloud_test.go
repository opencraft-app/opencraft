package platform

import "testing"

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
