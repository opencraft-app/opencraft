package runtime

import (
	"testing"

	"chatserver/internal/apperror"
)

func TestSQLiteRequiresAllThreeRoles(t *testing.T) {
	tests := []struct {
		name  string
		roles []Role
	}{
		{name: "API only", roles: []Role{RoleAPI}},
		{name: "worker only", roles: []Role{RoleWorker}},
		{name: "missing scheduler", roles: []Role{RoleAPI, RoleWorker}},
		{name: "missing API", roles: []Role{RoleWorker, RoleScheduler}},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			roles, err := NewRoleSet(test.roles...)
			if err != nil {
				t.Fatalf("NewRoleSet() error = %v", err)
			}
			err = roles.Validate(DatabaseModeSQLite)
			if got := apperror.CodeOf(err); got != "database_mode_role_invalid" {
				t.Fatalf(
					"Validate(SQLite) code = %q, want database_mode_role_invalid",
					got,
				)
			}
		})
	}
}

func TestSQLiteAcceptsOnlyCombinedRoles(t *testing.T) {
	roles, err := NewRoleSet(RoleAPI, RoleWorker, RoleScheduler)
	if err != nil {
		t.Fatalf("NewRoleSet() error = %v", err)
	}
	if err := roles.Validate(DatabaseModeSQLite); err != nil {
		t.Fatalf("Validate(SQLite) error = %v", err)
	}
}

func TestTDSQLAllowsIndependentValidRoles(t *testing.T) {
	for _, role := range []Role{RoleAPI, RoleWorker, RoleScheduler} {
		roles, err := NewRoleSet(role)
		if err != nil {
			t.Fatalf("NewRoleSet(%s) error = %v", role, err)
		}
		if err := roles.Validate(DatabaseModeTDSQL); err != nil {
			t.Fatalf("Validate(TDSQL %s) error = %v", role, err)
		}
	}
}

func TestRoleSetRejectsUnknownOrDuplicateRole(t *testing.T) {
	if _, err := NewRoleSet(Role("unknown")); err == nil {
		t.Fatal("NewRoleSet(unknown) error = nil")
	}
	if _, err := NewRoleSet(RoleAPI, RoleAPI); err == nil {
		t.Fatal("NewRoleSet(duplicate) error = nil")
	}
}
