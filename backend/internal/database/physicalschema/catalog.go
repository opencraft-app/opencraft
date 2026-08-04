package physicalschema

import (
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"strings"

	entmigrate "chatserver/internal/ent/migrate"
	"entgo.io/ent/dialect"
	entschema "entgo.io/ent/dialect/sql/schema"
	"entgo.io/ent/schema/field"
)

// TableKind 是 TDSQL 业务表的物理分布类型。
type TableKind string

const (
	// TableKindHashShard 表示按单一 shardkey HASH 分布的 Group-Shard 表。
	TableKindHashShard TableKind = "hash-shard"
)

// RouteConstraint 是 shardkey 在 TDSQL 中必须满足的物理约束。
type RouteConstraint struct {
	Column       string
	PhysicalType string
	MaxLength    int
	CharacterSet string
	Collation    string
	Nullable     bool
	Immutable    bool
}

// TableSpec 合并 Ent desired-state 与平台物理分片规则。
type TableSpec struct {
	Schema             string
	Name               string
	Kind               TableKind
	ShardKey           string
	LogicalPrimaryKey  []string
	PhysicalPrimaryKey []string
	Route              RouteConstraint
	Desired            *entschema.Table
}

// Catalog 是编译器与物理审计共享的唯一业务表目录。
type Catalog struct {
	tables []TableSpec
	byName map[string]int
}

var sizedCharacterType = regexp.MustCompile(`^(?:var)?char\(([1-9][0-9]*)\)$`)

// Current 从正式 manifest 与 Ent 生成的 desired-state 构建当前目录。
func Current() (*Catalog, error) {
	return Build(Manifest(), entmigrate.Tables)
}

// Baseline20260801000000 返回已发布 TDSQL baseline 对应的物理规格。
//
// baseline 是不可变迁移历史，不能随 Ent desired-state 增长而被重新编译。
// 新字段必须由后续增量 migration 引入。
func Baseline20260801000000() (*Catalog, error) {
	desired, err := entschema.CopyTables(entmigrate.Tables)
	if err != nil {
		return nil, fmt.Errorf("copy baseline desired tables: %w", err)
	}
	baselineDesired := desired[:0]
	for _, table := range desired {
		if table.Name == "computer_setup_codes" || table.Name == "direct_conversations" {
			continue
		}
		if table.Name == "computers" {
			serverID, serverOK := table.Column("server_id")
			name, nameOK := table.Column("name")
			if !serverOK || !nameOK {
				return nil, fmt.Errorf("baseline computers missing name key columns")
			}
			nameIndex := &entschema.Index{
				Name: "computer_server_id_name", Unique: true,
				Columns: []*entschema.Column{serverID, name},
			}
			table.Indexes = append([]*entschema.Index{nameIndex}, table.Indexes...)
		}
		if table.Name == "members" {
			serverID, serverOK := table.Column("server_id")
			handle, handleOK := table.Column("handle")
			if !serverOK || !handleOK {
				return nil, fmt.Errorf("baseline members missing handle key columns")
			}
			indexes := table.Indexes[:0]
			for _, index := range table.Indexes {
				if index.Name != "member_server_id_active_handle_key" {
					indexes = append(indexes, index)
				}
			}
			handleIndex := &entschema.Index{
				Name: "member_server_id_handle", Unique: true,
				Columns: []*entschema.Column{serverID, handle},
			}
			table.Indexes = append([]*entschema.Index{handleIndex}, indexes...)
		}
		columns := table.Columns[:0]
		for _, column := range table.Columns {
			if table.Name == "server_invites" && column.Name == "landing_channel_id" {
				continue
			}
			if table.Name == "computers" && isComputerEnrollmentColumn(column.Name) {
				continue
			}
			if table.Name == "agents" && column.Name == "deleted_at" {
				continue
			}
			if table.Name == "members" && column.Name == "active_handle_key" {
				continue
			}
			if table.Name == "reminders" && isReminderAnchorColumn(column.Name) {
				continue
			}
			columns = append(columns, column)
		}
		table.Columns = columns
		baselineDesired = append(baselineDesired, table)
	}
	entries := Manifest()
	baselineEntries := entries[:0]
	for _, entry := range entries {
		if entry.Table != "computer_setup_codes" && entry.Table != "direct_conversations" {
			baselineEntries = append(baselineEntries, entry)
		}
	}
	return Build(baselineEntries, baselineDesired)
}

func isReminderAnchorColumn(name string) bool {
	switch name {
	case "anchor_kind", "anchor_channel_id", "anchor_thread_id", "anchor_message_ref_json":
		return true
	default:
		return false
	}
}

func isComputerEnrollmentColumn(name string) bool {
	switch name {
	case "enrollment_generation",
		"enrollment_token_hash",
		"enrollment_expires_at",
		"enrollment_claimed_at",
		"enrollment_credential_version",
		"enrollment_release_version",
		"enrollment_target",
		"enrollment_architecture",
		"enrollment_manifest_object",
		"enrollment_manifest_sha256",
		"enrollment_signature_object",
		"enrollment_signature_sha256",
		"enrollment_installer_object",
		"enrollment_installer_sha256",
		"enrollment_signing_key_id",
		"enrollment_program_object",
		"enrollment_program_sha256",
		"enrollment_program_size":
		return true
	default:
		return false
	}
}

// Build 校验并合并路由 manifest 与 Ent desired-state。
func Build(entries []Entry, desired []*entschema.Table) (*Catalog, error) {
	inputNames := make(map[string]struct{}, len(desired))
	for _, table := range desired {
		if table == nil || strings.TrimSpace(table.Name) == "" {
			return nil, fmt.Errorf("desired table has empty name")
		}
		if _, exists := inputNames[table.Name]; exists {
			return nil, fmt.Errorf("duplicate desired table %s", table.Name)
		}
		inputNames[table.Name] = struct{}{}
		if len(table.ForeignKeys) != 0 {
			return nil, fmt.Errorf("table %s: foreign keys are forbidden", table.Name)
		}
	}
	copied, err := entschema.CopyTables(desired)
	if err != nil {
		return nil, fmt.Errorf("copy desired tables: %w", err)
	}
	if len(entries) != len(copied) {
		return nil, fmt.Errorf("manifest tables %d != desired tables %d", len(entries), len(copied))
	}
	desiredByName := make(map[string]*entschema.Table, len(copied))
	for _, table := range copied {
		if table == nil || strings.TrimSpace(table.Name) == "" {
			return nil, fmt.Errorf("desired table has empty name")
		}
		if _, exists := desiredByName[table.Name]; exists {
			return nil, fmt.Errorf("duplicate desired table %s", table.Name)
		}
		desiredByName[table.Name] = table
	}

	catalog := &Catalog{
		tables: make([]TableSpec, 0, len(entries)),
		byName: make(map[string]int, len(entries)),
	}
	for _, entry := range entries {
		if entry.Schema == "" || entry.Table == "" || entry.ShardKey == "" {
			return nil, fmt.Errorf("manifest entry is incomplete")
		}
		if _, exists := catalog.byName[entry.Table]; exists {
			return nil, fmt.Errorf("duplicate manifest table %s", entry.Table)
		}
		table, ok := desiredByName[entry.Table]
		if !ok {
			return nil, fmt.Errorf("manifest table %s has no desired table", entry.Table)
		}
		spec, err := buildTable(entry, table)
		if err != nil {
			return nil, fmt.Errorf("table %s: %w", entry.Table, err)
		}
		catalog.byName[entry.Table] = len(catalog.tables)
		catalog.tables = append(catalog.tables, spec)
		delete(desiredByName, entry.Table)
	}
	if len(desiredByName) != 0 {
		return nil, fmt.Errorf("desired state contains tables outside manifest")
	}
	return catalog, nil
}

func buildTable(entry Entry, table *entschema.Table) (TableSpec, error) {
	if table.View {
		return TableSpec{}, fmt.Errorf("views are not supported")
	}
	if len(table.ForeignKeys) != 0 {
		return TableSpec{}, fmt.Errorf("foreign keys are forbidden")
	}
	logicalPK := columnNames(table.PrimaryKey)
	if !slices.Equal(logicalPK, []string{"id"}) {
		return TableSpec{}, fmt.Errorf("logical primary key %v != [id]", logicalPK)
	}
	shardColumn, ok := table.Column(entry.ShardKey)
	if !ok {
		return TableSpec{}, fmt.Errorf("missing shardkey column %s", entry.ShardKey)
	}
	if shardColumn.Nullable {
		return TableSpec{}, fmt.Errorf("shardkey column %s is nullable", entry.ShardKey)
	}
	route, err := routeConstraint(entry, shardColumn)
	if err != nil {
		return TableSpec{}, err
	}
	for _, index := range table.Indexes {
		if index.Unique && !containsColumn(index.Columns, entry.ShardKey) {
			return TableSpec{}, fmt.Errorf("unique index %s does not contain shardkey", index.Name)
		}
	}
	for _, column := range table.Columns {
		if column.Unique && column.Name != entry.ShardKey {
			return TableSpec{}, fmt.Errorf("unique column %s does not contain shardkey", column.Name)
		}
	}
	physicalPK := []string{"id"}
	if entry.ShardKey != "id" {
		physicalPK = []string{entry.ShardKey, "id"}
	}
	return TableSpec{
		Schema:             entry.Schema,
		Name:               entry.Table,
		Kind:               TableKindHashShard,
		ShardKey:           entry.ShardKey,
		LogicalPrimaryKey:  logicalPK,
		PhysicalPrimaryKey: physicalPK,
		Route:              route,
		Desired:            table,
	}, nil
}

func routeConstraint(entry Entry, column *entschema.Column) (RouteConstraint, error) {
	physicalType := strings.ToLower(strings.TrimSpace(column.SchemaType[dialect.MySQL]))
	constraint := RouteConstraint{
		Column:       column.Name,
		PhysicalType: physicalType,
		Nullable:     column.Nullable,
		Immutable:    true,
	}
	if column.Type != field.TypeString && column.Type != field.TypeEnum {
		return RouteConstraint{}, fmt.Errorf("shardkey column %s must use a bounded string type", column.Name)
	}
	matches := sizedCharacterType.FindStringSubmatch(physicalType)
	if len(matches) != 2 {
		return RouteConstraint{}, fmt.Errorf("shardkey column %s has unbounded type %q", column.Name, physicalType)
	}
	maxLength, err := strconv.Atoi(matches[1])
	if err != nil || maxLength <= 0 {
		return RouteConstraint{}, fmt.Errorf("shardkey column %s has invalid length", column.Name)
	}
	constraint.MaxLength = maxLength
	constraint.CharacterSet = "ascii"
	constraint.Collation = "ascii_bin"
	if entry.Table == "server_slug_registry" && (column.Name != "slug" || maxLength != 63) {
		return RouteConstraint{}, fmt.Errorf("server slug must be varchar(63)")
	}
	if entry.Table == "agent_im_routes" && (column.Name != "im_user_id" || maxLength != 32) {
		return RouteConstraint{}, fmt.Errorf("IM UserID must be varchar(32)")
	}
	return constraint, nil
}

func columnNames(columns []*entschema.Column) []string {
	names := make([]string, 0, len(columns))
	for _, column := range columns {
		names = append(names, column.Name)
	}
	return names
}

func containsColumn(columns []*entschema.Column, name string) bool {
	for _, column := range columns {
		if column.Name == name {
			return true
		}
	}
	return false
}

// Tables 返回目录中按 manifest 顺序排列的表规格副本。
func (c *Catalog) Tables() []TableSpec {
	if c == nil {
		return nil
	}
	return append([]TableSpec(nil), c.tables...)
}

// Table 按物理表名查找规格。
func (c *Catalog) Table(name string) (TableSpec, bool) {
	if c == nil {
		return TableSpec{}, false
	}
	position, ok := c.byName[name]
	if !ok {
		return TableSpec{}, false
	}
	return c.tables[position], true
}
