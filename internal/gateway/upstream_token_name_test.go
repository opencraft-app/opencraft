package gateway

import "testing"

func TestNewAPIExternalTokenNameFitsUpstreamLimit(t *testing.T) {
	externalKeyID := "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyAhIiMk"

	name := newAPIExternalTokenName(externalKeyID)
	if len(name) > 20 {
		t.Fatalf("token name length = %d, want at most 20: %q", len(name), name)
	}
	if name != "sgw-AQIDBAUGBwgJCgsM" {
		t.Fatalf("token name = %q, want stable shortened identity", name)
	}
}
