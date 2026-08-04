package modelcontract_test

import (
	"path/filepath"
	"strings"
	"testing"

	"chatserver/internal/database/modelcontract"
	"chatserver/internal/database/physicalschema"
	"entgo.io/ent/entc"
	"entgo.io/ent/entc/gen"
)

func TestPlatformContractMatchesEntAndRoutingManifest(t *testing.T) {
	contractPath := filepath.Join("..", "..", "..", "platform", "v1", "model-contract.yaml")
	contract, err := modelcontract.LoadFile(contractPath)
	if err != nil {
		t.Fatalf("加载领域模型契约：%v", err)
	}

	graph, err := entc.LoadGraph(filepath.Join("..", "..", "ent", "schema"), &gen.Config{
		Target:  t.TempDir(),
		Package: "chatserver/internal/ent",
	})
	if err != nil {
		t.Fatalf("加载 Ent Graph：%v", err)
	}
	shards := make(map[string]physicalschema.Entry, len(physicalschema.Manifest()))
	for _, entry := range physicalschema.Manifest() {
		shards[entry.Table] = entry
	}
	physical := make([]modelcontract.PhysicalTable, 0, len(graph.Nodes))
	for _, node := range graph.Nodes {
		entry, ok := shards[node.Table()]
		if !ok {
			t.Fatalf("Manifest 缺少表 %s", node.Table())
		}
		fields := []string{node.ID.Name}
		enumValues := make(map[string][]string)
		for _, item := range node.Fields {
			fields = append(fields, item.Name)
			if item.IsEnum() {
				enumValues[item.Name] = item.EnumValues()
			}
		}
		physical = append(physical, modelcontract.PhysicalTable{
			Schema: entry.Schema, Table: entry.Table, ShardKey: entry.ShardKey, Fields: fields,
			EnumValues: enumValues,
		})
	}
	if err := modelcontract.Validate(contract, physical); err != nil {
		t.Fatalf("领域模型契约漂移：%v", err)
	}
	if len(contract.Tables) != 27 {
		t.Fatalf("contract tables = %d，期望 27", len(contract.Tables))
	}
}

func TestContractStrictlyRejectsUnknownKeys(t *testing.T) {
	_, err := modelcontract.Load([]byte(`
schemaVersion: 1
tables: []
surprise: true
`))
	if err == nil || !strings.Contains(err.Error(), "surprise") {
		t.Fatalf("未知键错误 = %v", err)
	}
}

func TestContractRejectsDuplicateAndDanglingTables(t *testing.T) {
	contract := minimalContract()
	contract.Tables = append(contract.Tables, contract.Tables[0])
	if err := modelcontract.Validate(contract, minimalPhysical()); err == nil ||
		!strings.Contains(err.Error(), "重复") {
		t.Fatalf("重复表错误 = %v", err)
	}

	contract = minimalContract()
	contract.Tables[0].References = []modelcontract.Reference{{Field: "owner_id", Table: "missing"}}
	contract.Tables[0].SemanticFields["owner_id"] = "reference"
	if err := modelcontract.Validate(contract, minimalPhysical()); err == nil ||
		!strings.Contains(err.Error(), "不存在") {
		t.Fatalf("悬空引用错误 = %v", err)
	}
}

func TestContractRejectsShardDriftAndUnclassifiedSecrets(t *testing.T) {
	contract := minimalContract()
	contract.Tables[0].ShardKey = "owner_id"
	if err := modelcontract.Validate(contract, minimalPhysical()); err == nil ||
		!strings.Contains(err.Error(), "shardkey") {
		t.Fatalf("shardkey 漂移错误 = %v", err)
	}

	contract = minimalContract()
	physical := minimalPhysical()
	physical[0].Fields = append(physical[0].Fields, "secret_hash")
	if err := modelcontract.Validate(contract, physical); err == nil ||
		!strings.Contains(err.Error(), "secret_hash") {
		t.Fatalf("未分类 secret 错误 = %v", err)
	}
}

func TestContractRejectsLifecycleValuesThatDriftFromEntEnum(t *testing.T) {
	contract := minimalContract()
	contract.Tables[0].Lifecycle = &modelcontract.Lifecycle{
		Field: "state", Values: []string{"active", "removed"},
	}
	contract.Tables[0].SemanticFields["state"] = "lifecycle"
	physical := minimalPhysical()
	physical[0].Fields = append(physical[0].Fields, "state")
	physical[0].EnumValues = map[string][]string{"state": {"active", "disabled"}}

	if err := modelcontract.Validate(contract, physical); err == nil ||
		!strings.Contains(err.Error(), "lifecycle values") {
		t.Fatalf("lifecycle enum 漂移错误 = %v", err)
	}
}

func TestContractRejectsInvalidSemanticInvariants(t *testing.T) {
	t.Run("required while present field must be a logical reference", func(t *testing.T) {
		contract := minimalContract()
		contract.Tables[0].DeletePolicy = "tombstone"
		contract.Tables[0].RequiredWhilePresent = []string{"owner_id"}
		if err := modelcontract.Validate(contract, minimalPhysical()); err == nil ||
			!strings.Contains(err.Error(), "logical reference") {
			t.Fatalf("requiredWhilePresent 错误 = %v", err)
		}

		contract.Tables[0].References = []modelcontract.Reference{{Field: "owner_id", Table: "widgets"}}
		contract.Tables[0].SemanticFields["owner_id"] = "reference"
		physical := minimalPhysical()
		physical[0].Fields = append(physical[0].Fields, "owner_id")
		if err := modelcontract.Validate(contract, physical); err != nil {
			t.Fatalf("合法 requiredWhilePresent 被拒绝：%v", err)
		}
	})

	t.Run("immutable route field must exist", func(t *testing.T) {
		contract := minimalContract()
		contract.Tables[0].ImmutableRouteFields = append(contract.Tables[0].ImmutableRouteFields, "missing_route")
		if err := modelcontract.Validate(contract, minimalPhysical()); err == nil ||
			!strings.Contains(err.Error(), "missing_route") {
			t.Fatalf("immutable route field 错误 = %v", err)
		}
	})
	t.Run("lifecycle values must be unique", func(t *testing.T) {
		contract := minimalContract()
		contract.Tables[0].Lifecycle = &modelcontract.Lifecycle{Field: "state", Values: []string{"active", "active"}}
		contract.Tables[0].SemanticFields["state"] = "lifecycle"
		physical := minimalPhysical()
		physical[0].Fields = append(physical[0].Fields, "state")
		if err := modelcontract.Validate(contract, physical); err == nil ||
			!strings.Contains(err.Error(), "重复") {
			t.Fatalf("lifecycle duplicate 错误 = %v", err)
		}
	})
	t.Run("only projections and registries are rebuildable", func(t *testing.T) {
		contract := minimalContract()
		contract.Tables[0].Rebuildable = true
		if err := modelcontract.Validate(contract, minimalPhysical()); err == nil ||
			!strings.Contains(err.Error(), "rebuildable") {
			t.Fatalf("rebuildable 错误 = %v", err)
		}
	})
}

func minimalContract() modelcontract.Contract {
	return modelcontract.Contract{
		SchemaVersion: 1,
		Tables: []modelcontract.Table{{
			Schema: "Widget", Table: "widgets", Domain: "server", Kind: "authority",
			ShardKey: "server_id", LogicalID: "id", ImmutableRouteFields: []string{"server_id"},
			DeletePolicy: "tombstone", Retention: "permanent", SemanticFields: map[string]string{
				"server_id": "reference",
			},
		}},
	}
}

func minimalPhysical() []modelcontract.PhysicalTable {
	return []modelcontract.PhysicalTable{{
		Schema: "Widget", Table: "widgets", ShardKey: "server_id",
		Fields: []string{"id", "server_id", "name"},
	}}
}
