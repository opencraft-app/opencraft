package app

import (
	"context"
	"testing"

	"velachat/agent/internal/vela/agentgateway"
	"velachat/agent/internal/vela/daemon"
)

func TestManagedAgentFactoryRegistersEveryLaunchOnInjectedHub(
	t *testing.T,
) {
	t.Parallel()

	hub, err := agentgateway.NewHub()
	if err != nil {
		t.Fatal(err)
	}
	defer hub.Close(context.Background())
	factory := &managedAgentFactory{
		root:       t.TempDir(),
		gatewayHub: hub,
	}

	register := func(agentID, serverID, launchID string) *agentgateway.Gateway {
		t.Helper()
		gateway, registerErr := factory.registerGateway(
			daemon.AgentAssignment{
				AgentID:  agentID,
				ServerID: serverID,
			},
			daemon.Fence{LaunchID: launchID},
			agentgateway.NewTransportSlot(),
		)
		if registerErr != nil {
			t.Fatal(registerErr)
		}
		return gateway
	}

	agentA := register("agent_a", "server_a", "launch-a")
	defer agentA.Close(context.Background())
	agentB := register("agent_b", "server_b", "launch-b")
	defer agentB.Close(context.Background())
	if agentA.RuntimeEnvironment()["VELA_AGENT_PROXY_URL"] !=
		agentB.RuntimeEnvironment()["VELA_AGENT_PROXY_URL"] {
		t.Fatal("managed Agent launches did not share the daemon GatewayHub")
	}
}
