package openapi

import (
	"context"
	"testing"
)

func TestExtensibleRuntimeSelectorAndVersionedSurfaces(t *testing.T) {
	t.Parallel()

	spec, err := GetSwagger()
	if err != nil {
		t.Fatal(err)
	}
	if err := spec.Validate(context.Background()); err != nil {
		t.Fatal(err)
	}
	for path, method := range map[string]string{
		"/servers/{serverId}/agents-v2": "GET",
		"/computer/session-v2":          "POST",
		"/computer/assignments-v3":     "GET",
	} {
		item := spec.Paths.Map()[path]
		if item == nil || item.GetOperation(method) == nil {
			t.Errorf("missing %s %s", method, path)
		}
	}
	for _, name := range []string{
		"RuntimeSelectorV2",
		"AgentV2",
		"ComputerSessionV2",
		"ComputerAssignmentSnapshotV3",
	} {
		if schema := spec.Components.Schemas[name]; schema == nil || schema.Value == nil {
			t.Errorf("missing schema %q", name)
		}
	}
	runtimeSelector := spec.Components.Schemas["RuntimeSelectorV2"]
	if runtimeSelector == nil || runtimeSelector.Value == nil {
		return
	}
	kind := runtimeSelector.Value.Properties["kind"]
	if kind == nil || kind.Value == nil {
		t.Fatal("RuntimeSelectorV2.kind is missing")
	}
	if len(kind.Value.Enum) != 0 {
		t.Fatalf("RuntimeSelectorV2.kind is still closed: %#v", kind.Value.Enum)
	}
	if kind.Value.Pattern == "" {
		t.Fatal("RuntimeSelectorV2.kind has no machine validation pattern")
	}
}
