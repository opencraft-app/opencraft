package openclaw

import (
	"path/filepath"
	"reflect"
	"testing"

	"velachat/agent/internal/runtimeapi"
)

func TestBuildGatewayLaunchIsProfileIsolatedAndHostOwned(t *testing.T) {
	t.Parallel()

	request := runtimeapi.StartRequest{
		AgentID:          "018f0c9e-7b14-7abc-8def-0123456789ab",
		WorkingDirectory: filepath.Join(t.TempDir(), "workspace"),
		Environment: map[string]string{
			"HOME":                 "/users/tester",
			"VELA_AGENT_PROXY_URL": "http://127.0.0.1:12345",
		},
	}
	launch := buildGatewayLaunch(request, "/opt/bin/openclaw", 19051, "secret")
	wantArgs := []string{
		"--profile", "vela-fa7216c3dbd15928790094db476aa2ef",
		"gateway", "--allow-unconfigured", "--port", "19051",
	}
	if launch.executable != "/opt/bin/openclaw" ||
		!reflect.DeepEqual(launch.args, wantArgs) ||
		launch.directory != request.WorkingDirectory {
		t.Fatalf("launch = %#v", launch)
	}
	for key, want := range map[string]string{
		"OPENCLAW_GATEWAY_TOKEN":       "secret",
		"OPENCLAW_DISABLE_BONJOUR":     "1",
		"OPENCLAW_EXEC_SHELL_SNAPSHOT": "0",
		"OPENCLAW_NO_RESPAWN":          "1",
		"OPENCLAW_SKIP_CHANNELS":       "1",
		"OPENCLAW_WORKSPACE_DIR":       request.WorkingDirectory,
		"VELA_AGENT_PROXY_URL":         "http://127.0.0.1:12345",
	} {
		if launch.environment[key] != want {
			t.Errorf("environment[%q] = %q, want %q", key, launch.environment[key], want)
		}
	}
}
