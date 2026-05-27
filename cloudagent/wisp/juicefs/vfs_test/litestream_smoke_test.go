//go:build litestreamvfs && vfs

package vfs_test

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"github.com/juicedata/juicefs/pkg/meta"
)

func TestLitestreamCOSCheckpointSmoke(t *testing.T) {
	if os.Getenv("RUN_LITESTREAM_COS_SMOKE") != "1" {
		t.Skip("set RUN_LITESTREAM_COS_SMOKE=1 to run the real object-store smoke test")
	}
	if os.Getenv("COS_BUCKET") == "" || os.Getenv("COS_REGION") == "" || os.Getenv("COS_ENDPOINT") == "" {
		t.Skip("COS_* environment is required")
	}

	workdir := t.TempDir()
	dbPath := filepath.Join(workdir, "meta.db")
	remotePath := fmt.Sprintf("juicefs/litestream-smoke/%d/meta.db", time.Now().UnixNano())
	syncInterval := os.Getenv("LITESTREAM_SMOKE_SYNC_INTERVAL")
	if syncInterval == "" {
		syncInterval = "100ms"
	}
	replicaURL := os.Getenv("LITESTREAM_SMOKE_REPLICA_URL")
	var uri string
	if replicaURL != "" {
		uri = fmt.Sprintf("sqlite3://%s?litestream_write=true&litestream_replica_url=%s&litestream_sync_interval=%s&litestream_barrier_timeout=60s", dbPath, url.QueryEscape(replicaURL), url.QueryEscape(syncInterval))
	} else {
		uri = fmt.Sprintf("sqlite3://%s?litestream_write=true&litestream_path=%s&litestream_sync_interval=%s&litestream_barrier_timeout=60s", dbPath, remotePath, url.QueryEscape(syncInterval))
	}

	m := meta.NewClient(uri, meta.DefaultConf())
	defer func() { _ = m.Shutdown() }()

	format := &meta.Format{Name: "litestream-smoke", DirStats: true}
	if err := m.Init(format, true); err != nil {
		t.Fatalf("init meta: %v", err)
	}
	if err := m.NewSession(true); err != nil {
		t.Fatalf("new session: %v", err)
	}

	ctx := meta.NewContext(1, 0, []uint32{0})
	var dirIno, fileIno meta.Ino
	var dirAttr, fileAttr meta.Attr
	if st := m.Mkdir(ctx, 1, "smoke", 0o755, 0, 0, &dirIno, &dirAttr); st != 0 {
		t.Fatalf("mkdir smoke: %v", st)
	}
	if st := m.Create(ctx, dirIno, "hello.txt", 0o644, 0, 0, &fileIno, &fileAttr); st != 0 {
		t.Fatalf("create file: %v", st)
	}
	if st := m.SetXattr(ctx, fileIno, "user.smoke", []byte("ok"), 0); st != 0 {
		t.Fatalf("setxattr: %v", st)
	}
	if st := m.Close(ctx, fileIno); st != 0 {
		t.Fatalf("close file: %v", st)
	}

	barrier, ok := m.(meta.CheckpointBarrier)
	if !ok {
		t.Fatalf("meta backend %T does not implement checkpoint barrier", m)
	}
	lease, err := barrier.BeginCheckpoint(context.Background())
	if err != nil {
		t.Fatalf("begin checkpoint barrier: %v", err)
	}
	if err := lease.Release(); err != nil {
		t.Fatalf("release checkpoint barrier: %v", err)
	}

	if err := m.CloseSession(); err != nil {
		t.Fatalf("close session: %v", err)
	}
	if err := m.Shutdown(); err != nil {
		t.Fatalf("shutdown before cold restore: %v", err)
	}

	if err := os.Remove(dbPath); err != nil && !os.IsNotExist(err) {
		t.Fatalf("remove local db: %v", err)
	}
	if err := os.RemoveAll(filepath.Join(workdir, ".litestream")); err != nil {
		t.Fatalf("remove local litestream cache: %v", err)
	}

	m2 := meta.NewClient(uri, meta.DefaultConf())
	defer func() { _ = m2.Shutdown() }()
	if _, err := m2.Load(true); err != nil {
		t.Fatalf("load after cold restore: %v", err)
	}
	if err := m2.NewSession(true); err != nil {
		t.Fatalf("new session after cold restore: %v", err)
	}
	defer func() { _ = m2.CloseSession() }()

	var lookedDir, lookedFile meta.Ino
	var lookedDirAttr, lookedFileAttr meta.Attr
	if st := m2.Lookup(ctx, 1, "smoke", &lookedDir, &lookedDirAttr, true); st != 0 {
		t.Fatalf("lookup restored dir: %v", st)
	}
	if lookedDir != dirIno {
		t.Fatalf("restored dir inode = %d, want %d", lookedDir, dirIno)
	}
	if st := m2.Lookup(ctx, lookedDir, "hello.txt", &lookedFile, &lookedFileAttr, true); st != 0 {
		t.Fatalf("lookup restored file: %v", st)
	}
	if lookedFile != fileIno {
		t.Fatalf("restored file inode = %d, want %d", lookedFile, fileIno)
	}
	var value []byte
	if st := m2.GetXattr(ctx, lookedFile, "user.smoke", &value); st != 0 {
		t.Fatalf("getxattr restored file: %v", st)
	}
	if string(value) != "ok" {
		t.Fatalf("restored xattr = %q, want %q", string(value), "ok")
	}

	if st := m2.Unlink(ctx, lookedDir, "hello.txt"); st != 0 && st != syscall.ENOENT {
		t.Fatalf("cleanup unlink: %v", st)
	}
	if st := m2.Rmdir(ctx, 1, "smoke"); st != 0 && st != syscall.ENOENT {
		t.Fatalf("cleanup rmdir: %v", st)
	}
}
