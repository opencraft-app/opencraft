package provider

import (
	"testing"

	"cvm-mock-e2b/internal/core"
)

func TestCloudInstanceForPoolDerivesRegion(t *testing.T) {
	ref, err := CloudInstanceForPool(core.Pool{ID: "pool-jhb", Zone: "ap-johorbahru-1"}, "ins-jhb")
	if err != nil {
		t.Fatalf("cloud instance for pool: %v", err)
	}
	if ref.CloudID != "ins-jhb" || ref.Region != "ap-johorbahru" {
		t.Fatalf("unexpected cloud instance ref: %+v", ref)
	}
}
