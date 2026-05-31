package service

import (
	"strings"
	"testing"
)

func TestMySQLUserSelectColumnsOmitsContentAuditFieldsWhenDisabled(t *testing.T) {
	columns := mysqlUserSelectColumns("u.", false)
	if strings.Contains(columns, "pending_name") || strings.Contains(columns, "name_audit_status") {
		t.Fatalf("disabled content audit should not select audit columns: %s", columns)
	}
}

func TestMySQLUserSelectColumnsIncludesContentAuditFieldsWhenEnabled(t *testing.T) {
	columns := mysqlUserSelectColumns("u.", true)
	for _, want := range []string{"u.pending_name", "u.name_audit_status"} {
		if !strings.Contains(columns, want) {
			t.Fatalf("enabled content audit should select %s: %s", want, columns)
		}
	}
}
