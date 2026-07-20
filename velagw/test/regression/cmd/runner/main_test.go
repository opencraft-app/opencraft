package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWriteTerminationSummaryIsSingleLineAndBounded(t *testing.T) {
	path := filepath.Join(t.TempDir(), "termination.log")
	value := "status=failed\nerror=" + strings.Repeat("x", 5000)
	if err := writeTerminationSummary(path, value); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "\n") || len(raw) > maxTerminationSummaryBytes {
		t.Fatalf("termination summary length=%d value=%q", len(raw), raw)
	}
}
