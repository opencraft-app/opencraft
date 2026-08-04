package tdsqlddl

import (
	"os"
	"strings"
	"testing"

	"chatserver/internal/database/physicalschema"
)

func Test正式Baseline只由冻结Catalog编译(t *testing.T) {
	source, err := os.ReadFile("../migrationsource/tdsql/20260801000000_baseline.sql")
	if err != nil {
		t.Fatal(err)
	}
	catalog, err := physicalschema.Baseline20260801000000()
	if err != nil {
		t.Fatal(err)
	}
	compiled, err := Compile(string(source), catalog)
	if err != nil {
		t.Fatalf("Compile() error = %v", err)
	}
	tables, err := ParseDocument(compiled)
	if err != nil {
		t.Fatal(err)
	}
	if len(tables) != 25 {
		t.Fatalf("编译表数量 = %d，期望 25", len(tables))
	}
	if got := strings.Count(compiled, "shardkey=`"); got != 25 {
		t.Fatalf("shardkey option 数量 = %d，期望 25", got)
	}
	if !strings.Contains(compiled, "`slug` varchar(63) CHARACTER SET ascii COLLATE ascii_bin NOT NULL") ||
		!strings.Contains(compiled, "`im_user_id` varchar(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL") {
		t.Fatal("编译结果缺少字符串 route 的物理边界")
	}
}
