package state

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/QuantumNous/new-api/common"
)

func TestStoreWritesModeRestrictedJSON(t *testing.T) {
	t.Parallel()

	root := filepath.Join(t.TempDir(), "state")
	store := New(root)
	want := map[string]string{"accessToken": "test_access"}
	if err := store.Write("computer/user-session.json", want); err != nil {
		t.Fatalf("Write() error = %v", err)
	}

	rootInfo, err := os.Stat(root)
	if err != nil {
		t.Fatal(err)
	}
	if got := rootInfo.Mode().Perm(); got != 0o700 {
		t.Fatalf("root mode = %o, want 700", got)
	}

	path := filepath.Join(root, "computer", "user-session.json")
	fileInfo, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := fileInfo.Mode().Perm(); got != 0o600 {
		t.Fatalf("file mode = %o, want 600", got)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]string
	if err := common.Unmarshal(data, &got); err != nil {
		t.Fatal(err)
	}
	if got["accessToken"] != want["accessToken"] {
		t.Fatalf("accessToken = %q, want %q", got["accessToken"], want["accessToken"])
	}
}

func TestStoreRejectsPathsOutsideRoot(t *testing.T) {
	t.Parallel()

	parent := t.TempDir()
	root := filepath.Join(parent, "state")
	store := New(root)
	for _, outside := range []string{
		filepath.Join(parent, "outside.json"),
		filepath.Join(parent, "absolute.json"),
	} {
		relative := "../outside.json"
		if filepath.Base(outside) == "absolute.json" {
			relative = outside
		}
		err := store.Write(relative, map[string]bool{"escaped": true})
		if err == nil {
			t.Fatalf("Write(%q) error = nil, want traversal rejection", relative)
		}
		if _, statErr := os.Stat(outside); !os.IsNotExist(statErr) {
			t.Fatalf("outside file %q stat error = %v, want not-exist", outside, statErr)
		}
	}
}

func TestStoreReadsWrittenJSON(t *testing.T) {
	t.Parallel()

	store := New(filepath.Join(t.TempDir(), "state"))
	type session struct {
		ServerURL string `json:"serverUrl"`
		UserID    string `json:"userId"`
	}
	want := session{ServerURL: "https://example.invalid", UserID: "user_test"}
	if err := store.Write("computer/user-session.json", want); err != nil {
		t.Fatal(err)
	}

	var got session
	if err := store.Read("computer/user-session.json", &got); err != nil {
		t.Fatalf("Read() error = %v", err)
	}
	if got != want {
		t.Fatalf("Read() = %#v, want %#v", got, want)
	}
}

func TestStoreRemoveRejectsTraversalAndDeletesOnlyRequestedFile(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	store := New(root)
	if err := store.Write("computer/session.json", map[string]string{"token": "test"}); err != nil {
		t.Fatal(err)
	}
	if err := store.Remove("../outside.json"); !errors.Is(err, ErrUnsafePath) {
		t.Fatalf("Remove traversal error = %v", err)
	}
	if err := store.Remove("computer/session.json"); err != nil {
		t.Fatal(err)
	}
	var destination map[string]string
	if err := store.Read("computer/session.json", &destination); !os.IsNotExist(err) {
		t.Fatalf("Read after Remove error = %v", err)
	}
}
