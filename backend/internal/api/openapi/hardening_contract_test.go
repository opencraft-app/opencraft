package openapi_test

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	api "chatserver/internal/api/openapi"
	httptransport "chatserver/internal/transport/http"
	"gopkg.in/yaml.v3"
)

func TestReleasedSpecsRemainFrozenWhileCurrentAdvancesToFiveZero(t *testing.T) {
	main := loadYAML(t, filepath.Join("..", "..", "..", "platform", "v1", "openapi.yaml"))
	bootstrap := loadYAML(t, filepath.Join("..", "..", "..", "platform", "v1", "computer-bootstrap.openapi.yaml"))
	for name, spec := range map[string]map[string]any{"main": main, "bootstrap": bootstrap} {
		if got := nestedString(t, spec, "info", "version"); got != "5.0.0" {
			t.Errorf("%s info.version = %q，期望 5.0.0", name, got)
		}
	}
	for name, path := range map[string]string{
		"main":      filepath.Join("..", "..", "..", "platform", "v1", "releases", "2.0.0.openapi.yaml"),
		"bootstrap": filepath.Join("..", "..", "..", "platform", "v1", "releases", "2.0.0.computer-bootstrap.openapi.yaml"),
	} {
		spec := loadYAML(t, path)
		if got := nestedString(t, spec, "info", "version"); got != "2.0.0" {
			t.Errorf("released %s info.version = %q，必须保持 2.0.0", name, got)
		}
	}
}

func TestEveryCursorOperationReturnsStrictPageEnvelope(t *testing.T) {
	spec := loadMainSpec(t)
	expected := map[string]string{
		"listServers":                    "ServerPage",
		"listMembers":                    "MemberPage",
		"listDirectConversations":        "DirectConversationPage",
		"listTasks":                      "TaskPage",
		"listMessageThreadReplies":       "ThreadReplyReferencePage",
		"listRuntimeTasks":               "TaskPage",
		"listRuntimeReminderLog":         "ReminderOccurrencePage",
		"listRuntimeReminderOccurrences": "ReminderOccurrencePage",
	}
	found := map[string]bool{}
	for _, operation := range operations(spec) {
		if !operationHasParameter(spec, operation.pathItem, operation.value, "cursor") {
			continue
		}
		want, ok := expected[operation.id]
		if !ok {
			t.Errorf("operation %s 接受 cursor 但未进入分页契约", operation.id)
			continue
		}
		found[operation.id] = true
		got := responseSchemaRef(t, operation.value, "200")
		if got != "#/components/schemas/"+want {
			t.Errorf("%s 200 schema = %q，期望 %s", operation.id, got, want)
		}
	}
	for id := range expected {
		if !found[id] {
			t.Errorf("分页 operation %s 不存在或没有 cursor", id)
		}
	}
	components := nestedMap(t, spec, "components", "schemas")
	for _, name := range []string{"ServerPage", "MemberPage", "TaskPage", "ThreadReplyReferencePage", "ReminderOccurrencePage"} {
		schema := anyMap(t, components[name], "schema "+name)
		if schema["additionalProperties"] != false {
			t.Errorf("%s additionalProperties 必须为 false", name)
		}
		required := stringSlice(t, schema["required"], name+".required")
		for _, field := range []string{"items", "nextCursor"} {
			if !slices.Contains(required, field) {
				t.Errorf("%s.required 缺少 %s", name, field)
			}
		}
	}
}

func TestParameterDiscoveryIncludesPathItemLevelDeclarations(t *testing.T) {
	spec := map[string]any{
		"components": map[string]any{"parameters": map[string]any{
			"Cursor": map[string]any{"name": "cursor", "in": "query"},
		}},
	}
	pathItem := map[string]any{"parameters": []any{
		map[string]any{"$ref": "#/components/parameters/Cursor"},
	}}
	if !operationHasParameter(spec, pathItem, map[string]any{}, "cursor") {
		t.Fatal("path-item 级 cursor 未被分页契约发现")
	}
}

func TestRevisionHeaderIsExplicitAndNeverPretendsToBeETag(t *testing.T) {
	specPath := filepath.Join("..", "..", "..", "platform", "v1", "openapi.yaml")
	raw, err := os.ReadFile(specPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"If-Match", "IfMatch", "ETag:"} {
		if strings.Contains(string(raw), forbidden) {
			t.Errorf("OpenAPI 仍含旧 revision 语义 %q", forbidden)
		}
	}
	spec := loadYAMLBytes(t, raw)
	withResponse := map[string]bool{
		"updateServer": true, "updateMember": true, "updateChannel": true,
		"updateAgent": true, "updateRuntimeTaskStatus": true, "updateComputer": true,
		"createComputerSetupCommand": true, "updateTask": true, "updateReminder": true,
		"updateRuntimeReminder": true, "snoozeRuntimeReminder": true,
	}
	withoutResponse := map[string]bool{"cancelReminder": true, "cancelRuntimeReminder": true}
	seen := map[string]bool{}
	for _, operation := range operations(spec) {
		has := operationHasParameter(spec, operation.pathItem, operation.value, "X-Resource-Revision")
		want := withResponse[operation.id] || withoutResponse[operation.id]
		if has != want {
			t.Errorf("%s X-Resource-Revision = %v，期望 %v", operation.id, has, want)
		}
		if !want {
			continue
		}
		seen[operation.id] = true
		if withResponse[operation.id] && !successHasHeader(operation.value, "X-Resource-Revision") {
			t.Errorf("%s 成功响应缺少 X-Resource-Revision", operation.id)
		}
	}
	if len(seen) != len(withResponse)+len(withoutResponse) {
		t.Fatalf("revision operations = %d，期望 %d", len(seen), len(withResponse)+len(withoutResponse))
	}
	parameter := nestedMap(t, spec, "components", "parameters", "ResourceRevision")
	if parameter["name"] != "X-Resource-Revision" || parameter["in"] != "header" || parameter["required"] != true {
		t.Fatalf("ResourceRevision parameter = %#v", parameter)
	}
	schema := anyMap(t, parameter["schema"], "ResourceRevision.schema")
	if schema["type"] != "integer" || asInt(t, schema["minimum"]) != 0 {
		t.Fatalf("ResourceRevision schema = %#v", schema)
	}
}

func TestAuthDomainRegistryCoversEveryOperationExactlyOnce(t *testing.T) {
	spec := loadMainSpec(t)
	registry := nestedMap(t, spec, "x-auth-domain-registry")
	registered := map[string]string{}
	for domain, raw := range registry {
		for _, id := range stringSlice(t, raw, "x-auth-domain-registry."+domain) {
			if old, exists := registered[id]; exists {
				t.Errorf("operation %s 同时属于 %s/%s", id, old, domain)
			}
			registered[id] = domain
		}
	}
	for _, operation := range operations(spec) {
		domain, exists := registered[operation.id]
		if !exists {
			t.Errorf("operation %s 缺少 auth domain", operation.id)
			continue
		}
		if got := effectiveAuthDomain(spec, operation.value, domain); got != domain {
			t.Errorf("operation %s registry=%s，OpenAPI security=%s", operation.id, domain, got)
		}
		delete(registered, operation.id)
	}
	for id := range registered {
		t.Errorf("auth registry 包含不存在 operation %s", id)
	}
}

func TestServerTaskSurfaceIsHumanOnly(t *testing.T) {
	spec := loadMainSpec(t)
	for _, id := range []string{"listTasks", "getTask", "updateTask"} {
		operation := operationByID(t, spec, id)
		if got := securitySchemes(spec, operation); !slices.Equal(got, []string{"HumanBearer"}) {
			t.Errorf("%s security = %v", id, got)
		}
	}
}

func TestOpenAPIErrorRegistryExactlyMatchesGoRuntime(t *testing.T) {
	spec := loadMainSpec(t)
	rawRegistry := nestedMap(t, spec, "x-error-code-registry")
	want := map[string]int{}
	for _, mapping := range httptransport.AllErrorMappings() {
		want[mapping.Code] = mapping.Status
	}
	if len(rawRegistry) != len(want) {
		t.Fatalf("OpenAPI errors = %d，Go errors = %d", len(rawRegistry), len(want))
	}
	for code, status := range want {
		entry, ok := rawRegistry[code]
		if !ok {
			t.Errorf("OpenAPI 缺少错误码 %s", code)
			continue
		}
		if got := asInt(t, anyMap(t, entry, code)["status"]); got != status {
			t.Errorf("错误码 %s status = %d，期望 %d", code, got, status)
		}
	}
	if _, err := api.GetSwagger(); err != nil {
		t.Fatalf("生成 OpenAPI 无法加载：%v", err)
	}
}

type rawOperation struct {
	id       string
	pathItem map[string]any
	value    map[string]any
}

func loadMainSpec(t *testing.T) map[string]any {
	t.Helper()
	return loadYAML(t, filepath.Join("..", "..", "..", "platform", "v1", "openapi.yaml"))
}

func loadYAML(t *testing.T, path string) map[string]any {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return loadYAMLBytes(t, data)
}

func loadYAMLBytes(t *testing.T, data []byte) map[string]any {
	t.Helper()
	var result map[string]any
	if err := yaml.Unmarshal(data, &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func operations(spec map[string]any) []rawOperation {
	result := make([]rawOperation, 0)
	for _, rawPath := range anyMapNoTest(spec["paths"]) {
		pathItem := anyMapNoTest(rawPath)
		for method, raw := range pathItem {
			if !slices.Contains([]string{"get", "post", "put", "patch", "delete", "options", "head", "trace"}, method) {
				continue
			}
			operation := anyMapNoTest(raw)
			id, _ := operation["operationId"].(string)
			result = append(result, rawOperation{id: id, pathItem: pathItem, value: operation})
		}
	}
	return result
}

func operationByID(t *testing.T, spec map[string]any, id string) map[string]any {
	t.Helper()
	for _, operation := range operations(spec) {
		if operation.id == id {
			return operation.value
		}
	}
	t.Fatalf("operation %s 不存在", id)
	return nil
}

func operationHasParameter(spec, pathItem, operation map[string]any, name string) bool {
	for _, owner := range []map[string]any{pathItem, operation} {
		for _, raw := range anySlice(owner["parameters"]) {
			parameter := anyMapNoTest(raw)
			if reference, ok := parameter["$ref"].(string); ok {
				parts := strings.Split(reference, "/")
				parameter = anyMapNoTest(nestedNoTest(spec, "components", "parameters", parts[len(parts)-1]))
			}
			if parameter["name"] == name {
				return true
			}
		}
	}
	return false
}

func responseSchemaRef(t *testing.T, operation map[string]any, status string) string {
	t.Helper()
	response := nestedMap(t, operation, "responses", status, "content", "application/json", "schema")
	value, _ := response["$ref"].(string)
	return value
}

func successHasHeader(operation map[string]any, name string) bool {
	responses := anyMapNoTest(operation["responses"])
	for status, raw := range responses {
		if !strings.HasPrefix(status, "2") {
			continue
		}
		if _, exists := anyMapNoTest(anyMapNoTest(raw)["headers"])[name]; exists {
			return true
		}
	}
	return false
}

func effectiveAuthDomain(spec, operation map[string]any, declared string) string {
	if declared == "callback" || declared == "public" {
		if _, explicit := operation["security"]; explicit && len(anySlice(operation["security"])) == 0 {
			return declared
		}
		return "invalid"
	}
	schemes := securitySchemes(spec, operation)
	if len(schemes) != 1 {
		return "invalid"
	}
	return map[string]string{
		"HumanBearer": "human", "RuntimeBearer": "runtime",
		"ComputerCredentialAuth": "computer-credential", "ComputerBearer": "computer-bearer",
		"EnrollmentAuth": "enrollment",
	}[schemes[0]]
}

func securitySchemes(spec, operation map[string]any) []string {
	raw, explicit := operation["security"]
	if !explicit {
		raw = spec["security"]
	}
	result := make([]string, 0)
	for _, requirement := range anySlice(raw) {
		for scheme := range anyMapNoTest(requirement) {
			result = append(result, scheme)
		}
	}
	slices.Sort(result)
	return result
}

func nestedMap(t *testing.T, root map[string]any, keys ...string) map[string]any {
	t.Helper()
	return anyMap(t, nestedNoTest(root, keys...), strings.Join(keys, "."))
}

func nestedString(t *testing.T, root map[string]any, keys ...string) string {
	t.Helper()
	value, ok := nestedNoTest(root, keys...).(string)
	if !ok {
		t.Fatalf("%s 不是 string", strings.Join(keys, "."))
	}
	return value
}

func nestedNoTest(root map[string]any, keys ...string) any {
	var current any = root
	for _, key := range keys {
		current = anyMapNoTest(current)[key]
	}
	return current
}

func anyMap(t *testing.T, value any, label string) map[string]any {
	t.Helper()
	result, ok := value.(map[string]any)
	if !ok {
		t.Fatalf("%s 不是 object: %T", label, value)
	}
	return result
}

func anyMapNoTest(value any) map[string]any {
	result, _ := value.(map[string]any)
	return result
}

func anySlice(value any) []any {
	result, _ := value.([]any)
	return result
}

func stringSlice(t *testing.T, value any, label string) []string {
	t.Helper()
	raw := anySlice(value)
	result := make([]string, 0, len(raw))
	for _, item := range raw {
		text, ok := item.(string)
		if !ok {
			t.Fatalf("%s 含非 string: %T", label, item)
		}
		result = append(result, text)
	}
	return result
}

func asInt(t *testing.T, value any) int {
	t.Helper()
	switch number := value.(type) {
	case int:
		return number
	case int64:
		return int(number)
	case uint64:
		return int(number)
	case float64:
		return int(number)
	default:
		t.Fatalf("值不是 integer: %T", value)
		return 0
	}
}
