package agentmanagement

import (
	"testing"

	agentport "chatserver/internal/ports/agent"
)

func TestValidRuntimeAcceptsExtensibleCanonicalKinds(t *testing.T) {
	t.Parallel()

	for _, kind := range []string{"hermes-acp", "hermes-gateway", "openclaw", "future-runtime-2"} {
		if !validRuntime(agentport.Runtime{Kind: kind}) {
			t.Errorf("validRuntime(%q) = false", kind)
		}
	}
}

func TestValidRuntimeRejectsMalformedKinds(t *testing.T) {
	t.Parallel()

	for _, kind := range []string{"", "OpenClaw", "-openclaw", "open_claw"} {
		if validRuntime(agentport.Runtime{Kind: kind}) {
			t.Errorf("validRuntime(%q) = true", kind)
		}
	}
}
