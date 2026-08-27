package clientcli

import "testing"

func TestRootCommandTopologyMirrorsGatewayPlanes(t *testing.T) {
	root := NewRoot(Dependencies{})
	paths := []string{
		"doctor",
		"ctl tenant ensure",
		"ctl tenant assignment get",
		"ctl tenant assignment set",
		"ctl subscription apply",
		"ctl subscription cancel",
		"ctl subscription get",
		"ctl credit get",
		"ctl byok get",
		"ctl byok set",
		"ctl byok sync",
		"admin tenant show",
		"admin key create",
		"traffic models",
		"traffic chat",
		"scenario trade-lifecycle",
		"scenario onboard",
		"scenario renew",
		"scenario cancel",
		"scenario byok",
		"scenario full",
	}
	for _, path := range paths {
		if _, _, err := root.Find(splitCommandPath(path)); err != nil {
			t.Errorf("missing command %q: %v", path, err)
		}
	}
}
