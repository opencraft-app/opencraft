package httpapi

import (
	"encoding/json"
	"os"
	"sort"
	"testing"
)

func TestOpenAPIIncludesControlPlaneChannelContract(t *testing.T) {
	raw, err := os.ReadFile("../../docs/openapi.json")
	if err != nil {
		t.Fatal(err)
	}
	var spec struct {
		Paths      map[string]json.RawMessage `json:"paths"`
		Components struct {
			Schemas map[string]struct {
				Properties map[string]json.RawMessage `json:"properties"`
				Required   []string                   `json:"required"`
			} `json:"schemas"`
		} `json:"components"`
	}
	if err := json.Unmarshal(raw, &spec); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{
		"/api/channel-bundles",
		"/api/channel-bundles/import",
		"/api/channel-bundles/{bundle_id}/delivery-status",
		"/api/channel-bundles/{bundle_id}/plan",
		"/api/channel-bundles/{bundle_id}/apply",
		"/api/desired-config/export",
		"/api/desired-config/import",
		"/api/admin/traffic-probe",
		"/api/admin/shard-expansions",
		"/api/admin/shard-expansions/{expansion_id}/infrastructure",
		"/api/admin/shard-expansions/{expansion_id}/verification",
	} {
		if len(spec.Paths[path]) == 0 {
			t.Fatalf("OpenAPI missing control-plane path %s", path)
		}
	}
	for schema, properties := range map[string][]string{
		"ChannelBundleDeliveryStatus":   {"status", "counts", "sets", "coverage_checked_at"},
		"ChannelBundleSetActionRequest": {"set_id", "force_drift"},
		"SetCapacityPolicy":             {"redis_db_start", "redis_db_limit"},
		"DesiredConfig":                 {"api_version", "kind", "global_options", "channel_bundles"},
		"TrafficProbeRequest":           {"mode", "api_key", "user_id", "model", "prompt"},
		"ShardExpansion":                {"shard_id", "status", "redis_db_start", "redis_db_limit", "mysql_endpoint", "redis_endpoint"},
		"Shard":                         {"endpoint", "redis_endpoint", "redis_db_start", "redis_db_limit"},
	} {
		definition, ok := spec.Components.Schemas[schema]
		if !ok {
			t.Fatalf("OpenAPI missing schema %s", schema)
		}
		for _, property := range properties {
			if len(definition.Properties[property]) == 0 {
				t.Fatalf("OpenAPI schema %s missing property %s", schema, property)
			}
		}
	}
	applySchema, ok := spec.Components.Schemas["ApplySubscriptionRequest"]
	if !ok {
		t.Fatal("OpenAPI missing ApplySubscriptionRequest")
	}
	if len(applySchema.Properties["idempotency_key"]) == 0 {
		t.Fatal("ApplySubscriptionRequest missing idempotency_key")
	}
	required := map[string]bool{}
	for _, field := range applySchema.Required {
		required[field] = true
	}
	if required["idempotency_key"] {
		t.Fatal("ApplySubscriptionRequest idempotency_key must remain optional for legacy callers")
	}
}

func TestOpenAPIPathsMatchOpenSpecContract(t *testing.T) {
	raw, err := os.ReadFile("../../docs/openapi.json")
	if err != nil {
		t.Fatal(err)
	}
	var openAPI struct {
		Paths map[string]json.RawMessage `json:"paths"`
	}
	if err := json.Unmarshal(raw, &openAPI); err != nil {
		t.Fatal(err)
	}
	contractRaw, err := os.ReadFile("../../openspec/openapi_contract.json")
	if err != nil {
		t.Fatal(err)
	}
	var contract struct {
		Paths []string `json:"paths"`
	}
	if err := json.Unmarshal(contractRaw, &contract); err != nil {
		t.Fatal(err)
	}
	contractPaths := map[string]bool{}
	for _, path := range contract.Paths {
		if path == "" {
			t.Fatal("OpenSpec OpenAPI contract contains an empty path")
		}
		if contractPaths[path] {
			t.Fatalf("OpenSpec OpenAPI contract contains duplicate path %s", path)
		}
		contractPaths[path] = true
		if len(openAPI.Paths[path]) == 0 {
			t.Fatalf("OpenAPI is missing OpenSpec-contracted path %s", path)
		}
	}
	for path := range openAPI.Paths {
		if !contractPaths[path] {
			t.Fatalf("OpenAPI path %s is not listed in openspec/openapi_contract.json", path)
		}
	}
	if !sort.StringsAreSorted(contract.Paths) {
		t.Fatalf("openspec/openapi_contract.json paths must stay sorted: %+v", contract.Paths)
	}
}
