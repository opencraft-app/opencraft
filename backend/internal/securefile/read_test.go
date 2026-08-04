package securefile

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRead接受本地0600和Kubernetes0440(t *testing.T) {
	for _, mode := range []os.FileMode{0o600, 0o440} {
		t.Run(mode.String(), func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "secret")
			if err := os.WriteFile(path, []byte("sensitive-value"), mode); err != nil {
				t.Fatal(err)
			}
			got, err := Read(path, "测试密钥", 4096)
			if err != nil {
				t.Fatalf("Read() error = %v", err)
			}
			if string(got) != "sensitive-value" {
				t.Fatalf("Read() = %q", got)
			}
		})
	}
}

func TestRead拒绝公开权限且不泄漏路径或内容(t *testing.T) {
	path := filepath.Join(t.TempDir(), "secret")
	const secret = "never-log-this-secret"
	if err := os.WriteFile(path, []byte(secret), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := Read(path, "测试密钥", 4096)
	if err == nil {
		t.Fatal("Read() accepted mode 0644")
	}
	if strings.Contains(err.Error(), path) || strings.Contains(err.Error(), secret) {
		t.Fatalf("错误泄漏敏感信息：%v", err)
	}
}

func TestRead拒绝符号链接(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "target")
	if err := os.WriteFile(target, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "link")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	if _, err := Read(link, "测试密钥", 4096); err == nil {
		t.Fatal("Read() accepted symlink")
	}
}

func TestRead接受KubernetesProjectedSecretLink(t *testing.T) {
	root := t.TempDir()
	revision := "..2026_07_31_12_00_00.000000000"
	revisionDir := filepath.Join(root, revision)
	if err := os.Mkdir(revisionDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(revisionDir, "secret"), []byte("projected-value"), 0o440); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(revision, filepath.Join(root, "..data")); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "secret")
	if err := os.Symlink(filepath.Join("..data", "secret"), path); err != nil {
		t.Fatal(err)
	}

	got, err := Read(path, "测试密钥", 4096)
	if err != nil {
		t.Fatalf("Read() error = %v", err)
	}
	if string(got) != "projected-value" {
		t.Fatalf("Read() = %q", got)
	}
}

func TestRead拒绝伪造的KubernetesLink逃逸挂载目录(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret"), []byte("escaped"), 0o440); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "..data")); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "secret")
	if err := os.Symlink(filepath.Join("..data", "secret"), path); err != nil {
		t.Fatal(err)
	}

	if _, err := Read(path, "测试密钥", 4096); err == nil {
		t.Fatal("Read() accepted projected secret escaping its mount directory")
	}
}
