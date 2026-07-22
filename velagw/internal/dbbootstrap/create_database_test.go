package dbbootstrap

import "testing"

func TestCreateDatabaseStatementRejectsUnsafeName(t *testing.T) {
	if _, err := CreateDatabaseStatement("newapi_set_a"); err != nil {
		t.Fatal(err)
	}
	if _, err := CreateDatabaseStatement("newapi;drop"); err == nil {
		t.Fatal("expected unsafe database name to be rejected")
	}
}
