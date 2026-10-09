package schemaaudit

import (
	"context"
	"os"
	"strconv"
	"strings"
	"testing"

	"chatserver/internal/database/physicalschema"
	"chatserver/internal/database/tdsqlddl"
)

func TestVerifyTDSQLInspector接受完整物理Schema并拒绝Noshard(t *testing.T) {
	catalog, err := physicalschema.Current()
	if err != nil {
		t.Fatal(err)
	}
	source, err := os.ReadFile("../../../migrations/tdsql/20260801000000_baseline.sql")
	if err != nil {
		t.Fatal(err)
	}
	tables, err := tdsqlddl.ParseDocument(string(source))
	if err != nil {
		t.Fatal(err)
	}
	setupCodeSource, err := os.ReadFile("../../../migrations/tdsql/20260802180000_computer_setup_codes.sql")
	if err != nil {
		t.Fatal(err)
	}
	setupCodeTables, err := tdsqlddl.ParseDocument(string(setupCodeSource))
	if err != nil {
		t.Fatal(err)
	}
	tables = append(tables, setupCodeTables...)
	directSource, err := os.ReadFile("../../../migrations/tdsql/20260804130000_server_scoped_direct_messages.sql")
	if err != nil {
		t.Fatal(err)
	}
	createOffset := strings.Index(string(directSource), "CREATE TABLE")
	if createOffset < 0 {
		t.Fatal("Server scoped DM migration missing CREATE TABLE")
	}
	directTables, err := tdsqlddl.ParseDocument(string(directSource[createOffset:]))
	if err != nil {
		t.Fatal(err)
	}
	tables = append(tables, directTables...)
	inspector := &fakeTDSQLInspector{
		sets: []Set{
			{OpaqueID: "set-a", RangeStart: 0, RangeEnd: 31},
			{OpaqueID: "set-b", RangeStart: 32, RangeEnd: 63},
		},
		create:  make(map[string]string, len(tables)),
		columns: make(map[string][]ColumnObservation, len(tables)),
	}
	for _, table := range tables {
		spec, ok := catalog.Table(table.Name)
		if !ok {
			t.Fatalf("runtime 包含未知表 %s", table.Name)
		}
		if table.Name == "computers" {
			indexes := table.Indexes[:0]
			for _, index := range table.Indexes {
				if index.Name != "computer_server_id_name" {
					indexes = append(indexes, index)
				}
			}
			table.Indexes = indexes
		}
		if table.Name == "members" {
			for index := range table.Indexes {
				if table.Indexes[index].Name == "member_server_id_handle" {
					table.Indexes[index] = tdsqlddl.Index{
						Name:    "member_server_id_active_handle_key",
						Unique:  true,
						Columns: []string{"server_id", "active_handle_key"},
						Raw: "UNIQUE INDEX `member_server_id_active_handle_key` " +
							"(`server_id`, `active_handle_key`)",
					}
				}
			}
		}
		existing := make(map[string]tdsqlddl.Column, len(table.Columns))
		for _, column := range table.Columns {
			existing[column.Name] = column
		}
		table.Columns = table.Columns[:0]
		for _, desired := range spec.Desired.Columns {
			column, ok := existing[desired.Name]
			if !ok {
				raw := "`" + desired.Name + "` " + mysqlType(desired)
				if desired.Nullable {
					raw += " NULL"
				} else {
					raw += " NOT NULL"
				}
				if desired.Default != nil {
					raw += " DEFAULT " + mysqlDefaultFixture(desired.Default)
				}
				column = tdsqlddl.Column{
					Name: desired.Name, Type: mysqlType(desired),
					Nullable: desired.Nullable, Raw: raw,
				}
			}
			table.Columns = append(table.Columns, column)
		}
		inspector.tables = append(inspector.tables, table.Name)
		inspector.create[table.Name] = tdsqlddl.Render(table, spec)
		for _, column := range spec.Desired.Columns {
			observation := ColumnObservation{
				Name:         column.Name,
				Type:         mysqlType(column),
				Nullable:     column.Nullable,
				DefaultValue: mysqlDefaultFixture(column.Default),
				DefaultValid: column.Default != nil,
			}
			if column.Name == spec.ShardKey {
				observation.CharacterSet = "ascii"
				observation.Collation = "ascii_bin"
			}
			inspector.columns[table.Name] = append(inspector.columns[table.Name], observation)
		}
	}
	if err := verifyTDSQLInspector(context.Background(), inspector, catalog); err != nil {
		t.Fatalf("verifyTDSQLInspector() error = %v", err)
	}

	inspector.create["members"] = strings.Replace(
		inspector.create["members"], " shardkey=`server_id`", "", 1,
	)
	if err := verifyTDSQLInspector(context.Background(), inspector, catalog); err == nil {
		t.Fatal("verifyTDSQLInspector() 应拒绝 noshard 表")
	}
}

func TestMySQLDefaultMatches覆盖LaunchFence所需默认值(t *testing.T) {
	tests := []struct {
		actual   string
		valid    bool
		expected any
		want     bool
	}{
		{actual: "0", valid: true, expected: int64(0), want: true},
		{actual: "false", valid: true, expected: false, want: true},
		{actual: "unknown", valid: true, expected: "unknown", want: true},
		{actual: "'unknown'", valid: true, expected: "unknown", want: true},
		{valid: false, expected: nil, want: true},
		{valid: false, expected: int64(0), want: false},
	}
	for _, test := range tests {
		if got := mysqlDefaultMatches(test.actual, test.valid, test.expected); got != test.want {
			t.Fatalf(
				"mysqlDefaultMatches(%q, %v, %#v) = %v, want %v",
				test.actual, test.valid, test.expected, got, test.want,
			)
		}
	}
}

func mysqlDefaultFixture(value any) string {
	switch value := value.(type) {
	case bool:
		if value {
			return "1"
		}
		return "0"
	case int:
		return strconv.Itoa(value)
	case int64:
		return strconv.FormatInt(value, 10)
	case string:
		return value
	default:
		return ""
	}
}

func TestQuoteMySQLIdentifier使用反引号并转义(t *testing.T) {
	if got := quoteMySQLIdentifier("a`b"); got != "`a``b`" {
		t.Fatalf("quoteMySQLIdentifier() = %q", got)
	}
}

type fakeTDSQLInspector struct {
	sets    []Set
	tables  []string
	create  map[string]string
	columns map[string][]ColumnObservation
}

func (fake *fakeTDSQLInspector) Topology(context.Context) ([]Set, error) {
	return append([]Set(nil), fake.sets...), nil
}

func (fake *fakeTDSQLInspector) BusinessTables(context.Context) ([]string, error) {
	return append([]string(nil), fake.tables...), nil
}

func (fake *fakeTDSQLInspector) ShowCreate(_ context.Context, table string) (string, error) {
	return fake.create[table], nil
}

func (fake *fakeTDSQLInspector) Columns(_ context.Context, table string) ([]ColumnObservation, error) {
	return append([]ColumnObservation(nil), fake.columns[table]...), nil
}

func (fake *fakeTDSQLInspector) Allsets(_ context.Context, _ string) ([]AllsetsObservation, error) {
	result := make([]AllsetsObservation, 0, len(fake.sets))
	for _, set := range fake.sets {
		result = append(result, AllsetsObservation{OpaqueID: set.OpaqueID, Count: 1})
	}
	return result, nil
}
