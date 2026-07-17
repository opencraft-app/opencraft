package gateway

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
)

var (
	ErrResourceNotFound       = errors.New("resource not found")
	ErrResourceRowNotFound    = errors.New("resource row not found")
	ErrResourceActionNotFound = errors.New("resource action not found")
	ErrResourceFieldReadonly  = errors.New("resource field is readonly")
)

type ResourceColumn struct {
	Key       string `json:"key"`
	Label     string `json:"label"`
	Type      string `json:"type"`
	Primary   bool   `json:"primary,omitempty"`
	Sensitive bool   `json:"sensitive,omitempty"`
	Editable  bool   `json:"editable,omitempty"`
}

type ResourceAction struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	Description string `json:"description,omitempty"`
}

type ResourceDefinition struct {
	ID          string           `json:"id"`
	Label       string           `json:"label"`
	Description string           `json:"description,omitempty"`
	PrimaryKey  string           `json:"primary_key"`
	ReadOnly    bool             `json:"read_only"`
	Columns     []ResourceColumn `json:"columns"`
	Actions     []ResourceAction `json:"actions,omitempty"`
}

type ResourceListOptions struct {
	Limit  int
	Offset int
}

type ResourceRow struct {
	ID     string         `json:"id"`
	Values map[string]any `json:"values"`
}

type ResourceRowsResult struct {
	Resource ResourceDefinition `json:"resource"`
	Rows     []ResourceRow      `json:"rows"`
	Total    int                `json:"total"`
	Limit    int                `json:"limit"`
	Offset   int                `json:"offset"`
}

type ResourceRowResult struct {
	Resource ResourceDefinition `json:"resource"`
	Row      ResourceRow        `json:"row"`
}

type resourceSpec struct {
	def            ResourceDefinition
	table          string
	orderBy        string
	selectCols     []string
	whereCols      []string
	excludeDeleted bool
}

func (s *Service) ListResourceDefinitions() []ResourceDefinition {
	specs := resourceSpecs()
	defs := make([]ResourceDefinition, 0, len(specs))
	for _, id := range resourceOrder() {
		defs = append(defs, specs[id].def)
	}
	return defs
}

func (s *Service) ListResourceRows(ctx context.Context, resourceID string, opts ResourceListOptions) (ResourceRowsResult, error) {
	spec, ok := resourceSpecs()[strings.TrimSpace(resourceID)]
	if !ok {
		return ResourceRowsResult{}, ErrResourceNotFound
	}
	opts = normalizeResourceListOptions(opts)
	rows, total, err := s.listResourceRows(ctx, spec, opts)
	if err != nil {
		return ResourceRowsResult{}, err
	}
	return ResourceRowsResult{
		Resource: spec.def,
		Rows:     rows,
		Total:    total,
		Limit:    opts.Limit,
		Offset:   opts.Offset,
	}, nil
}

func (s *Service) GetResourceRow(ctx context.Context, resourceID string, rowID string) (ResourceRowResult, error) {
	spec, ok := resourceSpecs()[strings.TrimSpace(resourceID)]
	if !ok {
		return ResourceRowResult{}, ErrResourceNotFound
	}
	row, ok, err := s.getResourceRow(ctx, spec, strings.TrimSpace(rowID))
	if err != nil {
		return ResourceRowResult{}, err
	}
	if !ok {
		return ResourceRowResult{}, ErrResourceRowNotFound
	}
	return ResourceRowResult{Resource: spec.def, Row: row}, nil
}

func (s *Service) PatchResourceRow(ctx context.Context, resourceID string, rowID string, values map[string]any) (ResourceRowResult, error) {
	spec, ok := resourceSpecs()[strings.TrimSpace(resourceID)]
	if !ok {
		return ResourceRowResult{}, ErrResourceNotFound
	}
	if len(values) == 0 {
		return s.GetResourceRow(ctx, resourceID, rowID)
	}
	editable := map[string]bool{}
	for _, column := range spec.def.Columns {
		if column.Editable {
			editable[column.Key] = true
		}
	}
	for key := range values {
		if !editable[key] {
			return ResourceRowResult{}, fmt.Errorf("%w: %s", ErrResourceFieldReadonly, key)
		}
	}
	if err := s.patchResourceRow(ctx, resourceID, strings.TrimSpace(rowID), values); err != nil {
		return ResourceRowResult{}, err
	}
	return s.GetResourceRow(ctx, resourceID, rowID)
}

func (s *Service) RunResourceAction(ctx context.Context, resourceID string, actionID string, rowID string, params map[string]any) (ResourceRowResult, error) {
	spec, ok := resourceSpecs()[strings.TrimSpace(resourceID)]
	if !ok {
		return ResourceRowResult{}, ErrResourceNotFound
	}
	actionID = strings.TrimSpace(actionID)
	found := false
	for _, action := range spec.def.Actions {
		if action.ID == actionID {
			found = true
			break
		}
	}
	if !found {
		return ResourceRowResult{}, ErrResourceActionNotFound
	}
	if err := s.runResourceAction(ctx, resourceID, actionID, strings.TrimSpace(rowID), params); err != nil {
		return ResourceRowResult{}, err
	}
	return s.GetResourceRow(ctx, resourceID, rowID)
}

func normalizeResourceListOptions(opts ResourceListOptions) ResourceListOptions {
	if opts.Limit <= 0 {
		opts.Limit = 50
	}
	if opts.Limit > 200 {
		opts.Limit = 200
	}
	if opts.Offset < 0 {
		opts.Offset = 0
	}
	return opts
}

func resourceOrder() []string {
	return []string{
		"tenants",
		"sets",
		"shards",
		"set_reconcile_facts",
		"set_provision_requests",
		"user_bindings",
		"api_key_bindings",
		"plans",
		"set_plans",
		"channel_specs",
		"channel_sync_states",
		"tenant_observations",
		"subscription_period_overlays",
	}
}

func resourceSpecs() map[string]resourceSpec {
	return map[string]resourceSpec{
		"tenants": {
			def: ResourceDefinition{
				ID:          "tenants",
				Label:       "Tenants",
				Description: "大模型租户库存与 new-api Set 承载状态。",
				PrimaryKey:  "user_id",
				Columns: []ResourceColumn{
					colPrimary("user_id", "User ID", "string"),
					col("backend", "Backend", "string"),
					col("set_id", "Set", "string"),
					col("status", "Status", "string"),
					colEditable("source", "Source", "string"),
					colEditable("display_name", "Display Name", "string"),
					col("created_at", "Created", "datetime"),
					col("updated_at", "Updated", "datetime"),
				},
				Actions: []ResourceAction{
					{ID: "enable", Label: "Enable", Description: "把租户状态改为 active。"},
					{ID: "disable", Label: "Disable", Description: "禁止控制面写入和流量路由。"},
					{ID: "delete", Label: "Delete", Description: "软删除租户。"},
					{ID: "route_new", Label: "Route new", Description: "切到指定 new-api set，需要 set_id 参数。"},
				},
			},
			table:          "llmgateway_tenants",
			selectCols:     []string{"external_user_id AS user_id", "backend", "set_id", "status", "source", "display_name", "created_at", "updated_at"},
			whereCols:      []string{"external_user_id"},
			orderBy:        "updated_at DESC, external_user_id ASC",
			excludeDeleted: true,
		},
		"sets": {
			def: ResourceDefinition{
				ID:          "sets",
				Label:       "Sets",
				Description: "已纳管 new-api deployment。",
				PrimaryKey:  "id",
				Columns: []ResourceColumn{
					colPrimary("id", "Set ID", "string"),
					colEditable("name", "Name", "string"),
					colEditable("base_url", "Base URL", "string"),
					colEditable("status", "Status", "string"),
					col("setup", "Setup", "bool"),
					col("admin_user_id", "Admin User", "number"),
					col("admin_username", "Admin Username", "string"),
					col("admin_role", "Admin Role", "number"),
					col("admin_status", "Admin Status", "number"),
					col("admin_group", "Admin Group", "string"),
					colSensitive("admin_access_token", "Admin Token", "string"),
					col("max_users", "Max Users", "number"),
					col("warn_users", "Warn Users", "number"),
					col("reserved_users", "Reserved Users", "number"),
					col("observed_user_count", "Observed Users", "number"),
					col("capacity_updated_at", "Capacity Updated", "datetime"),
					col("shard_id", "Shard", "string"),
					col("newapi_replicas", "Replicas", "number"),
					col("sql_max_open_conns", "Max SQL Conns", "number"),
					col("sql_max_idle_conns", "Idle SQL Conns", "number"),
					col("sql_max_lifetime_seconds", "SQL Lifetime", "number"),
					col("traffic_sql_max_open_conns", "Traffic SQL Conns", "number"),
					col("traffic_sql_max_idle_conns", "Traffic Idle SQL Conns", "number"),
					col("traffic_sql_max_lifetime_seconds", "Traffic SQL Lifetime", "number"),
					col("subscription_write_concurrency", "Subscription Writes", "number"),
					col("admin_health_status", "Admin Health", "string"),
					col("admin_health_consecutive_failures", "Admin Health Failures", "number"),
					col("admin_health_error", "Admin Health Error", "string"),
					col("admin_health_checked_at", "Admin Health Checked", "datetime"),
					col("admin_health_last_success_at", "Admin Health Success", "datetime"),
					col("admission_status", "Admission", "string"),
					col("admission_error", "Admission Error", "string"),
					col("admission_checked_at", "Admission Checked", "datetime"),
					col("created_at", "Created", "datetime"),
					col("updated_at", "Updated", "datetime"),
				},
				Actions: []ResourceAction{
					{ID: "enable", Label: "Enable"},
					{ID: "drain", Label: "Drain"},
					{ID: "disable", Label: "Disable"},
					{ID: "bootstrap", Label: "Bootstrap"},
				},
			},
			table:      "llmgateway_sets",
			selectCols: []string{"id", "name", "base_url", "status", "setup", "admin_user_id", "admin_username", "admin_role", "admin_status", "admin_group", "admin_access_token", "max_users", "warn_users", "reserved_users", "observed_user_count", "capacity_updated_at", "shard_id", "newapi_replicas", "sql_max_open_conns", "sql_max_idle_conns", "sql_max_lifetime_seconds", "traffic_sql_max_open_conns", "traffic_sql_max_idle_conns", "traffic_sql_max_lifetime_seconds", "subscription_write_concurrency", "admin_health_status", "admin_health_consecutive_failures", "admin_health_error", "admin_health_checked_at", "admin_health_last_success_at", "admission_status", "admission_error", "admission_checked_at", "created_at", "updated_at"},
			whereCols:  []string{"id"},
			orderBy:    "id ASC",
		},
		"shards": {
			def: ResourceDefinition{
				ID:          "shards",
				Label:       "Shards",
				Description: "数据库分片和逻辑连接预算。",
				PrimaryKey:  "id",
				ReadOnly:    true,
				Columns: []ResourceColumn{
					colPrimary("id", "Shard ID", "string"),
					col("name", "Name", "string"),
					col("kind", "Kind", "string"),
					col("endpoint", "Endpoint", "string"),
					col("status", "Status", "string"),
					col("max_connections", "Max Connections", "number"),
					col("reserved_connections", "Reserved Connections", "number"),
					col("warn_ratio", "Warn Ratio", "number"),
					col("critical_ratio", "Critical Ratio", "number"),
					col("max_sets", "Max Sets", "number"),
					col("admin_sql_max_open_conns", "Admin SQL Conns", "number"),
					col("traffic_sql_max_open_conns", "Traffic SQL Conns", "number"),
					col("subscription_write_concurrency", "Subscription Writes", "number"),
					col("created_at", "Created", "datetime"),
					col("updated_at", "Updated", "datetime"),
				},
			},
			table:      "llmgateway_shards",
			selectCols: []string{"id", "name", "kind", "endpoint", "status", "max_connections", "reserved_connections", "warn_ratio", "critical_ratio", "max_sets", "admin_sql_max_open_conns", "traffic_sql_max_open_conns", "subscription_write_concurrency", "created_at", "updated_at"},
			whereCols:  []string{"id"},
			orderBy:    "id ASC",
		},
		"set_reconcile_facts": {
			def: ResourceDefinition{
				ID:          "set_reconcile_facts",
				Label:       "Set Reconcile Facts",
				Description: "kro/Fleet 观测到的 Set 纳管事实。写入 facts 不代表 Set 已经可用，pending 需由 reconcile 消费。",
				PrimaryKey:  "source,namespace,fleet,set_id",
				ReadOnly:    true,
				Columns: []ResourceColumn{
					colPrimary("source", "Source", "string"),
					colPrimary("namespace", "Namespace", "string"),
					colPrimary("fleet", "Fleet", "string"),
					colPrimary("set_id", "Set ID", "string"),
					col("name", "Name", "string"),
					col("base_url", "Base URL", "string"),
					col("shard_ref", "Shard", "string"),
					col("desired_hash", "Desired Hash", "string"),
					col("status", "Status", "string"),
					col("last_error", "Last Error", "string"),
					col("last_observed_at", "Observed", "datetime"),
					col("last_reconciled_at", "Reconciled", "datetime"),
					col("created_at", "Created", "datetime"),
					col("updated_at", "Updated", "datetime"),
				},
			},
			table: "llmgateway_set_reconcile_facts",
			selectCols: []string{
				"source", "namespace_name AS namespace", "fleet", "set_id", "name", "base_url", "shard_ref", "desired_hash",
				"status", "last_error", "last_observed_at", "last_reconciled_at", "created_at", "updated_at",
			},
			whereCols: []string{"source", "namespace_name", "fleet", "set_id"},
			orderBy:   "updated_at DESC, source ASC, namespace_name ASC, fleet ASC, set_id ASC",
		},
		"set_provision_requests": {
			def: ResourceDefinition{
				ID:          "set_provision_requests",
				Label:       "Set Provision Requests",
				Description: "容量控制器产生的扩 Set 意图。set-manager 读取 pending request 后创建 runtime，并回写状态。",
				PrimaryKey:  "id",
				ReadOnly:    true,
				Columns: []ResourceColumn{
					colPrimary("id", "Request ID", "string"),
					col("source", "Source", "string"),
					col("namespace", "Namespace", "string"),
					col("fleet", "Fleet", "string"),
					col("set_id", "Set ID", "string"),
					col("shard_ref", "Shard", "string"),
					col("database_name", "Database", "string"),
					col("redis_db", "Redis DB", "string"),
					col("status", "Status", "string"),
					col("reason", "Reason", "string"),
					col("last_error", "Last Error", "string"),
					col("requested_users", "Requested Users", "number"),
					col("max_users_per_set", "Max Users", "number"),
					col("last_status_at", "Status At", "datetime"),
					col("created_at", "Created", "datetime"),
					col("updated_at", "Updated", "datetime"),
				},
			},
			table: "llmgateway_set_provision_requests",
			selectCols: []string{
				"id", "source", "namespace_name AS namespace", "fleet", "set_id", "shard_ref", "database_name", "redis_db",
				"status", "reason", "last_error", "requested_users", "max_users_per_set", "last_status_at", "created_at", "updated_at",
			},
			whereCols: []string{"id"},
			orderBy:   "updated_at DESC, id ASC",
		},
		"user_bindings": {
			def: ResourceDefinition{
				ID:          "user_bindings",
				Label:       "User Bindings",
				Description: "外部用户到 set/new-api 用户的纳管状态。",
				PrimaryKey:  "external_user_id",
				ReadOnly:    true,
				Columns: []ResourceColumn{
					colPrimary("external_user_id", "External User", "string"),
					col("set_id", "Set", "string"),
					col("upstream_user_id", "Upstream User", "number"),
					col("username", "Username", "string"),
					colSensitive("password", "Password", "string"),
					col("last_plan_id", "Last Plan", "string"),
					col("last_extended_period_end", "Extended Period End", "datetime"),
					col("provision_status", "Provision", "string"),
					col("last_provision_error", "Provision Error", "string"),
					col("created_at", "Created", "datetime"),
					col("updated_at", "Updated", "datetime"),
				},
				Actions: []ResourceAction{{ID: "clear_error", Label: "Clear Error"}},
			},
			table:      "llmgateway_user_bindings",
			selectCols: []string{"external_user_id", "set_id", "upstream_user_id", "username", "password", "last_plan_id", "last_extended_period_end", "provision_status", "last_provision_error", "created_at", "updated_at"},
			whereCols:  []string{"external_user_id"},
			orderBy:    "updated_at DESC, external_user_id ASC",
		},
		"api_key_bindings": {
			def: ResourceDefinition{
				ID:          "api_key_bindings",
				Label:       "API Key Bindings",
				Description: "外部 key 到 upstream new-api token 的映射，完整密钥仅用于受控恢复。",
				PrimaryKey:  "external_key_id",
				ReadOnly:    true,
				Columns: []ResourceColumn{
					colPrimary("external_key_id", "External Key ID", "string"),
					colSensitive("external_key", "External Key", "string"),
					col("external_key_hash", "External Key Hash", "string"),
					col("purpose", "Purpose", "string"),
					col("set_id", "Set", "string"),
					col("user_id", "User ID", "string"),
					colSensitive("upstream_key", "Upstream Key", "string"),
					col("upstream_key_id", "Upstream Key ID", "number"),
					col("created_at", "Created", "datetime"),
				},
			},
			table:      "llmgateway_api_key_bindings",
			selectCols: []string{"external_key_id", "external_key", "external_key_hash", "purpose", "set_id", "user_id", "upstream_key", "upstream_key_id", "created_at"},
			whereCols:  []string{"external_key_id"},
			orderBy:    "created_at DESC, external_key_id ASC",
		},
		"plans": {
			def: ResourceDefinition{
				ID:          "plans",
				Label:       "Entitlement Plans",
				Description: "平台不可变的周期权益模板。",
				PrimaryKey:  "id",
				ReadOnly:    true,
				Columns: []ResourceColumn{
					colPrimary("id", "Plan ID", "string"),
					col("name", "Name", "string"),
					col("monthly_tokens", "Monthly Tokens", "number"),
					col("period_value", "Period Value", "number"),
					col("period_unit", "Period Unit", "string"),
					col("is_active", "Active", "bool"),
					col("fingerprint", "Fingerprint", "string"),
					col("created_at", "Created", "datetime"),
					col("updated_at", "Updated", "datetime"),
				},
			},
			table:      "llmgateway_plans",
			selectCols: []string{"id", "name", "monthly_tokens", "period_value", "period_unit", "is_active", "fingerprint", "created_at", "updated_at"},
			whereCols:  []string{"id"},
			orderBy:    "updated_at DESC, id ASC",
		},
		"set_plans": {
			def: ResourceDefinition{
				ID:          "set_plans",
				Label:       "Set Plan Deliveries",
				Description: "权益模板在每个服务集群的下发状态。",
				PrimaryKey:  "plan_id,set_id",
				ReadOnly:    true,
				Columns: []ResourceColumn{
					colPrimary("plan_id", "Plan ID", "string"),
					colPrimary("set_id", "Set", "string"),
					col("upstream_plan_id", "Upstream Plan", "number"),
					col("status", "Status", "string"),
					col("attempts", "Attempts", "number"),
					col("last_error", "Last Error", "string"),
					col("synced_at", "Synced", "datetime"),
					col("created_at", "Created", "datetime"),
					col("updated_at", "Updated", "datetime"),
				},
			},
			table:      "llmgateway_set_plans",
			selectCols: []string{"plan_id", "set_id", "upstream_plan_id", "status", "attempts", "last_error", "synced_at", "created_at", "updated_at"},
			whereCols:  []string{"plan_id", "set_id"},
			orderBy:    "updated_at DESC, plan_id ASC, set_id ASC",
		},
		"channel_specs": {
			def: ResourceDefinition{
				ID:          "channel_specs",
				Label:       "Channel Specs",
				Description: "OpenAI-compatible 渠道期望态。",
				PrimaryKey:  "id",
				Columns: []ResourceColumn{
					colPrimary("id", "Channel ID", "string"),
					colEditable("name", "Name", "string"),
					colEditable("type", "Type", "number"),
					col("key_hash", "Key Hash", "string"),
					colEditable("base_url", "Base URL", "string"),
					colEditable("models", "Models", "string"),
					colEditable("group", "Group", "string"),
					colEditable("model_mapping", "Model Mapping", "json"),
					colEditable("priority", "Priority", "number"),
					colEditable("weight", "Weight", "number"),
					colEditable("status", "Status", "string"),
					colEditable("remark", "Remark", "string"),
					col("fingerprint", "Fingerprint", "string"),
					col("desired_remote_name", "Remote Name", "string"),
					col("created_at", "Created", "datetime"),
					col("updated_at", "Updated", "datetime"),
				},
			},
			table:      "llmgateway_channel_specs",
			selectCols: []string{"id", "name", "type", "key_hash", "base_url", "models", "group_name AS `group`", "model_mapping", "priority", "weight", "status", "remark", "fingerprint", "desired_remote_name", "created_at", "updated_at"},
			whereCols:  []string{"id"},
			orderBy:    "updated_at DESC, id ASC",
		},
		"channel_sync_states": {
			def: ResourceDefinition{
				ID:          "channel_sync_states",
				Label:       "Channel Sync States",
				Description: "渠道在各 Set 上的同步状态。",
				PrimaryKey:  "channel_id,set_id",
				ReadOnly:    true,
				Columns: []ResourceColumn{
					colPrimary("channel_id", "Channel ID", "string"),
					colPrimary("set_id", "Set", "string"),
					col("remote_channel_id", "Remote Channel", "number"),
					col("status", "Status", "string"),
					col("last_error", "Last Error", "string"),
					col("desired_fingerprint", "Desired FP", "string"),
					col("applied_fingerprint", "Applied FP", "string"),
					col("remote_fingerprint", "Remote FP", "string"),
					col("last_applied_key_hash", "Applied Key Hash", "string"),
					col("last_synced_at", "Synced", "datetime"),
					col("last_checked_at", "Checked", "datetime"),
					col("created_at", "Created", "datetime"),
					col("updated_at", "Updated", "datetime"),
				},
			},
			table:      "llmgateway_channel_sync_states",
			selectCols: []string{"channel_id", "set_id", "remote_channel_id", "status", "last_error", "desired_fingerprint", "applied_fingerprint", "remote_fingerprint", "last_applied_key_hash", "last_synced_at", "last_checked_at", "created_at", "updated_at"},
			whereCols:  []string{"channel_id", "set_id"},
			orderBy:    "updated_at DESC, channel_id ASC, set_id ASC",
		},
		"tenant_observations": {
			def: ResourceDefinition{
				ID:          "tenant_observations",
				Label:       "Tenant Observations",
				Description: "最近一次运营观测投影。",
				PrimaryKey:  "user_id",
				ReadOnly:    true,
				Columns: []ResourceColumn{
					colPrimary("user_id", "User ID", "string"),
					col("backend", "Backend", "string"),
					col("set_id", "Set", "string"),
					col("upstream_user_id", "Upstream User", "number"),
					col("username", "Username", "string"),
					col("current_plan_id", "Current Plan", "string"),
					col("last_applied_plan_id", "Last Plan", "string"),
					col("subscription_status", "Subscription", "string"),
					col("has_active_subscription", "Active Sub", "bool"),
					col("token_balance", "Token Balance", "number"),
					col("credit_available", "Credit Available", "number"),
					col("credit_status", "Credit Status", "string"),
					col("credit_error", "Credit Error", "string"),
					col("unlimited", "Unlimited", "bool"),
					col("period_start", "Period Start", "string"),
					col("period_end", "Period End", "string"),
					col("source", "Source", "string"),
					col("observed_at", "Observed", "datetime"),
					col("created_at", "Created", "datetime"),
					col("updated_at", "Updated", "datetime"),
				},
			},
			table:      "llmgateway_tenant_observations",
			selectCols: []string{"external_user_id AS user_id", "backend", "set_id", "upstream_user_id", "username", "current_plan_id", "last_applied_plan_id", "subscription_status", "has_active_subscription", "token_balance", "credit_available", "credit_status", "credit_error", "unlimited", "period_start", "period_end", "source", "observed_at", "created_at", "updated_at"},
			whereCols:  []string{"external_user_id"},
			orderBy:    "updated_at DESC, external_user_id ASC",
		},
		"subscription_period_overlays": {
			def: ResourceDefinition{
				ID:          "subscription_period_overlays",
				Label:       "Period Overlays",
				Description: "ctl 可观测 period_end 对齐投影。",
				PrimaryKey:  "external_user_id",
				ReadOnly:    true,
				Columns: []ResourceColumn{
					colPrimary("external_user_id", "External User", "string"),
					col("set_id", "Set", "string"),
					col("period_end", "Period End", "datetime"),
					col("created_at", "Created", "datetime"),
					col("updated_at", "Updated", "datetime"),
				},
			},
			table:      "llmgateway_subscription_period_overlays",
			selectCols: []string{"external_user_id", "set_id", "period_end", "created_at", "updated_at"},
			whereCols:  []string{"external_user_id"},
			orderBy:    "updated_at DESC, external_user_id ASC",
		},
	}
}

func colPrimary(key string, label string, typ string) ResourceColumn {
	column := col(key, label, typ)
	column.Primary = true
	return column
}

func colEditable(key string, label string, typ string) ResourceColumn {
	column := col(key, label, typ)
	column.Editable = true
	return column
}

func colSensitive(key string, label string, typ string) ResourceColumn {
	column := col(key, label, typ)
	column.Sensitive = true
	return column
}

func col(key string, label string, typ string) ResourceColumn {
	return ResourceColumn{Key: key, Label: label, Type: typ}
}

func (s *Service) listResourceRows(ctx context.Context, spec resourceSpec, opts ResourceListOptions) ([]ResourceRow, int, error) {
	switch store := s.store.(type) {
	case *MemoryStore:
		rows, err := memoryResourceRows(store, spec.def.ID)
		if err != nil {
			return nil, 0, err
		}
		if spec.excludeDeleted {
			rows = filterDeletedResourceRows(rows)
		}
		sortResourceRows(rows, spec.def.PrimaryKey)
		total := len(rows)
		start := opts.Offset
		if start > total {
			start = total
		}
		end := start + opts.Limit
		if end > total {
			end = total
		}
		return rows[start:end], total, nil
	case *MySQLStore:
		return store.listSQLResourceRows(ctx, spec, opts)
	default:
		return nil, 0, fmt.Errorf("resource admin is not supported by store %T", s.store)
	}
}

func (s *Service) getResourceRow(ctx context.Context, spec resourceSpec, rowID string) (ResourceRow, bool, error) {
	switch store := s.store.(type) {
	case *MemoryStore:
		rows, err := memoryResourceRows(store, spec.def.ID)
		if err != nil {
			return ResourceRow{}, false, err
		}
		for _, row := range rows {
			if row.ID == rowID {
				return row, true, nil
			}
		}
		return ResourceRow{}, false, nil
	case *MySQLStore:
		return store.getSQLResourceRow(ctx, spec, rowID)
	default:
		return ResourceRow{}, false, fmt.Errorf("resource admin is not supported by store %T", s.store)
	}
}

func (s *Service) patchResourceRow(ctx context.Context, resourceID string, rowID string, values map[string]any) error {
	switch resourceID {
	case "tenants":
		tenant, ok, err := s.store.GetTenant(ctx, rowID)
		if err != nil {
			return err
		}
		if !ok {
			return ErrResourceRowNotFound
		}
		if value, ok := values["display_name"]; ok {
			tenant.DisplayName = stringResourceValue(value)
		}
		if value, ok := values["source"]; ok {
			tenant.Source = stringResourceValue(value)
		}
		return s.store.SaveTenant(ctx, tenant)
	case "sets":
		set, ok, err := s.store.GetSet(ctx, rowID)
		if err != nil {
			return err
		}
		if !ok {
			return ErrResourceRowNotFound
		}
		if value, ok := values["name"]; ok {
			set.Name = stringResourceValue(value)
		}
		if value, ok := values["base_url"]; ok {
			set.BaseURL = strings.TrimRight(stringResourceValue(value), "/")
		}
		if value, ok := values["status"]; ok {
			status := strings.TrimSpace(strings.ToLower(stringResourceValue(value)))
			switch status {
			case SetStatusActive, SetStatusDraining, SetStatusDisabled:
				set.Status = status
			default:
				return fmt.Errorf("invalid set status %q", status)
			}
		}
		if value, ok := values["max_users"]; ok {
			set.MaxUsers = nonNegativeResourceInt(value)
		}
		if value, ok := values["warn_users"]; ok {
			set.WarnUsers = nonNegativeResourceInt(value)
		}
		if value, ok := values["reserved_users"]; ok {
			set.ReservedUsers = nonNegativeResourceInt(value)
		}
		return s.store.SaveSet(ctx, set)
	case "channel_specs":
		spec, ok, err := s.store.GetChannelSpec(ctx, rowID)
		if err != nil {
			return err
		}
		if !ok {
			return ErrResourceRowNotFound
		}
		if value, ok := values["name"]; ok {
			spec.Name = stringResourceValue(value)
		}
		if value, ok := values["type"]; ok {
			spec.Type = int(int64ResourceValue(value))
		}
		if value, ok := values["base_url"]; ok {
			spec.BaseURL = stringResourceValue(value)
		}
		if value, ok := values["models"]; ok {
			spec.Models = stringResourceValue(value)
		}
		if value, ok := values["group"]; ok {
			spec.Group = stringResourceValue(value)
		}
		if value, ok := values["model_mapping"]; ok {
			spec.ModelMapping = stringResourceValue(value)
		}
		if value, ok := values["priority"]; ok {
			spec.Priority = int64ResourceValue(value)
		}
		if value, ok := values["weight"]; ok {
			spec.Weight = uint(int64ResourceValue(value))
		}
		if value, ok := values["status"]; ok {
			spec.Status = stringResourceValue(value)
		}
		if value, ok := values["remark"]; ok {
			spec.Remark = stringResourceValue(value)
		}
		_, err = s.UpsertChannelSpec(ctx, spec)
		return err
	default:
		return ErrResourceFieldReadonly
	}
}

func (s *Service) runResourceAction(ctx context.Context, resourceID string, actionID string, rowID string, params map[string]any) error {
	switch resourceID {
	case "tenants":
		switch actionID {
		case "enable", "disable", "delete":
			tenant, ok, err := s.store.GetTenant(ctx, rowID)
			if err != nil {
				return err
			}
			if !ok {
				return ErrResourceRowNotFound
			}
			switch actionID {
			case "enable":
				tenant.Status = TenantStatusActive
			case "disable":
				tenant.Status = TenantStatusDisabled
			case "delete":
				tenant.Status = TenantStatusDeleted
			}
			return s.store.SaveTenant(ctx, tenant)
		case "route_new":
			setID := strings.TrimSpace(stringResourceValue(params["set_id"]))
			if setID == "" {
				return fmt.Errorf("set_id is required")
			}
			_, err := s.SetUserAssignment(ctx, UserAssignment{ExternalUserID: rowID, Backend: UserBackendNew, SetID: setID})
			return err
		}
	case "sets":
		switch actionID {
		case "enable", "drain", "disable":
			set, ok, err := s.store.GetSet(ctx, rowID)
			if err != nil {
				return err
			}
			if !ok {
				return ErrResourceRowNotFound
			}
			switch actionID {
			case "enable":
				set.Status = SetStatusActive
			case "drain":
				set.Status = SetStatusDraining
			case "disable":
				set.Status = SetStatusDisabled
			}
			return s.store.SaveSet(ctx, set)
		case "bootstrap":
			_, err := s.BootstrapSet(ctx, rowID)
			return err
		}
	case "user_bindings":
		if actionID == "clear_error" {
			binding, ok, err := s.store.GetUserBinding(ctx, rowID)
			if err != nil {
				return err
			}
			if !ok {
				return ErrResourceRowNotFound
			}
			binding.LastProvisionError = ""
			if binding.ProvisionStatus == BindingProvisionStatusFailed {
				binding.ProvisionStatus = BindingProvisionStatusAllocated
			}
			return s.store.SaveUserBinding(ctx, binding)
		}
	}
	return ErrResourceActionNotFound
}

func (s *MySQLStore) listSQLResourceRows(ctx context.Context, spec resourceSpec, opts ResourceListOptions) ([]ResourceRow, int, error) {
	where := ""
	filterArgs := []any{}
	if spec.excludeDeleted {
		where = " WHERE status <> ?"
		filterArgs = append(filterArgs, TenantStatusDeleted)
	}
	var total int
	if err := s.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM "+spec.table+where, filterArgs...).Scan(&total); err != nil {
		return nil, 0, err
	}
	query := "SELECT " + strings.Join(spec.selectCols, ", ") + " FROM " + spec.table + where + " ORDER BY " + spec.orderBy + " LIMIT ? OFFSET ?"
	queryArgs := append(filterArgs, opts.Limit, opts.Offset)
	rows, err := s.db.QueryContext(ctx, query, queryArgs...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	result, err := scanSQLResourceRows(rows, spec)
	return result, total, err
}

func filterDeletedResourceRows(rows []ResourceRow) []ResourceRow {
	visible := rows[:0]
	for _, row := range rows {
		if status, _ := row.Values["status"].(string); status == TenantStatusDeleted {
			continue
		}
		visible = append(visible, row)
	}
	return visible
}

func (s *MySQLStore) getSQLResourceRow(ctx context.Context, spec resourceSpec, rowID string) (ResourceRow, bool, error) {
	parts := splitResourceRowID(rowID)
	if len(parts) != len(spec.whereCols) {
		return ResourceRow{}, false, ErrResourceRowNotFound
	}
	clauses := make([]string, 0, len(spec.whereCols))
	args := make([]any, 0, len(spec.whereCols))
	for i, col := range spec.whereCols {
		clauses = append(clauses, col+" = ?")
		args = append(args, parts[i])
	}
	query := "SELECT " + strings.Join(spec.selectCols, ", ") + " FROM " + spec.table + " WHERE " + strings.Join(clauses, " AND ") + " LIMIT 1"
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return ResourceRow{}, false, err
	}
	defer rows.Close()
	result, err := scanSQLResourceRows(rows, spec)
	if err != nil {
		return ResourceRow{}, false, err
	}
	if len(result) == 0 {
		return ResourceRow{}, false, nil
	}
	return result[0], true, nil
}

func scanSQLResourceRows(rows *sql.Rows, spec resourceSpec) ([]ResourceRow, error) {
	names, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	result := []ResourceRow{}
	for rows.Next() {
		raw := make([]any, len(names))
		dest := make([]any, len(names))
		for i := range raw {
			dest[i] = &raw[i]
		}
		if err := rows.Scan(dest...); err != nil {
			return nil, err
		}
		values := map[string]any{}
		for i, name := range names {
			values[name] = normalizeSQLResourceValue(raw[i])
		}
		maskSensitiveResourceValues(spec, values)
		result = append(result, ResourceRow{ID: resourceRowID(spec.def.PrimaryKey, values), Values: values})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return result, nil
}

func normalizeSQLResourceValue(value any) any {
	switch v := value.(type) {
	case nil:
		return nil
	case []byte:
		return string(v)
	case time.Time:
		return v.UTC().Format(time.RFC3339Nano)
	default:
		return v
	}
}

func memoryResourceRows(store *MemoryStore, resourceID string) ([]ResourceRow, error) {
	store.mu.RLock()
	defer store.mu.RUnlock()
	rows := []ResourceRow{}
	switch resourceID {
	case "tenants":
		for _, item := range store.tenants {
			values := rowValues(map[string]any{
				"user_id":      item.ExternalUserID,
				"backend":      item.Backend,
				"set_id":       item.SetID,
				"status":       item.Status,
				"source":       item.Source,
				"display_name": item.DisplayName,
				"created_at":   item.CreatedAt,
				"updated_at":   item.UpdatedAt,
			})
			rows = append(rows, ResourceRow{ID: item.ExternalUserID, Values: values})
		}
	case "sets":
		for _, item := range store.sets {
			values := rowValues(map[string]any{
				"id":                                item.ID,
				"name":                              item.Name,
				"base_url":                          item.BaseURL,
				"status":                            item.Status,
				"setup":                             item.Setup,
				"admin_user_id":                     item.AdminUserID,
				"admin_username":                    item.AdminUsername,
				"admin_role":                        item.AdminRole,
				"admin_status":                      item.AdminStatus,
				"admin_group":                       item.AdminGroup,
				"admin_access_token":                maskedResourceValue(item.AdminAccessToken),
				"shard_id":                          item.ShardID,
				"sql_max_open_conns":                item.SQLMaxOpenConns,
				"sql_max_idle_conns":                item.SQLMaxIdleConns,
				"sql_max_lifetime_seconds":          item.SQLMaxLifetimeSeconds,
				"traffic_sql_max_open_conns":        item.TrafficSQLMaxOpenConns,
				"traffic_sql_max_idle_conns":        item.TrafficSQLMaxIdleConns,
				"traffic_sql_max_lifetime_seconds":  item.TrafficSQLMaxLifetimeSeconds,
				"subscription_write_concurrency":    item.SubscriptionWriteConcurrency,
				"admin_health_status":               item.AdminHealthStatus,
				"admin_health_consecutive_failures": item.AdminHealthConsecutiveFailures,
				"admin_health_error":                item.AdminHealthError,
				"admin_health_checked_at":           item.AdminHealthCheckedAt,
				"admin_health_last_success_at":      item.AdminHealthLastSuccessAt,
				"created_at":                        item.CreatedAt,
				"updated_at":                        item.UpdatedAt,
			})
			rows = append(rows, ResourceRow{ID: item.ID, Values: values})
		}
	case "shards":
		for _, item := range store.shards {
			values := rowValues(map[string]any{
				"id": item.ID, "name": item.Name, "kind": item.Kind, "endpoint": item.Endpoint, "status": item.Status,
				"max_connections": item.MaxConnections, "reserved_connections": item.ReservedConnections,
				"warn_ratio": item.WarnRatio, "critical_ratio": item.CriticalRatio, "max_sets": item.MaxSets,
				"admin_sql_max_open_conns":       item.AdminSQLMaxOpenConns,
				"traffic_sql_max_open_conns":     item.TrafficSQLMaxOpenConns,
				"subscription_write_concurrency": item.SubscriptionWriteConcurrency,
				"created_at":                     item.CreatedAt, "updated_at": item.UpdatedAt,
			})
			rows = append(rows, ResourceRow{ID: item.ID, Values: values})
		}
	case "set_reconcile_facts":
		for _, item := range store.setFacts {
			values := rowValues(map[string]any{
				"source":             item.Source,
				"namespace":          item.Namespace,
				"fleet":              item.Fleet,
				"set_id":             item.SetID,
				"name":               item.Name,
				"base_url":           item.BaseURL,
				"shard_ref":          item.ShardRef,
				"desired_hash":       item.DesiredHash,
				"status":             item.Status,
				"last_error":         item.LastError,
				"last_observed_at":   item.LastObservedAt,
				"last_reconciled_at": item.LastReconciledAt,
				"created_at":         item.CreatedAt,
				"updated_at":         item.UpdatedAt,
			})
			rows = append(rows, ResourceRow{ID: item.Source + "|" + item.Namespace + "|" + item.Fleet + "|" + item.SetID, Values: values})
		}
	case "set_provision_requests":
		for _, item := range store.setRequests {
			values := rowValues(map[string]any{
				"id":                item.ID,
				"source":            item.Source,
				"namespace":         item.Namespace,
				"fleet":             item.Fleet,
				"set_id":            item.SetID,
				"shard_ref":         item.ShardRef,
				"database_name":     item.DatabaseName,
				"redis_db":          item.RedisDB,
				"status":            item.Status,
				"reason":            item.Reason,
				"last_error":        item.LastError,
				"requested_users":   item.RequestedUsers,
				"max_users_per_set": item.MaxUsersPerSet,
				"last_status_at":    item.LastStatusAt,
				"created_at":        item.CreatedAt,
				"updated_at":        item.UpdatedAt,
			})
			rows = append(rows, ResourceRow{ID: item.ID, Values: values})
		}
	case "user_bindings":
		for _, item := range store.users {
			item = normalizeUserBinding(item)
			values := rowValues(map[string]any{
				"external_user_id":         item.ExternalUserID,
				"set_id":                   item.SetID,
				"upstream_user_id":         item.UpstreamUserID,
				"username":                 item.Username,
				"password":                 maskedResourceValue(item.Password),
				"last_plan_id":             item.LastPlanID,
				"last_extended_period_end": item.LastExtendedPeriodEnd,
				"provision_status":         item.ProvisionStatus,
				"last_provision_error":     item.LastProvisionError,
				"created_at":               item.CreatedAt,
				"updated_at":               item.UpdatedAt,
			})
			rows = append(rows, ResourceRow{ID: item.ExternalUserID, Values: values})
		}
	case "api_key_bindings":
		for _, item := range store.apiKeysByID {
			values := rowValues(map[string]any{
				"external_key_id":   item.ExternalKeyID,
				"external_key":      maskedResourceValue(item.ExternalKey),
				"external_key_hash": item.ExternalKeyHash,
				"purpose":           item.Purpose,
				"set_id":            item.SetID,
				"user_id":           item.UserID,
				"upstream_key":      maskedResourceValue(item.UpstreamKey),
				"upstream_key_id":   item.UpstreamKeyID,
				"created_at":        item.CreatedAt,
			})
			rows = append(rows, ResourceRow{ID: item.ExternalKeyID, Values: values})
		}
	case "plans":
		for _, item := range store.entitlementPlans {
			values := rowValues(map[string]any{
				"id": item.ID, "name": item.Name, "monthly_tokens": item.MonthlyTokens,
				"period_value": item.PeriodValue, "period_unit": item.PeriodUnit,
				"is_active": item.IsActive, "fingerprint": item.Fingerprint,
				"created_at": item.CreatedAt, "updated_at": item.UpdatedAt,
			})
			rows = append(rows, ResourceRow{ID: item.ID, Values: values})
		}
	case "set_plans":
		for _, item := range store.setPlans {
			values := rowValues(map[string]any{
				"plan_id": item.PlanID, "set_id": item.SetID, "upstream_plan_id": item.UpstreamPlanID,
				"status": item.Status, "attempts": item.Attempts, "last_error": item.LastError,
				"synced_at": item.SyncedAt, "created_at": item.CreatedAt, "updated_at": item.UpdatedAt,
			})
			rows = append(rows, ResourceRow{ID: item.PlanID + "|" + item.SetID, Values: values})
		}
	case "channel_specs":
		for _, item := range store.channels {
			values := rowValues(map[string]any{
				"id":                  item.ID,
				"name":                item.Name,
				"type":                item.Type,
				"key_hash":            item.KeyHash,
				"base_url":            item.BaseURL,
				"models":              item.Models,
				"group":               item.Group,
				"model_mapping":       item.ModelMapping,
				"priority":            item.Priority,
				"weight":              item.Weight,
				"status":              item.Status,
				"remark":              item.Remark,
				"fingerprint":         item.Fingerprint,
				"desired_remote_name": item.DesiredRemoteName,
				"created_at":          item.CreatedAt,
				"updated_at":          item.UpdatedAt,
			})
			rows = append(rows, ResourceRow{ID: item.ID, Values: values})
		}
	case "channel_sync_states":
		for _, item := range store.channelStates {
			values := rowValues(map[string]any{
				"channel_id":            item.ChannelID,
				"set_id":                item.SetID,
				"remote_channel_id":     item.RemoteChannelID,
				"status":                item.Status,
				"last_error":            item.LastError,
				"desired_fingerprint":   item.DesiredFingerprint,
				"applied_fingerprint":   item.AppliedFingerprint,
				"remote_fingerprint":    item.RemoteFingerprint,
				"last_applied_key_hash": item.LastAppliedKeyHash,
				"last_synced_at":        item.LastSyncedAt,
				"last_checked_at":       item.LastCheckedAt,
				"created_at":            item.CreatedAt,
				"updated_at":            item.UpdatedAt,
			})
			rows = append(rows, ResourceRow{ID: item.ChannelID + "|" + item.SetID, Values: values})
		}
	case "tenant_observations":
		for _, item := range store.observations {
			values := rowValues(map[string]any{
				"user_id":                 item.ExternalUserID,
				"backend":                 item.Backend,
				"set_id":                  item.SetID,
				"upstream_user_id":        item.UpstreamUserID,
				"username":                item.Username,
				"current_plan_id":         item.CurrentPlanID,
				"last_applied_plan_id":    item.LastAppliedPlanID,
				"subscription_status":     item.SubscriptionStatus,
				"has_active_subscription": item.HasActiveSubscription,
				"token_balance":           item.TokenBalance,
				"credit_available":        item.CreditAvailable,
				"credit_status":           item.CreditStatus,
				"credit_error":            item.CreditError,
				"unlimited":               item.Unlimited,
				"period_start":            item.PeriodStart,
				"period_end":              item.PeriodEnd,
				"source":                  item.Source,
				"observed_at":             item.ObservedAt,
				"created_at":              item.CreatedAt,
				"updated_at":              item.UpdatedAt,
			})
			rows = append(rows, ResourceRow{ID: item.ExternalUserID, Values: values})
		}
	case "subscription_period_overlays":
		for _, item := range store.periodEnds {
			values := rowValues(map[string]any{
				"external_user_id": item.ExternalUserID,
				"set_id":           item.SetID,
				"period_end":       item.PeriodEnd,
				"created_at":       item.CreatedAt,
				"updated_at":       item.UpdatedAt,
			})
			rows = append(rows, ResourceRow{ID: item.ExternalUserID, Values: values})
		}
	default:
		return nil, ErrResourceNotFound
	}
	return rows, nil
}

func rowValues(values map[string]any) map[string]any {
	for key, value := range values {
		if t, ok := value.(time.Time); ok {
			if t.IsZero() {
				values[key] = ""
			} else {
				values[key] = t.UTC().Format(time.RFC3339Nano)
			}
		}
	}
	return values
}

func maskSensitiveResourceValues(spec resourceSpec, values map[string]any) {
	for _, column := range spec.def.Columns {
		if column.Sensitive {
			values[column.Key] = maskedResourceValue(values[column.Key])
		}
	}
}

func maskedResourceValue(value any) string {
	if value == nil {
		return ""
	}
	if strings.TrimSpace(fmt.Sprint(value)) == "" {
		return ""
	}
	return "***"
}

func sortResourceRows(rows []ResourceRow, primaryKey string) {
	sort.Slice(rows, func(i, j int) bool {
		return rows[i].ID < rows[j].ID
	})
}

func resourceRowID(primaryKey string, values map[string]any) string {
	parts := strings.Split(primaryKey, ",")
	ids := make([]string, 0, len(parts))
	for _, part := range parts {
		ids = append(ids, fmt.Sprint(values[strings.TrimSpace(part)]))
	}
	return strings.Join(ids, "|")
}

func splitResourceRowID(rowID string) []string {
	if strings.Contains(rowID, "|") {
		return strings.Split(rowID, "|")
	}
	return []string{rowID}
}

func stringResourceValue(value any) string {
	switch v := value.(type) {
	case nil:
		return ""
	case string:
		return strings.TrimSpace(v)
	default:
		return strings.TrimSpace(fmt.Sprint(v))
	}
}

func int64ResourceValue(value any) int64 {
	switch v := value.(type) {
	case int:
		return int64(v)
	case int64:
		return v
	case float64:
		return int64(v)
	case string:
		parsed, _ := strconv.ParseInt(strings.TrimSpace(v), 10, 64)
		return parsed
	default:
		return 0
	}
}

func nonNegativeResourceInt(value any) int {
	parsed := int(int64ResourceValue(value))
	if parsed < 0 {
		return 0
	}
	return parsed
}

func boolResourceValue(value any) bool {
	switch v := value.(type) {
	case bool:
		return v
	case string:
		parsed, _ := strconv.ParseBool(strings.TrimSpace(v))
		return parsed
	default:
		return false
	}
}
