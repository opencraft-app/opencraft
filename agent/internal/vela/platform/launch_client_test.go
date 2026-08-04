package platform

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"velachat/agent/internal/common"
	"velachat/agent/internal/vela/daemon"
)

func TestComputerClientAllocatesAndRefreshesServerFencedLaunch(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 8, 1, 13, 30, 0, 0, time.UTC)
	launchID := "01989c24-7540-7f12-a27b-c83243215dda"
	predecessor := "01989c24-7540-7f12-a27b-c83243215ddc"
	assignment := daemon.AgentAssignment{
		AgentID: computerTestAgentID, ServerID: computerTestServerID,
		DesiredState: daemon.DesiredRunning, ConfigGeneration: 3,
		CredentialVersion: 2, Runtime: daemon.RuntimeConfig{Kind: "codex"},
		ReplyPolicy: "mention_and_dm",
	}
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		requests++
		if request.Header.Get("Authorization") != "Bearer computer-short-token" {
			t.Fatalf("authorization = %q", request.Header.Get("Authorization"))
		}
		switch request.URL.Path {
		case "/v1/computer/agents/" + computerTestAgentID + "/launches":
			var body ComputerAgentLaunchRequest
			if err := common.DecodeJson(request.Body, &body); err != nil {
				t.Fatal(err)
			}
			if body.LaunchID != launchID || body.PredecessorLaunchID == nil ||
				*body.PredecessorLaunchID != predecessor ||
				body.AssignmentEpoch != computerTestEpoch ||
				body.AssignmentRevision != 9 || body.ConfigGeneration != 3 ||
				body.CredentialVersion != 2 {
				t.Fatalf("launch request = %#v", body)
			}
			response.WriteHeader(http.StatusCreated)
			writeComputerJSON(t, response, map[string]any{
				"launch": map[string]any{
					"launchId": launchID, "assignmentEpoch": computerTestEpoch,
					"configGeneration": 3, "credentialVersion": 2,
					"attempt": 7, "issuedAt": now,
				},
				"session": launchSessionPayload(now),
			})
		case "/v1/computer/agents/" + computerTestAgentID + "/launches/" + launchID + "/session":
			var body ComputerAgentSessionRefreshRequest
			if err := common.DecodeJson(request.Body, &body); err != nil {
				t.Fatal(err)
			}
			if body.AssignmentEpoch != computerTestEpoch ||
				body.ConfigGeneration != 3 || body.CredentialVersion != 2 ||
				body.Attempt != 7 {
				t.Fatalf("refresh request = %#v", body)
			}
			writeComputerJSON(t, response, launchSessionPayload(now))
		default:
			http.NotFound(response, request)
		}
	}))
	defer server.Close()

	client, err := NewClient(Config{
		BaseURL: server.URL + "/v1", Now: func() time.Time { return now },
		MaxSessionTTL: 24 * time.Hour, AllowInsecureLoopback: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	token, err := newComputerAccessToken("computer-short-token")
	if err != nil {
		t.Fatal(err)
	}
	allocated, err := client.CreateComputerAgentLaunch(
		context.Background(), token,
		ComputerAgentLaunchRequest{
			LaunchID: launchID, PredecessorLaunchID: &predecessor,
			AssignmentEpoch: computerTestEpoch, AssignmentRevision: 9,
			ConfigGeneration: 3, CredentialVersion: 2,
		},
		assignment,
	)
	if err != nil {
		t.Fatal(err)
	}
	if allocated.Fence.LaunchID != launchID || allocated.Fence.Attempt != 7 ||
		allocated.Session.Agent.ID != computerTestAgentID {
		t.Fatalf("allocated = %#v", allocated)
	}
	refreshed, err := client.RefreshComputerAgentLaunchSession(
		context.Background(), token, allocated.Fence, assignment,
	)
	if err != nil {
		t.Fatal(err)
	}
	if refreshed.Agent.ID != computerTestAgentID || requests != 2 {
		t.Fatalf("refreshed = %#v requests=%d", refreshed, requests)
	}
}

func launchSessionPayload(now time.Time) map[string]any {
	return map[string]any{
		"accessToken": "agent-short-token", "expiresAt": now.Add(15 * time.Minute),
		"agent": map[string]any{
			"id": computerTestAgentID, "serverId": computerTestServerID,
			"userId":       "im_agent_fixture",
			"capabilities": []string{"read", "send", "server", "tasks"},
			"replyPolicy":  "mention_and_dm",
			"runtime":      map[string]any{"kind": "codex", "model": nil},
		},
		"im": map[string]any{
			"sdkAppId": 1600000000, "userId": "im_agent_fixture",
			"userSig": "user-sig-fixture", "expiresAt": now.Add(15 * time.Minute),
		},
	}
}
