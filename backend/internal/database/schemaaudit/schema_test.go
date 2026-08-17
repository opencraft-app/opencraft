package schemaaudit

import (
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"entgo.io/ent/entc"
	"entgo.io/ent/entc/gen"
)

type indexContract struct {
	unique  bool
	columns string
}

type tableContract struct {
	fields   string
	nillable string
	indexes  []indexContract
}

func TestEntGraph符合27表规格(t *testing.T) {
	graph, err := entc.LoadGraph(filepath.Join("..", "..", "ent", "schema"), &gen.Config{
		Target:  t.TempDir(),
		Package: "chatserver/internal/ent",
	})
	if err != nil {
		t.Fatalf("加载 Ent Graph：%v", err)
	}

	contracts := schemaContracts()
	if got := len(graph.Nodes); got != len(contracts) {
		t.Fatalf("Ent Entity 数量 = %d，期望 %d", got, len(contracts))
	}
	for _, node := range graph.Nodes {
		table := node.Table()
		contract, ok := contracts[table]
		if !ok {
			t.Errorf("发现规格外 Entity %s（表 %s）", node.Name, table)
			continue
		}
		assertNodeContract(t, node, table, contract)
	}
}

func assertNodeContract(t *testing.T, node *gen.Type, table string, contract tableContract) {
	t.Helper()

	if len(node.Edges) != 0 || len(node.ForeignKeys) != 0 {
		t.Errorf("表 %s 生成了 Edge 或外键", table)
	}
	if node.ID == nil || node.ID.Name != "id" || !node.ID.IsString() || !node.ID.Immutable || !node.ID.Default {
		t.Errorf("表 %s 的逻辑 ID 不符合 UUIDv7 Mixin：%#v", table, node.ID)
	}

	gotFields := []string{node.ID.Name}
	gotNillable := make([]string, 0)
	for _, field := range node.Fields {
		gotFields = append(gotFields, field.Name)
		if field.Nillable {
			gotNillable = append(gotNillable, field.Name)
		}
	}
	assertWords(t, table+" fields", gotFields, contract.fields)
	assertWords(t, table+" nillable", gotNillable, contract.nillable)

	entry := entryByTable(t, table)
	raw, ok := node.Annotations["ChatserverShardKey"]
	if !ok {
		t.Errorf("表 %s 缺少 ChatserverShardKey Annotation", table)
	} else {
		value, ok := raw.(map[string]any)
		if !ok || value["field"] != entry.ShardKey {
			t.Errorf("表 %s shardkey annotation = %#v，期望 %s", table, raw, entry.ShardKey)
		}
	}

	gotIndexes := make([]string, 0, len(node.Indexes))
	for _, index := range node.Indexes {
		prefix := "N:"
		if index.Unique {
			prefix = "U:"
		}
		gotIndexes = append(gotIndexes, prefix+strings.Join(index.Columns, ","))
	}
	wantIndexes := make([]string, 0, len(contract.indexes))
	for _, index := range contract.indexes {
		prefix := "N:"
		if index.unique {
			prefix = "U:"
		}
		wantIndexes = append(wantIndexes, prefix+index.columns)
	}
	slices.Sort(gotIndexes)
	slices.Sort(wantIndexes)
	if !slices.Equal(gotIndexes, wantIndexes) {
		t.Errorf("表 %s indexes = %v，期望 %v", table, gotIndexes, wantIndexes)
	}
}

func assertWords(t *testing.T, label string, got []string, words string) {
	t.Helper()
	want := strings.Fields(words)
	slices.Sort(got)
	slices.Sort(want)
	if !slices.Equal(got, want) {
		t.Errorf("%s = %v，期望 %v", label, got, want)
	}
}

func entryByTable(t *testing.T, table string) Entry {
	t.Helper()
	for _, entry := range Entries() {
		if entry.Table == table {
			return entry
		}
	}
	t.Fatalf("manifest 中不存在表 %s", table)
	return Entry{}
}

func u(columns string) indexContract { return indexContract{unique: true, columns: columns} }
func n(columns string) indexContract { return indexContract{columns: columns} }

func schemaContracts() map[string]tableContract {
	return map[string]tableContract{
		"account_login_identities": {
			fields:   "id login_hash kind normalized_login account_id state created_at retired_at",
			nillable: "retired_at",
			indexes:  []indexContract{u("login_hash,kind"), n("login_hash,account_id")},
		},
		"accounts": {
			fields:  "id email email_normalized display_name password_hash token_version im_user_id im_state revision created_at updated_at",
			indexes: []indexContract{n("id,im_state")},
		},
		"auth_sessions": {
			fields:   "id account_id family_id refresh_token_hash expires_at used_at revoked_at created_at updated_at",
			nillable: "used_at revoked_at",
			indexes:  []indexContract{u("account_id,refresh_token_hash"), n("account_id,family_id"), n("account_id,expires_at")},
		},
		"account_server_memberships": {
			fields:  "id account_id server_id member_id role status server_name_snapshot server_slug_snapshot server_revision projected_at updated_at",
			indexes: []indexContract{u("account_id,server_id"), n("account_id,status,updated_at,server_id")},
		},
		"server_slug_registry": {
			fields:  "id slug server_id state created_at updated_at",
			indexes: []indexContract{u("slug"), n("slug,server_id")},
		},
		"servers": {
			fields:   "id slug name description owner_member_id im_group_id im_state next_task_number revision created_at updated_at",
			nillable: "description owner_member_id",
			indexes:  []indexContract{n("id,im_state"), n("id,owner_member_id")},
		},
		"server_invites": {
			fields:   "id server_id token_hash role max_uses used_count landing_channel_id expires_at revoked_at created_by_member_id revision created_at updated_at",
			nillable: "landing_channel_id revoked_at",
			indexes:  []indexContract{u("server_id,token_hash"), n("server_id,expires_at,id")},
		},
		"members": {
			fields:   "id server_id account_id kind role display_name handle active_handle_key status im_state revision created_at updated_at",
			nillable: "account_id active_handle_key",
			indexes:  []indexContract{u("server_id,active_handle_key"), u("server_id,account_id"), n("server_id,status,id")},
		},
		"agents": {
			fields:   "id server_id im_user_id computer_id description runtime_kind runtime_model profile_capability_refresh_id profile_capabilities_json reply_policy desired_state observed_state credential_version im_state im_presence im_presence_updated_at im_transport_state im_transport_updated_at host_last_seen_at last_observed_at last_error_code observed_assignment_epoch observed_generation observed_attempt observed_sequence observed_launch_id current_launch_id current_launch_assignment_epoch current_launch_generation current_launch_credential_version current_launch_attempt current_launch_updated_at created_by_member_id revision created_at updated_at deleted_at",
			nillable: "computer_id description runtime_model profile_capability_refresh_id profile_capabilities_json im_presence_updated_at im_transport_updated_at host_last_seen_at last_observed_at last_error_code observed_assignment_epoch observed_launch_id current_launch_id current_launch_assignment_epoch current_launch_updated_at deleted_at",
			indexes:  []indexContract{u("server_id,im_user_id"), n("server_id,computer_id,observed_state,id"), n("server_id,desired_state,observed_state,im_state,last_observed_at,id")},
		},
		"agent_im_routes": {
			fields:  "id im_user_id server_id agent_id state created_at updated_at",
			indexes: []indexContract{u("im_user_id"), n("server_id,agent_id")},
		},
		"agent_runtime_credentials": {
			fields:   "id server_id agent_id version secret_hash state last_used_at created_at revoked_at",
			nillable: "last_used_at revoked_at",
			indexes:  []indexContract{u("server_id,agent_id,version"), u("server_id,secret_hash"), n("server_id,agent_id,state,version")},
		},
		"computers": {
			fields:   "id server_id name tat_region tat_instance_id tat_instance_kind os_type lifecycle_state tat_agent_state registration_expires_at last_observed_at last_error_code assignment_epoch assignment_revision host_last_seen_at daemon_version daemon_build_id daemon_version_token_issued_at last_reconcile_error_code enrollment_generation enrollment_token_hash enrollment_expires_at enrollment_claimed_at enrollment_credential_version enrollment_release_version enrollment_release_set_json enrollment_target enrollment_architecture enrollment_manifest_object enrollment_manifest_sha256 enrollment_signature_object enrollment_signature_sha256 enrollment_installer_object enrollment_installer_sha256 enrollment_signing_key_id enrollment_program_object enrollment_program_sha256 enrollment_program_size revision created_at updated_at",
			nillable: "tat_instance_id registration_expires_at last_observed_at last_error_code host_last_seen_at daemon_version daemon_build_id daemon_version_token_issued_at last_reconcile_error_code enrollment_token_hash enrollment_expires_at enrollment_claimed_at enrollment_credential_version enrollment_release_version enrollment_release_set_json enrollment_target enrollment_architecture enrollment_manifest_object enrollment_manifest_sha256 enrollment_signature_object enrollment_signature_sha256 enrollment_installer_object enrollment_installer_sha256 enrollment_signing_key_id enrollment_program_object enrollment_program_sha256 enrollment_program_size",
			indexes:  []indexContract{u("server_id,tat_region,tat_instance_id"), n("server_id,lifecycle_state,id"), n("server_id,tat_agent_state,last_observed_at")},
		},
		"computer_setup_codes": {
			fields:  "id code_hash server_id computer_id generation expires_at created_at",
			indexes: []indexContract{u("code_hash"), n("code_hash,expires_at,id")},
		},
		"computer_runtime_credentials": {
			fields:   "id server_id computer_id version secret_hash state expires_at grace_expires_at last_used_at revoked_at created_at",
			nillable: "grace_expires_at last_used_at revoked_at",
			indexes:  []indexContract{u("server_id,computer_id,version"), u("server_id,secret_hash"), n("server_id,computer_id,state,version"), n("server_id,expires_at,id")},
		},
		"computer_agent_observations": {
			fields:   "id server_id computer_id agent_id assignment_epoch assignment_revision config_generation credential_version attempt sequence launch_id state im_transport_state error_code accepted_at_ingest rejection_reason_at_ingest request_hash observed_at created_at",
			nillable: "error_code rejection_reason_at_ingest",
			indexes:  []indexContract{u("server_id,id"), n("server_id,agent_id,config_generation,attempt,sequence"), n("server_id,computer_id,created_at,id")},
		},
		"tat_instance_bindings": {
			fields:  "id binding_hash tat_region tat_instance_id server_id computer_id state created_at updated_at",
			indexes: []indexContract{u("binding_hash"), n("binding_hash,server_id,computer_id")},
		},
		"channels": {
			fields:   "id server_id name description visibility system_key im_group_id im_topic_id im_state revision created_at updated_at",
			nillable: "description system_key im_topic_id",
			indexes:  []indexContract{u("server_id,name"), u("server_id,system_key"), u("server_id,im_group_id,im_topic_id"), n("server_id,im_state,id")},
		},
		"channel_members": {
			fields:  "id server_id channel_id member_id state im_state membership_version created_at updated_at",
			indexes: []indexContract{u("server_id,channel_id,member_id"), n("server_id,member_id,state,channel_id"), n("server_id,channel_id,state,member_id")},
		},
		"direct_conversations": {
			fields:  "id server_id member_a_id member_b_id im_group_id status im_state revision created_at updated_at",
			indexes: []indexContract{u("server_id,member_a_id,member_b_id"), u("server_id,im_group_id"), n("server_id,member_a_id,updated_at,id"), n("server_id,member_b_id,updated_at,id"), n("server_id,im_state,id")},
		},
		"message_thread_refs": {
			fields:   "id server_id channel_id thread_id role message_kind message_id group_id topic_id sender_user_id message_sequence message_timestamp created_by_member_id reply_count last_reply_at created_at updated_at",
			nillable: "group_id topic_id sender_user_id last_reply_at",
			indexes:  []indexContract{u("server_id,channel_id,message_id"), n("server_id,thread_id,role,message_sequence,id"), n("server_id,channel_id,role,last_reply_at,id")},
		},
		"message_thread_reads": {
			fields:  "id server_id thread_id member_id last_read_ref_id last_read_sequence last_read_at revision created_at updated_at",
			indexes: []indexContract{u("server_id,thread_id,member_id"), n("server_id,member_id,updated_at,id")},
		},
		"tasks": {
			fields:   "id server_id number title description status owner_member_id assignment_revision created_by_member_id updated_by_member_id source_message_ref_json revision created_at updated_at",
			nillable: "description owner_member_id source_message_ref_json",
			indexes:  []indexContract{u("server_id,number"), n("server_id,owner_member_id,status,id"), n("server_id,status,updated_at,id")},
		},
		"reminders": {
			fields:   "id server_id agent_id created_by_member_id schedule_kind schedule timezone text status next_fire_at anchor_kind anchor_channel_id anchor_thread_id anchor_message_ref_json revision created_at updated_at",
			nillable: "next_fire_at anchor_kind anchor_channel_id anchor_thread_id anchor_message_ref_json",
			indexes:  []indexContract{n("server_id,agent_id,status,id"), n("server_id,status,next_fire_at,id")},
		},
		"reminder_occurrences": {
			fields:   "id server_id reminder_id agent_id scheduled_fire_at state acknowledged_at result_code text_snapshot created_at updated_at",
			nillable: "acknowledged_at result_code",
			indexes:  []indexContract{u("server_id,reminder_id,scheduled_fire_at"), n("server_id,agent_id,state,scheduled_fire_at,id")},
		},
		"tencent_operations": {
			fields:   "id partition_key server_id service kind resource_type resource_id idempotency_key desired_revision request_snapshot_json state attempts next_attempt_at lease_owner lease_expires_at deadline_at last_error_code result_json created_at updated_at completed_at",
			nillable: "server_id desired_revision request_snapshot_json next_attempt_at lease_owner lease_expires_at deadline_at last_error_code result_json completed_at",
			indexes:  []indexContract{u("partition_key,service,idempotency_key"), n("partition_key,state,next_attempt_at,id"), n("partition_key,resource_type,resource_id,desired_revision")},
		},
		"idempotency_records": {
			fields:  "id partition_key scope_type scope_id idempotency_key request_hash response_status response_body_json expires_at created_at",
			indexes: []indexContract{u("partition_key,scope_type,scope_id,idempotency_key"), n("partition_key,expires_at,id")},
		},
		"outbox_events": {
			fields:   "id partition_key server_id event_type aggregate_type aggregate_id state attempts available_at lease_owner lease_expires_at last_error_code created_at processed_at",
			nillable: "server_id lease_owner lease_expires_at last_error_code processed_at",
			indexes:  []indexContract{n("partition_key,state,available_at,id"), n("partition_key,aggregate_type,aggregate_id,id")},
		},
	}
}
