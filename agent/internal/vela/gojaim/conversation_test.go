package gojaim

import (
	"context"
	"testing"
	"time"

	"velachat/agent/internal/vela/im"
)

func TestConversationsIncludesZeroUnreadAndStableTitles(t *testing.T) {
	fake := &fakeCommandEngine{responses: map[string]any{
		"listConversations": map[string]any{
			"isSyncCompleted": true,
			"conversationList": []any{
				map[string]any{"conversationID": "C2Chuman-2", "unreadCount": int64(0), "userProfile": map[string]any{"nick": "李雷"}},
				map[string]any{"conversationID": "GROUPgroup-1", "unreadCount": int64(3), "groupProfile": map[string]any{"name": "研发"}},
			},
		},
	}}
	transport := &Transport{
		config: TransportConfig{RequestTimeout: time.Second},
		engine: fake,
		events: make(chan im.Event, 1),
	}
	snapshot, err := transport.Conversations(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !snapshot.IsSyncCompleted || len(snapshot.Items) != 2 || snapshot.Items[0].UnreadCount != 0 || snapshot.Items[0].Title != "李雷" || snapshot.Items[1].Title != "研发" {
		t.Fatalf("snapshot = %#v", snapshot)
	}
}

func TestConversationUpdateEventProjectsCompleteConversationDTOs(t *testing.T) {
	transport := &Transport{}
	events := transport.projectRuntimeEvent(RuntimeEvent{
		Type: "conversation_updated",
		Data: []any{
			map[string]any{
				"conversationID": "C2Chuman-2",
				"unreadCount":    int64(0),
				"userProfile":    map[string]any{"nick": "李雷"},
			},
			map[string]any{
				"conversationID": "GROUPgroup-1",
				"unreadCount":    int64(3),
				"groupProfile":   map[string]any{"name": "研发"},
			},
		},
	}, im.Session{LaunchID: "launch-1"})

	if len(events) != 1 || events[0].Type != im.EventConversationUpdated {
		t.Fatalf("events = %#v, want one conversation update", events)
	}
	if got := events[0].Conversations; len(got) != 2 ||
		got[0].UnreadCount != 0 || got[0].Title != "李雷" ||
		got[1].UnreadCount != 3 || got[1].Title != "研发" {
		t.Fatalf("conversations = %#v", got)
	}
}
