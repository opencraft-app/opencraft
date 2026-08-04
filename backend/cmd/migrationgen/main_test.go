package main

import (
	"testing"

	"entgo.io/ent/dialect"
)

func TestParseDialect只接受正式方言(t *testing.T) {
	tests := []struct {
		input     string
		dialect   string
		directory string
		ok        bool
	}{
		{input: "sqlite", dialect: dialect.SQLite, directory: "sqlite", ok: true},
		{input: "tdsql", dialect: dialect.MySQL, directory: "tdsql", ok: true},
		{input: "mysql", ok: false},
	}
	for _, tt := range tests {
		gotDialect, gotDirectory, err := parseDialect(tt.input)
		if tt.ok && (err != nil || gotDialect != tt.dialect || gotDirectory != tt.directory) {
			t.Fatalf("parseDialect(%q) = (%q,%q,%v)", tt.input, gotDialect, gotDirectory, err)
		}
		if !tt.ok && err == nil {
			t.Fatalf("parseDialect(%q) 应失败", tt.input)
		}
	}
}
