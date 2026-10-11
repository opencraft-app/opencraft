package im

import (
	"encoding/json"
	"errors"
	"testing"
)

func TestConversationConstructorsKeepOnlyStableRoutingFields(t *testing.T) {
	t.Parallel()

	c2c, err := NewC2CConversation(" human_1 ")
	if err != nil {
		t.Fatal(err)
	}
	if c2c.Kind() != ConversationC2C ||
		c2c.PeerUserID() != "human_1" ||
		c2c.GroupID() != "" ||
		c2c.TopicID() != "" {
		t.Fatalf("c2c = %#v", c2c)
	}

	topic, err := NewTopicConversation("group_1", "topic_1")
	if err != nil {
		t.Fatal(err)
	}
	if topic.Kind() != ConversationTopic ||
		topic.GroupID() != "group_1" ||
		topic.TopicID() != "topic_1" {
		t.Fatalf("topic = %#v", topic)
	}

	if _, err := NewGroupConversation(" "); !errors.Is(
		err,
		ErrInvalidConversation,
	) {
		t.Fatalf("empty group error = %v", err)
	}
}

func TestMessageRefAndUserSigValidateAndRedact(t *testing.T) {
	t.Parallel()

	conversation, err := NewGroupConversation("group_1")
	if err != nil {
		t.Fatal(err)
	}
	reference, err := NewMessageRef(
		conversation,
		"message_1",
		7,
		1785398400000,
	)
	if err != nil {
		t.Fatal(err)
	}
	if reference.MessageID() != "message_1" ||
		reference.Sequence() != 7 ||
		reference.TimestampMS() != 1785398400000 {
		t.Fatalf("reference = %#v", reference)
	}

	userSig, err := NewUserSig("short-usersig")
	if err != nil {
		t.Fatal(err)
	}
	if userSig.String() != "[REDACTED]" ||
		userSig.GoString() != "[REDACTED]" ||
		userSig.Reveal() != "short-usersig" {
		t.Fatalf("UserSig redaction failed: %s", userSig)
	}
	if _, err := userSig.MarshalJSON(); !errors.Is(
		err,
		ErrSensitiveMarshal,
	) {
		t.Fatalf("MarshalJSON error = %v", err)
	}

	custom := SendCustomRequest{
		Conversation: conversation,
		CustomType:   "platform.task.v1",
		Data:         json.RawMessage(`{"resourceId":"task_1"}`),
	}
	if len(custom.Data) == 0 {
		t.Fatal("custom payload was lost")
	}
}
