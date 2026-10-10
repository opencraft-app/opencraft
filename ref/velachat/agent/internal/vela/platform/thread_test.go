package platform

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"velachat/agent/internal/common"
)

const (
	threadTestServerID  = "0198fb26-0dd1-7503-9729-0483f4172101"
	threadTestAgentID   = "0198fb26-0dd2-7305-bdf0-7eecf7522102"
	threadTestChannelID = "0198fb26-0dd3-7104-9fe2-780cdfaf2103"
	threadTestThreadID  = "0198fb26-0dd4-7ced-8df0-e9f7af5a2104"
	threadTestReplyID   = "0198fb26-0dd5-705d-bfe4-dd4272102105"
)

func TestClientResolvesAndRegistersRuntimeThreadReferences(t *testing.T) {
	now := time.Date(2026, 8, 2, 19, 30, 0, 0, time.UTC)
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer runtime-token" {
			t.Fatalf("Authorization = %q", request.Header.Get("Authorization"))
		}
		var body struct {
			ChannelID string                  `json:"channelId"`
			Root      runtimeThreadRefPayload `json:"rootMessageRef"`
			Reply     runtimeThreadRefPayload `json:"messageRef"`
		}
		if err := common.DecodeJson(request.Body, &body); err != nil {
			t.Fatal(err)
		}
		response.Header().Set("Content-Type", "application/json")
		switch {
		case request.Method == http.MethodPost && request.URL.Path == "/v1/runtime/threads:resolve":
			if request.Header.Get("Idempotency-Key") != "resolve-thread-1" ||
				body.ChannelID != threadTestChannelID || body.Root.MessageID != "root-message" {
				t.Fatalf("resolve request body=%#v headers=%#v", body, request.Header)
			}
			_, _ = response.Write([]byte(`{
              "id":"` + threadTestThreadID + `","serverId":"` + threadTestServerID + `","channelId":"` + threadTestChannelID + `",
              "rootMessageRef":{"kind":"group","messageId":"root-message","groupId":"community-1","topicId":"topic-general","senderUserId":"human_alice","sequence":42,"timestamp":1785699000},
              "replyCount":0,"unreadCount":0,"lastReplyAt":null,"createdAt":"` + now.Format(time.RFC3339) + `"
            }`))
		case request.Method == http.MethodPost && request.URL.Path == "/v1/runtime/threads/"+threadTestThreadID+"/replies":
			if request.Header.Get("Idempotency-Key") != "register-reply-1" ||
				body.ChannelID != threadTestChannelID || body.Reply.MessageID != "reply-message" {
				t.Fatalf("reply request body=%#v headers=%#v", body, request.Header)
			}
			response.WriteHeader(http.StatusCreated)
			_, _ = response.Write([]byte(`{
              "id":"` + threadTestReplyID + `","threadId":"` + threadTestThreadID + `",
              "messageRef":{"kind":"group","messageId":"reply-message","groupId":"community-1","topicId":"topic-general","senderUserId":"agent_builder","sequence":43,"timestamp":1785699001},
              "createdAt":"` + now.Add(time.Second).Format(time.RFC3339) + `"
            }`))
		default:
			http.NotFound(response, request)
		}
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
	root := ThreadMessageRef{
		Kind: "group", MessageID: "root-message", GroupID: "community-1",
		TopicID: "topic-general", SenderUserID: "human_alice",
		Sequence: 42, Timestamp: 1785699000,
	}
	thread, err := client.ResolveRuntimeThread(
		context.Background(), token, threadTestServerID, threadTestChannelID,
		root, "resolve-thread-1",
	)
	if err != nil || thread.ID != threadTestThreadID ||
		thread.RootMessageRef.MessageID != "root-message" {
		t.Fatalf("ResolveRuntimeThread() = (%#v, %v)", thread, err)
	}
	reply := root
	reply.MessageID = "reply-message"
	reply.SenderUserID = "agent_builder"
	reply.Sequence = 43
	reply.Timestamp = 1785699001
	registered, err := client.RegisterRuntimeThreadReply(
		context.Background(), token, threadTestChannelID, threadTestThreadID,
		reply, "register-reply-1",
	)
	if err != nil || registered.ID != threadTestReplyID ||
		registered.MessageRef.MessageID != "reply-message" {
		t.Fatalf("RegisterRuntimeThreadReply() = (%#v, %v)", registered, err)
	}
}
