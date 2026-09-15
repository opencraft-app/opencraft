package agentmanagement

import (
	"testing"

	agentport "git.woa.com/wisp/mono2/collaboration/internal/ports/agent"
)

func TestValidRuntimeAcceptsExplicitHermesKinds(t *testing.T) {
	t.Parallel()

	for _, kind := range []string{"hermes-acp", "hermes-gateway"} {
		if !validRuntime(agentport.Runtime{Kind: kind}) {
			t.Errorf("validRuntime(%q) = false", kind)
		}
	}
}

func TestValidRuntimeRejectsKindsMissingFromCanonicalVelaHost(t *testing.T) {
	t.Parallel()

	for _, kind := range []string{"claude", "kimi", "pi"} {
		if validRuntime(agentport.Runtime{Kind: kind}) {
			t.Errorf("validRuntime(%q) = true", kind)
		}
	}
}
