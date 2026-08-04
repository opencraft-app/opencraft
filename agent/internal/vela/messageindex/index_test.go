package messageindex

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/vela/im"
)

func TestIndexPersistsBoundedMessageReferencesWithoutContent(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	index, err := New(root, 2)
	if err != nil {
		t.Fatal(err)
	}
	conversation, _ := im.NewGroupConversation("group-1")
	add := func(id string, sequence int64) {
		reference, refErr := im.NewMessageRef(
			conversation, id, sequence, time.Now().UnixMilli(),
		)
		if refErr != nil {
			t.Fatal(refErr)
		}
		if addErr := index.Add("#general", reference); addErr != nil {
			t.Fatal(addErr)
		}
	}
	add("aaaaaaaa-0001", 1)
	add("aaaaaaaa-0002", 2)
	if _, err := index.Resolve("aaaaaaaa", "#general"); !errors.Is(err, ErrAmbiguous) {
		t.Fatalf("ambiguous Resolve error = %v", err)
	}
	add("bbbbbbbb-0003", 3)

	reloaded, err := New(root, 2)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := reloaded.Resolve("aaaaaaaa-0001", "#general"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("evicted Resolve error = %v", err)
	}
	entry, err := reloaded.Resolve("bbbbbbbb", "#general")
	if err != nil {
		t.Fatal(err)
	}
	if entry.Ref.MessageID() != "bbbbbbbb-0003" || entry.Target != "#general" {
		t.Fatalf("entry = %#v", entry)
	}
	data, err := os.ReadFile(filepath.Join(root, indexRelativePath))
	if err != nil {
		t.Fatal(err)
	}
	if string(data) == "" || containsText(data, "message body") {
		t.Fatalf("unexpected persisted index = %s", data)
	}
}

func containsText(data []byte, value string) bool {
	for index := 0; index+len(value) <= len(data); index++ {
		if string(data[index:index+len(value)]) == value {
			return true
		}
	}
	return false
}
