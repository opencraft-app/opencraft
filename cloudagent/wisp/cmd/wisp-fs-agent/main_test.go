package main

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestWriteRawPathWritesBinaryContentAtomically(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "nested", "artifact.bin")
	content := []byte{0, 1, 2, 3, 255, 'o', 'k'}

	oldStdin := os.Stdin
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stdin = reader
	defer func() { os.Stdin = oldStdin }()
	if _, err := writer.Write(content); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}

	if err := writeRawPath(target, "0755"); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, content) {
		t.Fatalf("content = %v, want %v", got, content)
	}
	info, err := os.Stat(target)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o755 {
		t.Fatalf("mode = %v, want 0755", info.Mode().Perm())
	}
}
