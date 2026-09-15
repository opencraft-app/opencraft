package workspaces

import (
	"path/filepath"
	"testing"
)

func TestAttachmentResolverSelectsExactlyOnePrincipal(t *testing.T) {
	root := filepath.Join(t.TempDir(), "users")
	resolver, err := PrincipalAttachmentResolver(root)
	if err != nil {
		t.Fatal(err)
	}
	got, err := resolver(Principal{ID: "principal-1", Username: "skipzhang"})
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(root, PrincipalHomeSegment("skipzhang"), ".codex", "attachments")
	if got != want || got == root {
		t.Fatalf("unexpected attachment capability: got=%q want=%q", got, want)
	}
}
