package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRunRejectsUnpinnedLiteChatInput(t *testing.T) {
	input := filepath.Join(t.TempDir(), "professional.js")
	if err := os.WriteFile(
		input,
		[]byte(strings.Repeat("x", 100_001)),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	err := run(input, filepath.Join(t.TempDir(), "upload.js"), filepath.Join(t.TempDir(), "bundle.js"))
	if err == nil || !strings.Contains(err.Error(), "SHA-256 mismatch") {
		t.Fatalf("run error = %v, want SHA-256 mismatch", err)
	}
}

func TestRunRejectsUnpinnedUploadPlugin(t *testing.T) {
	err := validateUploadPlugin([]byte("not the pinned plugin"))
	if err == nil || !strings.Contains(err.Error(), "upload plugin SHA-256 mismatch") {
		t.Fatalf("validateUploadPlugin error = %v, want SHA-256 mismatch", err)
	}
}
