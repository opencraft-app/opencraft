package cmd

import (
	"encoding/binary"
	"encoding/json"
	"testing"
	"time"

	"github.com/juicedata/juicefs/pkg/meta"
)

func TestLitestreamMaintenanceMessageIncludesControlPayload(t *testing.T) {
	opts := meta.LitestreamMaintenanceOptions{
		Snapshot:                 true,
		CompactLevel:             1,
		EnforceSnapshotRetention: true,
		SnapshotRetention:        5 * time.Minute,
		EnforceL0Retention:       true,
		L0Retention:              0,
	}
	msg, err := litestreamMaintenanceMessage(opts)
	if err != nil {
		t.Fatal(err)
	}
	if got := binary.BigEndian.Uint32(msg[0:4]); got != meta.LitestreamMaintenance {
		t.Fatalf("cmd = %d, want %d", got, meta.LitestreamMaintenance)
	}
	payloadSize := binary.BigEndian.Uint32(msg[4:8])
	if payloadSize == 0 {
		t.Fatal("payload size should be non-zero")
	}
	if int(payloadSize) != len(msg)-8 {
		t.Fatalf("payload size = %d, message payload length = %d", payloadSize, len(msg)-8)
	}
	var got meta.LitestreamMaintenanceOptions
	if err := json.Unmarshal(msg[8:], &got); err != nil {
		t.Fatal(err)
	}
	if got != opts {
		t.Fatalf("opts = %+v, want %+v", got, opts)
	}
}
