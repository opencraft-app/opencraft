package platform

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

const (
	directoryTestServerID  = "0198fa8c-8b2d-75bd-9321-80d4adbd1101"
	directoryTestAgentID   = "0198fa8c-8b2e-7221-ae50-dab5ac0d1102"
	directoryTestChannelID = "0198fa8c-8b2f-769c-81da-fc38f3241103"
	directoryTestHumanID   = "0198fa8c-8b30-7053-9daa-d9bc93dc1104"
)

func TestClientLoadsAndValidatesRuntimeDirectory(t *testing.T) {
	now := time.Date(2026, 8, 2, 18, 0, 0, 0, time.UTC)
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet || request.URL.Path != "/v1/runtime/directory" ||
			request.Header.Get("Authorization") != "Bearer runtime-token" {
			t.Fatalf("request = %s %s auth=%q", request.Method, request.URL.Path, request.Header.Get("Authorization"))
		}
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{
          "server":{"id":"` + directoryTestServerID + `","slug":"team","name":"研发"},
          "self":{"agentId":"` + directoryTestAgentID + `","memberId":"` + directoryTestAgentID + `","handle":"builder","displayName":"Builder","imUserId":"agent_builder"},
          "channels":[{"id":"` + directoryTestChannelID + `","name":"全员","visibility":"public","joined":true,"imGroupId":"community-1","imTopicId":null,"imState":"ready","revision":2}],
          "members":[
            {"memberId":"` + directoryTestAgentID + `","kind":"agent","humanId":null,"agentId":"` + directoryTestAgentID + `","handle":"builder","displayName":"Builder","imUserId":"agent_builder"},
            {"memberId":"` + directoryTestHumanID + `","kind":"human","humanId":"` + directoryTestHumanID + `","agentId":null,"handle":"alice","displayName":"Alice","imUserId":"human_alice"}
          ],
          "revision":"sha256:test-directory","expiresAt":"` + now.Add(2*time.Minute).Format(time.RFC3339) + `"
        }`))
	}))
	defer server.Close()
	client, err := NewClient(Config{
		BaseURL: server.URL, HTTPClient: server.Client(), AllowInsecureLoopback: true,
		Now: func() time.Time { return now }, MaxSessionTTL: 15 * time.Minute,
	})
	if err != nil {
		t.Fatal(err)
	}
	token, _ := NewAccessToken("runtime-token")

	got, err := client.GetRuntimeDirectory(
		context.Background(), token, directoryTestServerID, directoryTestAgentID,
	)
	if err != nil {
		t.Fatalf("GetRuntimeDirectory() error = %v", err)
	}
	if got.Server.ID != directoryTestServerID || got.Self.AgentID != directoryTestAgentID ||
		len(got.Channels) != 1 || got.Channels[0].ID != directoryTestChannelID ||
		len(got.Members) != 2 || got.Members[1].HumanID != directoryTestHumanID ||
		got.Revision != "sha256:test-directory" || !got.ExpiresAt.Equal(now.Add(2*time.Minute)) {
		t.Fatalf("GetRuntimeDirectory() = %#v", got)
	}
}

func TestClientRejectsDirectoryForDifferentRuntime(t *testing.T) {
	now := time.Date(2026, 8, 2, 18, 0, 0, 0, time.UTC)
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{
          "server":{"id":"0198fa8c-8b31-7efd-bb71-278477cc1105","slug":"other","name":"Other"},
          "self":{"agentId":"` + directoryTestAgentID + `","memberId":"` + directoryTestAgentID + `","handle":"builder","displayName":"Builder","imUserId":"agent_builder"},
          "channels":[],"members":[],"revision":"sha256:bad","expiresAt":"` + now.Add(time.Minute).Format(time.RFC3339) + `"
        }`))
	}))
	defer server.Close()
	client, err := NewClient(Config{
		BaseURL: server.URL, HTTPClient: server.Client(), AllowInsecureLoopback: true,
		Now: func() time.Time { return now }, MaxSessionTTL: 15 * time.Minute,
	})
	if err != nil {
		t.Fatal(err)
	}
	token, _ := NewAccessToken("runtime-token")
	if _, err := client.GetRuntimeDirectory(
		context.Background(), token, directoryTestServerID, directoryTestAgentID,
	); err != ErrInvalidRuntimeDirectory {
		t.Fatalf("GetRuntimeDirectory() error = %v", err)
	}
}

func TestClientLoadsAuthorizedRuntimeChannelMembers(t *testing.T) {
	now := time.Date(2026, 8, 2, 18, 30, 0, 0, time.UTC)
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet ||
			request.URL.Path != "/v1/runtime/channels/"+directoryTestChannelID+"/members" ||
			request.Header.Get("Authorization") != "Bearer runtime-token" {
			t.Fatalf("request = %s %s auth=%q", request.Method, request.URL.Path, request.Header.Get("Authorization"))
		}
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{
          "channel":{"id":"` + directoryTestChannelID + `","name":"全员","visibility":"public","joined":true,"imGroupId":"community-1","imTopicId":null,"imState":"ready","revision":2},
          "members":[
            {"memberId":"` + directoryTestAgentID + `","kind":"agent","humanId":null,"agentId":"` + directoryTestAgentID + `","handle":"builder","displayName":"Builder","imUserId":"agent_builder"},
            {"memberId":"` + directoryTestHumanID + `","kind":"human","humanId":"` + directoryTestHumanID + `","agentId":null,"handle":"alice","displayName":"Alice","imUserId":"human_alice"}
          ],
          "revision":"sha256:test-channel-members","expiresAt":"` + now.Add(2*time.Minute).Format(time.RFC3339) + `"
        }`))
	}))
	defer server.Close()
	client, err := NewClient(Config{
		BaseURL: server.URL, HTTPClient: server.Client(), AllowInsecureLoopback: true,
		Now: func() time.Time { return now }, MaxSessionTTL: 15 * time.Minute,
	})
	if err != nil {
		t.Fatal(err)
	}
	token, _ := NewAccessToken("runtime-token")

	got, err := client.GetRuntimeChannelMembers(
		context.Background(), token, directoryTestServerID,
		directoryTestAgentID, directoryTestChannelID,
	)
	if err != nil {
		t.Fatalf("GetRuntimeChannelMembers() error = %v", err)
	}
	if got.Channel.ID != directoryTestChannelID || len(got.Members) != 2 ||
		got.Members[1].HumanID != directoryTestHumanID ||
		got.Revision != "sha256:test-channel-members" ||
		!got.ExpiresAt.Equal(now.Add(2*time.Minute)) {
		t.Fatalf("GetRuntimeChannelMembers() = %#v", got)
	}
}
