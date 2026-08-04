package tdsqlddl

import (
	"crypto/md5"
	"fmt"
	"regexp"
	"slices"
	"strings"

	"chatserver/internal/database/physicalschema"
	"entgo.io/ent/dialect"
	entschema "entgo.io/ent/dialect/sql/schema"
	"entgo.io/ent/schema/field"
)

var (
	shardKeyOption    = regexp.MustCompile("(?i)\\bshardkey\\s*=\\s*(?:`([^`]*)`|([A-Za-z0-9_]+))")
	characterSet      = regexp.MustCompile(`(?i)\s+CHARACTER\s+SET\s+[A-Za-z0-9_]+`)
	collation         = regexp.MustCompile(`(?i)\s+COLLATE\s+[A-Za-z0-9_]+`)
	characterSetValue = regexp.MustCompile(`(?i)\bCHARACTER\s+SET\s+([A-Za-z0-9_]+)`)
	collationValue    = regexp.MustCompile(`(?i)\bCOLLATE\s+([A-Za-z0-9_]+)`)
)

// Compile 将 ordinary-MySQL baseline 确定性编译为 TDSQL HASH 分表 DDL。
func Compile(source string, catalog *physicalschema.Catalog) (string, error) {
	if catalog == nil {
		return "", fmt.Errorf("physical schema catalog is nil")
	}
	parsed, err := ParseDocument(source)
	if err != nil {
		return "", err
	}
	byName := make(map[string]*Table, len(parsed))
	for _, table := range parsed {
		if _, exists := byName[table.Name]; exists {
			return "", fmt.Errorf("duplicate CREATE TABLE %s", table.Name)
		}
		if _, ok := catalog.Table(table.Name); !ok {
			return "", fmt.Errorf("table %s is outside physical schema", table.Name)
		}
		byName[table.Name] = table
	}
	specs := catalog.Tables()
	if len(byName) != len(specs) {
		return "", fmt.Errorf("CREATE TABLE count %d != catalog count %d", len(byName), len(specs))
	}
	var output strings.Builder
	for _, spec := range specs {
		table := byName[spec.Name]
		if table == nil {
			return "", fmt.Errorf("missing CREATE TABLE %s", spec.Name)
		}
		violations := Compare(table, spec)
		if len(violations) != 0 {
			return "", fmt.Errorf("table %s: %s", spec.Name, violations[0].Message)
		}
		table.PrimaryKey = append([]string(nil), spec.PhysicalPrimaryKey...)
		table.ShardKey = spec.ShardKey
		output.WriteString(Render(table, spec))
	}
	compiled := output.String()
	reparsed, err := ParseDocument(compiled)
	if err != nil {
		return "", fmt.Errorf("reparse compiled DDL: %w", err)
	}
	if len(reparsed) != len(specs) {
		return "", fmt.Errorf("compiled table count mismatch")
	}
	for _, table := range reparsed {
		spec, ok := catalog.Table(table.Name)
		if !ok {
			return "", fmt.Errorf("compiled table %s is outside catalog", table.Name)
		}
		if violations := Compare(table, spec); len(violations) != 0 {
			return "", fmt.Errorf("compiled table %s: %s", table.Name, violations[0].Message)
		}
	}
	return compiled, nil
}

// Compare 比较解析后的表与物理规格。逻辑 PK 与目标物理 PK 都可作为编译输入。
func Compare(table *Table, spec physicalschema.TableSpec) []Violation {
	if table == nil {
		return []Violation{{Message: "table is nil"}}
	}
	if table.Name != spec.Name {
		return []Violation{{Message: "table name mismatch"}}
	}
	if len(table.Columns) != len(spec.Desired.Columns) {
		return []Violation{{Message: "column count mismatch"}}
	}
	for i, expected := range spec.Desired.Columns {
		actual := table.Columns[i]
		if actual.Name != expected.Name {
			return []Violation{{Message: fmt.Sprintf("column %d name mismatch", i)}}
		}
		if normalizeType(actual.Type) != normalizeType(mysqlType(expected)) {
			return []Violation{{Message: fmt.Sprintf("column %s type mismatch", actual.Name)}}
		}
		if actual.Nullable != expected.Nullable {
			return []Violation{{Message: fmt.Sprintf("column %s nullability mismatch", actual.Name)}}
		}
	}
	if !slices.Equal(table.PrimaryKey, spec.LogicalPrimaryKey) &&
		!slices.Equal(table.PrimaryKey, spec.PhysicalPrimaryKey) {
		return []Violation{{Message: "primary key mismatch"}}
	}
	if table.ShardKey != "" && table.ShardKey != spec.ShardKey {
		return []Violation{{Message: "shardkey option conflicts with catalog"}}
	}
	if len(table.Indexes) != len(spec.Desired.Indexes) {
		return []Violation{{Message: "index count mismatch"}}
	}
	expectedIndexes := make(map[string]*entschema.Index, len(spec.Desired.Indexes))
	for _, index := range spec.Desired.Indexes {
		expectedIndexes[physicalIndexName(index.Name)] = index
	}
	for _, actual := range table.Indexes {
		expected := expectedIndexes[actual.Name]
		if expected == nil {
			return []Violation{{Message: fmt.Sprintf("unexpected index %s", actual.Name)}}
		}
		if actual.Unique != expected.Unique || !slices.Equal(actual.Columns, schemaColumnNames(expected.Columns)) {
			return []Violation{{Message: fmt.Sprintf("index %s mismatch", actual.Name)}}
		}
		delete(expectedIndexes, actual.Name)
	}
	if len(expectedIndexes) != 0 {
		return []Violation{{Message: "missing indexes"}}
	}
	return nil
}

// ComparePhysical 在通用结构比较之上，严格要求运行时物理 PK、shardkey 与 route 字符语义。
func ComparePhysical(table *Table, spec physicalschema.TableSpec) []Violation {
	if violations := Compare(table, spec); len(violations) != 0 {
		return violations
	}
	if !slices.Equal(table.PrimaryKey, spec.PhysicalPrimaryKey) {
		return []Violation{{Message: "physical primary key mismatch"}}
	}
	if table.ShardKey != spec.ShardKey {
		return []Violation{{Message: "physical shardkey mismatch"}}
	}
	for _, column := range table.Columns {
		if column.Name != spec.ShardKey {
			continue
		}
		charset := characterSetValue.FindStringSubmatch(column.Raw)
		collate := collationValue.FindStringSubmatch(column.Raw)
		if len(charset) != 2 || !strings.EqualFold(charset[1], spec.Route.CharacterSet) ||
			len(collate) != 2 || !strings.EqualFold(collate[1], spec.Route.Collation) {
			return []Violation{{Message: "route character semantics mismatch"}}
		}
		return nil
	}
	return []Violation{{Message: "route column missing"}}
}

// Render 输出单行、稳定、可再次解析的 CREATE TABLE。
func Render(table *Table, spec physicalschema.TableSpec) string {
	elements := make([]string, 0, len(table.Columns)+len(table.Indexes)+1)
	for _, column := range table.Columns {
		if column.Name == spec.ShardKey {
			elements = append(elements, renderRouteColumn(column))
		} else {
			elements = append(elements, strings.TrimSpace(column.Raw))
		}
	}
	elements = append(elements, "PRIMARY KEY ("+quotedColumns(spec.PhysicalPrimaryKey)+")")
	for _, index := range table.Indexes {
		elements = append(elements, strings.TrimSpace(index.Raw))
	}
	options := shardKeyOption.ReplaceAllString(table.Options, "")
	options = strings.Join(strings.Fields(options), " ")
	if options != "" {
		options += " "
	}
	options += "shardkey=`" + escapeIdentifier(spec.ShardKey) + "`"
	return fmt.Sprintf("-- Create %q table\nCREATE TABLE `%s` (%s) %s;\n",
		table.Name,
		escapeIdentifier(table.Name),
		strings.Join(elements, ", "),
		options,
	)
}

func renderRouteColumn(column Column) string {
	prefix := strings.TrimSpace(column.Raw[:column.typeEnd])
	suffix := column.Raw[column.typeEnd:]
	suffix = characterSet.ReplaceAllString(suffix, "")
	suffix = collation.ReplaceAllString(suffix, "")
	suffix = strings.TrimSpace(suffix)
	if suffix != "" {
		suffix = " " + suffix
	}
	return prefix + " CHARACTER SET ascii COLLATE ascii_bin" + suffix
}

func parseShardKey(options string) (string, int, error) {
	matches := shardKeyOption.FindAllStringSubmatch(options, -1)
	if len(matches) == 0 {
		return "", 0, nil
	}
	value := matches[0][1]
	if value == "" {
		value = matches[0][2]
	}
	if value == "" {
		return "", len(matches), fmt.Errorf("empty shardkey option")
	}
	return value, len(matches), nil
}

func physicalIndexName(name string) string {
	if len(name) <= 64 {
		return name
	}
	digest := md5.Sum([]byte(name))
	return fmt.Sprintf("%s_%x", name[:31], digest)
}

func schemaColumnNames(columns []*entschema.Column) []string {
	names := make([]string, 0, len(columns))
	for _, column := range columns {
		names = append(names, column.Name)
	}
	return names
}

func quotedColumns(columns []string) string {
	quoted := make([]string, 0, len(columns))
	for _, column := range columns {
		quoted = append(quoted, "`"+escapeIdentifier(column)+"`")
	}
	return strings.Join(quoted, ", ")
}

func escapeIdentifier(value string) string { return strings.ReplaceAll(value, "`", "``") }

func normalizeType(value string) string {
	return strings.ToLower(strings.Join(strings.Fields(strings.TrimSpace(value)), " "))
}

func mysqlType(column *entschema.Column) string {
	if value := column.SchemaType[dialect.MySQL]; value != "" {
		return strings.ToLower(value)
	}
	switch column.Type {
	case field.TypeString, field.TypeEnum:
		if column.Size > 65535 {
			return "longtext"
		}
		size := column.Size
		if size <= 0 {
			size = 255
		}
		return fmt.Sprintf("varchar(%d)", size)
	case field.TypeBytes:
		if column.Size > 0 {
			return fmt.Sprintf("varbinary(%d)", column.Size)
		}
		return "longblob"
	case field.TypeTime:
		return "datetime(6)"
	case field.TypeBool:
		return "tinyint(1)"
	default:
		if column.Type.Integer() {
			return "bigint"
		}
		if column.Type.Float() {
			return "double"
		}
		return strings.ToLower(column.Type.String())
	}
}
