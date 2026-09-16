package tdsqlbaseline

import (
	"os"
	"path/filepath"
	"testing"
)

func TestBuild和Verify确定性绑定正式Baseline(t *testing.T) {
	source, err := os.ReadFile("../migrationsource/tdsql/" + Filename)
	if err != nil {
		t.Fatal(err)
	}
	first, err := Build(source)
	if err != nil {
		t.Fatalf("Build() error = %v", err)
	}
	second, err := Build(source)
	if err != nil {
		t.Fatal(err)
	}
	if string(first.Output) != string(second.Output) ||
		string(first.CompileSum) != string(second.CompileSum) {
		t.Fatal("相同 source/Catalog 未得到逐字节相同产物")
	}
	if err := Verify(source, first.Output, first.CompileSum); err != nil {
		t.Fatalf("Verify() error = %v", err)
	}
	const publishedBinding = "version=tdsqlddl/v1 catalog_sha256=59350612cc6667afb40105f16d72558b8b48f46e39763193f2508b7b3cbdb6f2 file=20260801000000_baseline.sql source_sha256=8a59b693e545b9401db6d7759e0cf78a766df4ef53794dace26900a63d5c73ab output_sha256=82f5c1ae99f40185d02a72fb5e891488a753577470e3205f03e178514296fa7b\n"
	if string(first.CompileSum) != publishedBinding {
		t.Fatal("published baseline identity 被改写")
	}
	tampered := append([]byte(nil), first.Output...)
	tampered[len(tampered)-2] ^= 1
	if err := Verify(source, tampered, first.CompileSum); err == nil {
		t.Fatal("Verify() 应拒绝被修改的 runtime SQL")
	}
}

func TestPublishFiles只发布一次且VerifyFiles检查全部绑定(t *testing.T) {
	source, err := os.ReadFile("../migrationsource/tdsql/" + Filename)
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	sourceDir := filepath.Join(root, "internal", "database", "migrationsource", "tdsql")
	if err := os.MkdirAll(sourceDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sourceDir, Filename), source, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := PublishFiles(root); err != nil {
		t.Fatalf("PublishFiles() error = %v", err)
	}
	if err := VerifyFiles(root); err != nil {
		t.Fatalf("VerifyFiles() error = %v", err)
	}
	if err := PublishFiles(root); err == nil {
		t.Fatal("PublishFiles() 不应覆盖已经发布的 baseline")
	}
	outputPath := filepath.Join(root, "migrations", "tdsql", Filename)
	if err := os.WriteFile(outputPath, []byte("tampered"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := VerifyFiles(root); err == nil {
		t.Fatal("VerifyFiles() 应拒绝被修改的 runtime baseline")
	}
}
