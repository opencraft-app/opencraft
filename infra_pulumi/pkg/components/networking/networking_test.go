package networking

import (
	"reflect"
	"testing"

	"github.com/skipzhang/mono/infra_pulumi/pkg/config"
)

func TestSandboxNetworkReconcilesSubnetMulticast(t *testing.T) {
	if got := subnetIgnoreChanges(config.ProfileSandboxNetwork); !reflect.DeepEqual(got, []string{"tags"}) {
		t.Fatalf("sandbox-network subnet ignore changes = %#v", got)
	}
}

func TestFullProfilePreservesExistingSubnetMulticast(t *testing.T) {
	want := []string{"tags", "isMulticast"}
	if got := subnetIgnoreChanges(config.ProfileFull); !reflect.DeepEqual(got, want) {
		t.Fatalf("full-profile subnet ignore changes = %#v, want %#v", got, want)
	}
}
