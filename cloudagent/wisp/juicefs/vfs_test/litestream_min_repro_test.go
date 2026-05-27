//go:build litestreamvfs && vfs

package vfs_test

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/benbjohnson/litestream"
	_ "github.com/benbjohnson/litestream/file"
	_ "github.com/benbjohnson/litestream/s3"
	sqlite3 "github.com/mattn/go-sqlite3"
	"github.com/psanford/sqlite3vfs"
)

const minReproDriver = "sqlite3-litestream-min-repro"

var (
	minReproOnce     sync.Once
	minReproVFSSeq   atomic.Uint64
	minReproVFSNames sync.Map
)

func TestLitestreamCOSMinRepro(t *testing.T) {
	if os.Getenv("RUN_LITESTREAM_COS_SMOKE") != "1" {
		t.Skip("set RUN_LITESTREAM_COS_SMOKE=1 to run the real object-store smoke test")
	}
	replicaURL := os.Getenv("LITESTREAM_SMOKE_REPLICA_URL")
	if replicaURL == "" {
		t.Skip("LITESTREAM_SMOKE_REPLICA_URL is required")
	}
	if os.Getenv("AWS_ACCESS_KEY_ID") == "" {
		if v := os.Getenv("TENCENTCLOUD_SECRET_ID"); v != "" {
			t.Setenv("AWS_ACCESS_KEY_ID", v)
		}
	}
	if os.Getenv("AWS_SECRET_ACCESS_KEY") == "" {
		if v := os.Getenv("TENCENTCLOUD_SECRET_KEY"); v != "" {
			t.Setenv("AWS_SECRET_ACCESS_KEY", v)
		}
	}

	workdir := t.TempDir()
	dbPath := filepath.Join(workdir, "min-repro.db")
	bufferPath := filepath.Join(workdir, ".litestream", "min-repro.buffer.db")
	hydrationPath := filepath.Join(workdir, ".litestream", "min-repro.hydrated.db")
	driverName, dsn, err := registerMinReproDriver(dbPath, replicaURL, bufferPath, hydrationPath)
	if err != nil {
		t.Fatalf("register min repro driver: %v", err)
	}

	db, err := sql.Open(driverName, dsn)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)

	if err := db.Ping(); err != nil {
		t.Fatalf("ping db: %v", err)
	}
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT)`); err != nil {
		t.Fatalf("create table: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO t (v) VALUES ('hello')`); err != nil {
		t.Fatalf("insert row: %v", err)
	}

	// Give the VFS one short window to upload the first LTX before the next read.
	time.Sleep(300 * time.Millisecond)

	var count int
	if err := db.QueryRow(`SELECT count(*) FROM t`).Scan(&count); err != nil {
		t.Fatalf("count rows after first sync: %v", err)
	}
	if count != 1 {
		t.Fatalf("count=%d, want 1", count)
	}

	var txid string
	if err := db.QueryRow(`PRAGMA litestream_txid`).Scan(&txid); err != nil {
		t.Fatalf("pragma litestream_txid: %v", err)
	}
	if txid == "" {
		t.Fatalf("empty txid after sync")
	}
}

func registerMinReproDriver(dbPath, replicaURL, bufferPath, hydrationPath string) (string, string, error) {
	minReproOnce.Do(func() {
		sql.Register(minReproDriver, &sqlite3.SQLiteDriver{})
	})

	client, err := litestream.NewReplicaClientFromURL(replicaURL)
	if err != nil {
		return "", "", fmt.Errorf("new replica client: %w", err)
	}
	if err := client.Init(context.Background()); err != nil {
		return "", "", fmt.Errorf("init replica client: %w", err)
	}

	vfsID := fmt.Sprintf("min-repro-%x", minReproVFSSeq.Add(1))
	vfs := litestream.NewVFS(client, slog.Default())
	vfs.WriteEnabled = true
	vfs.WriteSyncInterval = 100 * time.Millisecond
	vfs.WriteBufferPath = bufferPath
	vfs.HydrationEnabled = true
	vfs.HydrationPath = hydrationPath
	if err := sqlite3vfs.RegisterVFS(vfsID, vfs); err != nil && !strings.Contains(err.Error(), "already exists") {
		return "", "", fmt.Errorf("register VFS: %w", err)
	}
	minReproVFSNames.Store(vfsID, struct{}{})

	q := url.Values{}
	q.Set("vfs", vfsID)
	q.Set("_timeout", "5000")
	return minReproDriver, "file:" + dbPath + "?" + q.Encode(), nil
}
