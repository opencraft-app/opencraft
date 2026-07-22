package gateway

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	mysql "github.com/go-sql-driver/mysql"
)

func TestIsMySQLTransientLockErrorRecognizesDeadlockAndLockWaitTimeout(t *testing.T) {
	cases := []error{
		&mysql.MySQLError{Number: 1213, Message: "Deadlock found when trying to get lock; try restarting transaction"},
		&mysql.MySQLError{Number: 1205, Message: "Lock wait timeout exceeded; try restarting transaction"},
		errors.New("Error 1213 (40001): Deadlock found when trying to get lock; try restarting transaction"),
	}
	for _, err := range cases {
		if !isMySQLTransientLockError(err) {
			t.Fatalf("expected transient lock error for %v", err)
		}
	}
}

func TestTenantDeletionSuccessUpdateDoesNotRescanAllTargets(t *testing.T) {
	query := tenantDeletionSuccessJobUpdateSQL()
	if strings.Contains(query, "llmgateway_tenant_deletion_targets") || strings.Contains(strings.ToUpper(query), "SELECT") {
		t.Fatalf("tenant deletion progress update must stay O(1): %s", query)
	}
	for _, fragment := range []string{
		"success_count = success_count + 1",
		"success_count + 1 >= target_count",
		"failure_count > 0",
	} {
		if !strings.Contains(query, fragment) {
			t.Fatalf("tenant deletion progress update is missing %q: %s", fragment, query)
		}
	}
}

func TestTenantSearchLikePatternEscapesWildcards(t *testing.T) {
	if got, want := tenantSearchLikePattern(`sgw%_\tenant`), `sgw\%\_\\tenant%`; got != want {
		t.Fatalf("tenantSearchLikePattern() = %q, want %q", got, want)
	}
}

func TestTenantSummaryBaseSQLDoesNotAggregateAllKeys(t *testing.T) {
	query := tenantSummaryBaseSQL()
	if strings.Contains(query, "llmgateway_api_key_bindings") || strings.Contains(query, "GROUP BY user_id") {
		t.Fatalf("tenant page query must not aggregate the full key table: %s", query)
	}
	for _, table := range []string{"llmgateway_tenants", "llmgateway_user_bindings", "llmgateway_user_assignments", "llmgateway_tenant_observations"} {
		if !strings.Contains(query, table) {
			t.Fatalf("tenant page query is missing %s: %s", table, query)
		}
	}
}

func TestTenantListCompositeIndexesCoverPagingSearchAndStatistics(t *testing.T) {
	indexes := tenantListCompositeIndexes()
	want := map[string]string{
		"idx_llmgateway_tenants_backend_page":        "backend,updated_at,external_user_id",
		"idx_llmgateway_tenants_set_page":            "set_id,updated_at,external_user_id",
		"idx_llmgateway_tenants_backend_status":      "backend,status",
		"idx_llmgateway_user_bindings_username_user": "username,external_user_id",
	}
	for _, index := range indexes {
		columns, ok := want[index.Name]
		if !ok {
			continue
		}
		if got := strings.Join(index.Columns, ","); got != columns {
			t.Fatalf("index %s columns = %s, want %s", index.Name, got, columns)
		}
		delete(want, index.Name)
	}
	if len(want) != 0 {
		t.Fatalf("missing tenant indexes: %+v", want)
	}
}

func TestMySQLCompositeIndexDDLUsesOnlineAlterSyntax(t *testing.T) {
	statement, err := mysqlCompositeIndexDDL(mysqlIndexSpec{
		Table:   "llmgateway_tenants",
		Name:    "idx_example",
		Columns: []string{"backend", "updated_at"},
	})
	if err != nil {
		t.Fatal(err)
	}
	want := "ALTER TABLE `llmgateway_tenants` ADD INDEX `idx_example` (`backend`,`updated_at`), ALGORITHM=INPLACE, LOCK=NONE"
	if statement != want {
		t.Fatalf("mysqlCompositeIndexDDL() = %q, want %q", statement, want)
	}
}

func TestIsMySQLTransientLockErrorRejectsOrdinaryErrors(t *testing.T) {
	if isMySQLTransientLockError(errors.New("duplicate entry")) {
		t.Fatal("duplicate entry should not be treated as a transient lock error")
	}
}

func TestChannelBundleSpecStoragePreservesOptions(t *testing.T) {
	autoBan := 0
	raw, err := marshalChannelBundleSpecForStorage(ChannelBundleSpec{
		Version: 1,
		Kind:    ChannelBundleKind,
		Options: []ChannelBundleOption{
			{Key: "ModelRatio", Value: `{"llmgw-mock-chat":1}`},
		},
		Channels: []ChannelBundleChannel{{
			ID:                 "mock",
			Name:               "Mock",
			Type:               1,
			Key:                "sk-provider",
			BaseURL:            "http://mockllm:8080",
			Models:             "llmgw-mock-chat",
			Group:              "default",
			Status:             ChannelSpecStatusEnabled,
			AutoBan:            &autoBan,
			Tag:                "production",
			Other:              "ap-beijing",
			StatusCodeMapping:  `{"429":503}`,
			OtherSettings:      `{"azure_responses_version":"2025-04-01-preview"}`,
			OpenAIOrganization: "org-vela",
			TestModel:          "llmgw-mock-chat",
			IsMultiKey:         true,
			MultiKeyMode:       "polling",
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	var stored map[string]any
	if err := json.Unmarshal([]byte(raw), &stored); err != nil {
		t.Fatal(err)
	}
	if _, ok := stored["options"]; !ok {
		t.Fatalf("stored channel bundle spec dropped options: %s", raw)
	}
	spec, err := unmarshalChannelBundleSpecFromStorage(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(spec.Options) != 1 || spec.Options[0].Key != "ModelRatio" || spec.Options[0].Value != `{"llmgw-mock-chat":1}` {
		t.Fatalf("unexpected restored options: %+v", spec.Options)
	}
	channel := spec.Channels[0]
	if channel.AutoBan == nil || *channel.AutoBan != 0 || channel.Tag != "production" || channel.Other != "ap-beijing" || !channel.IsMultiKey || channel.MultiKeyMode != "polling" {
		t.Fatalf("extended channel desired state was not restored: %+v", channel)
	}
}
