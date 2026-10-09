package schemaaudit

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestEnt生成产物覆盖且只覆盖正式Entity(t *testing.T) {
	entRoot := filepath.Join("..", "..", "ent")
	entries, err := os.ReadDir(entRoot)
	if err != nil {
		t.Fatalf("读取 Ent 生成目录：%v", err)
	}

	wantPackages := make(map[string]struct{}, len(Entries()))
	for _, entry := range Entries() {
		wantPackages[strings.ToLower(entry.Schema)] = struct{}{}
	}

	gotPackages := make(map[string]struct{}, len(wantPackages))
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		if _, ok := wantPackages[entry.Name()]; ok {
			gotPackages[entry.Name()] = struct{}{}
		}
	}
	if len(gotPackages) != len(wantPackages) {
		t.Fatalf("生成 Entity 包数量 = %d，期望 %d；已有=%v", len(gotPackages), len(wantPackages), gotPackages)
	}
	for name := range wantPackages {
		if _, ok := gotPackages[name]; !ok {
			t.Errorf("缺少生成 Entity 包 %s", name)
		}
	}

	if _, err := os.Stat(filepath.Join(entRoot, "client.go")); err != nil {
		t.Errorf("缺少生成 client.go：%v", err)
	}
	if _, err := os.Stat(filepath.Join(entRoot, "migrate", "migrate.go")); err != nil {
		t.Errorf("缺少生成 migrate/migrate.go：%v", err)
	}
}
