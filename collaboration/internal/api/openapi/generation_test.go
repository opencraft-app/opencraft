package openapi

import (
	"context"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestGeneratedSpecHasFrozenShape(t *testing.T) {
	t.Parallel()

	spec, err := GetSwagger()
	if err != nil {
		t.Fatalf("load embedded OpenAPI: %v", err)
	}
	if err := spec.Validate(context.Background()); err != nil {
		t.Fatalf("validate embedded OpenAPI: %v", err)
	}

	paths := spec.Paths.Map()
	if got, want := len(paths), 73; got != want {
		t.Fatalf("path count = %d, want %d", got, want)
	}
	for _, path := range []string{
		"/callbacks/tencent-im/state",
		"/computer/setup-codes:redeem",
		"/servers/{serverId}/inbox",
		"/servers/{serverId}/activity",
		"/servers/{serverId}/channels/{channelId}/threads",
		"/servers/{serverId}/channels/{channelId}/threads/{threadId}",
		"/servers/{serverId}/channels/{channelId}/threads/{threadId}/replies",
		"/servers/{serverId}/channels/{channelId}/threads/{threadId}/read",
		"/runtime/tasks",
		"/runtime/directory",
		"/runtime/tasks/{taskId}",
		"/runtime/tasks/{taskId}/claim",
		"/runtime/channels/{channelId}/members",
		"/runtime/threads:resolve",
		"/runtime/threads/{threadId}/replies",
		"/runtime/reminders",
		"/runtime/reminders/{reminderId}",
		"/runtime/reminders/{reminderId}/snooze",
		"/runtime/reminders/{reminderId}/log",
		"/servers/{serverId}/computers-v2",
	} {
		if paths[path] == nil {
			t.Errorf("embedded OpenAPI is missing %q", path)
		}
	}
}

func TestComputerV2SelectsAnExistingLightVelaInstance(t *testing.T) {
	t.Parallel()

	spec, err := GetSwagger()
	if err != nil {
		t.Fatalf("load embedded OpenAPI: %v", err)
	}
	if spec.Info == nil || spec.Info.Version != "5.0.0" {
		t.Fatalf("OpenAPI version = %#v, want 5.0.0", spec.Info)
	}
	path := spec.Paths.Find("/servers/{serverId}/computers-v2")
	if path == nil || path.Get == nil || path.Post == nil {
		t.Fatal("computers-v2 collection GET/POST is missing")
	}
	if path.Get.OperationID != "ListComputersV2" || path.Post.OperationID != "CreateComputerV2" {
		t.Fatalf("computers-v2 operations = %q/%q", path.Get.OperationID, path.Post.OperationID)
	}
	request := spec.Components.Schemas["CreateComputerV2Request"]
	if request == nil || request.Value == nil {
		t.Fatal("CreateComputerV2Request schema is missing")
	}
	for _, field := range []string{"kind", "instanceId"} {
		if !containsRequired(request.Value.Required, field) {
			t.Errorf("CreateComputerV2Request does not require %s", field)
		}
	}
	if request.Value.Properties["kind"] == nil ||
		request.Value.Properties["instanceId"] == nil {
		t.Fatal("CreateComputerV2Request kind/instanceId properties are missing")
	}
	for _, forbidden := range []string{"createInstance", "bundleId", "planId", "tatRegion"} {
		if request.Value.Properties[forbidden] != nil {
			t.Errorf("CreateComputerV2Request exposes forbidden instance creation field %s", forbidden)
		}
	}
}

func TestAgentComputerBindingIsRequiredAndNonNullable(t *testing.T) {
	t.Parallel()

	spec, err := GetSwagger()
	if err != nil {
		t.Fatalf("load embedded OpenAPI: %v", err)
	}
	if spec.Info == nil || spec.Info.Version != "5.0.0" {
		t.Fatalf("OpenAPI version = %#v, want 5.0.0", spec.Info)
	}
	for _, name := range []string{"Agent", "CreateAgentRequest"} {
		reference := spec.Components.Schemas[name]
		if reference == nil || reference.Value == nil {
			t.Fatalf("%s schema is missing", name)
		}
		if !containsRequired(reference.Value.Required, "computerId") {
			t.Errorf("%s does not require computerId", name)
		}
		property := reference.Value.Properties["computerId"]
		if property == nil || property.Value == nil || property.Value.Nullable {
			t.Errorf("%s computerId is missing or nullable", name)
		}
	}
	update := spec.Components.Schemas["UpdateAgentRequest"]
	if update == nil || update.Value == nil {
		t.Fatal("UpdateAgentRequest schema is missing")
	}
	property := update.Value.Properties["computerId"]
	if property == nil || property.Value == nil || property.Value.Nullable {
		t.Error("UpdateAgentRequest computerId is missing or nullable")
	}
}

func containsRequired(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func TestGeneratedStrictInterfaceCoversEveryOperation(t *testing.T) {
	t.Parallel()

	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve current test file")
	}
	generatedFile := filepath.Join(filepath.Dir(currentFile), "server.gen.go")
	parsed, err := parser.ParseFile(token.NewFileSet(), generatedFile, nil, 0)
	if err != nil {
		t.Fatalf("parse generated server: %v", err)
	}

	methods := -1
	ast.Inspect(parsed, func(node ast.Node) bool {
		typeSpec, ok := node.(*ast.TypeSpec)
		if !ok || typeSpec.Name.Name != "StrictServerInterface" {
			return true
		}
		iface, ok := typeSpec.Type.(*ast.InterfaceType)
		if !ok {
			t.Fatalf("StrictServerInterface has type %T", typeSpec.Type)
		}
		methods = iface.Methods.NumFields()
		return false
	})
	if got, want := methods, 98; got != want {
		t.Fatalf("strict method count = %d, want %d", got, want)
	}
}

func TestGeneratedClientCoversRuntimeAndLifecycleOperations(t *testing.T) {
	t.Parallel()

	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve current test file")
	}
	generatedFile := filepath.Join(filepath.Dir(currentFile), "client.gen.go")
	source, err := os.ReadFile(generatedFile)
	if err != nil {
		t.Fatalf("read generated client: %v", err)
	}

	for _, marker := range []string{
		"type ClientWithResponses struct",
		"func NewClientWithResponses",
		"DeployAgentWithResponse",
		"GetOperationWithResponse",
		"ListInboxWithResponse",
		"ListActivityWithResponse",
		"EnsureMessageThreadWithResponse",
		"ListMessageThreadRepliesWithResponse",
		"RegisterMessageThreadReplyWithResponse",
		"ListRuntimeTasksWithResponse",
		"GetRuntimeDirectoryWithResponse",
		"ClaimRuntimeTaskWithResponse",
		"UpdateRuntimeTaskStatusWithResponse",
		"GetRuntimeChannelMembersWithResponse",
		"ResolveRuntimeThreadWithResponse",
		"RegisterRuntimeThreadReplyWithResponse",
		"ListRuntimeRemindersWithResponse",
		"CreateRuntimeReminderWithResponse",
		"UpdateRuntimeReminderWithResponse",
		"CancelRuntimeReminderWithResponse",
		"SnoozeRuntimeReminderWithResponse",
		"ListRuntimeReminderLogWithResponse",
		"CreateComputerAgentLaunchWithResponse",
		"RefreshComputerAgentSessionWithResponse",
		"ListComputersV2WithResponse",
		"CreateComputerV2WithResponse",
	} {
		if !strings.Contains(string(source), marker) {
			t.Errorf("generated client is missing %q", marker)
		}
	}
}

func TestGeneratedCreateServerSupportsReadyAndAcceptedResponses(t *testing.T) {
	t.Parallel()

	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve current test file")
	}
	generatedFile := filepath.Join(filepath.Dir(currentFile), "server.gen.go")
	source, err := os.ReadFile(generatedFile)
	if err != nil {
		t.Fatalf("read generated server: %v", err)
	}

	for _, marker := range []string{
		"type CreateServer201JSONResponse Server",
		"type CreateServer202JSONResponse AcceptedResource",
	} {
		if !strings.Contains(string(source), marker) {
			t.Errorf("generated server is missing %q", marker)
		}
	}
}

func TestTerminalSessionSchemaCarriesCompleteClientBootstrap(t *testing.T) {
	t.Parallel()

	spec, err := GetSwagger()
	if err != nil {
		t.Fatalf("load embedded OpenAPI: %v", err)
	}
	reference := spec.Components.Schemas["TerminalSession"]
	if reference == nil || reference.Value == nil {
		t.Fatal("TerminalSession schema is missing")
	}
	required := make(map[string]bool, len(reference.Value.Required))
	for _, name := range reference.Value.Required {
		required[name] = true
	}
	for _, name := range []string{
		"protocol",
		"sessionId",
		"webSocketUrl",
		"expiresAt",
		"authentication",
		"terminal",
	} {
		if reference.Value.Properties[name] == nil {
			t.Errorf("TerminalSession is missing property %q", name)
		}
		if !required[name] {
			t.Errorf("TerminalSession property %q is not required", name)
		}
	}
}
