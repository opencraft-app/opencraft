package tdsqlddl

import (
	"strings"
	"testing"

	"chatserver/internal/database/physicalschema"
	"entgo.io/ent/dialect"
	entschema "entgo.io/ent/dialect/sql/schema"
	"entgo.io/ent/schema/field"
)

func TestParseCreateTable正确跳过字符串注释和嵌套括号(t *testing.T) {
	source := `
-- 注释中的逗号,括号()与 CREATE TABLE 都不是语句
CREATE TABLE ` + "`members`" + ` (
  ` + "`id`" + ` varchar(64) NOT NULL,
  ` + "`server_id`" + ` varchar(64) NOT NULL,
  ` + "`display_name`" + ` varchar(255) NOT NULL DEFAULT 'a,b(c)' COMMENT 'x, y',
  PRIMARY KEY (` + "`id`" + `),
  UNIQUE INDEX ` + "`member_server_id_display_name`" + ` (` + "`server_id`" + `, ` + "`display_name`" + `)
) CHARSET utf8mb4 COLLATE utf8mb4_bin;
`
	tables, err := ParseDocument(source)
	if err != nil {
		t.Fatalf("ParseDocument() error = %v", err)
	}
	if len(tables) != 1 || tables[0].Name != "members" || len(tables[0].Columns) != 3 ||
		len(tables[0].Indexes) != 1 {
		t.Fatalf("解析结果 = %#v", tables)
	}
}

func TestCompile改写物理主键路由语义并保持幂等(t *testing.T) {
	catalog := testCatalog(t)
	source := "CREATE TABLE `members` (`id` varchar(64) NOT NULL, `server_id` varchar(64) NOT NULL, `display_name` varchar(255) NOT NULL, PRIMARY KEY (`id`), UNIQUE INDEX `member_server_id_display_name` (`server_id`, `display_name`)) CHARSET utf8mb4 COLLATE utf8mb4_bin;\n"
	compiled, err := Compile(source, catalog)
	if err != nil {
		t.Fatalf("Compile() error = %v", err)
	}
	checks := []string{
		"`server_id` varchar(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL",
		"PRIMARY KEY (`server_id`, `id`)",
		"shardkey=`server_id`",
	}
	for _, check := range checks {
		if !strings.Contains(compiled, check) {
			t.Fatalf("编译结果缺少 %q：\n%s", check, compiled)
		}
	}
	again, err := Compile(compiled, catalog)
	if err != nil {
		t.Fatalf("幂等 Compile() error = %v", err)
	}
	if again != compiled {
		t.Fatalf("编译不幂等：\nfirst=%s\nagain=%s", compiled, again)
	}
	tables, err := ParseDocument(compiled)
	if err != nil {
		t.Fatal(err)
	}
	spec, _ := catalog.Table("members")
	if violations := ComparePhysical(tables[0], spec); len(violations) != 0 {
		t.Fatalf("ComparePhysical() = %v", violations)
	}
}

func TestComparePhysical拒绝逻辑PK缺失ShardKey和错误字符语义(t *testing.T) {
	catalog := testCatalog(t)
	spec, _ := catalog.Table("members")
	logical := "CREATE TABLE `members` (`id` varchar(64) NOT NULL, `server_id` varchar(64) NOT NULL, `display_name` varchar(255) NOT NULL, PRIMARY KEY (`id`), UNIQUE INDEX `member_server_id_display_name` (`server_id`, `display_name`)) CHARSET utf8mb4 COLLATE utf8mb4_bin;"
	tables, err := ParseDocument(logical)
	if err != nil {
		t.Fatal(err)
	}
	if violations := ComparePhysical(tables[0], spec); len(violations) == 0 {
		t.Fatal("ComparePhysical() 应拒绝逻辑主键和缺失 shardkey")
	}
	wrong := "CREATE TABLE `members` (`id` varchar(64) NOT NULL, `server_id` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL, `display_name` varchar(255) NOT NULL, PRIMARY KEY (`server_id`, `id`), UNIQUE INDEX `member_server_id_display_name` (`server_id`, `display_name`)) CHARSET utf8mb4 COLLATE utf8mb4_bin shardkey=`server_id`;"
	tables, err = ParseDocument(wrong)
	if err != nil {
		t.Fatal(err)
	}
	if violations := ComparePhysical(tables[0], spec); len(violations) == 0 {
		t.Fatal("ComparePhysical() 应拒绝错误 route 字符集")
	}
}

func TestCompile拒绝规格外语句重复表和冲突ShardKey(t *testing.T) {
	catalog := testCatalog(t)
	base := "CREATE TABLE `members` (`id` varchar(64) NOT NULL, `server_id` varchar(64) NOT NULL, `display_name` varchar(255) NOT NULL, PRIMARY KEY (`id`), UNIQUE INDEX `member_server_id_display_name` (`server_id`, `display_name`)) CHARSET utf8mb4 COLLATE utf8mb4_bin"
	tests := []string{
		base + "; ALTER TABLE `members` ADD COLUMN `bad` bigint;",
		base + "; " + base + ";",
		base + " shardkey=`id`;",
	}
	for _, source := range tests {
		if _, err := Compile(source, catalog); err == nil {
			t.Fatalf("Compile() 应拒绝：%s", source)
		}
	}
}

func testCatalog(t *testing.T) *physicalschema.Catalog {
	t.Helper()
	id := testStringColumn("id", "varchar(64)")
	serverID := testStringColumn("server_id", "varchar(64)")
	displayName := testStringColumn("display_name", "varchar(255)")
	table := &entschema.Table{
		Name:       "members",
		Columns:    []*entschema.Column{id, serverID, displayName},
		PrimaryKey: []*entschema.Column{id},
		Indexes: []*entschema.Index{
			{
				Name:    "member_server_id_display_name",
				Unique:  true,
				Columns: []*entschema.Column{serverID, displayName},
			},
		},
	}
	catalog, err := physicalschema.Build(
		[]physicalschema.Entry{{Schema: "Member", Table: "members", ShardKey: "server_id"}},
		[]*entschema.Table{table},
	)
	if err != nil {
		t.Fatal(err)
	}
	return catalog
}

func testStringColumn(name string, mysqlType string) *entschema.Column {
	return &entschema.Column{
		Name: name,
		Type: field.TypeString,
		SchemaType: map[string]string{
			dialect.MySQL: mysqlType,
		},
	}
}
