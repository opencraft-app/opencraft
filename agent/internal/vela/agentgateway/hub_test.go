package agentgateway

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/agentapi"
	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/vela/platform"
)

func TestHubSharesListenerAndIsolatesLaunchRegistrations(t *testing.T) {
	t.Parallel()

	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	hub, err := NewHub()
	if err != nil {
		t.Fatal(err)
	}
	defer hub.Close(context.Background())
	slotA := NewTransportSlot()
	transportA := &recordingTransport{}
	bindingA := slotA.Bind(transportA)
	defer bindingA.Release()
	slotB := NewTransportSlot()
	transportB := &recordingTransport{}
	bindingB := slotB.Bind(transportB)
	defer bindingB.Release()

	agentA, err := hub.Register(Config{
		AgentID:      "agent_a",
		ServerID:     "server_a",
		RuntimeEpoch: "launch-a",
		StateRoot:    t.TempDir(),
		Executable:   executable,
		Transport:    slotA,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer agentA.Close(context.Background())
	agentB, err := hub.Register(Config{
		AgentID:      "agent_b",
		ServerID:     "server_b",
		RuntimeEpoch: "launch-b",
		StateRoot:    t.TempDir(),
		Executable:   executable,
		Transport:    slotB,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer agentB.Close(context.Background())

	for _, item := range []struct {
		gateway  *Gateway
		agentID  string
		serverID string
	}{
		{gateway: agentA, agentID: "agent_a", serverID: "server_a"},
		{gateway: agentB, agentID: "agent_b", serverID: "server_b"},
	} {
		if err := item.gateway.UpdateAuthorization(platform.AgentIdentity{
			ID:           item.agentID,
			ServerID:     item.serverID,
			Capabilities: []string{"read", "send"},
		}); err != nil {
			t.Fatal(err)
		}
	}

	environmentA := agentA.RuntimeEnvironment()
	environmentB := agentB.RuntimeEnvironment()
	for _, item := range []struct {
		environment map[string]string
		launchID    string
	}{
		{environment: environmentA, launchID: "launch-a"},
		{environment: environmentB, launchID: "launch-b"},
	} {
		wantSuffix := filepath.Join(
			"launches",
			item.launchID,
			"proxy.token",
		)
		if !strings.HasSuffix(
			filepath.Clean(item.environment["SLOCK_AGENT_PROXY_TOKEN_FILE"]),
			string(os.PathSeparator)+wantSuffix,
		) {
			t.Fatalf(
				"launch token path = %q, want suffix %q",
				item.environment["SLOCK_AGENT_PROXY_TOKEN_FILE"],
				wantSuffix,
			)
		}
		wrapperDirectory := strings.Split(
			item.environment["PATH"],
			string(os.PathListSeparator),
		)[0]
		raftWrapper, readErr := os.ReadFile(
			filepath.Join(wrapperDirectory, "raft"),
		)
		if readErr != nil {
			t.Fatal(readErr)
		}
		slockWrapper, readErr := os.ReadFile(
			filepath.Join(wrapperDirectory, "slock"),
		)
		if readErr != nil {
			t.Fatal(readErr)
		}
		if string(raftWrapper) != string(slockWrapper) {
			t.Fatal("raft and slock wrappers differ")
		}
		if strings.Contains(string(raftWrapper), "RAFT_AGENT_CLI_PROFILE") {
			t.Fatalf("wrapper 仍包含已删除的 CLI profile：%q", raftWrapper)
		}
	}
	if environmentA["SLOCK_AGENT_PROXY_URL"] !=
		environmentB["SLOCK_AGENT_PROXY_URL"] {
		t.Fatalf(
			"Gateway URL A=%q B=%q",
			environmentA["SLOCK_AGENT_PROXY_URL"],
			environmentB["SLOCK_AGENT_PROXY_URL"],
		)
	}
	tokenA, err := os.ReadFile(
		environmentA["SLOCK_AGENT_PROXY_TOKEN_FILE"],
	)
	if err != nil {
		t.Fatal(err)
	}
	tokenB, err := os.ReadFile(
		environmentB["SLOCK_AGENT_PROXY_TOKEN_FILE"],
	)
	if err != nil {
		t.Fatal(err)
	}
	if string(tokenA) == string(tokenB) {
		t.Fatal("two launches received the same capability token")
	}

	message := gatewayIncomingMessage(t)
	target, err := agentA.RegisterMessage(message)
	if err != nil {
		t.Fatal(err)
	}
	clientA := newGatewayTestClient(t, environmentA)
	clientB := newGatewayTestClient(t, environmentB)
	if count := gatewayInboxCount(t, clientA); count != 1 {
		t.Fatalf("Agent A inbox count = %d", count)
	}
	if count := gatewayInboxCount(t, clientB); count != 0 {
		t.Fatalf("Agent B observed Agent A inbox, count = %d", count)
	}
	err = clientB.Call(
		context.Background(),
		agentapi.MessageSend,
		agentapi.Request{Body: map[string]any{
			"target":  target,
			"content": "cross-agent send must fail",
		}},
		nil,
	)
	httpError, ok := err.(*agentapi.HTTPError)
	if !ok || httpError.StatusCode != http.StatusForbidden {
		t.Fatalf("cross-Agent send error = %#v", err)
	}
	if transportA.request.Text != "" || transportB.request.Text != "" {
		t.Fatalf(
			"cross-Agent send reached transport A=%#v B=%#v",
			transportA.request,
			transportB.request,
		)
	}
}

func TestHubRevokesOnlyTheClosedLaunchToken(t *testing.T) {
	t.Parallel()

	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	hub, err := NewHub()
	if err != nil {
		t.Fatal(err)
	}
	defer hub.Close(context.Background())

	register := func(agentID, launchID string) *Gateway {
		t.Helper()
		gateway, registerErr := hub.Register(Config{
			AgentID:      agentID,
			ServerID:     "server_1",
			RuntimeEpoch: launchID,
			StateRoot:    t.TempDir(),
			Executable:   executable,
			Transport:    NewTransportSlot(),
		})
		if registerErr != nil {
			t.Fatal(registerErr)
		}
		if updateErr := gateway.UpdateAuthorization(
			platform.AgentIdentity{
				ID:           agentID,
				ServerID:     "server_1",
				Capabilities: []string{"read"},
			},
		); updateErr != nil {
			t.Fatal(updateErr)
		}
		return gateway
	}

	agentA := register("agent_a", "launch-a")
	agentB := register("agent_b", "launch-b")
	defer agentB.Close(context.Background())
	environmentA := agentA.RuntimeEnvironment()
	environmentB := agentB.RuntimeEnvironment()
	tokenA, err := os.ReadFile(
		environmentA["SLOCK_AGENT_PROXY_TOKEN_FILE"],
	)
	if err != nil {
		t.Fatal(err)
	}
	if err := agentA.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Dir(
		environmentA["SLOCK_AGENT_PROXY_TOKEN_FILE"],
	)); !os.IsNotExist(err) {
		t.Fatalf("closed launch directory remains: %v", err)
	}

	request, err := http.NewRequest(
		http.MethodGet,
		environmentA["SLOCK_AGENT_PROXY_URL"]+
			agentapi.BasePath+"/inbox",
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+string(tokenA))
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("revoked launch status = %d", response.StatusCode)
	}
	if count := gatewayInboxCount(
		t,
		newGatewayTestClient(t, environmentB),
	); count != 0 {
		t.Fatalf("remaining Agent inbox count = %d", count)
	}
}

func TestHubRejectsDuplicateLaunchRegistration(t *testing.T) {
	t.Parallel()

	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	hub, err := NewHub()
	if err != nil {
		t.Fatal(err)
	}
	defer hub.Close(context.Background())
	stateRoot := t.TempDir()
	config := Config{
		AgentID:      "agent_a",
		ServerID:     "server_a",
		RuntimeEpoch: "launch-a",
		StateRoot:    stateRoot,
		Executable:   executable,
		Transport:    NewTransportSlot(),
	}
	first, err := hub.Register(config)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close(context.Background())
	_, err = hub.Register(config)
	if !errors.Is(err, ErrLaunchAlreadyRegistered) {
		t.Fatalf("duplicate registration error = %v", err)
	}
}

func TestHubRequiresBearerAuthorizationScheme(t *testing.T) {
	t.Parallel()

	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	hub, err := NewHub()
	if err != nil {
		t.Fatal(err)
	}
	defer hub.Close(context.Background())
	gateway, err := hub.Register(Config{
		AgentID:      "agent_a",
		ServerID:     "server_a",
		RuntimeEpoch: "launch-a",
		StateRoot:    t.TempDir(),
		Executable:   executable,
		Transport:    NewTransportSlot(),
	})
	if err != nil {
		t.Fatal(err)
	}
	defer gateway.Close(context.Background())
	environment := gateway.RuntimeEnvironment()
	token, err := os.ReadFile(
		environment["SLOCK_AGENT_PROXY_TOKEN_FILE"],
	)
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequest(
		http.MethodGet,
		environment["SLOCK_AGENT_PROXY_URL"]+
			agentapi.BasePath+"/inbox",
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", string(token))
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("authorization without Bearer status = %d", response.StatusCode)
	}
}

func newGatewayTestClient(
	t *testing.T,
	environment map[string]string,
) *agentapi.Client {
	t.Helper()
	client, err := agentapi.New(agentapi.ClientOptions{
		BaseURL:   environment["SLOCK_AGENT_PROXY_URL"],
		TokenFile: environment["SLOCK_AGENT_PROXY_TOKEN_FILE"],
	})
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func gatewayInboxCount(t *testing.T, client *agentapi.Client) int {
	t.Helper()
	var inbox struct {
		Rows []struct {
			Target string `json:"target"`
		} `json:"rows"`
	}
	if err := client.Call(
		context.Background(),
		agentapi.InboxCheck,
		agentapi.Request{},
		&inbox,
	); err != nil {
		t.Fatal(err)
	}
	return len(inbox.Rows)
}
