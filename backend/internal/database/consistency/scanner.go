// Package consistency provides bounded, partition-routed integrity checks for
// relationships intentionally not enforced by database foreign keys.
package consistency

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
	"strings"

	"chatserver/internal/pagination"
	"chatserver/internal/persistedjson"
)

type Scope string

const (
	ScopeServer   Scope = "server"
	ScopeAccount  Scope = "account"
	ScopeRegistry Scope = "registry"
)

type Options struct {
	Scope        Scope
	PartitionKey string
	RegistryType string
	Cursor       string
	Limit        int
}

type Issue struct {
	Check        string `json:"check"`
	ResourceType string `json:"resourceType"`
	ResourceID   string `json:"resourceId"`
	Detail       string `json:"detail"`
}

type Report struct {
	Scope        Scope   `json:"scope"`
	PartitionKey string  `json:"partitionKey"`
	Issues       []Issue `json:"issues"`
	NextCursor   *string `json:"nextCursor"`
}

type Scanner struct{ db *sql.DB }

func New(db *sql.DB) (*Scanner, error) {
	if db == nil {
		return nil, errors.New("一致性扫描器缺少数据库连接")
	}
	return &Scanner{db: db}, nil
}

func (scanner *Scanner) Scan(ctx context.Context, options Options) (Report, error) {
	if ctx == nil || strings.TrimSpace(options.PartitionKey) == "" || options.Limit < 1 || options.Limit > 1000 {
		return Report{}, errors.New("一致性扫描参数无效")
	}
	if options.Scope != ScopeServer && options.Scope != ScopeAccount && options.Scope != ScopeRegistry {
		return Report{}, errors.New("一致性扫描 scope 无效")
	}
	if options.Scope == ScopeRegistry && !knownRegistry(options.RegistryType) {
		return Report{}, errors.New("registry scope 必须提供合法 registry-type")
	}
	filter := fmt.Sprintf("scope=%s&partition=%s&registry=%s", options.Scope, options.PartitionKey, options.RegistryType)
	after := ""
	if options.Cursor != "" {
		values, err := pagination.Decode(options.Cursor, "checkConsistency", filter, 1)
		if err != nil {
			return Report{}, fmt.Errorf("一致性扫描 cursor 无效: %w", err)
		}
		after = values[0]
	}
	var issues []Issue
	var err error
	switch options.Scope {
	case ScopeServer:
		issues, err = scanner.scanServer(ctx, options.PartitionKey, after, options.Limit+1)
	case ScopeAccount:
		issues, err = scanner.scanAccount(ctx, options.PartitionKey, after, options.Limit+1)
	case ScopeRegistry:
		issues, err = scanner.scanRegistry(ctx, options.RegistryType, options.PartitionKey, after)
	}
	if err != nil {
		return Report{}, err
	}
	sort.Slice(issues, func(i, j int) bool { return issueKey(issues[i]) < issueKey(issues[j]) })
	if after != "" {
		index := sort.Search(len(issues), func(index int) bool { return issueKey(issues[index]) > after })
		issues = issues[index:]
	}
	result := Report{Scope: options.Scope, PartitionKey: options.PartitionKey}
	if len(issues) > options.Limit {
		issues = issues[:options.Limit]
		next, encodeErr := pagination.Encode("checkConsistency", filter, issueKey(issues[len(issues)-1]))
		if encodeErr != nil {
			return Report{}, encodeErr
		}
		result.NextCursor = &next
	}
	result.Issues = issues
	return result, nil
}

type routedCheck struct {
	name, resourceType, detail, query, cursorColumn string
}

// referenceCoverage 把领域契约中的逻辑引用绑定到真实扫描规则。数据库没有外键时，
// 这份清单使“新增 reference 却忘记补一致性检查”成为可测试的契约漂移。
type referenceCoverage struct {
	table, field string
	scope        Scope
	check        string
}

func scannerReferenceCoverage() []referenceCoverage {
	partition := func(table string) referenceCoverage {
		return referenceCoverage{table: table, field: "server_id", scope: ScopeServer, check: "partition_authority"}
	}
	return []referenceCoverage{
		{table: "account_login_identities", field: "account_id", scope: ScopeRegistry, check: "registry_target"},
		{table: "auth_sessions", field: "account_id", scope: ScopeAccount, check: "account_authority"},
		{table: "account_server_memberships", field: "account_id", scope: ScopeAccount, check: "account_authority"},
		{table: "account_server_memberships", field: "server_id", scope: ScopeAccount, check: "membership_projection"},
		{table: "account_server_memberships", field: "member_id", scope: ScopeAccount, check: "membership_projection"},
		{table: "server_slug_registry", field: "server_id", scope: ScopeRegistry, check: "registry_target"},
		{table: "servers", field: "owner_member_id", scope: ScopeServer, check: "server_owner"},
		partition("server_invites"),
		{table: "server_invites", field: "created_by_member_id", scope: ScopeServer, check: "invite_creator"},
		{table: "server_invites", field: "landing_channel_id", scope: ScopeServer, check: "invite_landing"},
		partition("members"),
		{table: "members", field: "account_id", scope: ScopeServer, check: "member_account"},
		partition("agents"),
		{table: "agents", field: "computer_id", scope: ScopeServer, check: "agent_computer"},
		{table: "agents", field: "created_by_member_id", scope: ScopeServer, check: "agent_creator"},
		{table: "agent_im_routes", field: "server_id", scope: ScopeRegistry, check: "registry_target"},
		{table: "agent_im_routes", field: "agent_id", scope: ScopeRegistry, check: "registry_target"},
		partition("agent_runtime_credentials"),
		{table: "agent_runtime_credentials", field: "agent_id", scope: ScopeServer, check: "runtime_credential"},
		partition("computers"),
		partition("computer_runtime_credentials"),
		{table: "computer_runtime_credentials", field: "computer_id", scope: ScopeServer, check: "computer_credential"},
		{table: "computer_setup_codes", field: "server_id", scope: ScopeRegistry, check: "registry_target"},
		{table: "computer_setup_codes", field: "computer_id", scope: ScopeRegistry, check: "registry_target"},
		partition("computer_agent_observations"),
		{table: "computer_agent_observations", field: "computer_id", scope: ScopeServer, check: "observation_refs"},
		{table: "computer_agent_observations", field: "agent_id", scope: ScopeServer, check: "observation_refs"},
		{table: "tat_instance_bindings", field: "server_id", scope: ScopeRegistry, check: "registry_target"},
		{table: "tat_instance_bindings", field: "computer_id", scope: ScopeRegistry, check: "registry_target"},
		partition("channels"),
		partition("channel_members"),
		{table: "channel_members", field: "channel_id", scope: ScopeServer, check: "channel_member"},
		{table: "channel_members", field: "member_id", scope: ScopeServer, check: "channel_member"},
		partition("direct_conversations"),
		{table: "direct_conversations", field: "member_a_id", scope: ScopeServer, check: "direct_conversation"},
		{table: "direct_conversations", field: "member_b_id", scope: ScopeServer, check: "direct_conversation"},
		partition("message_thread_refs"),
		{table: "message_thread_refs", field: "channel_id", scope: ScopeServer, check: "thread_ref"},
		{table: "message_thread_refs", field: "created_by_member_id", scope: ScopeServer, check: "thread_ref"},
		partition("message_thread_reads"),
		{table: "message_thread_reads", field: "thread_id", scope: ScopeServer, check: "thread_read"},
		{table: "message_thread_reads", field: "member_id", scope: ScopeServer, check: "thread_read"},
		{table: "message_thread_reads", field: "last_read_ref_id", scope: ScopeServer, check: "thread_read"},
		partition("tasks"),
		{table: "tasks", field: "owner_member_id", scope: ScopeServer, check: "task_members"},
		{table: "tasks", field: "created_by_member_id", scope: ScopeServer, check: "task_members"},
		{table: "tasks", field: "updated_by_member_id", scope: ScopeServer, check: "task_members"},
		partition("reminders"),
		{table: "reminders", field: "agent_id", scope: ScopeServer, check: "reminder_refs"},
		{table: "reminders", field: "created_by_member_id", scope: ScopeServer, check: "reminder_refs"},
		{table: "reminders", field: "anchor_channel_id", scope: ScopeServer, check: "reminder_refs"},
		{table: "reminders", field: "anchor_thread_id", scope: ScopeServer, check: "reminder_refs"},
		partition("reminder_occurrences"),
		{table: "reminder_occurrences", field: "reminder_id", scope: ScopeServer, check: "occurrence_refs"},
		{table: "reminder_occurrences", field: "agent_id", scope: ScopeServer, check: "occurrence_refs"},
		{table: "tencent_operations", field: "server_id", scope: ScopeServer, check: "operation_partition"},
		{table: "outbox_events", field: "server_id", scope: ScopeServer, check: "outbox_partition"},
	}
}

func (scanner *Scanner) scanServer(ctx context.Context, serverID, after string, limit int) ([]Issue, error) {
	checks := serverChecks()
	sort.Slice(checks, func(i, j int) bool { return checks[i].name < checks[j].name })
	afterCheck, afterID := splitIssueKey(after)
	authorityIssues, err := scanner.scanServerAuthority(ctx, serverID, afterCheck, afterID)
	if err != nil {
		return nil, err
	}
	issues := make([]Issue, 0, len(authorityIssues))
	issues = append(issues, authorityIssues...)
	for _, check := range checks {
		if afterCheck != "" && check.name < afterCheck {
			continue
		}
		cursorID := ""
		if check.name == afterCheck {
			cursorID = afterID
		}
		query := strings.Replace(check.query, " ORDER BY", " AND "+check.cursorColumn+">? ORDER BY", 1)
		rows, err := scanner.db.QueryContext(ctx, query, serverID, cursorID, limit)
		if err != nil {
			return nil, fmt.Errorf("一致性检查 %s 失败: %w", check.name, err)
		}
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				_ = rows.Close()
				return nil, err
			}
			issues = append(issues, Issue{Check: check.name, ResourceType: check.resourceType, ResourceID: id, Detail: check.detail})
		}
		if err := rows.Err(); err != nil {
			_ = rows.Close()
			return nil, err
		}
		if err := rows.Close(); err != nil {
			return nil, err
		}
	}
	memberIssues, err := scanner.scanMemberAccounts(ctx, serverID, afterCheck, afterID, limit)
	if err != nil {
		return nil, err
	}
	issues = append(issues, memberIssues...)
	registryIssues, err := scanner.scanServerRegistries(ctx, serverID, afterCheck, afterID, limit)
	if err != nil {
		return nil, err
	}
	issues = append(issues, registryIssues...)
	jsonIssues, err := scanner.scanServerPersistentJSON(ctx, serverID, afterCheck, afterID, limit)
	if err != nil {
		return nil, err
	}
	return append(issues, jsonIssues...), nil
}

func serverChecks() []routedCheck {
	return []routedCheck{
		{"agent_member", "agent", "Agent 与同 Server Agent Member 的生命周期不一致", `SELECT a.id FROM agents a LEFT JOIN members m ON m.server_id=a.server_id AND m.id=a.id WHERE a.server_id=? AND (m.id IS NULL OR m.kind<>'agent' OR (a.deleted_at IS NULL AND m.status<>'active') OR (a.deleted_at IS NOT NULL AND m.status<>'removed')) ORDER BY a.id LIMIT ?`, "a.id"},
		{"agent_computer", "agent", "活跃 Agent 必须绑定同 Server 已纳管 active Computer；历史引用必须仍存在", `SELECT a.id FROM agents a LEFT JOIN computers c ON c.server_id=a.server_id AND c.id=a.computer_id WHERE a.server_id=? AND ((a.deleted_at IS NULL AND (a.computer_id IS NULL OR c.id IS NULL OR c.lifecycle_state<>'active' OR c.tat_instance_id IS NULL)) OR (a.deleted_at IS NOT NULL AND a.computer_id IS NOT NULL AND c.id IS NULL)) ORDER BY a.id LIMIT ?`, "a.id"},
		{"agent_creator", "agent", "Agent creator 不在同 Server", `SELECT a.id FROM agents a LEFT JOIN members m ON m.server_id=a.server_id AND m.id=a.created_by_member_id WHERE a.server_id=? AND m.id IS NULL ORDER BY a.id LIMIT ?`, "a.id"},
		{"channel_member", "channel_member", "ChannelMember 的 Channel 或 Member 不在同 Server", `SELECT cm.id FROM channel_members cm LEFT JOIN channels c ON c.server_id=cm.server_id AND c.id=cm.channel_id LEFT JOIN members m ON m.server_id=cm.server_id AND m.id=cm.member_id WHERE cm.server_id=? AND (c.id IS NULL OR m.id IS NULL) ORDER BY cm.id LIMIT ?`, "cm.id"},
		{"direct_conversation", "direct_conversation", "DirectConversation 的 canonical Member 对无效", `SELECT d.id FROM direct_conversations d LEFT JOIN members a ON a.server_id=d.server_id AND a.id=d.member_a_id LEFT JOIN members b ON b.server_id=d.server_id AND b.id=d.member_b_id WHERE d.server_id=? AND (a.id IS NULL OR b.id IS NULL OR d.member_a_id>=d.member_b_id) ORDER BY d.id LIMIT ?`, "d.id"},
		{"invite_creator", "server_invite", "ServerInvite creator 不在同 Server", `SELECT i.id FROM server_invites i LEFT JOIN members m ON m.server_id=i.server_id AND m.id=i.created_by_member_id WHERE i.server_id=? AND m.id IS NULL ORDER BY i.id LIMIT ?`, "i.id"},
		{"invite_landing", "server_invite", "ServerInvite 落地 Channel 不在同 Server", `SELECT i.id FROM server_invites i LEFT JOIN channels c ON c.server_id=i.server_id AND c.id=i.landing_channel_id WHERE i.server_id=? AND i.landing_channel_id IS NOT NULL AND c.id IS NULL ORDER BY i.id LIMIT ?`, "i.id"},
		{"runtime_credential", "agent_runtime_credential", "Agent credential 指向缺失/已删除 Agent、版本无效或 active 版本漂移", `SELECT c.id FROM agent_runtime_credentials c LEFT JOIN agents a ON a.server_id=c.server_id AND a.id=c.agent_id WHERE c.server_id=? AND (a.id IS NULL OR c.version<1 OR (c.state='active' AND (a.deleted_at IS NOT NULL OR c.version<>a.credential_version))) ORDER BY c.id LIMIT ?`, "c.id"},
		{"server_owner", "server", "Server owner 不在本 Server", `SELECT s.id FROM servers s LEFT JOIN members m ON m.server_id=s.id AND m.id=s.owner_member_id WHERE s.id=? AND s.owner_member_id IS NOT NULL AND m.id IS NULL ORDER BY s.id LIMIT ?`, "s.id"},
		{"thread_read", "message_thread_read", "Thread read 的 Thread、Member 或最后已读引用无效", `SELECT r.id FROM message_thread_reads r LEFT JOIN message_thread_refs root ON root.server_id=r.server_id AND root.id=r.thread_id AND root.role='root' LEFT JOIN members m ON m.server_id=r.server_id AND m.id=r.member_id LEFT JOIN message_thread_refs last ON last.server_id=r.server_id AND last.id=r.last_read_ref_id AND last.thread_id=r.thread_id WHERE r.server_id=? AND (root.id IS NULL OR m.id IS NULL OR last.id IS NULL OR last.message_sequence<>r.last_read_sequence) ORDER BY r.id LIMIT ?`, "r.id"},
		{"thread_ref", "message_thread_ref", "Thread 引用的 Channel 或 creator 不在同 Server", `SELECT r.id FROM message_thread_refs r LEFT JOIN channels c ON c.server_id=r.server_id AND c.id=r.channel_id LEFT JOIN members m ON m.server_id=r.server_id AND m.id=r.created_by_member_id WHERE r.server_id=? AND (c.id IS NULL OR m.id IS NULL) ORDER BY r.id LIMIT ?`, "r.id"},
		{"task_members", "task", "Task owner/creator/updater 不在同 Server", `SELECT t.id FROM tasks t LEFT JOIN members o ON o.server_id=t.server_id AND o.id=t.owner_member_id LEFT JOIN members c ON c.server_id=t.server_id AND c.id=t.created_by_member_id LEFT JOIN members u ON u.server_id=t.server_id AND u.id=t.updated_by_member_id WHERE t.server_id=? AND ((t.owner_member_id IS NOT NULL AND o.id IS NULL) OR c.id IS NULL OR u.id IS NULL) ORDER BY t.id LIMIT ?`, "t.id"},
		{"reminder_refs", "reminder", "Reminder 的 Agent、creator 或消息锚点不在同 Server", `SELECT r.id FROM reminders r LEFT JOIN agents a ON a.server_id=r.server_id AND a.id=r.agent_id LEFT JOIN members m ON m.server_id=r.server_id AND m.id=r.created_by_member_id LEFT JOIN channels c ON c.server_id=r.server_id AND c.id=r.anchor_channel_id LEFT JOIN message_thread_refs tr ON tr.server_id=r.server_id AND tr.id=r.anchor_thread_id AND tr.role='root' WHERE r.server_id=? AND (a.id IS NULL OR m.id IS NULL OR (r.anchor_channel_id IS NOT NULL AND c.id IS NULL) OR (r.anchor_thread_id IS NOT NULL AND tr.id IS NULL) OR (r.anchor_thread_id IS NOT NULL AND r.anchor_channel_id IS NOT NULL AND tr.channel_id<>r.anchor_channel_id)) ORDER BY r.id LIMIT ?`, "r.id"},
		{"occurrence_refs", "reminder_occurrence", "Occurrence 的 Reminder 或 Agent 不在同 Server", `SELECT o.id FROM reminder_occurrences o LEFT JOIN reminders r ON r.server_id=o.server_id AND r.id=o.reminder_id LEFT JOIN agents a ON a.server_id=o.server_id AND a.id=o.agent_id WHERE o.server_id=? AND (r.id IS NULL OR a.id IS NULL OR r.agent_id<>o.agent_id) ORDER BY o.id LIMIT ?`, "o.id"},
		{"computer_credential", "computer_runtime_credential", "Computer credential 指向缺失/removed Computer 或版本无效", `SELECT cr.id FROM computer_runtime_credentials cr LEFT JOIN computers c ON c.server_id=cr.server_id AND c.id=cr.computer_id WHERE cr.server_id=? AND (c.id IS NULL OR c.lifecycle_state='removed' OR cr.version<1 OR cr.expires_at<=cr.created_at) ORDER BY cr.id LIMIT ?`, "cr.id"},
		{"observation_refs", "computer_agent_observation", "Observation 的 Computer/Agent/ingest 事实或同 launch 序列无效", `SELECT o.id FROM computer_agent_observations o LEFT JOIN computers c ON c.server_id=o.server_id AND c.id=o.computer_id LEFT JOIN agents a ON a.server_id=o.server_id AND a.id=o.agent_id WHERE o.server_id=? AND (c.id IS NULL OR a.id IS NULL OR o.sequence<1 OR o.attempt<1 OR o.config_generation<1 OR (o.accepted_at_ingest=1 AND o.rejection_reason_at_ingest IS NOT NULL) OR (o.accepted_at_ingest=0 AND (o.rejection_reason_at_ingest IS NULL OR o.rejection_reason_at_ingest='')) OR (o.accepted_at_ingest=1 AND o.launch_id=a.current_launch_id AND (o.assignment_epoch<>a.current_launch_assignment_epoch OR o.config_generation<>a.current_launch_generation OR o.credential_version<>a.current_launch_credential_version OR o.attempt<>a.current_launch_attempt)) OR EXISTS (SELECT 1 FROM computer_agent_observations p WHERE p.server_id=o.server_id AND p.agent_id=o.agent_id AND p.launch_id=o.launch_id AND (p.created_at<o.created_at OR (p.created_at=o.created_at AND p.id<o.id)) AND p.sequence>=o.sequence)) ORDER BY o.id LIMIT ?`, "o.id"},
		{"operation_partition", "tencent_operation", "TencentOperation partition_key/server_id 不一致", `SELECT id FROM tencent_operations WHERE partition_key=? AND server_id IS NOT NULL AND server_id<>partition_key ORDER BY id LIMIT ?`, "id"},
		{"outbox_partition", "outbox_event", "Outbox partition_key/server_id 不一致", `SELECT id FROM outbox_events WHERE partition_key=? AND server_id IS NOT NULL AND server_id<>partition_key ORDER BY id LIMIT ?`, "id"},
	}
}

func (scanner *Scanner) scanServerAuthority(ctx context.Context, serverID, afterCheck, afterID string) ([]Issue, error) {
	if afterCheck != "" && "partition_authority" < afterCheck {
		return nil, nil
	}
	if afterCheck == "partition_authority" && serverID <= afterID {
		return nil, nil
	}
	var count int
	if err := scanner.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM servers WHERE id=?`, serverID).Scan(&count); err != nil {
		return nil, err
	}
	if count == 1 {
		return nil, nil
	}
	return []Issue{{Check: "partition_authority", ResourceType: "server", ResourceID: serverID, Detail: "Server 分区缺少权威 Server"}}, nil
}

func (scanner *Scanner) scanMemberAccounts(ctx context.Context, serverID, afterCheck, afterID string, limit int) ([]Issue, error) {
	if afterCheck != "" && "member_account" < afterCheck {
		return nil, nil
	}
	if afterCheck != "member_account" {
		afterID = ""
	}
	rows, err := scanner.db.QueryContext(ctx, `SELECT id,account_id FROM members WHERE server_id=? AND id>? ORDER BY id LIMIT ?`, serverID, afterID, limit)
	if err != nil {
		return nil, err
	}
	type memberAccount struct{ memberID, accountID string }
	values := make([]memberAccount, 0)
	for rows.Next() {
		var value memberAccount
		if err := rows.Scan(&value.memberID, &value.accountID); err != nil {
			_ = rows.Close()
			return nil, err
		}
		values = append(values, value)
	}
	if err := closeRows(rows); err != nil {
		return nil, err
	}
	issues := make([]Issue, 0)
	for _, value := range values {
		var count int
		if err := scanner.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM accounts WHERE id=?`, value.accountID).Scan(&count); err != nil {
			return nil, err
		}
		if count != 1 {
			issues = append(issues, Issue{Check: "member_account", ResourceType: "member", ResourceID: value.memberID, Detail: "Member 指向的 Account 不存在"})
		}
	}
	return issues, nil
}

func (scanner *Scanner) scanServerRegistries(ctx context.Context, serverID, afterCheck, afterID string, limit int) ([]Issue, error) {
	if afterCheck != "" && "authority_registry" < afterCheck {
		return nil, nil
	}
	if afterCheck != "authority_registry" {
		afterID = ""
	}
	issues := make([]Issue, 0)
	var id, slug string
	err := scanner.db.QueryRowContext(ctx, `SELECT id,slug FROM servers WHERE id=?`, serverID).Scan(&id, &slug)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	if err == nil && id > afterID {
		issue, err := scanner.checkRegistryTarget(ctx, "server_slug_registry", id, `SELECT COUNT(*) FROM server_slug_registry WHERE slug=? AND server_id=?`, slug, serverID)
		if err != nil {
			return nil, err
		}
		if issue != nil {
			issues = append(issues, *issue)
		}
	}
	rows, err := scanner.db.QueryContext(ctx, `SELECT id,im_user_id FROM agents WHERE server_id=? AND id>? ORDER BY id LIMIT ?`, serverID, afterID, limit)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var agentID, imUserID string
		if err := rows.Scan(&agentID, &imUserID); err != nil {
			_ = rows.Close()
			return nil, err
		}
		issue, err := scanner.checkRegistryTarget(ctx, "agent_im_route", agentID, `SELECT COUNT(*) FROM agent_im_routes WHERE im_user_id=? AND server_id=? AND agent_id=?`, imUserID, serverID, agentID)
		if err != nil {
			_ = rows.Close()
			return nil, err
		}
		if issue != nil {
			issues = append(issues, *issue)
		}
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	rows, err = scanner.db.QueryContext(ctx, `SELECT id,tat_region,tat_instance_id FROM computers WHERE server_id=? AND lifecycle_state='active' AND tat_instance_id IS NOT NULL AND id>? ORDER BY id LIMIT ?`, serverID, afterID, limit)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var computerID, region, instanceID string
		if err := rows.Scan(&computerID, &region, &instanceID); err != nil {
			_ = rows.Close()
			return nil, err
		}
		issue, err := scanner.checkRegistryTarget(ctx, "tat_instance_binding", computerID, `SELECT COUNT(*) FROM tat_instance_bindings WHERE binding_hash=? AND server_id=? AND computer_id=? AND state='active'`, tatBindingHash(region, instanceID), serverID, computerID)
		if err != nil {
			_ = rows.Close()
			return nil, err
		}
		if issue != nil {
			issues = append(issues, *issue)
		}
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, err
	}
	return issues, rows.Close()
}

func (scanner *Scanner) checkRegistryTarget(ctx context.Context, resourceType, resourceID, query string, args ...any) (*Issue, error) {
	var count int
	if err := scanner.db.QueryRowContext(ctx, query, args...).Scan(&count); err != nil {
		return nil, err
	}
	if count == 1 {
		return nil, nil
	}
	return &Issue{Check: "authority_registry", ResourceType: resourceType, ResourceID: resourceID, Detail: "权威资源缺少唯一的 Registry 映射"}, nil
}

func tatBindingHash(region, instanceID string) string {
	digest := sha256.Sum256([]byte(region + "\x00" + instanceID))
	return hex.EncodeToString(digest[:])
}

func (scanner *Scanner) scanServerPersistentJSON(ctx context.Context, serverID, afterCheck, afterID string, limit int) ([]Issue, error) {
	if afterCheck != "" && "persisted_json" < afterCheck {
		return nil, nil
	}
	if afterCheck != "persisted_json" {
		afterID = ""
	}
	issues := make([]Issue, 0)
	rows, err := scanner.db.QueryContext(ctx, `SELECT id,service,kind,request_snapshot_json,result_json FROM tencent_operations WHERE partition_key=? AND (request_snapshot_json IS NOT NULL OR result_json IS NOT NULL) AND id>? ORDER BY id LIMIT ?`, serverID, afterID, limit)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var id, service, kind string
		var request, result sql.NullString
		if err := rows.Scan(&id, &service, &kind, &request, &result); err != nil {
			_ = rows.Close()
			return nil, err
		}
		if request.Valid {
			if _, err := persistedjson.ValidateSnapshot(request.String, service, kind); err != nil {
				issues = append(issues, invalidJSONIssue("tencent_operation.request", id, err))
			}
		}
		if result.Valid {
			if _, err := persistedjson.ValidateResultSnapshot(result.String, service, kind); err != nil {
				issues = append(issues, invalidJSONIssue("tencent_operation.result", id, err))
			}
		}
	}
	if err := closeRows(rows); err != nil {
		return nil, err
	}
	rows, err = scanner.db.QueryContext(ctx, `SELECT id,scope_type,response_body_json FROM idempotency_records WHERE partition_key=? AND id>? ORDER BY id LIMIT ?`, serverID, afterID, limit)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var id, scope, raw string
		if err := rows.Scan(&id, &scope, &raw); err != nil {
			_ = rows.Close()
			return nil, err
		}
		if !persistedjson.KnownScope(scope) {
			issues = append(issues, invalidJSONIssue("idempotency_record", id, errors.New("未注册的 scope")))
		} else if _, err := persistedjson.Validate(raw); err != nil {
			issues = append(issues, invalidJSONIssue("idempotency_record", id, err))
		}
	}
	if err := closeRows(rows); err != nil {
		return nil, err
	}
	for _, source := range []struct {
		resourceType string
		query        string
	}{
		{"task.source_message_ref", `SELECT id,source_message_ref_json FROM tasks WHERE server_id=? AND source_message_ref_json IS NOT NULL AND id>? ORDER BY id LIMIT ?`},
		{"reminder.anchor_message_ref", `SELECT id,anchor_message_ref_json FROM reminders WHERE server_id=? AND anchor_message_ref_json IS NOT NULL AND id>? ORDER BY id LIMIT ?`},
	} {
		rows, err = scanner.db.QueryContext(ctx, source.query, serverID, afterID, limit)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var id, raw string
			if err := rows.Scan(&id, &raw); err != nil {
				_ = rows.Close()
				return nil, err
			}
			if _, err := persistedjson.Validate(raw); err != nil {
				issues = append(issues, invalidJSONIssue(source.resourceType, id, err))
			}
		}
		if err := closeRows(rows); err != nil {
			return nil, err
		}
	}
	return issues, nil
}

func closeRows(rows *sql.Rows) error {
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return err
	}
	return rows.Close()
}

func invalidJSONIssue(resourceType, id string, err error) Issue {
	return Issue{Check: "persisted_json", ResourceType: resourceType, ResourceID: id, Detail: "持久 JSON 契约无效: " + err.Error()}
}

func (scanner *Scanner) scanAccount(ctx context.Context, accountID, after string, limit int) ([]Issue, error) {
	afterCheck, afterID := splitIssueKey(after)
	issues := make([]Issue, 0)
	if afterCheck == "" || afterCheck <= "account_authority" {
		var count int
		if err := scanner.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM accounts WHERE id=?`, accountID).Scan(&count); err != nil {
			return nil, err
		}
		if count != 1 && !(afterCheck == "account_authority" && accountID <= afterID) {
			issues = append(issues, Issue{Check: "account_authority", ResourceType: "account", ResourceID: accountID, Detail: "Account 分区缺少权威 Account"})
		}
	}
	if afterCheck != "" && afterCheck > "membership_projection" {
		return issues, nil
	}
	if afterCheck != "membership_projection" {
		afterID = ""
	}
	if afterCheck != "" && afterCheck < "membership_projection" {
		afterID = ""
	}
	if afterCheck != "" && afterCheck != "account_authority" && afterCheck != "membership_projection" {
		return nil, nil
	}
	rows, err := scanner.db.QueryContext(ctx, `SELECT id,server_id,member_id FROM account_server_memberships WHERE account_id=? AND id>? ORDER BY id LIMIT ?`, accountID, afterID, limit)
	if err != nil {
		return nil, err
	}
	type projection struct{ id, serverID, memberID string }
	var values []projection
	for rows.Next() {
		var value projection
		if err := rows.Scan(&value.id, &value.serverID, &value.memberID); err != nil {
			_ = rows.Close()
			return nil, err
		}
		values = append(values, value)
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	for _, value := range values {
		var memberCount, serverCount int
		err := scanner.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM members WHERE server_id=? AND id=? AND account_id=?`, value.serverID, value.memberID, accountID).Scan(&memberCount)
		if err != nil {
			return nil, err
		}
		if err := scanner.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM servers WHERE id=?`, value.serverID).Scan(&serverCount); err != nil {
			return nil, err
		}
		if memberCount != 1 || serverCount != 1 {
			issues = append(issues, Issue{Check: "membership_projection", ResourceType: "account_server_membership", ResourceID: value.id, Detail: "Account 投影与权威 Member 不一致"})
		}
	}
	return issues, nil
}

func (scanner *Scanner) scanRegistry(ctx context.Context, registryType, key, after string) ([]Issue, error) {
	afterCheck, afterID := splitIssueKey(after)
	if afterCheck != "" && afterCheck != "registry_target" {
		return nil, nil
	}
	var registryQuery, authorityQuery, resourceType string
	switch registryType {
	case "login":
		registryQuery = `SELECT id,account_id,'' FROM account_login_identities WHERE login_hash=? AND id>?`
		authorityQuery = `SELECT COUNT(*) FROM accounts WHERE id=?`
		resourceType = "account_login_identity"
	case "server-slug":
		registryQuery = `SELECT id,server_id,'' FROM server_slug_registry WHERE slug=? AND id>?`
		authorityQuery = `SELECT COUNT(*) FROM servers WHERE id=?`
		resourceType = "server_slug_registry"
	case "tat-binding":
		registryQuery = `SELECT id,server_id,computer_id FROM tat_instance_bindings WHERE binding_hash=? AND id>?`
		authorityQuery = `SELECT COUNT(*) FROM computers WHERE server_id=? AND id=?`
		resourceType = "tat_instance_binding"
	case "agent-im-route":
		registryQuery = `SELECT id,server_id,agent_id FROM agent_im_routes WHERE im_user_id=? AND id>?`
		authorityQuery = `SELECT COUNT(*) FROM agents WHERE server_id=? AND id=?`
		resourceType = "agent_im_route"
	case "computer-setup":
		registryQuery = `SELECT id,server_id,computer_id FROM computer_setup_codes WHERE code_hash=? AND id>?`
		authorityQuery = `SELECT COUNT(*) FROM computers WHERE server_id=? AND id=?`
		resourceType = "computer_setup_code"
	}
	rows, err := scanner.db.QueryContext(ctx, registryQuery, key, afterID)
	if err != nil {
		return nil, err
	}
	type registryRow struct{ id, route, target string }
	var values []registryRow
	for rows.Next() {
		var value registryRow
		if err := rows.Scan(&value.id, &value.route, &value.target); err != nil {
			_ = rows.Close()
			return nil, err
		}
		values = append(values, value)
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	var issues []Issue
	for _, value := range values {
		var count int
		var err error
		if value.target == "" {
			err = scanner.db.QueryRowContext(ctx, authorityQuery, value.route).Scan(&count)
		} else {
			err = scanner.db.QueryRowContext(ctx, authorityQuery, value.route, value.target).Scan(&count)
		}
		if err != nil {
			return nil, err
		}
		if count != 1 {
			issues = append(issues, Issue{Check: "registry_target", ResourceType: resourceType, ResourceID: value.id, Detail: "Registry 指向的权威资源不存在"})
		}
	}
	return issues, nil
}

func knownRegistry(value string) bool {
	switch value {
	case "login", "server-slug", "tat-binding", "agent-im-route", "computer-setup":
		return true
	default:
		return false
	}
}

func issueKey(issue Issue) string { return issue.Check + "\x00" + issue.ResourceID }

func splitIssueKey(value string) (string, string) {
	if value == "" {
		return "", ""
	}
	check, id, ok := strings.Cut(value, "\x00")
	if !ok {
		return value, ""
	}
	return check, id
}
