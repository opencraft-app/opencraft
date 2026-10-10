package openclaw

import (
	"crypto/sha256"
	"fmt"
	"os"
	"strconv"

	"velachat/agent/internal/runtimeapi"
)

type gatewayLaunch struct {
	executable  string
	args        []string
	directory   string
	environment map[string]string
}

func buildGatewayLaunch(
	request runtimeapi.StartRequest,
	executable string,
	port int,
	token string,
) gatewayLaunch {
	environment := make(map[string]string, len(request.Environment)+6)
	for key, value := range request.Environment {
		environment[key] = value
	}
	if environment["HOME"] == "" {
		if home, err := os.UserHomeDir(); err == nil {
			environment["HOME"] = home
		}
	}
	environment["OPENCLAW_GATEWAY_TOKEN"] = token
	environment["OPENCLAW_DISABLE_BONJOUR"] = "1"
	environment["OPENCLAW_EXEC_SHELL_SNAPSHOT"] = "0"
	environment["OPENCLAW_NO_RESPAWN"] = "1"
	environment["OPENCLAW_SKIP_CHANNELS"] = "1"
	environment["OPENCLAW_WORKSPACE_DIR"] = request.WorkingDirectory
	return gatewayLaunch{
		executable: executable,
		args: []string{
			"--profile", managedProfileName(request.AgentID),
			"gateway", "--allow-unconfigured", "--port", strconv.Itoa(port),
		},
		directory:   request.WorkingDirectory,
		environment: environment,
	}
}

func managedProfileName(agentID string) string {
	digest := sha256.Sum256([]byte(agentID))
	return "vela-" + fmt.Sprintf("%x", digest[:16])
}
