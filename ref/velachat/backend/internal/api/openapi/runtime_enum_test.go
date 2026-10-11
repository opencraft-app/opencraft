package openapi

import (
	"context"
	"testing"
)

func TestRuntimeConfigEnumIncludesExplicitHermesKinds(t *testing.T) {
	t.Parallel()

	spec, err := GetSwagger()
	if err != nil {
		t.Fatalf("load embedded OpenAPI: %v", err)
	}
	if err := spec.Validate(context.Background()); err != nil {
		t.Fatalf("validate embedded OpenAPI: %v", err)
	}
	runtimeConfig := spec.Components.Schemas["RuntimeConfig"]
	if runtimeConfig == nil || runtimeConfig.Value == nil {
		t.Fatal("RuntimeConfig schema is missing")
	}
	kind := runtimeConfig.Value.Properties["kind"]
	if kind == nil || kind.Value == nil {
		t.Fatal("RuntimeConfig.kind schema is missing")
	}
	values := make(map[string]bool, len(kind.Value.Enum))
	for _, raw := range kind.Value.Enum {
		value, ok := raw.(string)
		if !ok {
			t.Fatalf("RuntimeConfig.kind enum contains %T", raw)
		}
		values[value] = true
	}
	for _, want := range []string{"hermes-acp", "hermes-gateway"} {
		if !values[want] {
			t.Errorf("RuntimeConfig.kind enum is missing %q: %#v", want, values)
		}
	}
	if len(values) != 3 || !values["codex"] {
		t.Errorf(
			"RuntimeConfig.kind must equal canonical Vela catalog: %#v",
			values,
		)
	}
	for _, unavailable := range []string{"claude", "kimi", "pi"} {
		if values[unavailable] {
			t.Errorf(
				"RuntimeConfig.kind still advertises unavailable %q",
				unavailable,
			)
		}
	}
}
