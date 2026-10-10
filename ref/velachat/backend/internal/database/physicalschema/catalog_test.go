package physicalschema

import (
	"slices"
	"testing"

	"entgo.io/ent/dialect"
	entschema "entgo.io/ent/dialect/sql/schema"
	"entgo.io/ent/schema/field"
)

func TestCurrent包含完整物理规格(t *testing.T) {
	catalog, err := Current()
	if err != nil {
		t.Fatalf("Current() error = %v", err)
	}
	tables := catalog.Tables()
	if len(tables) != 27 {
		t.Fatalf("Tables() 数量 = %d，期望 27", len(tables))
	}
	for _, table := range tables {
		wantPK := []string{table.ShardKey, "id"}
		if table.ShardKey == "id" {
			wantPK = []string{"id"}
		}
		if !slices.Equal(table.PhysicalPrimaryKey, wantPK) {
			t.Fatalf("表 %s 物理主键 = %v，期望 %v", table.Name, table.PhysicalPrimaryKey, wantPK)
		}
		if len(table.Desired.ForeignKeys) != 0 {
			t.Fatalf("表 %s 包含数据库外键", table.Name)
		}
		for _, index := range table.Desired.Indexes {
			if index.Unique && !indexContains(index, table.ShardKey) {
				t.Fatalf("表 %s 唯一索引 %s 不包含 shardkey %s", table.Name, index.Name, table.ShardKey)
			}
		}
	}
}

func TestCurrent收紧字符串路由列(t *testing.T) {
	catalog, err := Current()
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		table     string
		column    string
		maxLength int
	}{
		{table: "server_slug_registry", column: "slug", maxLength: 63},
		{table: "agent_im_routes", column: "im_user_id", maxLength: 32},
	}
	for _, tt := range tests {
		spec, ok := catalog.Table(tt.table)
		if !ok {
			t.Fatalf("缺少表 %s", tt.table)
		}
		if spec.Route.Column != tt.column || spec.Route.MaxLength != tt.maxLength ||
			spec.Route.CharacterSet != "ascii" || spec.Route.Collation != "ascii_bin" ||
			!spec.Route.Immutable {
			t.Fatalf("表 %s 路由约束 = %#v", tt.table, spec.Route)
		}
	}
}

func TestBuild拒绝唯一索引缺少ShardKey(t *testing.T) {
	id := stringColumn("id", "varchar(64)")
	serverID := stringColumn("server_id", "varchar(64)")
	email := stringColumn("email", "varchar(255)")
	table := &entschema.Table{
		Name:       "members",
		Columns:    []*entschema.Column{id, serverID, email},
		PrimaryKey: []*entschema.Column{id},
		Indexes: []*entschema.Index{
			{Name: "member_email", Unique: true, Columns: []*entschema.Column{email}},
		},
	}
	_, err := Build(
		[]Entry{{Schema: "Member", Table: "members", ShardKey: "server_id"}},
		[]*entschema.Table{table},
	)
	if err == nil {
		t.Fatal("Build() 应拒绝不包含 shardkey 的唯一索引")
	}
}

func TestBuild拒绝可空或不存在的ShardKey(t *testing.T) {
	id := stringColumn("id", "varchar(64)")
	serverID := stringColumn("server_id", "varchar(64)")
	serverID.Nullable = true
	table := &entschema.Table{
		Name:       "members",
		Columns:    []*entschema.Column{id, serverID},
		PrimaryKey: []*entschema.Column{id},
	}
	entries := []Entry{{Schema: "Member", Table: "members", ShardKey: "server_id"}}
	if _, err := Build(entries, []*entschema.Table{table}); err == nil {
		t.Fatal("Build() 应拒绝可空 shardkey")
	}
	entries[0].ShardKey = "missing"
	if _, err := Build(entries, []*entschema.Table{table}); err == nil {
		t.Fatal("Build() 应拒绝不存在的 shardkey")
	}
}

func TestBuild拒绝重复表和外键(t *testing.T) {
	id := stringColumn("id", "varchar(64)")
	table := &entschema.Table{
		Name:       "servers",
		Columns:    []*entschema.Column{id},
		PrimaryKey: []*entschema.Column{id},
	}
	entry := Entry{Schema: "Server", Table: "servers", ShardKey: "id"}
	if _, err := Build([]Entry{entry, entry}, []*entschema.Table{table, table}); err == nil {
		t.Fatal("Build() 应拒绝重复表")
	}
	table.ForeignKeys = []*entschema.ForeignKey{{Symbol: "forbidden"}}
	if _, err := Build([]Entry{entry}, []*entschema.Table{table}); err == nil {
		t.Fatal("Build() 应拒绝数据库外键")
	}
}

func stringColumn(name string, mysqlType string) *entschema.Column {
	return &entschema.Column{
		Name: name,
		Type: field.TypeString,
		SchemaType: map[string]string{
			dialect.MySQL: mysqlType,
		},
	}
}

func indexContains(index *entschema.Index, column string) bool {
	for _, current := range index.Columns {
		if current.Name == column {
			return true
		}
	}
	return false
}
