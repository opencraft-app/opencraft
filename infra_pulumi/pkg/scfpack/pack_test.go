package scfpack

import (
	"archive/zip"
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestBuildRuntimeZipIsDeterministicAndMinimal(t *testing.T) {
	source := t.TempDir()
	dependencies := t.TempDir()
	if err := os.WriteFile(filepath.Join(source, "app.py"), []byte("def handler():\n    return 1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "requirements.txt"), []byte("redis==5.0.0\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "test_app.py"), []byte("should not ship"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dependencies, "redis"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dependencies, "redis", "__init__.py"), []byte("VERSION = 'test'\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	first := filepath.Join(t.TempDir(), "first.zip")
	second := filepath.Join(t.TempDir(), "second.zip")
	if err := BuildRuntimeZipFromDependencies(source, dependencies, first); err != nil {
		t.Fatal(err)
	}
	if err := BuildRuntimeZipFromDependencies(source, dependencies, second); err != nil {
		t.Fatal(err)
	}
	firstBytes, _ := os.ReadFile(first)
	secondBytes, _ := os.ReadFile(second)
	if !bytes.Equal(firstBytes, secondBytes) {
		t.Fatal("runtime zip is not deterministic")
	}

	reader, err := zip.OpenReader(first)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	if len(reader.File) != 3 || reader.File[0].Name != "app.py" || reader.File[1].Name != "requirements.txt" || reader.File[2].Name != "redis/__init__.py" {
		t.Fatalf("unexpected zip contents: %#v", reader.File)
	}
}

func TestBuildPythonRuntimeZipIntegration(t *testing.T) {
	if os.Getenv("SCF_PACK_INTEGRATION") != "1" {
		t.Skip("set SCF_PACK_INTEGRATION=1 to build the Python3.10 deployment package")
	}
	source := filepath.Join("..", "..", "functions", "notify_runtime")
	destination := filepath.Join(t.TempDir(), "notify_runtime.zip")
	if err := BuildPythonRuntimeZip(source, destination); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(destination)
	if err != nil {
		t.Fatal(err)
	}
	if info.Size() == 0 || info.Size() > 50*1024*1024 {
		t.Fatalf("unexpected SCF package size: %d", info.Size())
	}
	reader, err := zip.OpenReader(destination)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	names := make(map[string]bool, len(reader.File))
	for _, file := range reader.File {
		names[file.Name] = true
	}
	for _, required := range []string{"app.py", "redis/__init__.py", "pymysql/__init__.py", "tencentcloud/__init__.py"} {
		if !names[required] {
			t.Fatalf("deployment package is missing %s", required)
		}
	}
}

func TestContentAddressedPathChangesWhenPackageContentChanges(t *testing.T) {
	dir := t.TempDir()
	firstSource := filepath.Join(dir, "notify_runtime.zip")
	if err := os.WriteFile(firstSource, []byte("first"), 0o644); err != nil {
		t.Fatal(err)
	}
	first, err := ContentAddressedPath(firstSource)
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(first) != "notify_runtime-a7937b64b8caa58f.zip" {
		t.Fatalf("unexpected content-addressed path %q", first)
	}
	if _, err := os.Stat(first); err != nil {
		t.Fatalf("hashed package does not exist: %v", err)
	}

	secondSource := filepath.Join(dir, "notify_runtime.zip")
	if err := os.WriteFile(secondSource, []byte("second"), 0o644); err != nil {
		t.Fatal(err)
	}
	second, err := ContentAddressedPath(secondSource)
	if err != nil {
		t.Fatal(err)
	}
	if first == second {
		t.Fatal("different package content produced the same Pulumi input path")
	}
}
