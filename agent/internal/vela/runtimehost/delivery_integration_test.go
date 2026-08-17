package runtimehost

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"velachat/agent/internal/runtimeapi"
	"velachat/agent/internal/vela/agentgateway"
	"velachat/agent/internal/vela/im"
	"velachat/agent/internal/vela/ingress"
	"velachat/agent/internal/vela/platform"
)

func TestAdapterAcceptsDirectConversationGroupFromRealGateway(t *testing.T) {
	t.Parallel()
	const (
		serverID = "0198fab7-e66f-70d4-982c-13d1abea2101"
		agentID  = "0198fab7-e670-7d41-9d9d-da6a1bea2102"
		humanID  = "0198fab7-e671-7171-9264-51081bea2103"
		directID = "0198fab7-e672-783f-b952-42ba1bea2104"
	)
	now := time.Date(2026, 8, 3, 10, 0, 0, 0, time.UTC)
	platformServer := httptest.NewServer(http.HandlerFunc(func(
		response http.ResponseWriter,
		request *http.Request,
	) {
		if request.Method != http.MethodGet ||
			request.URL.Path != "/v1/runtime/directory-v2" ||
			request.Header.Get("Authorization") != "Bearer runtime-token" {
			http.NotFound(response, request)
			return
		}
		response.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(response, `{
          "server":{"id":%q,"slug":"team","name":"Team"},
          "self":{"agentId":%q,"memberId":%q,"handle":"builder","displayName":"Builder","imUserId":"agent_builder"},
          "channels":[],
          "members":[
            {"memberId":%q,"kind":"agent","agentId":%q,"handle":"builder","displayName":"Builder","imUserId":"agent_builder"},
            {"memberId":%q,"kind":"human","humanId":%q,"handle":"alice","displayName":"Alice","imUserId":"human_alice"}
          ],
          "directConversations":[{"id":%q,"peerMemberId":%q,"imGroupId":"an_dm_authorized","imState":"ready","revision":1}],
          "revision":"sha256:delivery-integration","expiresAt":%q
        }`, serverID, agentID, agentID, agentID, agentID,
			humanID, humanID, directID, humanID,
			now.Add(5*time.Minute).Format(time.RFC3339))
	}))
	t.Cleanup(platformServer.Close)
	platformClient, err := platform.NewClient(platform.Config{
		BaseURL: platformServer.URL + "/v1", HTTPClient: platformServer.Client(),
		AllowInsecureLoopback: true, Now: func() time.Time { return now },
		MaxSessionTTL: 15 * time.Minute,
	})
	if err != nil {
		t.Fatal(err)
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	hub, err := agentgateway.NewHub()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = hub.Close(context.Background()) })
	gateway, err := hub.Register(agentgateway.Config{
		AgentID: agentID, ServerID: serverID, RuntimeEpoch: "runtime-epoch-1",
		StateRoot: t.TempDir(), Executable: executable,
		Transport: agentgateway.NewTransportSlot(), PlatformClient: platformClient,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = gateway.Close(context.Background()) })

	manager := &fakeManager{}
	adapter, err := New(Config{
		AgentID: agentID, StateDirectory: t.TempDir(),
		WorkingDirectory: t.TempDir(), Actor: manager,
		Runtimes: fakeResolver{runtime: runtimeapi.ResolvedRuntime{
			ID: "codex", InternalID: "codex",
			LaunchPlanner: runtimeapi.LaunchPlannerFunc(func(input runtimeapi.LaunchInput) (runtimeapi.LaunchPlan, error) {
				return runtimeapi.LaunchPlan{Prompt: string(input.WakeMessage)}, nil
			}),
		}},
		Gateway:         gateway,
		NewRuntimeEpoch: func() (string, error) { return "runtime-epoch-1", nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = adapter.Close(context.Background()) })
	token, err := platform.NewAccessToken("runtime-token")
	if err != nil {
		t.Fatal(err)
	}
	if err := adapter.UpdateSession(platform.RuntimeSession{
		AccessToken: token,
		Agent: platform.AgentIdentity{
			ID: agentID, ServerID: serverID, UserID: "agent_builder",
			ReplyPolicy: "dm_only", RuntimeKind: "codex",
			Capabilities: []string{"read", "send", "server"},
		},
	}); err != nil {
		t.Fatal(err)
	}
	conversation, err := im.NewGroupConversation("an_dm_authorized")
	if err != nil {
		t.Fatal(err)
	}
	reference, err := im.NewMessageRef(
		conversation, "message-directory-1", 1, now.UnixMilli(),
	)
	if err != nil {
		t.Fatal(err)
	}
	result, err := adapter.HandleIngressMessage(context.Background(), im.IncomingMessage{
		Ref: reference, SenderUserID: "human_alice",
		Elements: []im.Element{{Type: im.ElementText, Text: "hello"}},
	})
	if err != nil || result.Disposition != ingress.RuntimeAccepted {
		t.Fatalf("HandleIngressMessage() = %#v, %v", result, err)
	}

	manager.mu.Lock()
	defer manager.mu.Unlock()
	if len(manager.starts) != 1 {
		t.Fatalf("starts = %#v", manager.starts)
	}
	if !strings.Contains(manager.starts[0].Prompt, `"target":"@alice"`) {
		t.Fatalf("wake prompt did not preserve visible target: %s", manager.starts[0].Prompt)
	}
}
