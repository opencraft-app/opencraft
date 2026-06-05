package channel

import "testing"

func TestBuildSessionKeyIsolatesGroupUsersWhenConfigured(t *testing.T) {
	msg := Message{
		ChannelType:            TypeWeCom,
		ChatType:               ChatGroup,
		ExternalConversationID: "group-1",
		ExternalUserID:         "user-a",
	}
	got := BuildSessionKey("main", msg, true, false)
	want := "agent:main:wecom:group:group-1:user-a"
	if got != want {
		t.Fatalf("unexpected session key: got %q want %q", got, want)
	}
}

func TestBuildSessionKeyDoesNotIsolateDMByUser(t *testing.T) {
	msg := Message{
		ChannelType:            TypeWeCom,
		ChatType:               ChatDM,
		ExternalConversationID: "user-a",
		ExternalUserID:         "user-a",
	}
	got := BuildSessionKey("main", msg, true, false)
	want := "agent:main:wecom:dm:user-a"
	if got != want {
		t.Fatalf("unexpected session key: got %q want %q", got, want)
	}
}

func TestBuildSessionKeyThreadCanBeSharedAcrossGroupUsers(t *testing.T) {
	msg := Message{
		ChannelType:            TypeWeCom,
		ChatType:               ChatGroup,
		ExternalConversationID: "group-1",
		ThreadID:               "thread-1",
		ExternalUserID:         "user-a",
	}
	got := BuildSessionKey("main", msg, true, false)
	want := "agent:main:wecom:group:group-1:thread-1"
	if got != want {
		t.Fatalf("unexpected session key: got %q want %q", got, want)
	}
}
