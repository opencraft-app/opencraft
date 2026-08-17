package consistency

import (
	"context"
	"database/sql"
	"fmt"
	"path/filepath"
	"strings"
	"testing"

	"chatserver/internal/database/modelcontract"
	_ "modernc.org/sqlite"
)

func TestScannerCoverageMatchesEveryDeclaredLogicalReference(t *testing.T) {
	contract, err := modelcontract.LoadFile(filepath.Join("..", "..", "..", "platform", "v1", "model-contract.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	covered := make(map[string]referenceCoverage)
	for _, entry := range scannerReferenceCoverage() {
		key := entry.table + "." + entry.field
		if _, duplicate := covered[key]; duplicate {
			t.Errorf("scanner reference coverage 重复: %s", key)
		}
		if entry.scope == "" || entry.check == "" {
			t.Errorf("scanner reference coverage 不完整: %#v", entry)
		}
		covered[key] = entry
	}
	for _, table := range contract.Tables {
		for _, reference := range table.References {
			key := table.Table + "." + reference.Field
			if _, ok := covered[key]; !ok {
				t.Errorf("领域引用未被一致性扫描器覆盖: %s -> %s", key, reference.Table)
			}
		}
	}
	if len(covered) == 0 {
		t.Fatal(fmt.Errorf("scanner reference coverage 为空"))
	}
}

func TestServerScanFindsOrphanWithoutCrossPartitionInput(t *testing.T) {
	db, err := sql.Open("sqlite", "file:consistency-test?mode=memory&cache=shared")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	statements := []string{
		`CREATE TABLE members(id TEXT,server_id TEXT,account_id TEXT,kind TEXT,status TEXT)`,
		`CREATE TABLE accounts(id TEXT)`,
		`CREATE TABLE servers(id TEXT,slug TEXT,owner_member_id TEXT)`,
		`CREATE TABLE server_invites(id TEXT,server_id TEXT,created_by_member_id TEXT,landing_channel_id TEXT)`,
		`CREATE TABLE server_slug_registry(id TEXT,slug TEXT,server_id TEXT)`,
		`CREATE TABLE agent_im_routes(id TEXT,im_user_id TEXT,server_id TEXT,agent_id TEXT)`,
		`CREATE TABLE tat_instance_bindings(id TEXT,binding_hash TEXT,server_id TEXT,computer_id TEXT,state TEXT)`,
		`CREATE TABLE computer_setup_codes(id TEXT,code_hash TEXT,server_id TEXT,computer_id TEXT)`,
		`CREATE TABLE agents(id TEXT,server_id TEXT,computer_id TEXT,im_user_id TEXT,created_by_member_id TEXT,credential_version INTEGER,current_launch_id TEXT,current_launch_assignment_epoch TEXT,current_launch_generation INTEGER,current_launch_credential_version INTEGER,current_launch_attempt INTEGER,profile_capability_refresh_id TEXT,deleted_at TEXT)`,
		`CREATE TABLE agent_runtime_credentials(id TEXT,server_id TEXT,agent_id TEXT,version INTEGER,state TEXT)`,
		`CREATE TABLE computers(id TEXT,server_id TEXT,lifecycle_state TEXT,tat_region TEXT,tat_instance_id TEXT)`,
		`CREATE TABLE channels(id TEXT,server_id TEXT)`,
		`CREATE TABLE channel_members(id TEXT,server_id TEXT,channel_id TEXT,member_id TEXT)`,
		`CREATE TABLE direct_conversations(id TEXT,server_id TEXT,member_a_id TEXT,member_b_id TEXT)`,
		`CREATE TABLE message_thread_refs(id TEXT,server_id TEXT,channel_id TEXT,thread_id TEXT,role TEXT,message_sequence INTEGER,created_by_member_id TEXT)`,
		`CREATE TABLE message_thread_reads(id TEXT,server_id TEXT,thread_id TEXT,member_id TEXT,last_read_ref_id TEXT,last_read_sequence INTEGER)`,
		`CREATE TABLE tasks(id TEXT,server_id TEXT,owner_member_id TEXT,created_by_member_id TEXT,updated_by_member_id TEXT,source_message_ref_json TEXT)`,
		`CREATE TABLE reminders(id TEXT,server_id TEXT,agent_id TEXT,created_by_member_id TEXT,anchor_channel_id TEXT,anchor_thread_id TEXT,anchor_message_ref_json TEXT)`,
		`CREATE TABLE reminder_occurrences(id TEXT,server_id TEXT,reminder_id TEXT,agent_id TEXT)`,
		`CREATE TABLE computer_runtime_credentials(id TEXT,server_id TEXT,computer_id TEXT,version INTEGER,expires_at TEXT,created_at TEXT)`,
		`CREATE TABLE computer_agent_observations(id TEXT,server_id TEXT,computer_id TEXT,agent_id TEXT,assignment_epoch TEXT,sequence INTEGER,attempt INTEGER,config_generation INTEGER,credential_version INTEGER,accepted_at_ingest INTEGER,rejection_reason_at_ingest TEXT,launch_id TEXT,created_at TEXT)`,
		`CREATE TABLE tencent_operations(id TEXT,partition_key TEXT,server_id TEXT,service TEXT,kind TEXT,resource_type TEXT,resource_id TEXT,state TEXT,request_snapshot_json TEXT,result_json TEXT)`,
		`CREATE TABLE outbox_events(id TEXT,partition_key TEXT,server_id TEXT)`,
		`CREATE TABLE idempotency_records(id TEXT,partition_key TEXT,scope_type TEXT,response_body_json TEXT)`,
		`CREATE TABLE account_server_memberships(id TEXT,account_id TEXT,server_id TEXT,member_id TEXT)`,
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Exec(`INSERT INTO accounts(id) VALUES('account-a'); INSERT INTO members(id,server_id,account_id,kind,status) VALUES('creator','server-a','account-a','human','active'); INSERT INTO servers(id,slug) VALUES('server-a','server-a'); INSERT INTO server_slug_registry(id,slug,server_id) VALUES('slug-a','server-a','server-a')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO agents(id,server_id,im_user_id,created_by_member_id,credential_version) VALUES('agent-orphan','server-a','agent-im','creator',1)`); err != nil {
		t.Fatal(err)
	}
	scanner, err := New(db)
	if err != nil {
		t.Fatal(err)
	}
	report, err := scanner.Scan(context.Background(), Options{Scope: ScopeServer, PartitionKey: "server-a", Limit: 100})
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Issues) != 3 ||
		report.Issues[0].Check != "agent_computer" ||
		report.Issues[0].ResourceID != "agent-orphan" ||
		report.Issues[1].Check != "agent_member" ||
		report.Issues[2].Check != "authority_registry" {
		t.Fatalf("issues = %#v", report.Issues)
	}
}

func TestServerScanDoesNotCompareHistoricalAcceptedReceiptWithCurrentLaunch(t *testing.T) {
	db := openScannerFixture(t)
	defer db.Close()
	_, err := db.Exec(`INSERT INTO computers(id,server_id,lifecycle_state,tat_region) VALUES('computer-1','server-a','active','ap-beijing')`)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`INSERT INTO members(id,server_id,account_id,kind,status) VALUES('agent-1','server-a','account-a','agent','active')`)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`INSERT INTO agents(id,server_id,computer_id,im_user_id,created_by_member_id,credential_version,current_launch_id,current_launch_assignment_epoch,current_launch_generation,current_launch_credential_version,current_launch_attempt) VALUES('agent-1','server-a','computer-1','agent-im','agent-1',2,'launch-new','epoch-new',2,2,2)`)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`INSERT INTO agent_im_routes(id,im_user_id,server_id,agent_id) VALUES('route-1','agent-im','server-a','agent-1')`)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`INSERT INTO computer_agent_observations(id,server_id,computer_id,agent_id,assignment_epoch,sequence,attempt,config_generation,credential_version,accepted_at_ingest,launch_id,created_at) VALUES('receipt-old','server-a','computer-1','agent-1','epoch-old',1,1,1,1,1,'launch-old','2026-01-01')`)
	if err != nil {
		t.Fatal(err)
	}
	scanner, _ := New(db)
	report, err := scanner.Scan(context.Background(), Options{Scope: ScopeServer, PartitionKey: "server-a", Limit: 100})
	if err != nil {
		t.Fatal(err)
	}
	for _, issue := range report.Issues {
		if issue.Check == "observation_refs" {
			t.Fatalf("历史 receipt 被误报: %#v", report.Issues)
		}
	}
}

func TestServerScanAcceptsDeletedAgentMemberTombstoneAndRejectsActiveCredential(t *testing.T) {
	db := openScannerFixture(t)
	defer db.Close()
	if _, err := db.Exec(`INSERT INTO members(id,server_id,account_id,kind,status) VALUES('agent-deleted','server-a','account-a','agent','removed')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO agents(id,server_id,im_user_id,created_by_member_id,credential_version,deleted_at) VALUES('agent-deleted','server-a','agent-im-deleted','creator',3,'2026-08-04T03:00:00Z')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO agent_runtime_credentials(id,server_id,agent_id,version,state) VALUES('credential-deleted','server-a','agent-deleted',3,'active')`); err != nil {
		t.Fatal(err)
	}

	scanner, _ := New(db)
	report, err := scanner.Scan(context.Background(), Options{Scope: ScopeServer, PartitionKey: "server-a", Limit: 100})
	if err != nil {
		t.Fatal(err)
	}
	foundCredential := false
	for _, issue := range report.Issues {
		if issue.Check == "agent_member" && issue.ResourceID == "agent-deleted" {
			t.Fatalf("已删除 Agent 的 removed Member 被误报: %#v", report.Issues)
		}
		if issue.Check == "runtime_credential" && issue.ResourceID == "credential-deleted" {
			foundCredential = true
		}
	}
	if !foundCredential {
		t.Fatalf("已删除 Agent 的 active credential 未被发现: %#v", report.Issues)
	}
}

func TestServerScanRequiresComputerForActiveAgentButPreservesDeletedHistory(t *testing.T) {
	db := openScannerFixture(t)
	defer db.Close()
	statements := []string{
		`INSERT INTO members(id,server_id,account_id,kind,status) VALUES('agent-active','server-a','account-a','agent','active')`,
		`INSERT INTO agents(id,server_id,im_user_id,created_by_member_id,credential_version) VALUES('agent-active','server-a','im-active','creator',0)`,
		`INSERT INTO agent_im_routes(id,im_user_id,server_id,agent_id) VALUES('route-active','im-active','server-a','agent-active')`,
		`INSERT INTO computers(id,server_id,lifecycle_state,tat_region) VALUES('computer-removed','server-a','removed','ap-beijing')`,
		`INSERT INTO members(id,server_id,account_id,kind,status) VALUES('agent-deleted-bound','server-a','account-a','agent','removed')`,
		`INSERT INTO agents(id,server_id,computer_id,im_user_id,created_by_member_id,credential_version,deleted_at) VALUES('agent-deleted-bound','server-a','computer-removed','im-deleted-bound','creator',0,'2026-08-04T03:00:00Z')`,
		`INSERT INTO agent_im_routes(id,im_user_id,server_id,agent_id) VALUES('route-deleted-bound','im-deleted-bound','server-a','agent-deleted-bound')`,
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}

	scanner, _ := New(db)
	report, err := scanner.Scan(context.Background(), Options{
		Scope: ScopeServer, PartitionKey: "server-a", Limit: 100,
	})
	if err != nil {
		t.Fatal(err)
	}
	foundActive := false
	for _, issue := range report.Issues {
		if issue.Check != "agent_computer" {
			continue
		}
		if issue.ResourceID == "agent-active" {
			foundActive = true
		}
		if issue.ResourceID == "agent-deleted-bound" {
			t.Fatalf("历史 Agent 指向 removed Computer 被误报: %#v", report.Issues)
		}
	}
	if !foundActive {
		t.Fatalf("未绑定 Computer 的活跃 Agent 未被发现: %#v", report.Issues)
	}
}

func openScannerFixture(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+t.Name()+"?mode=memory&cache=shared")
	if err != nil {
		t.Fatal(err)
	}
	statements := []string{
		`CREATE TABLE servers(id TEXT,slug TEXT,owner_member_id TEXT)`,
		`CREATE TABLE server_invites(id TEXT,server_id TEXT,created_by_member_id TEXT,landing_channel_id TEXT)`,
		`CREATE TABLE server_slug_registry(id TEXT,slug TEXT,server_id TEXT)`,
		`CREATE TABLE accounts(id TEXT)`,
		`CREATE TABLE account_login_identities(id TEXT,login_hash TEXT,account_id TEXT)`,
		`CREATE TABLE members(id TEXT,server_id TEXT,account_id TEXT,kind TEXT,status TEXT)`,
		`CREATE TABLE agents(id TEXT,server_id TEXT,computer_id TEXT,im_user_id TEXT,created_by_member_id TEXT,credential_version INTEGER,current_launch_id TEXT,current_launch_assignment_epoch TEXT,current_launch_generation INTEGER,current_launch_credential_version INTEGER,current_launch_attempt INTEGER,profile_capability_refresh_id TEXT,deleted_at TEXT)`,
		`CREATE TABLE agent_runtime_credentials(id TEXT,server_id TEXT,agent_id TEXT,version INTEGER,state TEXT)`,
		`CREATE TABLE agent_im_routes(id TEXT,im_user_id TEXT,server_id TEXT,agent_id TEXT)`,
		`CREATE TABLE computers(id TEXT,server_id TEXT,lifecycle_state TEXT,tat_region TEXT,tat_instance_id TEXT)`,
		`CREATE TABLE tat_instance_bindings(id TEXT,binding_hash TEXT,server_id TEXT,computer_id TEXT,state TEXT)`,
		`CREATE TABLE computer_setup_codes(id TEXT,code_hash TEXT,server_id TEXT,computer_id TEXT)`,
		`CREATE TABLE channels(id TEXT,server_id TEXT)`, `CREATE TABLE channel_members(id TEXT,server_id TEXT,channel_id TEXT,member_id TEXT)`,
		`CREATE TABLE direct_conversations(id TEXT,server_id TEXT,member_a_id TEXT,member_b_id TEXT)`,
		`CREATE TABLE message_thread_refs(id TEXT,server_id TEXT,channel_id TEXT,thread_id TEXT,role TEXT,message_sequence INTEGER,created_by_member_id TEXT)`,
		`CREATE TABLE message_thread_reads(id TEXT,server_id TEXT,thread_id TEXT,member_id TEXT,last_read_ref_id TEXT,last_read_sequence INTEGER)`,
		`CREATE TABLE tasks(id TEXT,server_id TEXT,owner_member_id TEXT,created_by_member_id TEXT,updated_by_member_id TEXT,source_message_ref_json TEXT)`,
		`CREATE TABLE reminders(id TEXT,server_id TEXT,agent_id TEXT,created_by_member_id TEXT,anchor_channel_id TEXT,anchor_thread_id TEXT,anchor_message_ref_json TEXT)`,
		`CREATE TABLE reminder_occurrences(id TEXT,server_id TEXT,reminder_id TEXT,agent_id TEXT)`,
		`CREATE TABLE computer_runtime_credentials(id TEXT,server_id TEXT,computer_id TEXT,version INTEGER,expires_at TEXT,created_at TEXT)`,
		`CREATE TABLE computer_agent_observations(id TEXT,server_id TEXT,computer_id TEXT,agent_id TEXT,assignment_epoch TEXT,sequence INTEGER,attempt INTEGER,config_generation INTEGER,credential_version INTEGER,accepted_at_ingest INTEGER,rejection_reason_at_ingest TEXT,launch_id TEXT,created_at TEXT)`,
		`CREATE TABLE tencent_operations(id TEXT,partition_key TEXT,server_id TEXT,service TEXT,kind TEXT,resource_type TEXT,resource_id TEXT,state TEXT,request_snapshot_json TEXT,result_json TEXT)`, `CREATE TABLE outbox_events(id TEXT,partition_key TEXT,server_id TEXT)`,
		`CREATE TABLE idempotency_records(id TEXT,partition_key TEXT,scope_type TEXT,response_body_json TEXT)`,
		`CREATE TABLE account_server_memberships(id TEXT,account_id TEXT,server_id TEXT,member_id TEXT)`,
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			db.Close()
			t.Fatal(err)
		}
	}
	if _, err := db.Exec(`INSERT INTO accounts(id) VALUES('account-a'); INSERT INTO members(id,server_id,account_id,kind,status) VALUES('creator','server-a','account-a','human','active'); INSERT INTO servers(id,slug) VALUES('server-a','server-a'); INSERT INTO server_slug_registry(id,slug,server_id) VALUES('slug-a','server-a','server-a')`); err != nil {
		db.Close()
		t.Fatal(err)
	}
	return db
}

func TestServerScanRequiresActiveBindingForCurrentComputerButAllowsRetiredTombstone(t *testing.T) {
	db := openScannerFixture(t)
	defer db.Close()
	activeHash := tatBindingHash("ap-guangzhou", "rins-active")
	removedHash := tatBindingHash("ap-guangzhou", "rins-retired")
	_, err := db.Exec(`
		INSERT INTO computers(id,server_id,lifecycle_state,tat_region,tat_instance_id)
		VALUES('computer-active','server-a','active','ap-guangzhou','rins-active');
		INSERT INTO computers(id,server_id,lifecycle_state,tat_region,tat_instance_id)
		VALUES('computer-removed','server-a','removed','ap-guangzhou',NULL);
		INSERT INTO tat_instance_bindings(id,binding_hash,server_id,computer_id,state)
		VALUES('binding-active',?,'server-a','computer-active','retired');
		INSERT INTO tat_instance_bindings(id,binding_hash,server_id,computer_id,state)
		VALUES('binding-retired',?,'server-a','computer-removed','retired')`, activeHash, removedHash)
	if err != nil {
		t.Fatal(err)
	}
	scanner, _ := New(db)
	report, err := scanner.Scan(context.Background(), Options{Scope: ScopeServer, PartitionKey: "server-a", Limit: 100})
	if err != nil {
		t.Fatal(err)
	}
	if !containsIssue(report.Issues, "authority_registry", "computer-active") {
		t.Fatalf("retired binding incorrectly satisfies active Computer: %#v", report.Issues)
	}
	if containsIssue(report.Issues, "authority_registry", "computer-removed") {
		t.Fatalf("removed Computer retired tombstone was treated as current binding: %#v", report.Issues)
	}
}

func containsIssue(issues []Issue, check, resourceID string) bool {
	for _, issue := range issues {
		if issue.Check == check && issue.ResourceID == resourceID {
			return true
		}
	}
	return false
}

func TestScanRejectsWrongScopeCursorBinding(t *testing.T) {
	db, err := sql.Open("sqlite", "file:consistency-empty?mode=memory&cache=shared")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	scanner, _ := New(db)
	if _, err := scanner.Scan(context.Background(), Options{Scope: ScopeRegistry, PartitionKey: "x", Limit: 10}); err == nil {
		t.Fatal("registry scan without registry type was accepted")
	}
}

func TestServerScanCursorContinuesInsideOneRuleWithoutDuplicates(t *testing.T) {
	db := openScannerFixture(t)
	defer db.Close()
	for _, id := range []string{"agent-a", "agent-b", "agent-c"} {
		if _, err := db.Exec(`INSERT INTO agents(id,server_id,im_user_id,created_by_member_id,credential_version) VALUES(?,?,?,?,?)`, id, "server-a", "im-"+id, "creator", 1); err != nil {
			t.Fatal(err)
		}
	}
	scanner, _ := New(db)
	first, err := scanner.Scan(context.Background(), Options{Scope: ScopeServer, PartitionKey: "server-a", Limit: 2})
	if err != nil || len(first.Issues) != 2 || first.NextCursor == nil {
		t.Fatalf("first page = %#v, %v", first, err)
	}
	second, err := scanner.Scan(context.Background(), Options{Scope: ScopeServer, PartitionKey: "server-a", Limit: 2, Cursor: *first.NextCursor})
	if err != nil || len(second.Issues) != 2 || second.Issues[0].ResourceID != "agent-c" {
		t.Fatalf("second page = %#v, %v", second, err)
	}
	if issueKey(first.Issues[1]) >= issueKey(second.Issues[0]) {
		t.Fatalf("分页键未单调: %#v -> %#v", first.Issues, second.Issues)
	}
}

func TestAccountAndRegistryScopesUsePointRoutedAuthorityChecks(t *testing.T) {
	db := openScannerFixture(t)
	defer db.Close()
	if _, err := db.Exec(`INSERT INTO account_server_memberships(id,account_id,server_id,member_id) VALUES('projection-1','account-a','server-a','member-missing')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO account_login_identities(id,login_hash,account_id) VALUES('login-1','login-hash','account-missing')`); err != nil {
		t.Fatal(err)
	}
	scanner, _ := New(db)
	account, err := scanner.Scan(context.Background(), Options{Scope: ScopeAccount, PartitionKey: "account-a", Limit: 10})
	if err != nil || len(account.Issues) != 1 || account.Issues[0].Check != "membership_projection" {
		t.Fatalf("account report = %#v, %v", account, err)
	}
	registry, err := scanner.Scan(context.Background(), Options{Scope: ScopeRegistry, RegistryType: "login", PartitionKey: "login-hash", Limit: 10})
	if err != nil || len(registry.Issues) != 1 || registry.Issues[0].Check != "registry_target" {
		t.Fatalf("registry report = %#v, %v", registry, err)
	}
}

func TestServerScanReportsUnknownPersistedJSONVersion(t *testing.T) {
	db := openScannerFixture(t)
	defer db.Close()
	if _, err := db.Exec(`INSERT INTO idempotency_records(id,partition_key,scope_type,response_body_json) VALUES('idem-1','server-a','task.create','{"schemaVersion":2,"payload":{}}')`); err != nil {
		t.Fatal(err)
	}
	scanner, _ := New(db)
	report, err := scanner.Scan(context.Background(), Options{Scope: ScopeServer, PartitionKey: "server-a", Limit: 100})
	if err != nil || len(report.Issues) != 1 || report.Issues[0].Check != "persisted_json" {
		t.Fatalf("report = %#v, %v", report, err)
	}
}

func TestServerScanCoversPreviouslyUnverifiedDomainReferences(t *testing.T) {
	db := openScannerFixture(t)
	defer db.Close()
	statements := []string{
		`UPDATE servers SET owner_member_id='missing-owner' WHERE id='server-a'`,
		`INSERT INTO server_invites(id,server_id,created_by_member_id) VALUES('invite-1','server-a','missing-creator')`,
		`INSERT INTO members(id,server_id,account_id,kind,status) VALUES('member-orphan','server-a','missing-account','human','active')`,
		`INSERT INTO agents(id,server_id,im_user_id,created_by_member_id,credential_version) VALUES('agent-creator-orphan','server-a','im-orphan','missing-creator',1)`,
		`INSERT INTO agent_runtime_credentials(id,server_id,agent_id,version,state) VALUES('credential-1','server-a','missing-agent',1,'active')`,
		`INSERT INTO message_thread_refs(id,server_id,channel_id,thread_id,role,message_sequence,created_by_member_id) VALUES('thread-1','server-a','missing-channel','thread-1','root',1,'missing-creator')`,
		`INSERT INTO message_thread_reads(id,server_id,thread_id,member_id,last_read_ref_id,last_read_sequence) VALUES('read-1','server-a','missing-thread','missing-member','missing-ref',1)`,
		`INSERT INTO reminders(id,server_id,agent_id,created_by_member_id,anchor_channel_id,anchor_thread_id) VALUES('reminder-1','server-a','missing-agent','missing-creator','missing-channel','missing-thread')`,
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}

	scanner, _ := New(db)
	report, err := scanner.Scan(context.Background(), Options{Scope: ScopeServer, PartitionKey: "server-a", Limit: 1000})
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]bool{
		"server_owner": false, "invite_creator": false, "member_account": false,
		"agent_creator": false, "runtime_credential": false, "thread_ref": false,
		"thread_read": false, "reminder_refs": false,
	}
	for _, issue := range report.Issues {
		if _, expected := want[issue.Check]; expected {
			want[issue.Check] = true
		}
	}
	for check, found := range want {
		if !found {
			t.Errorf("未报告 %s：%#v", check, report.Issues)
		}
	}
}

func TestEveryRelationalServerCheckCarriesItsServerShardKey(t *testing.T) {
	for _, check := range serverChecks() {
		if !strings.Contains(check.query, "WHERE") ||
			(!strings.Contains(check.query, ".server_id=?") && !strings.Contains(check.query, "partition_key=?") && !strings.Contains(check.query, "s.id=?")) {
			t.Errorf("%s 未显式携带 Server shardkey: %s", check.name, check.query)
		}
	}
}
