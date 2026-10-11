package tencentim

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestResourceDeriverMatchesFrozenCommunityFixture(t *testing.T) {
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve current file")
	}
	fixturePath := filepath.Join(
		filepath.Dir(currentFile),
		"..", "..", "..",
		"platform", "v1", "fixtures", "internal",
		"im-resource-identifiers.v1.json",
	)
	data, err := os.ReadFile(fixturePath)
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var fixture struct {
		Key       string `json:"fixtureHmacKeyUtf8"`
		ServerID  string `json:"serverId"`
		ChannelID string `json:"channelId"`
		GroupID   string `json:"imGroupId"`
		TopicID   string `json:"imTopicId"`
		TopicName string `json:"imTopicName"`
	}
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatalf("decode fixture: %v", err)
	}

	deriver, err := NewResourceDeriver([]byte(fixture.Key))
	if err != nil {
		t.Fatalf("NewResourceDeriver() error = %v", err)
	}
	groupID, err := deriver.CommunityGroupID(fixture.ServerID)
	if err != nil {
		t.Fatalf("CommunityGroupID() error = %v", err)
	}
	if groupID != fixture.GroupID {
		t.Fatalf("CommunityGroupID() = %q, want %q", groupID, fixture.GroupID)
	}
	topicID, topicName, err := deriver.Topic(
		fixture.ServerID,
		fixture.ChannelID,
		groupID,
	)
	if err != nil {
		t.Fatalf("Topic() error = %v", err)
	}
	if topicID != fixture.TopicID || topicName != fixture.TopicName {
		t.Fatalf(
			"Topic() = (%q, %q), want (%q, %q)",
			topicID,
			topicName,
			fixture.TopicID,
			fixture.TopicName,
		)
	}
}

func TestResourceDeriverRejectsUnsafeKeyAndNonUUIDv7(t *testing.T) {
	if _, err := NewResourceDeriver([]byte("short")); err == nil {
		t.Fatal("NewResourceDeriver(short key) error = nil")
	}
	deriver, err := NewResourceDeriver(
		[]byte("0123456789abcdef0123456789abcdef"),
	)
	if err != nil {
		t.Fatal(err)
	}
	for _, serverID := range []string{
		"",
		"not-a-uuid",
		"0198f4c2-7a31-6c91-a6d2-7d76f9188c38",
	} {
		if _, err := deriver.CommunityGroupID(serverID); err == nil {
			t.Fatalf("CommunityGroupID(%q) error = nil", serverID)
		}
	}
	if _, _, err := deriver.Topic(
		"0198f4c2-7a31-7c91-a6d2-7d76f9188c38",
		"not-a-uuid",
		"@TGS#_C_invalid",
	); err == nil {
		t.Fatal("Topic(invalid channel) error = nil")
	}
}

func TestResourceDeriverCreatesServerScopedDirectGroupID(t *testing.T) {
	deriver, err := NewResourceDeriver(
		[]byte("0123456789abcdef0123456789abcdef"),
	)
	if err != nil {
		t.Fatal(err)
	}
	serverID := "0198f4c2-7a31-7c91-a6d2-7d76f9188c38"
	directID := "0198f4c2-7a32-7c91-a6d2-7d76f9188c39"
	first, err := deriver.DirectGroupID(serverID, directID)
	if err != nil {
		t.Fatal(err)
	}
	second, err := deriver.DirectGroupID(serverID, directID)
	if err != nil {
		t.Fatal(err)
	}
	if first != second || len(first) != len("an_dm_")+26 || first[:len("an_dm_")] != "an_dm_" {
		t.Fatalf("DirectGroupID() = %q, repeated = %q", first, second)
	}
	if strings.HasPrefix(first, "@TGS#") {
		t.Fatalf("DirectGroupID() uses Tencent reserved prefix: %q", first)
	}
	other, err := deriver.DirectGroupID(
		"0198f4c2-7a33-7c91-a6d2-7d76f9188c40",
		directID,
	)
	if err != nil {
		t.Fatal(err)
	}
	if other == first {
		t.Fatal("same DirectConversation ID in another Server reused GroupID")
	}
	if _, err := deriver.DirectGroupID(serverID, "not-a-uuid"); err == nil {
		t.Fatal("DirectGroupID(invalid direct id) error = nil")
	}
}
