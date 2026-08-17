package persistedjson

import (
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"

	"chatserver/internal/database/modelcontract"
)

var literalScopePattern = regexp.MustCompile(`SetScopeType\("([^"]+)"\)`)

func TestAdapterPersistentJSONWritesUseRegisteredCodecs(t *testing.T) {
	_, current, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("无法定位 persistedjson 源码")
	}
	adapters := filepath.Join(filepath.Dir(current), "..", "adapters")
	err := filepath.WalkDir(adapters, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		text := string(data)
		for _, match := range literalScopePattern.FindAllStringSubmatch(text, -1) {
			if !KnownScope(match[1]) {
				t.Errorf("%s 使用未注册幂等 scope %q", path, match[1])
			}
		}
		assertCodec := func(setter, codec string) {
			setterCall := setter + "("
			codecCall := "persistedjson." + codec + "("
			if strings.Contains(text, setterCall) && !strings.Contains(text, codecCall) {
				t.Errorf("%s 写入 %s 但未经过 %s", path, setter, codecCall)
			}
		}
		for _, field := range DurableFields() {
			assertCodec(field.Setter, field.Codec)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestOperationAndIdempotencyRegistriesAreStableAndSorted(t *testing.T) {
	for _, values := range [][]string{OperationKinds(), IdempotencyScopes()} {
		if len(values) == 0 {
			t.Fatal("持久 JSON registry 为空")
		}
		for index := 1; index < len(values); index++ {
			if values[index-1] >= values[index] {
				t.Fatalf("registry 未稳定排序: %#v", values)
			}
		}
	}
}

func TestDurableFieldRegistryMatchesEveryOpaqueJSONFieldInModelContract(t *testing.T) {
	_, current, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("无法定位 persistedjson 源码")
	}
	root := filepath.Clean(filepath.Join(filepath.Dir(current), "..", ".."))
	contract, err := modelcontract.LoadFile(filepath.Join(root, "platform", "v1", "model-contract.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	want := make(map[string]struct{})
	for _, table := range contract.Tables {
		for field, class := range table.SemanticFields {
			if class == "opaque-json" {
				want[table.Table+"."+field] = struct{}{}
			}
		}
	}
	got := make(map[string]struct{})
	for _, field := range DurableFields() {
		key := field.Table + "." + field.Field
		if field.Setter == "" || field.Codec == "" {
			t.Errorf("持久 JSON field registry 不完整: %#v", field)
		}
		if _, duplicate := got[key]; duplicate {
			t.Errorf("持久 JSON field registry 重复: %s", key)
		}
		got[key] = struct{}{}
	}
	for key := range want {
		if _, ok := got[key]; !ok {
			t.Errorf("opaque-json 字段未注册 codec: %s", key)
		}
	}
	for key := range got {
		if _, ok := want[key]; !ok {
			t.Errorf("持久 JSON registry 存在契约外字段: %s", key)
		}
	}
}

func TestAgentProfileCapabilityPersistenceIsRegistered(t *testing.T) {
	if !KnownOperation("platform", "agent.profile.capabilities.refresh") {
		t.Fatal("Profile capability refresh operation kind is not registered")
	}
	if !KnownScope("agent.profile-capabilities.refresh") {
		t.Fatal("Profile capability refresh idempotency scope is not registered")
	}
	for _, field := range DurableFields() {
		if field.Table == "agents" && field.Field == "profile_capabilities_json" &&
			field.Codec == "EncodeProfileCapabilities" {
			return
		}
	}
	t.Fatal("Agent profile_capabilities_json durable field is not registered")
}
