// Package tdsqlbaseline 绑定 TDSQL logical source、PhysicalSchema 与 runtime SQL。
package tdsqlbaseline

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strconv"
	"strings"

	"chatserver/internal/database/physicalschema"
	"chatserver/internal/database/tdsqlddl"
	"entgo.io/ent/dialect"
)

const (
	// Filename 是 v1 唯一允许的 TDSQL baseline 文件。
	Filename = "20260801000000_baseline.sql"
	// CompilerFormatVersion 参与 compile.sum，变更渲染格式时必须升级。
	CompilerFormatVersion = "tdsqlddl/v1"
)

// Artifact 是由一份 logical source 确定性产生的 runtime 文件集合。
type Artifact struct {
	Output     []byte
	CompileSum []byte
}

// Build 编译 source，并生成绑定 Catalog 与输入输出哈希的 compile.sum。
func Build(source []byte) (Artifact, error) {
	catalog, err := physicalschema.Baseline20260801000000()
	if err != nil {
		return Artifact{}, fmt.Errorf("build physical schema: %w", err)
	}
	compiled, err := tdsqlddl.Compile(string(source), catalog)
	if err != nil {
		return Artifact{}, fmt.Errorf("compile TDSQL baseline: %w", err)
	}
	output := []byte(compiled)
	binding := fmt.Sprintf(
		"version=%s catalog_sha256=%s file=%s source_sha256=%s output_sha256=%s\n",
		CompilerFormatVersion,
		catalogSHA256(catalog),
		Filename,
		sha256Hex(source),
		sha256Hex(output),
	)
	return Artifact{Output: output, CompileSum: []byte(binding)}, nil
}

// Verify 从当前 source/Catalog 全量重建，并要求两个产物逐字节相等。
func Verify(source []byte, output []byte, compileSum []byte) error {
	expected, err := Build(source)
	if err != nil {
		return err
	}
	if !bytes.Equal(output, expected.Output) {
		return fmt.Errorf("runtime TDSQL baseline differs from compiled output")
	}
	if !bytes.Equal(compileSum, expected.CompileSum) {
		return fmt.Errorf("compile.sum differs from source, output, or catalog")
	}
	return nil
}

func catalogSHA256(catalog *physicalschema.Catalog) string {
	var canonical strings.Builder
	for _, table := range catalog.Tables() {
		canonical.WriteString("table=")
		canonical.WriteString(table.Name)
		canonical.WriteString("|schema=")
		canonical.WriteString(table.Schema)
		canonical.WriteString("|kind=")
		canonical.WriteString(string(table.Kind))
		canonical.WriteString("|shardkey=")
		canonical.WriteString(table.ShardKey)
		canonical.WriteString("|logical_pk=")
		canonical.WriteString(strings.Join(table.LogicalPrimaryKey, ","))
		canonical.WriteString("|physical_pk=")
		canonical.WriteString(strings.Join(table.PhysicalPrimaryKey, ","))
		canonical.WriteString("|route=")
		canonical.WriteString(table.Route.PhysicalType)
		canonical.WriteByte(':')
		canonical.WriteString(strconv.Itoa(table.Route.MaxLength))
		canonical.WriteByte(':')
		canonical.WriteString(table.Route.CharacterSet)
		canonical.WriteByte(':')
		canonical.WriteString(table.Route.Collation)
		for _, column := range table.Desired.Columns {
			canonical.WriteString("|column=")
			canonical.WriteString(column.Name)
			canonical.WriteByte(':')
			canonical.WriteString(column.Type.String())
			canonical.WriteByte(':')
			canonical.WriteString(column.SchemaType[dialect.MySQL])
			canonical.WriteByte(':')
			canonical.WriteString(strconv.FormatBool(column.Nullable))
		}
		for _, index := range table.Desired.Indexes {
			canonical.WriteString("|index=")
			canonical.WriteString(index.Name)
			canonical.WriteByte(':')
			canonical.WriteString(strconv.FormatBool(index.Unique))
			for _, column := range index.Columns {
				canonical.WriteByte(':')
				canonical.WriteString(column.Name)
			}
		}
		canonical.WriteByte('\n')
	}
	return sha256Hex([]byte(canonical.String()))
}

func sha256Hex(value []byte) string {
	digest := sha256.Sum256(value)
	return hex.EncodeToString(digest[:])
}
