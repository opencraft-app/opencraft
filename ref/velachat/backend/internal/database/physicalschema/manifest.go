// Package physicalschema 定义业务表在分布式数据库中的唯一物理规格。
package physicalschema

// Entry 将一张 Ent 业务表绑定到不可变的路由列。
type Entry struct {
	Schema   string
	Table    string
	ShardKey string
}

var manifest = []Entry{
	{Schema: "AccountLoginIdentity", Table: "account_login_identities", ShardKey: "login_hash"},
	{Schema: "Account", Table: "accounts", ShardKey: "id"},
	{Schema: "AuthSession", Table: "auth_sessions", ShardKey: "account_id"},
	{Schema: "AccountServerMembership", Table: "account_server_memberships", ShardKey: "account_id"},
	{Schema: "ServerSlugRegistry", Table: "server_slug_registry", ShardKey: "slug"},
	{Schema: "Server", Table: "servers", ShardKey: "id"},
	{Schema: "ServerInvite", Table: "server_invites", ShardKey: "server_id"},
	{Schema: "Member", Table: "members", ShardKey: "server_id"},
	{Schema: "Agent", Table: "agents", ShardKey: "server_id"},
	{Schema: "AgentIMRoute", Table: "agent_im_routes", ShardKey: "im_user_id"},
	{Schema: "AgentRuntimeCredential", Table: "agent_runtime_credentials", ShardKey: "server_id"},
	{Schema: "Computer", Table: "computers", ShardKey: "server_id"},
	{Schema: "ComputerSetupCode", Table: "computer_setup_codes", ShardKey: "code_hash"},
	{Schema: "ComputerRuntimeCredential", Table: "computer_runtime_credentials", ShardKey: "server_id"},
	{Schema: "ComputerAgentObservation", Table: "computer_agent_observations", ShardKey: "server_id"},
	{Schema: "TATInstanceBinding", Table: "tat_instance_bindings", ShardKey: "binding_hash"},
	{Schema: "Channel", Table: "channels", ShardKey: "server_id"},
	{Schema: "ChannelMember", Table: "channel_members", ShardKey: "server_id"},
	{Schema: "DirectConversation", Table: "direct_conversations", ShardKey: "server_id"},
	{Schema: "MessageThreadRef", Table: "message_thread_refs", ShardKey: "server_id"},
	{Schema: "MessageThreadRead", Table: "message_thread_reads", ShardKey: "server_id"},
	{Schema: "Task", Table: "tasks", ShardKey: "server_id"},
	{Schema: "Reminder", Table: "reminders", ShardKey: "server_id"},
	{Schema: "ReminderOccurrence", Table: "reminder_occurrences", ShardKey: "server_id"},
	{Schema: "TencentOperation", Table: "tencent_operations", ShardKey: "partition_key"},
	{Schema: "IdempotencyRecord", Table: "idempotency_records", ShardKey: "partition_key"},
	{Schema: "OutboxEvent", Table: "outbox_events", ShardKey: "partition_key"},
}

// Manifest 返回物理路由清单的副本。
func Manifest() []Entry {
	return append([]Entry(nil), manifest...)
}
