//go:build linux && cgo && lwext4sdk

package ext4sdk

import (
	"io"
	"path/filepath"
	"testing"
)

func TestFileBackendMkfsMountReadWrite(t *testing.T) {
	dir := t.TempDir()
	image := filepath.Join(dir, "ext4.img")

	backend, err := NewFileBackend(image, 4096, 4096)
	if err != nil {
		t.Fatalf("new backend: %v", err)
	}

	fs, err := New(backend, Options{
		DeviceName: "jfs-ext4-test",
		MountPoint: "/mp/",
		CacheItems: 128,
	})
	if err != nil {
		t.Fatalf("new fs: %v", err)
	}
	defer func() { _ = fs.Close() }()

	if err := fs.Format(FormatOptions{
		Type:      Ext4,
		BlockSize: 4096,
		Label:     "juicefs-ext4",
		Journal:   true,
	}); err != nil {
		t.Fatalf("format: %v", err)
	}
	if err := fs.Mount(false); err != nil {
		t.Fatalf("mount: %v", err)
	}
	if err := fs.Mkdir("hello"); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	f, err := fs.OpenFile("hello/world.txt", "wb")
	if err != nil {
		t.Fatalf("open write: %v", err)
	}
	if _, err := f.Write([]byte("juicefs-ext4")); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := f.Close(); err != nil {
		t.Fatalf("close write: %v", err)
	}
	if err := fs.Flush(); err != nil {
		t.Fatalf("flush: %v", err)
	}

	rf, err := fs.OpenFile("hello/world.txt", "rb")
	if err != nil {
		t.Fatalf("open read: %v", err)
	}
	defer func() { _ = rf.Close() }()
	buf := make([]byte, 32)
	n, err := rf.Read(buf)
	if err != nil && err != io.EOF {
		t.Fatalf("read: %v", err)
	}
	got := string(buf[:n])
	if got != "juicefs-ext4" {
		t.Fatalf("unexpected content: %q", got)
	}

	entries, err := fs.OpenDir("hello")
	if err != nil {
		t.Fatalf("open dir: %v", err)
	}
	defer func() { _ = entries.Close() }()
	for {
		de, err := entries.Next()
		if err != nil {
			t.Fatalf("dir next: %v", err)
		}
		if de.Name == "." || de.Name == ".." {
			continue
		}
		if de.Name != "world.txt" {
			t.Fatalf("unexpected dir entry: %#v", de)
		}
		break
	}
}

func TestFileBackendCrossRenameNoFlush(t *testing.T) {
	dir := t.TempDir()
	image := filepath.Join(dir, "ext4.img")

	backend, err := NewFileBackend(image, 4096, 4096)
	if err != nil {
		t.Fatalf("new backend: %v", err)
	}

	fs, err := New(backend, Options{
		DeviceName: "jfs-ext4-rename-noflush",
		MountPoint: "/mp/",
		CacheItems: 128,
	})
	if err != nil {
		t.Fatalf("new fs: %v", err)
	}
	defer func() { _ = fs.Close() }()

	if err := fs.Format(FormatOptions{
		Type:      Ext4,
		BlockSize: 4096,
		Label:     "juicefs-ext4",
		Journal:   true,
	}); err != nil {
		t.Fatalf("format: %v", err)
	}
	if err := fs.Mount(false); err != nil {
		t.Fatalf("mount: %v", err)
	}
	if err := fs.Mkdir("src"); err != nil {
		t.Fatalf("mkdir src: %v", err)
	}
	if err := fs.Mkdir("dst"); err != nil {
		t.Fatalf("mkdir dst: %v", err)
	}
	f, err := fs.OpenFile("src/alpha.txt", "wb")
	if err != nil {
		t.Fatalf("open write: %v", err)
	}
	if _, err := f.Write([]byte("payload")); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := f.Close(); err != nil {
		t.Fatalf("close write: %v", err)
	}
	if err := fs.Rename("src/alpha.txt", "dst/beta.txt"); err != nil {
		t.Fatalf("rename without flush: %v", err)
	}
	got, err := readAllForTest(fs, "dst/beta.txt")
	if err != nil {
		t.Fatalf("read renamed: %v", err)
	}
	if got != "payload" {
		t.Fatalf("unexpected renamed payload: %q", got)
	}
}

func TestFileBackendCrossRenameWithFlush(t *testing.T) {
	dir := t.TempDir()
	image := filepath.Join(dir, "ext4.img")

	backend, err := NewFileBackend(image, 4096, 4096)
	if err != nil {
		t.Fatalf("new backend: %v", err)
	}

	fs, err := New(backend, Options{
		DeviceName: "jfs-ext4-rename-flush",
		MountPoint: "/mp/",
		CacheItems: 128,
	})
	if err != nil {
		t.Fatalf("new fs: %v", err)
	}
	defer func() { _ = fs.Close() }()

	if err := fs.Format(FormatOptions{
		Type:      Ext4,
		BlockSize: 4096,
		Label:     "juicefs-ext4",
		Journal:   true,
	}); err != nil {
		t.Fatalf("format: %v", err)
	}
	if err := fs.Mount(false); err != nil {
		t.Fatalf("mount: %v", err)
	}
	if err := fs.Mkdir("src"); err != nil {
		t.Fatalf("mkdir src: %v", err)
	}
	if err := fs.Mkdir("dst"); err != nil {
		t.Fatalf("mkdir dst: %v", err)
	}
	f, err := fs.OpenFile("src/alpha.txt", "wb")
	if err != nil {
		t.Fatalf("open write: %v", err)
	}
	if _, err := f.Write([]byte("payload")); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := f.Close(); err != nil {
		t.Fatalf("close write: %v", err)
	}
	if err := fs.Flush(); err != nil {
		t.Fatalf("flush: %v", err)
	}
	if err := fs.Rename("src/alpha.txt", "dst/beta.txt"); err != nil {
		t.Fatalf("rename with flush: %v", err)
	}
	got, err := readAllForTest(fs, "dst/beta.txt")
	if err != nil {
		t.Fatalf("read renamed: %v", err)
	}
	if got != "payload" {
		t.Fatalf("unexpected renamed payload: %q", got)
	}
}

func readAllForTest(fs *FS, name string) (string, error) {
	rf, err := fs.OpenFile(name, "rb")
	if err != nil {
		return "", err
	}
	defer func() { _ = rf.Close() }()
	buf := make([]byte, 4096)
	var out []byte
	for {
		n, err := rf.Read(buf)
		if n > 0 {
			out = append(out, buf[:n]...)
		}
		if err == nil {
			continue
		}
		if err == io.EOF {
			break
		}
		return "", err
	}
	return string(out), nil
}
