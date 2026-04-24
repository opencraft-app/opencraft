package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestResolveConfigPath_DefaultWhenUnset(t *testing.T) {
	t.Setenv("CONFIG_PATH", "")

	if got := resolveConfigPath(); got != defaultConfigPath {
		t.Fatalf("expected default config path %q, got %q", defaultConfigPath, got)
	}
}

func TestResolveConfigPath_FallsBackFromMissingLocalOverride(t *testing.T) {
	wd := t.TempDir()
	deployDir := filepath.Join(wd, "deploy")
	if err := os.MkdirAll(deployDir, 0755); err != nil {
		t.Fatalf("mkdir deploy: %v", err)
	}
	fallback := filepath.Join(deployDir, "config.yaml")
	if err := os.WriteFile(fallback, []byte("server:\n  port: 18080\n"), 0644); err != nil {
		t.Fatalf("write fallback config: %v", err)
	}

	prevWd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	if err := os.Chdir(wd); err != nil {
		t.Fatalf("chdir: %v", err)
	}
	defer func() {
		_ = os.Chdir(prevWd)
	}()

	t.Setenv("CONFIG_PATH", filepath.Join("deploy", "config.local.yaml"))

	if got := resolveConfigPath(); got != defaultConfigPath {
		t.Fatalf("expected fallback config path %q, got %q", defaultConfigPath, got)
	}
}

func TestResolveConfigPath_KeepsMissingNonLocalPath(t *testing.T) {
	t.Setenv("CONFIG_PATH", "deploy/custom.yaml")

	if got := resolveConfigPath(); got != "deploy/custom.yaml" {
		t.Fatalf("expected missing non-local path to be preserved, got %q", got)
	}
}
