package schemaaudit

import "testing"

func TestManifest包含且只包含27张业务表(t *testing.T) {
	want := map[string]string{
		"account_login_identities":     "login_hash",
		"accounts":                     "id",
		"auth_sessions":                "account_id",
		"account_server_memberships":   "account_id",
		"server_slug_registry":         "slug",
		"servers":                      "id",
		"server_invites":               "server_id",
		"members":                      "server_id",
		"agents":                       "server_id",
		"agent_im_routes":              "im_user_id",
		"agent_runtime_credentials":    "server_id",
		"computers":                    "server_id",
		"computer_setup_codes":         "code_hash",
		"computer_runtime_credentials": "server_id",
		"computer_agent_observations":  "server_id",
		"tat_instance_bindings":        "binding_hash",
		"channels":                     "server_id",
		"channel_members":              "server_id",
		"direct_conversations":         "server_id",
		"message_thread_refs":          "server_id",
		"message_thread_reads":         "server_id",
		"tasks":                        "server_id",
		"reminders":                    "server_id",
		"reminder_occurrences":         "server_id",
		"tencent_operations":           "partition_key",
		"idempotency_records":          "partition_key",
		"outbox_events":                "partition_key",
	}

	entries := Entries()
	if got := len(entries); got != len(want) {
		t.Fatalf("Entries() 数量 = %d，期望 %d", got, len(want))
	}
	seen := make(map[string]struct{}, len(entries))
	for _, entry := range entries {
		if entry.Schema == "" {
			t.Fatalf("表 %q 缺少 Schema 名", entry.Table)
		}
		if _, duplicate := seen[entry.Table]; duplicate {
			t.Fatalf("表 %q 重复", entry.Table)
		}
		seen[entry.Table] = struct{}{}

		shardKey, ok := want[entry.Table]
		if !ok {
			t.Fatalf("发现规格外业务表 %q", entry.Table)
		}
		if entry.ShardKey != shardKey {
			t.Fatalf("表 %q shardkey = %q，期望 %q", entry.Table, entry.ShardKey, shardKey)
		}
	}
}

func TestEntries返回副本(t *testing.T) {
	first := Entries()
	first[0].Table = "被篡改"
	second := Entries()
	if second[0].Table == "被篡改" {
		t.Fatal("Entries() 暴露了可修改的内部 manifest")
	}
}
