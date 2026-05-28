package cmd

import (
	"encoding/binary"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/juicedata/juicefs/pkg/meta"
)

func TestWaitWritebackStagingCompleteReturnsWhenMissingOrEmpty(t *testing.T) {
	if err := waitWritebackStagingComplete(filepath.Join(t.TempDir(), "missing"), time.Second, time.Millisecond, false); err != nil {
		t.Fatalf("missing staging dir should be treated as drained: %v", err)
	}

	staging := filepath.Join(t.TempDir(), "rawstaging")
	if err := os.MkdirAll(staging, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := waitWritebackStagingComplete(staging, time.Second, time.Millisecond, false); err != nil {
		t.Fatalf("empty staging dir should be drained: %v", err)
	}
}

func TestWaitWritebackStagingCompleteTimeoutReportsLeftBytes(t *testing.T) {
	staging := filepath.Join(t.TempDir(), "rawstaging")
	if err := os.MkdirAll(staging, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(staging, "chunk"), []byte("pending"), 0o644); err != nil {
		t.Fatal(err)
	}

	err := waitWritebackStagingComplete(staging, time.Millisecond, time.Millisecond, false)
	if err == nil {
		t.Fatal("expected timeout while staging chunk remains")
	}
	if !strings.Contains(err.Error(), "timed out waiting for writeback staging chunks") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestWritebackCutBarrierMessageIncludesControlPayloadSize(t *testing.T) {
	msg := writebackCutBarrierMessage(120*time.Second, 30*time.Millisecond)
	if len(msg) != 24 {
		t.Fatalf("message length = %d, want 24", len(msg))
	}
	if got := binary.BigEndian.Uint32(msg[0:4]); got != meta.WritebackCutBarrier {
		t.Fatalf("cmd = %d, want %d", got, meta.WritebackCutBarrier)
	}
	if got := binary.BigEndian.Uint32(msg[4:8]); got != 16 {
		t.Fatalf("payload size = %d, want 16", got)
	}
	if got := time.Duration(binary.BigEndian.Uint64(msg[8:16])); got != 120*time.Second {
		t.Fatalf("timeout = %s", got)
	}
	if got := time.Duration(binary.BigEndian.Uint64(msg[16:24])); got != 30*time.Millisecond {
		t.Fatalf("poll interval = %s", got)
	}
}
