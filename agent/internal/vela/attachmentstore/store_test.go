package attachmentstore

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/vela/im"
)

func TestStoreStagesCompletesAndRecoversAttachment(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	store, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	record, err := store.Stage(
		"channel-1", "#general", "说明.txt", "text/plain", []byte("你好"),
	)
	if err != nil {
		t.Fatal(err)
	}
	if record.ID == "" || record.State != StatePending || record.SizeBytes != 6 {
		t.Fatalf("staged record = %#v", record)
	}
	loaded, data, err := store.Pending(record.ID)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Target != "#general" || string(data) != "你好" {
		t.Fatalf("pending = %#v %q", loaded, data)
	}
	info, err := os.Stat(filepath.Join(root, "attachments", "pending", record.ID+".bin"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("pending mode = %o", info.Mode().Perm())
	}

	completed, err := store.Complete(record.ID, "message-1", im.Attachment{
		ID: "tencent-file-1", Filename: "说明.txt", MIMEType: "text/plain",
		SizeBytes: 6, URL: "https://cos.ap-shanghai.myqcloud.com/tencent-file-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if completed.State != StateRemote || completed.MessageID != "message-1" ||
		completed.TencentFileID != "tencent-file-1" {
		t.Fatalf("completed = %#v", completed)
	}
	if _, _, err := store.Pending(record.ID); !errors.Is(err, ErrNotPending) {
		t.Fatalf("Pending after Complete error = %v", err)
	}

	reopened, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	remote, err := reopened.Remote(record.ID)
	if err != nil {
		t.Fatal(err)
	}
	if remote.URL != completed.URL || remote.Target != "#general" {
		t.Fatalf("recovered remote = %#v", remote)
	}
}

func TestStoreRememberUsesStableOpaqueID(t *testing.T) {
	t.Parallel()
	store, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	attachment := im.Attachment{
		ID: "unsafe/tencent/file", Filename: "report.pdf",
		MIMEType: "application/pdf", SizeBytes: 12,
		URL: "https://cos.ap-shanghai.myqcloud.com/file",
	}
	first, err := store.Remember("channel-1", "#general", "message-1", attachment)
	if err != nil {
		t.Fatal(err)
	}
	second, err := store.Remember("channel-1", "#general", "message-1", attachment)
	if err != nil {
		t.Fatal(err)
	}
	if first.ID != second.ID || len(first.ID) < 20 || first.ID[:4] != "att_" ||
		first.ID == attachment.ID || first.Direction != DirectionIncoming {
		t.Fatalf("remembered IDs = %q %q", first.ID, second.ID)
	}
	if _, err := store.Sent(first.ID); !errors.Is(err, ErrNotSent) {
		t.Fatalf("incoming attachment Sent error = %v", err)
	}
}

func TestStoreRememberRefreshesRotatingSignedURLIdempotently(t *testing.T) {
	t.Parallel()
	store, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	attachment := im.Attachment{
		ID: "tencent-file-1", Filename: "report.pdf",
		MIMEType: "application/octet-stream", SizeBytes: 12,
		URL: "https://1600000000-cn.rich.my-imcloud.com/download/file?auth=first",
	}
	first, err := store.Remember("channel-1", "#general", "message-1", attachment)
	if err != nil {
		t.Fatal(err)
	}
	attachment.URL = "https://1600000000-cn.rich.my-imcloud.com/download/file?auth=second"
	attachment.MIMEType = "application/pdf"
	second, err := store.Remember("channel-1", "#general", "message-1", attachment)
	if err != nil {
		t.Fatal(err)
	}
	if second.ID != first.ID || second.URL != attachment.URL ||
		second.MIMEType != "application/pdf" {
		t.Fatalf("refreshed record = %#v, first = %#v", second, first)
	}
	loaded, err := store.Remote(first.ID)
	if err != nil || loaded.URL != attachment.URL ||
		loaded.MIMEType != "application/pdf" {
		t.Fatalf("persisted refreshed record = (%#v, %v)", loaded, err)
	}
	attachment.SizeBytes++
	if _, err := store.Remember(
		"channel-1", "#general", "message-1", attachment,
	); !errors.Is(err, ErrConflict) {
		t.Fatalf("changed attachment identity error = %v", err)
	}
}

func TestStoreRejectsOversizedAndInvalidAttachments(t *testing.T) {
	t.Parallel()
	store, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Stage("", "#general", "a.txt", "text/plain", []byte("a")); !errors.Is(err, ErrInvalidAttachment) {
		t.Fatalf("invalid Stage error = %v", err)
	}
	if _, err := store.Stage(
		"channel-1", "#general", "a.bin", "application/octet-stream",
		make([]byte, MaxAttachmentBytes+1),
	); !errors.Is(err, ErrAttachmentTooLarge) {
		t.Fatalf("oversized Stage error = %v", err)
	}
}
