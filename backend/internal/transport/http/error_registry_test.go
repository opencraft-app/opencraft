package httptransport

import (
	"go/ast"
	"go/parser"
	"go/token"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
)

func TestEveryLiteralApplicationErrorCodeHasAnExplicitSurface(t *testing.T) {
	_, current, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("无法定位错误 registry 测试")
	}
	root := filepath.Clean(filepath.Join(filepath.Dir(current), "..", "..", ".."))
	diagnosticOnly := map[string]string{
		"database_mode_role_invalid": filepath.Join("internal", "runtime"),
	}
	err := filepath.WalkDir(filepath.Join(root, "internal"), func(
		path string,
		entry os.DirEntry,
		walkErr error,
	) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() || !strings.HasSuffix(path, ".go") ||
			strings.HasSuffix(path, "_test.go") {
			return nil
		}
		parsed, err := parser.ParseFile(token.NewFileSet(), path, nil, 0)
		if err != nil {
			return err
		}
		ast.Inspect(parsed, func(node ast.Node) bool {
			call, ok := node.(*ast.CallExpr)
			if !ok || len(call.Args) == 0 {
				return true
			}
			selector, ok := call.Fun.(*ast.SelectorExpr)
			if !ok {
				return true
			}
			packageName, packageOK := selector.X.(*ast.Ident)
			if !packageOK || packageName.Name != "apperror" ||
				selector.Sel.Name != "New" {
				return true
			}
			literal, ok := call.Args[0].(*ast.BasicLit)
			if !ok || literal.Kind != token.STRING {
				relative, _ := filepath.Rel(root, path)
				t.Errorf("%s 使用无法静态对账的动态 apperror code", relative)
				return true
			}
			code, err := strconv.Unquote(literal.Value)
			if err != nil || code == "" || code != strings.ToLower(code) {
				return true
			}
			if _, exists := LookupError(code); exists {
				return true
			}
			relative, _ := filepath.Rel(root, path)
			if prefix, exists := diagnosticOnly[code]; exists &&
				strings.HasPrefix(relative, prefix+string(filepath.Separator)) {
				return true
			}
			t.Errorf("%s 使用未进入 HTTP/OpenAPI registry 的应用错误码 %q", relative, code)
			return true
		})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestRegistryCoversEveryStableProductAndTransportCode(t *testing.T) {
	stableCodes := []string{
		"unauthenticated",
		"account_already_exists",
		"token_expired",
		"session_revoked",
		"im_identity_not_ready",
		"im_session_unavailable",
		"direct_conversation_closing",
		"runtime_credential_invalid",
		"runtime_credential_revoked",
		"computer_credential_invalid",
		"computer_credential_revoked",
		"computer_credential_exists",
		"computer_credential_not_current",
		"computer_removed",
		"computer_provider_identity_gone",
		"computer_replacement_identity_mismatch",
		"replacement_release_mismatch",
		"enrollment_invalid",
		"setup_expired",
		"setup_code_invalid",
		"computer_install_target_unsupported",
		"setup_code_target_conflict",
		"computer_already_claimed",
		"enrollment_claim_conflict",
		"assignment_query_invalid",
		"assignment_revision_regressed",
		"assignment_stale",
		"computer_credential_not_active",
		"predecessor_mismatch",
		"launch_id_conflict",
		"stale_launch",
		"sequence_conflict",
		"session_temporarily_unavailable",
		"server_not_found",
		"server_not_ready",
		"member_not_found",
		"member_removed",
		"owner_immutable",
		"already_member",
		"permission_denied",
		"forbidden",
		"revision_conflict",
		"resource_not_found",
		"invite_invalid",
		"operation_not_found",
		"channel_not_found",
		"channel_not_ready",
		"channel_membership_required",
		"channel_membership_not_found",
		"implicit_membership",
		"system_channel_immutable",
		"agent_not_found",
		"agent_not_ready",
		"agent_must_be_stopped",
		"runtime_unavailable",
		"runtime_config_invalid",
		"runtime_directory_not_found",
		"runtime_channel_not_found",
		"runtime_directory_too_large",
		"computer_not_found",
		"computer_not_ready",
		"computer_offline",
		"computer_in_use",
		"computer_has_bound_agents",
		"computer_already_registered",
		"computer_bootstrap_not_allowed",
		"provider_registration_pending",
		"provider_registration_failed",
		"provider_registration_expired",
		"computer_os_unsupported",
		"registration_expired",
		"tat_operation_failed",
		"tat_operation_uncertain",
		"terminal_session_unavailable",
		"task_not_found",
		"task_assignment_stale",
		"thread_not_found",
		"reminder_not_found",
		"reminder_occurrence_not_found",
		"schedule_invalid",
		"rate_limited",
		"idempotency_conflict",
		"tencent_unavailable",
		"tencent_rate_limited",
		"tencent_operation_uncertain",
		"tencent_permission_denied",
		"routing_key_invalid",
		"cross_partition_operation_denied",
		"invalid_request",
		"invalid_cursor",
		"route_not_found",
		"method_not_allowed",
		"internal_error",
	}

	for _, code := range stableCodes {
		t.Run(code, func(t *testing.T) {
			mapping, ok := LookupError(code)
			if !ok {
				t.Fatalf("LookupError(%q) is missing", code)
			}
			if mapping.Code != code {
				t.Fatalf("mapping.Code = %q, want %q", mapping.Code, code)
			}
			if mapping.Status < 400 || mapping.Status > 599 {
				t.Fatalf("mapping.Status = %d, want error status", mapping.Status)
			}
			if mapping.Message == "" {
				t.Fatal("mapping.Message is empty")
			}
		})
	}

	if got := len(AllErrorMappings()); got != len(stableCodes) {
		t.Fatalf("len(AllErrorMappings()) = %d, want %d", got, len(stableCodes))
	}
}

func TestRegistryKeepsImportantStatusMappings(t *testing.T) {
	tests := []struct {
		code   string
		status int
	}{
		{code: "channel_not_ready", status: http.StatusConflict},
		{code: "account_already_exists", status: http.StatusConflict},
		{code: "enrollment_invalid", status: http.StatusUnauthorized},
		{code: "setup_expired", status: http.StatusUnauthorized},
		{code: "setup_code_invalid", status: http.StatusUnauthorized},
		{code: "computer_install_target_unsupported", status: http.StatusUnprocessableEntity},
		{code: "setup_code_target_conflict", status: http.StatusConflict},
		{code: "computer_already_claimed", status: http.StatusConflict},
		{code: "enrollment_claim_conflict", status: http.StatusConflict},
		{code: "computer_removed", status: http.StatusGone},
		{code: "computer_provider_identity_gone", status: http.StatusGone},
		{code: "computer_replacement_identity_mismatch", status: http.StatusConflict},
		{code: "replacement_release_mismatch", status: http.StatusConflict},
		{code: "invalid_request", status: http.StatusBadRequest},
		{code: "route_not_found", status: http.StatusNotFound},
		{code: "method_not_allowed", status: http.StatusMethodNotAllowed},
		{code: "rate_limited", status: http.StatusTooManyRequests},
		{code: "tencent_rate_limited", status: http.StatusServiceUnavailable},
		{code: "internal_error", status: http.StatusInternalServerError},
	}

	for _, test := range tests {
		mapping, ok := LookupError(test.code)
		if !ok {
			t.Fatalf("LookupError(%q) is missing", test.code)
		}
		if mapping.Status != test.status {
			t.Errorf(
				"LookupError(%q).Status = %d, want %d",
				test.code,
				mapping.Status,
				test.status,
			)
		}
	}

	if _, ok := LookupError("DATABASE_OPEN_FAILED"); ok {
		t.Fatal("database diagnostic code must not be exposed as product HTTP error")
	}
}

func TestRegistryMapsBoundAgentComputerReleaseConflict(t *testing.T) {
	mapping, ok := LookupError("computer_has_bound_agents")
	if !ok || mapping.Status != http.StatusConflict {
		t.Fatalf(
			"LookupError(computer_has_bound_agents) = %#v, %v; want 409",
			mapping,
			ok,
		)
	}
}

func TestRegistryMapsLaunchFenceErrors(t *testing.T) {
	tests := map[string]int{
		"computer_credential_not_active":  http.StatusForbidden,
		"predecessor_mismatch":            http.StatusConflict,
		"launch_id_conflict":              http.StatusConflict,
		"stale_launch":                    http.StatusConflict,
		"sequence_conflict":               http.StatusConflict,
		"session_temporarily_unavailable": http.StatusServiceUnavailable,
	}
	for code, want := range tests {
		mapping, ok := LookupError(code)
		if !ok || mapping.Status != want {
			t.Errorf("LookupError(%q) = %#v, %v; want status %d", code, mapping, ok, want)
		}
	}
}
