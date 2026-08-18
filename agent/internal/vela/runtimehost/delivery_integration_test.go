package runtimehost

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"

	"velachat/agent/internal/agentapi"
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
		AttachmentFetcher: func(_ context.Context, rawURL string) ([]byte, string, error) {
			if rawURL != "https://image.rich.my-imcloud.com/screenshot.png?token=provider-secret" {
				t.Fatalf("attachment URL = %q", rawURL)
			}
			return []byte("PNG"), "image/png", nil
		},
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
			Capabilities: []string{"read", "send", "server", "attachments"},
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
		Elements: []im.Element{
			{Type: im.ElementText, Text: "please inspect"},
			{
				Type: im.ElementAttachment,
				Attachment: &im.Attachment{
					ID: "provider-secret", Filename: "screenshot.png", MIMEType: "image/png",
					SizeBytes: 3,
					URL:       "https://image.rich.my-imcloud.com/screenshot.png?token=provider-secret",
				},
			},
		},
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
	if !strings.Contains(manager.starts[0].Prompt, `"filename":"screenshot.png"`) ||
		strings.Contains(manager.starts[0].Prompt, "provider-secret") ||
		strings.Contains(manager.starts[0].Prompt, "my-imcloud.com") {
		t.Fatalf("wake prompt attachment = %s", manager.starts[0].Prompt)
	}
	attachmentID := regexp.MustCompile(`attc_[0-9a-f]{32}`).FindString(manager.starts[0].Prompt)
	if attachmentID == "" {
		t.Fatalf("wake prompt has no transient attachment ID: %s", manager.starts[0].Prompt)
	}
	tokenData, err := os.ReadFile(gateway.RuntimeEnvironment()["VELA_AGENT_PROXY_TOKEN_FILE"])
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequest(
		http.MethodGet,
		gateway.RuntimeEnvironment()["VELA_AGENT_PROXY_URL"]+agentapi.BasePath+"/attachments/"+attachmentID,
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+string(tokenData))
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK || string(data) != "PNG" {
		t.Fatalf("attachment download = status %d body %q", response.StatusCode, data)
	}
}

func TestAdapterRefreshesNewDirectConversationBeforeDispatch(t *testing.T) {
	const (
		serverID = "0198fab7-e66f-70d4-982c-13d1abea2101"
		agentID  = "0198fab7-e670-7d41-9d9d-da6a1bea2102"
		humanID  = "0198fab7-e671-7171-9264-51081bea2103"
		directID = "0198fab7-e672-783f-b952-42ba1bea2104"
		groupID  = "an_dm_created_after_session"
	)
	now := time.Date(2026, 8, 18, 10, 0, 0, 0, time.UTC)
	directoryCalls := 0
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
		directoryCalls++
		directs := "[]"
		if directoryCalls > 1 {
			directs = fmt.Sprintf(
				`[{"id":%q,"peerMemberId":%q,"imGroupId":%q,"imState":"ready","revision":1}]`,
				directID,
				humanID,
				groupID,
			)
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
          "directConversations":%s,
          "revision":"sha256:delivery-refresh-%d","expiresAt":%q
        }`, serverID, agentID, agentID, agentID, agentID, humanID, humanID,
			directs, directoryCalls, now.Add(5*time.Minute).Format(time.RFC3339))
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
		AgentID: agentID, ServerID: serverID, RuntimeEpoch: "runtime-epoch-refresh",
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
		NewRuntimeEpoch: func() (string, error) { return "runtime-epoch-refresh", nil },
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
			ReplyPolicy: "mention_and_dm", RuntimeKind: "codex",
			Capabilities: []string{"read", "send", "server"},
		},
	}); err != nil {
		t.Fatal(err)
	}
	conversation, err := im.NewGroupConversation(groupID)
	if err != nil {
		t.Fatal(err)
	}
	reference, err := im.NewMessageRef(
		conversation, "message-direct-created-after-session", 1, now.UnixMilli(),
	)
	if err != nil {
		t.Fatal(err)
	}
	result, err := adapter.HandleIngressMessage(context.Background(), im.IncomingMessage{
		Ref: reference, SenderUserID: "human_alice",
		Elements: []im.Element{{Type: im.ElementText, Text: "现在能收到吗"}},
	})
	if err != nil || result.Disposition != ingress.RuntimeAccepted {
		t.Fatalf("HandleIngressMessage() = %#v, %v", result, err)
	}
	if directoryCalls != 2 {
		t.Fatalf("directory calls = %d, want 2", directoryCalls)
	}
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if len(manager.starts) != 1 || !strings.Contains(manager.starts[0].Prompt, `"target":"@alice"`) {
		t.Fatalf("runtime starts = %#v", manager.starts)
	}
}
