// Package modelcontract 读取并验证平台领域模型的机器契约。
package modelcontract

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"slices"
	"strings"

	"gopkg.in/yaml.v3"
)

const CurrentSchemaVersion = 1

// Contract 是领域模型语义的唯一机器契约。
type Contract struct {
	SchemaVersion       int                  `yaml:"schemaVersion"`
	Tables              []Table              `yaml:"tables"`
	CrossShardWorkflows []CrossShardWorkflow `yaml:"crossShardWorkflows,omitempty"`
}

// Table 描述一张业务表的归属、生命周期与数据分类。
type Table struct {
	Schema               string            `yaml:"schema"`
	Table                string            `yaml:"table"`
	Domain               string            `yaml:"domain"`
	Kind                 string            `yaml:"kind"`
	ShardKey             string            `yaml:"shardKey"`
	LogicalID            string            `yaml:"logicalId"`
	ImmutableRouteFields []string          `yaml:"immutableRouteFields"`
	RequiredWhilePresent []string          `yaml:"requiredWhilePresent,omitempty"`
	References           []Reference       `yaml:"references,omitempty"`
	Lifecycle            *Lifecycle        `yaml:"lifecycle,omitempty"`
	DeletePolicy         string            `yaml:"deletePolicy"`
	Retention            string            `yaml:"retention"`
	Rebuildable          bool              `yaml:"rebuildable"`
	SemanticFields       map[string]string `yaml:"semanticFields,omitempty"`
}

// Reference 是不依赖数据库外键的逻辑引用。
type Reference struct {
	Field      string `yaml:"field"`
	Table      string `yaml:"table"`
	CrossShard bool   `yaml:"crossShard,omitempty"`
}

// Lifecycle 固定状态字段和允许值。
type Lifecycle struct {
	Field  string   `yaml:"field"`
	Values []string `yaml:"values"`
}

// CrossShardWorkflow 显式列出允许的跨分片业务流程。
type CrossShardWorkflow struct {
	Name      string            `yaml:"name"`
	Tables    []string          `yaml:"tables"`
	RouteKeys map[string]string `yaml:"routeKeys"`
	Direction string            `yaml:"direction"`
}

// PhysicalTable 是 Ent 与物理路由 Manifest 的最小联合投影。
type PhysicalTable struct {
	Schema     string
	Table      string
	ShardKey   string
	Fields     []string
	EnumValues map[string][]string
}

// LoadFile 从磁盘读取严格 YAML 契约。
func LoadFile(path string) (Contract, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Contract{}, err
	}
	return Load(data)
}

// Load 拒绝未知字段、多文档和不受支持的契约版本。
func Load(data []byte) (Contract, error) {
	decoder := yaml.NewDecoder(bytes.NewReader(data))
	decoder.KnownFields(true)
	var contract Contract
	if err := decoder.Decode(&contract); err != nil {
		return Contract{}, fmt.Errorf("解析领域模型契约: %w", err)
	}
	var extra any
	if err := decoder.Decode(&extra); err != nil && !errors.Is(err, io.EOF) {
		return Contract{}, fmt.Errorf("解析领域模型契约尾部: %w", err)
	} else if err == nil {
		return Contract{}, errors.New("领域模型契约只能包含一个 YAML document")
	}
	if contract.SchemaVersion != CurrentSchemaVersion {
		return Contract{}, fmt.Errorf("不支持的 schemaVersion %d", contract.SchemaVersion)
	}
	return contract, nil
}

// Validate 对照 Ent/Manifest 联合投影验证领域契约。
func Validate(contract Contract, physical []PhysicalTable) error {
	if contract.SchemaVersion != CurrentSchemaVersion {
		return fmt.Errorf("schemaVersion = %d，期望 %d", contract.SchemaVersion, CurrentSchemaVersion)
	}
	physicalByTable := make(map[string]PhysicalTable, len(physical))
	for _, item := range physical {
		if item.Table == "" || item.Schema == "" || item.ShardKey == "" {
			return fmt.Errorf("物理表定义不完整: %#v", item)
		}
		if _, exists := physicalByTable[item.Table]; exists {
			return fmt.Errorf("物理表 %s 重复", item.Table)
		}
		physicalByTable[item.Table] = item
	}

	contractByTable := make(map[string]Table, len(contract.Tables))
	contractBySchema := make(map[string]string, len(contract.Tables))
	for _, table := range contract.Tables {
		if table.Table == "" || table.Schema == "" {
			return errors.New("contract 存在空 schema/table")
		}
		if _, exists := contractByTable[table.Table]; exists {
			return fmt.Errorf("contract 表 %s 重复", table.Table)
		}
		if old, exists := contractBySchema[table.Schema]; exists {
			return fmt.Errorf("contract schema %s 重复用于 %s/%s", table.Schema, old, table.Table)
		}
		contractByTable[table.Table] = table
		contractBySchema[table.Schema] = table.Table
	}
	if len(contractByTable) != len(physicalByTable) {
		return fmt.Errorf("contract 表数 %d 与物理表数 %d 不一致", len(contractByTable), len(physicalByTable))
	}

	for tableName, table := range contractByTable {
		actual, exists := physicalByTable[tableName]
		if !exists {
			return fmt.Errorf("contract 表 %s 在物理模型中不存在", tableName)
		}
		if table.Schema != actual.Schema {
			return fmt.Errorf("表 %s schema = %s，物理值为 %s", tableName, table.Schema, actual.Schema)
		}
		if table.ShardKey != actual.ShardKey {
			return fmt.Errorf("表 %s shardkey = %s，Manifest 为 %s", tableName, table.ShardKey, actual.ShardKey)
		}
		if err := validateTable(table, actual.Fields, actual.EnumValues, contractByTable); err != nil {
			return err
		}
	}
	for tableName := range physicalByTable {
		if _, exists := contractByTable[tableName]; !exists {
			return fmt.Errorf("物理表 %s 未进入 contract", tableName)
		}
	}
	return validateWorkflows(contract.CrossShardWorkflows, contractByTable)
}

func validateTable(table Table, fields []string, enumValues map[string][]string, all map[string]Table) error {
	if table.Domain == "" || table.LogicalID == "" || table.Retention == "" {
		return fmt.Errorf("表 %s 缺少 domain/logicalId/retention", table.Table)
	}
	if !slices.Contains([]string{"authority", "registry", "projection", "ledger"}, table.Kind) {
		return fmt.Errorf("表 %s kind %q 无效", table.Table, table.Kind)
	}
	if table.Rebuildable && table.Kind != "registry" && table.Kind != "projection" {
		return fmt.Errorf("表 %s kind=%s 不能声明 rebuildable", table.Table, table.Kind)
	}
	if !slices.Contains([]string{"hard-delete", "tombstone", "expiry", "append-only"}, table.DeletePolicy) {
		return fmt.Errorf("表 %s deletePolicy %q 无效", table.Table, table.DeletePolicy)
	}
	fieldSet := make(map[string]struct{}, len(fields))
	for _, field := range fields {
		fieldSet[field] = struct{}{}
	}
	for _, required := range []string{table.LogicalID, table.ShardKey} {
		if _, exists := fieldSet[required]; !exists {
			return fmt.Errorf("表 %s 字段 %s 在 Ent 中不存在", table.Table, required)
		}
	}
	for _, field := range table.ImmutableRouteFields {
		if _, exists := fieldSet[field]; !exists {
			return fmt.Errorf("表 %s immutableRouteField %s 在 Ent 中不存在", table.Table, field)
		}
	}
	if !slices.Contains(table.ImmutableRouteFields, table.ShardKey) {
		return fmt.Errorf("表 %s shardkey %s 不是 immutableRouteFields", table.Table, table.ShardKey)
	}
	classes := []string{"lifecycle", "secret", "credential", "hash", "pii", "reference", "opaque-json"}
	for field, class := range table.SemanticFields {
		if _, exists := fieldSet[field]; !exists {
			return fmt.Errorf("表 %s semantic field %s 在 Ent 中不存在", table.Table, field)
		}
		if !slices.Contains(classes, class) {
			return fmt.Errorf("表 %s 字段 %s 分类 %q 无效", table.Table, field, class)
		}
	}
	for field := range fieldSet {
		if requiresExplicitClassification(field) {
			if _, exists := table.SemanticFields[field]; !exists {
				return fmt.Errorf("表 %s 敏感/持久字段 %s 未显式分类", table.Table, field)
			}
		}
	}
	for _, reference := range table.References {
		if _, exists := fieldSet[reference.Field]; !exists {
			return fmt.Errorf("表 %s reference field %s 不存在", table.Table, reference.Field)
		}
		if _, exists := all[reference.Table]; !exists {
			return fmt.Errorf("表 %s 引用的表 %s 不存在", table.Table, reference.Table)
		}
		if table.SemanticFields[reference.Field] != "reference" {
			return fmt.Errorf("表 %s 引用字段 %s 未分类为 reference", table.Table, reference.Field)
		}
	}
	if len(table.RequiredWhilePresent) > 0 && table.DeletePolicy != "tombstone" {
		return fmt.Errorf("表 %s requiredWhilePresent 只适用于 tombstone 表", table.Table)
	}
	referenceFields := make(map[string]struct{}, len(table.References))
	for _, reference := range table.References {
		referenceFields[reference.Field] = struct{}{}
	}
	seenRequired := make(map[string]struct{}, len(table.RequiredWhilePresent))
	for _, field := range table.RequiredWhilePresent {
		if _, exists := referenceFields[field]; !exists {
			return fmt.Errorf("表 %s requiredWhilePresent 字段 %s 不是 logical reference", table.Table, field)
		}
		if _, exists := seenRequired[field]; exists {
			return fmt.Errorf("表 %s requiredWhilePresent 字段 %s 重复", table.Table, field)
		}
		seenRequired[field] = struct{}{}
	}
	if table.Lifecycle != nil {
		if _, exists := fieldSet[table.Lifecycle.Field]; !exists {
			return fmt.Errorf("表 %s lifecycle field %s 不存在", table.Table, table.Lifecycle.Field)
		}
		if len(table.Lifecycle.Values) == 0 || table.SemanticFields[table.Lifecycle.Field] != "lifecycle" {
			return fmt.Errorf("表 %s lifecycle 定义不完整", table.Table)
		}
		seenValues := make(map[string]struct{}, len(table.Lifecycle.Values))
		for _, value := range table.Lifecycle.Values {
			if strings.TrimSpace(value) == "" {
				return fmt.Errorf("表 %s lifecycle value 不能为空", table.Table)
			}
			if _, exists := seenValues[value]; exists {
				return fmt.Errorf("表 %s lifecycle value %s 重复", table.Table, value)
			}
			seenValues[value] = struct{}{}
		}
		if actualValues, isEnum := enumValues[table.Lifecycle.Field]; isEnum {
			expected := slices.Clone(table.Lifecycle.Values)
			actual := slices.Clone(actualValues)
			slices.Sort(expected)
			slices.Sort(actual)
			if !slices.Equal(expected, actual) {
				return fmt.Errorf("表 %s lifecycle values %v 与 Ent enum %v 不一致", table.Table, expected, actual)
			}
		}
	}
	return nil
}

func requiresExplicitClassification(field string) bool {
	value := strings.ToLower(field)
	return strings.Contains(value, "secret") || strings.Contains(value, "credential") ||
		strings.Contains(value, "password") || strings.Contains(value, "hash") ||
		strings.Contains(value, "email") || strings.HasSuffix(value, "_json")
}

func validateWorkflows(workflows []CrossShardWorkflow, tables map[string]Table) error {
	seen := make(map[string]struct{}, len(workflows))
	for _, workflow := range workflows {
		if workflow.Name == "" || len(workflow.Tables) < 2 || len(workflow.RouteKeys) != len(workflow.Tables) {
			return fmt.Errorf("跨分片 workflow %q 定义不完整", workflow.Name)
		}
		if _, exists := seen[workflow.Name]; exists {
			return fmt.Errorf("跨分片 workflow %s 重复", workflow.Name)
		}
		seen[workflow.Name] = struct{}{}
		if !slices.Contains([]string{"one-way", "two-way"}, workflow.Direction) {
			return fmt.Errorf("跨分片 workflow %s direction 无效", workflow.Name)
		}
		for _, tableName := range workflow.Tables {
			table, exists := tables[tableName]
			if !exists {
				return fmt.Errorf("跨分片 workflow %s 的表 %s 不存在", workflow.Name, tableName)
			}
			if workflow.RouteKeys[tableName] != table.ShardKey {
				return fmt.Errorf("跨分片 workflow %s 的表 %s route key 错误", workflow.Name, tableName)
			}
		}
	}
	return nil
}
