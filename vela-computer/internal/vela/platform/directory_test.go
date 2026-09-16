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
	directoryTestDirectID  = "0198fa8c-8b31-7053-9daa-d9bc93dc1105"
)

func TestClientLoadsAndValidatesRuntimeDirectory(t *testing.T) {
	now := time.Date(2026, 8, 2, 18, 0, 0, 0, time.UTC)
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet || request.URL.Path != "/v1/runtime/directory-v2" ||
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
          "directConversations":[
            {"id":"` + directoryTestDirectID + `","peerMemberId":"` + directoryTestHumanID + `","imGroupId":"an_dm_authorized","imState":"ready","revision":3}
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
		len(got.DirectConversations) != 1 ||
		got.DirectConversations[0].ID != directoryTestDirectID ||
		got.DirectConversations[0].PeerMemberID != directoryTestHumanID ||
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

func TestClientFallsBackToLegacyRuntimeDirectory(t *testing.T) {
	now := time.Date(2026, 8, 2, 18, 15, 0, 0, time.UTC)
	paths := make([]string, 0, 2)
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		paths = append(paths, request.URL.Path)
		if request.URL.Path == "/v1/runtime/directory-v2" {
			http.NotFound(response, request)
			return
		}
		if request.URL.Path != "/v1/runtime/directory" {
			t.Fatalf("request path = %q", request.URL.Path)
		}
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{
          "server":{"id":"` + directoryTestServerID + `","slug":"team","name":"研发"},
          "self":{"agentId":"` + directoryTestAgentID + `","memberId":"` + directoryTestAgentID + `","handle":"builder","displayName":"Builder","imUserId":"agent_builder"},
          "channels":[],
          "members":[{"memberId":"` + directoryTestAgentID + `","kind":"agent","humanId":null,"agentId":"` + directoryTestAgentID + `","handle":"builder","displayName":"Builder","imUserId":"agent_builder"}],
          "revision":"sha256:legacy-directory","expiresAt":"` + now.Add(2*time.Minute).Format(time.RFC3339) + `"
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
	if err != nil || len(got.DirectConversations) != 0 || len(paths) != 2 ||
		paths[0] != "/v1/runtime/directory-v2" ||
		paths[1] != "/v1/runtime/directory" {
		t.Fatalf("GetRuntimeDirectory() = (%#v, %v), paths=%#v", got, err, paths)
	}
}

func TestClientRejectsV2DirectoryWithoutDirectConversations(t *testing.T) {
	now := time.Date(2026, 8, 2, 18, 20, 0, 0, time.UTC)
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{
          "server":{"id":"` + directoryTestServerID + `","slug":"team","name":"研发"},
          "self":{"agentId":"` + directoryTestAgentID + `","memberId":"` + directoryTestAgentID + `","handle":"builder","displayName":"Builder","imUserId":"agent_builder"},
          "channels":[],
          "members":[{"memberId":"` + directoryTestAgentID + `","kind":"agent","humanId":null,"agentId":"` + directoryTestAgentID + `","handle":"builder","displayName":"Builder","imUserId":"agent_builder"}],
          "revision":"sha256:missing-directs","expiresAt":"` + now.Add(2*time.Minute).Format(time.RFC3339) + `"
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

func TestClientRejectsInvalidDirectConversationAuthorization(t *testing.T) {
	now := time.Date(2026, 8, 2, 18, 25, 0, 0, time.UTC)
	otherPeerID := "0198fa8c-8b32-7053-9daa-d9bc93dc1106"
	otherDirectID := "0198fa8c-8b33-7053-9daa-d9bc93dc1107"
	tests := []struct {
		name    string
		directs string
	}{
		{
			name: "unknown peer",
			directs: `[{"id":"` + directoryTestDirectID + `","peerMemberId":"` +
				otherPeerID + `","imGroupId":"an_dm_unknown","imState":"ready","revision":1}]`,
		},
		{
			name: "self peer",
			directs: `[{"id":"` + directoryTestDirectID + `","peerMemberId":"` +
				directoryTestAgentID + `","imGroupId":"an_dm_self","imState":"ready","revision":1}]`,
		},
		{
			name: "duplicate peer",
			directs: `[` +
				`{"id":"` + directoryTestDirectID + `","peerMemberId":"` + directoryTestHumanID + `","imGroupId":"an_dm_one","imState":"ready","revision":1},` +
				`{"id":"` + otherDirectID + `","peerMemberId":"` + directoryTestHumanID + `","imGroupId":"an_dm_two","imState":"ready","revision":1}` +
				`]`,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
				response.Header().Set("Content-Type", "application/json")
				_, _ = response.Write([]byte(`{
                  "server":{"id":"` + directoryTestServerID + `","slug":"team","name":"研发"},
                  "self":{"agentId":"` + directoryTestAgentID + `","memberId":"` + directoryTestAgentID + `","handle":"builder","displayName":"Builder","imUserId":"agent_builder"},
                  "channels":[],
                  "members":[
                    {"memberId":"` + directoryTestAgentID + `","kind":"agent","humanId":null,"agentId":"` + directoryTestAgentID + `","handle":"builder","displayName":"Builder","imUserId":"agent_builder"},
                    {"memberId":"` + directoryTestHumanID + `","kind":"human","humanId":"` + directoryTestHumanID + `","agentId":null,"handle":"alice","displayName":"Alice","imUserId":"human_alice"}
                  ],
                  "directConversations":` + test.directs + `,
                  "revision":"sha256:invalid-directs","expiresAt":"` + now.Add(2*time.Minute).Format(time.RFC3339) + `"
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
		})
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
