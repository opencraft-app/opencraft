package rescuearchive

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"os"
	"path/filepath"
	"sort"
	"testing"
)

func TestWriteHermesZipIsImportCompatible(t *testing.T) {
	root := t.TempDir()
	hermesHome := filepath.Join(root, "home", "agentuser", ".hermes")
	writeFile(t, filepath.Join(hermesHome, "config.yaml"), "model: test\n")
	writeFile(t, filepath.Join(hermesHome, ".env"), "OPENAI_API_KEY=x\n")
	writeFile(t, filepath.Join(hermesHome, "state.db"), "sqlite")
	writeFile(t, filepath.Join(hermesHome, "skills", "demo", "SKILL.md"), "# Demo\n")
	writeFile(t, filepath.Join(hermesHome, "gateway.pid"), "123")
	writeFile(t, filepath.Join(hermesHome, "node_modules", "leftpad", "index.js"), "bad")
	writeFile(t, filepath.Join(hermesHome, "__pycache__", "x.pyc"), "bad")

	var out bytes.Buffer
	err := Write(Config{
		MountRoot:   root,
		RemotePaths: []string{"/home/agentuser/.hermes"},
		ArchiveMode: ModeHermes,
	}, &out)
	if err != nil {
		t.Fatal(err)
	}

	reader, err := zip.NewReader(bytes.NewReader(out.Bytes()), int64(out.Len()))
	if err != nil {
		t.Fatal(err)
	}
	names := make([]string, 0, len(reader.File))
	for _, file := range reader.File {
		names = append(names, file.Name)
	}
	sort.Strings(names)

	assertContains(t, names, "config.yaml")
	assertContains(t, names, ".env")
	assertContains(t, names, "state.db")
	assertContains(t, names, "skills/demo/SKILL.md")
	assertNotContains(t, names, "home/agentuser/.hermes/config.yaml")
	assertNotContains(t, names, "gateway.pid")
	assertNotContains(t, names, "node_modules/leftpad/index.js")
	assertNotContains(t, names, "__pycache__/x.pyc")
}

func TestWriteHermesZipRequiresMarker(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "home", "agentuser", ".hermes"), 0o755); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	err := Write(Config{
		MountRoot:   root,
		RemotePaths: []string{"/home/agentuser/.hermes"},
		ArchiveMode: ModeHermes,
	}, &out)
	if err == nil {
		t.Fatal("expected missing Hermes marker error")
	}
}

func TestWriteGenericTarGzipKeepsLegacyPathShape(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "etc", "app.conf"), "ok")

	var out bytes.Buffer
	err := Write(Config{
		MountRoot:   root,
		RemotePaths: []string{"/etc"},
		ArchiveMode: ModeGeneric,
	}, &out)
	if err != nil {
		t.Fatal(err)
	}

	gz, err := gzip.NewReader(bytes.NewReader(out.Bytes()))
	if err != nil {
		t.Fatal(err)
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	var names []string
	for {
		header, err := tr.Next()
		if err != nil {
			break
		}
		names = append(names, header.Name)
	}
	assertContains(t, names, "etc/app.conf")
}

func writeFile(t *testing.T, path string, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func assertContains(t *testing.T, values []string, want string) {
	t.Helper()
	for _, value := range values {
		if value == want {
			return
		}
	}
	t.Fatalf("missing %q in %v", want, values)
}

func assertNotContains(t *testing.T, values []string, want string) {
	t.Helper()
	for _, value := range values {
		if value == want {
			t.Fatalf("unexpected %q in %v", want, values)
		}
	}
}
