package hermes

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestManagedProfileIdentityIsStableAndAgentScoped(t *testing.T) {
	t.Parallel()

	first, err := managedProfileName("agent-1")
	if err != nil {
		t.Fatal(err)
	}
	second, err := managedProfileName("agent-2")
	if err != nil {
		t.Fatal(err)
	}
	if first != "vela-6ff3b3bd11c44cac620c43d5b65377bd" {
		t.Fatalf("first managed Profile = %q", first)
	}
	if second != "vela-c3544aa158a89417843d45b303d3caf7" {
		t.Fatalf("second managed Profile = %q", second)
	}
	if first == second {
		t.Fatal("different Agents resolved to the same managed Profile")
	}
	if _, err := managedProfileName(" \t "); err == nil {
		t.Fatal("empty Agent ID produced a managed Profile")
	}
}

func TestManagedProfileSelectionUsesOnlyTrustedDefaultHome(t *testing.T) {
	t.Parallel()

	trustedHome := t.TempDir()
	root := filepath.Join(trustedHome, ".hermes")
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(
		filepath.Join(root, "active_profile"),
		[]byte("must-not-be-selected\n"),
		0o600,
	); err != nil {
		t.Fatal(err)
	}

	selection, err := managedProfileSelection(trustedHome, "agent-1")
	if err != nil {
		t.Fatal(err)
	}
	wantHome := filepath.Join(
		trustedHome,
		".hermes",
		"profiles",
		"vela-6ff3b3bd11c44cac620c43d5b65377bd",
	)
	if selection.Name != "vela-6ff3b3bd11c44cac620c43d5b65377bd" ||
		selection.Home != wantHome ||
		!reflect.DeepEqual(
			selection.Args,
			[]string{
				"--profile",
				"vela-6ff3b3bd11c44cac620c43d5b65377bd",
			},
		) ||
		!selection.Explicit {
		t.Fatalf("managed selection = %#v", selection)
	}
}
